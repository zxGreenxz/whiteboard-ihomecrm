// =============================================================
// queue.js — xử lý job trong zalo_send_queue.
//
// Giữ nguyên 2 bất biến của bản cũ:
//   • CLAIM NGUYÊN TỬ: chỉ xử lý nếu chuyển được queued→processing (0 dòng
//     đổi = tick/instance khác đã nhận → bỏ qua, chống gửi trùng).
//   • RẢI NHỊP anti-spam giữa các job do vòng tick lo (700–1500ms).
//
// Mới:
//   • Gửi tin text: dựng QUOTE THÔ từ payload.target_raw; lỗi provider không
//     tự gửi lại vì phản hồi mất không chứng minh tin chưa tới Zalo.
//   • mentions [{pos,uid,len}] truyền thẳng zca.
//   • Job media (image/file/voice/sticker) → media.js.
//   • Job async: find_user (soạn tin theo SĐT), sticker_list — ghi kết quả
//     vào cột result để FE poll.
//   • delete_for_me / seen / typing.
//   • Tôn trọng not_before (job hẹn giờ — bỏ qua tới lúc đến hạn).
// =============================================================
import { ThreadType } from 'zca-js';
import { sb, log, sessions, orgOf } from './ctx.js';
import { upsertMessagesForThread, emojiToZca } from './inbound.js';
import { sendMediaJob } from './media.js';
import { sendForwardMediaJob } from './forward-media.js';
import { validateZaloCommandScope, formatScopeRejection, logScopeRejection, clampHistoryCount } from './scope-guard.js';
import { INSTANCE_ID } from './lease.js';
import { validateAutomationDelivery } from './automation-delivery.js';
import { finalizeSend, sendReceipt } from './send-finalization.js';

async function jobDone(jobId, extra = {}) {
  const { data, error } = await sb.from('zalo_send_queue')
    .update({ status: 'sent', last_error: null, processed_at: new Date().toISOString(), ...extra })
    .eq('id', jobId).eq('status', 'processing').eq('processing_instance_id', INSTANCE_ID).select('id');
  if (error || !data?.length) throw new Error(`Không ghi nhận được kết quả job: ${error?.message || 'claim đã đổi chủ'}`);
}
async function jobFail(job, message, { claimed = true, unknown = false, receiptIds = [] } = {}) {
  let query = sb.from('zalo_send_queue').update({
    status: 'failed', last_error: String(message).slice(0, 300), attempts: (job.attempts || 0) + 1,
    processed_at: new Date().toISOString(),
    ...(unknown ? { result: { outcome: 'unknown', requires_reconciliation: true, provider_message_ids: receiptIds } } : {}),
  }).eq('id', job.id).eq('status', claimed ? 'processing' : 'queued');
  if (claimed) query = query.eq('processing_instance_id', INSTANCE_ID);
  const { data, error } = await query.select('id');
  if (error || !data?.length) { log('jobFail chưa ghi nhận được', job.id, error?.message || 'claim đã đổi chủ'); return; }
  const ids = [...new Set([job.message_id, ...(Array.isArray(job.payload?.message_ids) ? job.payload.message_ids : [])].filter(Boolean))];
  if (ids.length) {
    const { error: messageError } = await sb.from('zalo_messages').update({ status: 'failed' })
      .in('id', ids).eq('account_id', job.account_id).eq('organization_id', job.organization_id)
      .eq('conversation_id', job.conversation_id).eq('status', 'pending');
    if (messageError) log('jobFail message', job.id, messageError.message);
  }
}

async function deferJob(job, reason) {
  const { error } = await sb.from('zalo_send_queue').update({
    not_before: new Date(Date.now() + 15_000).toISOString(), last_error: reason,
  }).eq('id', job.id).eq('status', 'queued');
  if (error) log('deferJob', job.id, error.message);
}

export async function recoverInterruptedJobs() {
  const { data, error } = await sb.rpc('zalo_worker_recover_jobs_v1', { p_instance_id: INSTANCE_ID });
  if (error) throw new Error(`Không đối soát được hàng đợi sau khởi động: ${error.message}`);
  if (data?.reason === 'lease_lost') throw new Error('Không còn lease để đối soát hàng đợi');
  log('queue recovery', data);
  return data;
}

