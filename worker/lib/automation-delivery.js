import { sb } from './ctx.js';
import { chuanHoaBroadcast } from './automation-config.js';
import { gioVietNam, trongKhungGio } from './automation-scenario.js';

// Lượt gửi MỘT LẦN còn hiệu lực cho tin đã xếp: đang chạy hoặc đã chốt (kể cả chốt lỗi một
// phần). 'queued' chưa từng có tin; 'cancelled' là người dùng/dừng khẩn cấp đã huỷ.
const HEN_GIO_CON_GUI = new Set(['running', 'done', 'failed']);

// Re-read before a provider side effect: configuration and recipients may have
// changed since enqueue. SQL admission also serializes stop/quota/lease checks.
export async function validateAutomationDelivery(job, db = sb, now = new Date()) {
  if (job?.payload?.tu_dong !== true) return { ok: true };
  const kind = job.payload.auto_reply === true ? 'auto_reply' : 'broadcast_vacant';
  // A one-shot is its own authority: the schedule switch and config.recipients do
  // not apply, but hours/day/due checks below do (same as zalo_worker_begin_provider_v1).
  const oneshotId = kind === 'broadcast_vacant' && job.payload.oneshot_id ? String(job.payload.oneshot_id) : null;
  const reject = reason => ({ ok: false, reason });
  const { data: auto, error } = await db.from('zalo_automations')
    .select('enabled, config').eq('organization_id', job.organization_id).eq('kind', kind).maybeSingle();
  if (error) return reject('AUTOMATION_UNVERIFIED: không đọc được cấu hình hiện tại');
  if (!oneshotId && !auto?.enabled) return reject('CANCELLED_AUTOMATION: tự động hóa đã tắt');
  const { data: conv, error: convError } = await db.from('zalo_conversations')
    .select('account_id, organization_id, is_sale_partner, thread_type').eq('id', job.conversation_id).maybeSingle();
  if (convError) return reject('AUTOMATION_UNVERIFIED: không đọc được người nhận hiện tại');
  if (!conv || conv.account_id !== job.account_id || conv.organization_id !== job.organization_id) {
    return reject('REJECTED_SCOPE: người nhận tự động không còn đúng phạm vi');
  }
  if (kind === 'auto_reply') {
    return conv.is_sale_partner ? { ok: true } : reject('CANCELLED_AUTOMATION: hội thoại không còn là sale');
  }
  const config = chuanHoaBroadcast(auto?.config);
  if (oneshotId) {
    const { data: shot, error: shotError } = await db.from('zalo_automation_oneshots')
      .select('organization_id, status, recipients').eq('id', oneshotId).maybeSingle();
    if (shotError) return reject('AUTOMATION_UNVERIFIED: không đọc được lượt gửi một lần');
    if (!shot || shot.organization_id !== job.organization_id) {
      return reject('REJECTED_SCOPE: lượt gửi một lần không thuộc công ty này');
    }
    if (!HEN_GIO_CON_GUI.has(shot.status)) return reject('CANCELLED_AUTOMATION: lượt gửi một lần đã bị huỷ');
    if (!Array.isArray(shot.recipients) || !shot.recipients.includes(job.conversation_id)) {
      return reject('CANCELLED_AUTOMATION: hội thoại không thuộc lượt gửi một lần');
    }
    if (conv.thread_type !== 'group' || !conv.is_sale_partner) {
      return reject('CANCELLED_AUTOMATION: hội thoại không còn là nhóm sale');
    }
    // Emergency stop blocks every message of a one-shot, including a finished shot's
    // queued/processing/recovered jobs; a job created before the latest stop never
    // sends, even after the stop is lifted (mirrors app_private.zalo_oneshot_job_bi_dung_v1).
    const { data: stop, error: stopError } = await db.from('zalo_automation_runs')
      .select('created_at').eq('organization_id', job.organization_id).eq('kind', 'broadcast_vacant')
      .eq('mode', 'stopped').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (stopError) return reject('AUTOMATION_UNVERIFIED: không đọc được trạng thái dừng khẩn cấp');
    if (stop?.created_at) {
      const stopAt = Date.parse(stop.created_at);
      const jobAt = Date.parse(job.created_at);
      if (!Number.isFinite(stopAt) || !Number.isFinite(jobAt) || jobAt <= stopAt) {
        return reject('CANCELLED_AUTOMATION: tin được xếp trước lần dừng khẩn cấp');
      }
      const { data: saves, error: saveError } = await db.from('zalo_automations')
        .select('updated_at').eq('organization_id', job.organization_id);
      if (saveError) return reject('AUTOMATION_UNVERIFIED: không đọc được lần lưu cấu hình');
      const lastSave = Math.max(...(Array.isArray(saves) ? saves : []).map(r => Date.parse(r?.updated_at)).filter(Number.isFinite));
      if (!(lastSave > stopAt)) return reject('CANCELLED_AUTOMATION: tự động hóa đang dừng khẩn cấp');
    }
  } else if (!config.recipients.includes(job.conversation_id)) {
    return reject('CANCELLED_AUTOMATION: hội thoại đã bỏ khỏi danh sách nhận');
  }
  const scheduledAt = new Date(job.not_before || job.created_at);
  if (!Number.isFinite(scheduledAt.getTime())) return reject('EXPIRED_AUTOMATION: thiếu thời điểm gửi hợp lệ');
  if (gioVietNam(scheduledAt).ngay !== gioVietNam(now).ngay) {
    return reject('EXPIRED_AUTOMATION: không gửi danh sách phòng của ngày khác');
  }
  const window = trongKhungGio(now, config.antiSpam);
  if (!window.trong) return reject(`EXPIRED_AUTOMATION: ${window.lyDo}`);
  if (scheduledAt > now) return reject('AUTOMATION_NOT_DUE: chưa tới giờ gửi');
  return { ok: true };
}
