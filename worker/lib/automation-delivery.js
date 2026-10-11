import { sb } from './ctx.js';
import { chuanHoaBroadcast } from './automation-config.js';
import { gioVietNam, trongKhungGio } from './automation-scenario.js';

// Re-read before a provider side effect: configuration and recipients may have
// changed since enqueue. SQL admission also serializes stop/quota/lease checks.
export async function validateAutomationDelivery(job, db = sb, now = new Date()) {
  if (job?.payload?.tu_dong !== true) return { ok: true };
  const kind = job.payload.auto_reply === true ? 'auto_reply' : 'broadcast_vacant';
  const reject = reason => ({ ok: false, reason });
  const { data: auto, error } = await db.from('zalo_automations')
    .select('enabled, config').eq('organization_id', job.organization_id).eq('kind', kind).maybeSingle();
  if (error) return reject('AUTOMATION_UNVERIFIED: không đọc được cấu hình hiện tại');
  if (!auto?.enabled) return reject('CANCELLED_AUTOMATION: tự động hóa đã tắt');
  const { data: conv, error: convError } = await db.from('zalo_conversations')
    .select('account_id, organization_id, is_sale_partner').eq('id', job.conversation_id).maybeSingle();
  if (convError) return reject('AUTOMATION_UNVERIFIED: không đọc được người nhận hiện tại');
  if (!conv || conv.account_id !== job.account_id || conv.organization_id !== job.organization_id) {
    return reject('REJECTED_SCOPE: người nhận tự động không còn đúng phạm vi');
  }
  if (kind === 'auto_reply') {
    return conv.is_sale_partner ? { ok: true } : reject('CANCELLED_AUTOMATION: hội thoại không còn là sale');
  }
  const config = chuanHoaBroadcast(auto.config);
  if (!config.recipients.includes(job.conversation_id)) {
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