// Fence every provider request against the database lease and latest user
// intent. Once admitted, an error is an unknown effect; never resend blindly.
function fencedSession(session, job, delivery) {
  return { ...session, api: new Proxy(session.api, {
    get(target, key) {
      const method = target[key];
      if (typeof method !== 'function') return method;
      return async (...args) => {
        if (sessions.get(job.account_id) !== session) throw new Error('SESSION_CHANGED: phiên đã dừng hoặc thay thế');
        const automation = await validateAutomationDelivery(job);
        if (!automation.ok) throw new Error(automation.reason);
        const { data, error } = await sb.rpc('zalo_worker_begin_provider_v1', { p_job_id: job.id, p_instance_id: INSTANCE_ID });
        if (error || data !== true) throw new Error(`PROVIDER_NOT_ADMITTED: ${error?.message || 'lease, tài khoản hoặc job đã thay đổi'}`);
        delivery.started = true;
        let deadline;
        let result;
        try {
          result = await Promise.race([
            method.apply(target, args),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT: chưa xác nhận kết quả sau 60 giây')), 60_000); }),
          ]);
        } finally { clearTimeout(deadline); }
        const ids = [result?.msgId, result?.message?.msgId, ...(Array.isArray(result?.attachment) ? result.attachment.map(row => row?.msgId) : [])].filter(Boolean).map(String);
        delivery.receiptIds.push(...ids);
        return result;
      };
    },
  }) };
}

// Dựng quote THÔ đúng shape SendMessageQuote của zca — thiếu nguyên liệu thì
// trả null (gửi thường), KHÔNG đoán.
function buildQuote(p) {
  if (!p.target_msg_id || !p.target_raw) return null;
  const r = p.target_raw;
  return {
    content: r.content ?? (p.target_body || ''),
    msgType: r.msgType || 'webchat',
    propertyExt: r.propertyExt ?? null,
    uidFrom: r.uidFrom || '',
    msgId: String(p.target_msg_id),
    cliMsgId: String(p.target_cli_msg_id || ''),
    ts: String(r.ts || ''),
    ttl: 0,
  };
}

async function sendText(s, job, p, threadId, type) {
  const content = { msg: p.body || '' };
  if (Array.isArray(p.mentions) && p.mentions.length && type === ThreadType.Group) {
    content.mentions = p.mentions
      .filter((m) => m && m.uid)
      .map((m) => ({ pos: Number(m.pos) || 0, uid: String(m.uid), len: Number(m.len) || 0 }));
  }
  const quote = buildQuote(p);
  const res = await s.api.sendMessage(quote ? { ...content, quote } : content, threadId, type);
  await finalizeSend(job, job.message_id ? [sendReceipt(job.message_id, res?.message || res)] : []);
  log('sent', job.id);
}

// Soạn tin theo SĐT: findUser → tạo hội thoại 1-1 → result.conversation_id.
async function findUserJob(s, job, p) {
  const u = await s.api.findUser(String(p.phone || ''));
  const uid = u?.uid ? String(u.uid) : null;
  if (!uid) {
    await jobFail(job, 'Số điện thoại này không dùng Zalo (hoặc chặn tìm kiếm).');
    return;
  }
  const row = {
    user_id: job.user_id,
    organization_id: job.organization_id || orgOf(job.account_id),
    account_id: job.account_id, thread_id: uid, thread_type: 'user',
    peer_name: u.display_name || u.zalo_name || 'Khách Zalo',
    peer_avatar_url: u.avatar || null,
    peer_phone: String(p.phone || '') || null,
    peer_zalo_uid: uid, kind: 'unknown',
  };
  const { data: conv, error } = await sb.from('zalo_conversations')
    .upsert(row, { onConflict: 'account_id,thread_id', ignoreDuplicates: false })
    .select('id').single();
  if (error) throw new Error(error.message);
  await jobDone(job.id, { result: { conversation_id: conv.id } });
  log('find_user →', p.phone, '→', conv.id);
}

async function stickerListJob(s, job, p) {
  const ids = await s.api.getStickers(String(p.keyword || ''));
  const top = (Array.isArray(ids) ? ids : []).slice(0, 30);
  let detail = [];
  if (top.length) {
    const d = await s.api.getStickersDetail(top);
    detail = (Array.isArray(d) ? d : []).map((x) => ({
      id: x.id, cateId: x.cateId, type: x.type, text: x.text || null,
      url: x.stickerUrl || null, spriteUrl: x.stickerSpriteUrl || null, webpUrl: x.stickerWebpUrl || null,
    }));
  }
  await jobDone(job.id, { result: detail });
  log('sticker_list', p.keyword, '→', detail.length);
}

// Seen best-effort: cần params thô của tin inbound cuối (đã lưu ở zalo_raw).
async function seenJob(s, job, p, type) {
  const { data: msg, error } = await sb.from('zalo_messages')
    .select('zalo_msg_id, cli_msg_id, zalo_raw')
    .eq('account_id', job.account_id).eq('zalo_msg_id', String(p.target_msg_id || '')).maybeSingle();
  if (error) throw new Error(error.message);
  const r = msg?.zalo_raw;
  if (!msg || !r || !r.uidFrom) { await jobDone(job.id); return; } // thiếu nguyên liệu → bỏ qua êm
  await s.api.sendSeenEvent({
    msgId: String(msg.zalo_msg_id), cliMsgId: String(msg.cli_msg_id || ''),
    uidFrom: String(r.uidFrom), idTo: String(r.idTo || ''),
    msgType: String(r.msgType || 'webchat'),
    st: Number(r.st) || 0, at: Number(r.at) || 0, cmd: Number(r.cmd) || 0,
    ts: String(r.ts || ''),
  }, type);
  await jobDone(job.id);
}

