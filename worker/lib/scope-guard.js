// =============================================================
// scope-guard.js — kiểm PHẠM VI của một job trước khi gọi Zalo.
//
// VÌ SAO (re-anchor bảo mật 02/09/2026, PZALO-C01 ×4 — P1):
//   Browser role vẫn INSERT thẳng được vào zalo_send_queue (grant 20260626000001
//   chưa revoke; policy _org_write FOR ALL). Trước đây worker tin nguyên
//   payload.thread_id / target_msg_id / account_id → một người có
//   chat_zalo.send trong công ty forge được job gửi/react/recall/kéo lịch sử
//   qua account khác hoặc thread không thuộc hội thoại nào — kể cả vòng qua bản
//   vá RPC zalo_load_history. Guard này chạy SAU claim queued→processing và
//   TRƯỚC mọi lời gọi provider: trượt = fail job với REJECTED_SCOPE, không gọi
//   Zalo. Thuần worker, rollback bằng deploy lại.
//
// Luật:
//   1. job.account_id phải tồn tại và cùng org với job.organization_id.
//   2. Có conversation_id → conversation phải thuộc đúng account + org, và
//      payload.thread_id (nếu có) phải TRÙNG conversation.thread_id.
//   3. Không có conversation_id nhưng có thread_id → phải khớp một hội thoại
//      của CHÍNH account đó (worker chỉ nói chuyện với thread đã biết).
//   4. load_history: chỉ cho hội thoại NHÓM đã biết; count kẹp 1..200.
//   5. react/recall/delete_for_me: target_msg_id phải là tin của đúng hội thoại
//      (account-scoped); recall thêm: tin OUT do chính job.user_id gửi.
//   6. Job không đụng thread (find_user, sticker_list) chỉ cần luật 1.
// =============================================================
import { sb, log } from './ctx.js';

export const MAX_HISTORY_COUNT = 200;
const KHONG_DUNG_THREAD = new Set(['find_user', 'sticker_list']);

function bad(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

export function clampHistoryCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return 50;
  return Math.min(Math.floor(v), MAX_HISTORY_COUNT);
}

/**
 * @param {object} job — dòng zalo_send_queue
 * @param {object} [db] — client supabase (mặc định sb), tiêm được để test
 * @returns {Promise<{ok:true, conv:object|null, account:object} | {ok:false, reason:string, detail:any}>}
 */
export async function validateZaloCommandScope(job, db = sb) {
  const p = job?.payload || {};
  const action = String(p.action || '');
  if (!job?.account_id) return bad('job thiếu account_id');

  const { data: account, error: accErr } = await db.from('zalo_accounts')
    .select('id, organization_id').eq('id', job.account_id).maybeSingle();
  if (accErr) return bad('không đọc được account', accErr.message);
  if (!account) return bad('account không tồn tại', job.account_id);
  if (job.organization_id && account.organization_id !== job.organization_id) {
    return bad('account khác org với job', { account: account.organization_id, job: job.organization_id });
  }

  let conv = null;
  if (job.conversation_id) {
    const { data, error } = await db.from('zalo_conversations')
      .select('id, account_id, organization_id, thread_id, thread_type')
      .eq('id', job.conversation_id).maybeSingle();
    if (error) return bad('không đọc được conversation', error.message);
    if (!data) return bad('conversation không tồn tại', job.conversation_id);
    conv = data;
    if (conv.account_id !== job.account_id) return bad('conversation thuộc account khác', conv.account_id);
    if (conv.organization_id !== account.organization_id) return bad('conversation khác org', conv.organization_id);
    if (p.thread_id != null && String(p.thread_id) !== String(conv.thread_id)) {
      return bad('payload.thread_id lệch conversation', { payload: String(p.thread_id), conv: String(conv.thread_id) });
    }
  } else if (p.thread_id != null && !KHONG_DUNG_THREAD.has(action)) {
    const { data, error } = await db.from('zalo_conversations')
      .select('id, account_id, organization_id, thread_id, thread_type')
      .eq('account_id', job.account_id).eq('thread_id', String(p.thread_id)).maybeSingle();
    if (error) return bad('không đọc được conversation theo thread', error.message);
    if (!data) return bad('thread_id không thuộc hội thoại nào của account', String(p.thread_id));
    conv = data;
  }

  if (action === 'load_history') {
    if (!conv) return bad('load_history cần hội thoại đã biết');
    if (conv.thread_type !== 'group') return bad('load_history chỉ cho hội thoại nhóm', conv.thread_type);
  }

  if (['react', 'recall', 'delete_for_me'].includes(action)) {
    if (!p.target_msg_id) return bad(`${action} thiếu target_msg_id`);
    if (!conv) return bad(`${action} cần hội thoại đã biết`);
    const { data: msg, error } = await db.from('zalo_messages')
      .select('id, conversation_id, direction, sent_by')
      .eq('account_id', job.account_id).eq('zalo_msg_id', String(p.target_msg_id)).maybeSingle();
    if (error) return bad('không đọc được message đích', error.message);
    if (!msg || msg.conversation_id !== conv.id) return bad('target_msg_id không thuộc hội thoại', String(p.target_msg_id));
    if (action === 'recall') {
      if (msg.direction !== 'out') return bad('chỉ thu hồi được tin đi', msg.direction);
      if (msg.sent_by && job.user_id && msg.sent_by !== job.user_id) return bad('chỉ thu hồi được tin do chính mình gửi', msg.sent_by);
    }
  }

  return { ok: true, conv, account };
}

/** Ghi lý do từ chối gọn cho last_error (jobFail cắt 300 ký tự). */
export function formatScopeRejection(res) {
  const detail = res.detail == null ? '' : ` ${typeof res.detail === 'string' ? res.detail : JSON.stringify(res.detail)}`;
  return `REJECTED_SCOPE: ${res.reason}${detail}`;
}

export function logScopeRejection(job, res) {
  log('REJECTED_SCOPE', job?.id, res.reason, res.detail ?? '');
}