export async function processJob(job) {
  let claimed = false;
  const delivery = { started: false, receiptIds: [] };
  try {
    const scope = await validateZaloCommandScope(job);
    if (!scope.ok) {
      logScopeRejection(job, scope);
      if (scope.reason.startsWith('không đọc được')) await deferJob(job, 'WAITING_DATABASE: chưa xác minh được phạm vi');
      else await jobFail(job, formatScopeRejection(scope), { claimed: false });
      return;
    }
    if (scope.account.status === 'disconnected') {
      await jobFail(job, 'ACCOUNT_DISCONNECTED: người dùng đã ngắt kết nối', { claimed: false });
      return;
    }
    const session = sessions.get(job.account_id);
    if (!session || scope.account.status !== 'connected') {
      await deferJob(job, 'WAITING_SESSION: đang chờ tài khoản kết nối');
      return;
    }
    const automation = await validateAutomationDelivery(job);
    if (!automation.ok) { await jobFail(job, automation.reason, { claimed: false }); return; }
    const { data: claim, error: claimError } = await sb.rpc('zalo_worker_claim_job_v1', { p_job_id: job.id, p_instance_id: INSTANCE_ID });
    if (claimError) throw new Error(claimError.message);
    if (!claim?.ok) return;
    claimed = true;
    const s = fencedSession(session, job, delivery);
    const p = job.payload || {};
    // thread/type lấy từ hội thoại ĐÃ KIỂM (scope.conv), không tin payload.
    const threadId = scope.conv ? String(scope.conv.thread_id) : (p.thread_id ? String(p.thread_id) : null);
    const ttype = scope.conv ? scope.conv.thread_type : (p.thread_type || null);
    const type = ttype === 'group' ? ThreadType.Group : ThreadType.User;

    if (p.kind === 'forward_media') {
      if (!threadId) throw new Error('Không tìm thấy hội thoại chuyển tiếp');
      await sendForwardMediaJob(s, job, threadId, type);
    } else if (p.action === 'react') {
      await s.api.addReaction(emojiToZca(p.emoji), { data: { msgId: String(p.target_msg_id || ''), cliMsgId: String(p.target_cli_msg_id || '') }, threadId, type });
      log('reacted', job.id, p.emoji);
      await jobDone(job.id);
    } else if (p.action === 'recall') {
      await s.api.undo({ msgId: String(p.target_msg_id || ''), cliMsgId: String(p.target_cli_msg_id || '') }, threadId, type);
      log('recalled', job.id);
      await jobDone(job.id);
    } else if (p.action === 'load_history') {
      const h = await s.api.getGroupChatHistory(threadId, clampHistoryCount(p.count));
      const n = await upsertMessagesForThread(job.account_id, job.user_id, threadId, 'group', h?.groupMsgs || [], s.api);
      log('history', job.id, '→', n, 'tin');
      await jobDone(job.id);
    } else if (p.action === 'delete_for_me') {
      await s.api.deleteMessage({
        data: {
          msgId: String(p.target_msg_id || ''),
          cliMsgId: String(p.target_cli_msg_id || ''),
          uidFrom: String(p.target_uid_from || s.ownId || ''),
        },
        threadId, type,
      }, true);
      log('deleted for me', job.id);
      await jobDone(job.id);
    } else if (p.action === 'seen') {
      await seenJob(s, job, p, type);
    } else if (p.action === 'typing') {
      await s.api.sendTypingEvent(threadId, type);
      await jobDone(job.id);
    } else if (p.action === 'find_user') {
      await findUserJob(s, job, p);
    } else if (p.action === 'sticker_list') {
      await stickerListJob(s, job, p);
    } else if (['image', 'file', 'voice', 'sticker'].includes(String(p.type))) {
      if (!threadId) throw new Error('Không tìm thấy hội thoại của job media');
      await sendMediaJob(s, job, p, threadId, type);
    } else {
      if (!threadId) throw new Error('Không tìm thấy hội thoại của job');
      await sendText(s, job, p, threadId, type);
    }
  } catch (e) {
    log('job error', job.id, e?.message || e);
    if (claimed) await jobFail(job, `${delivery.started ? 'UNKNOWN_EFFECT: cần đối soát, không tự gửi lại. ' : ''}${e?.message || e}`, {
      claimed, unknown: delivery.started, receiptIds: delivery.receiptIds,
    });
  }
}
