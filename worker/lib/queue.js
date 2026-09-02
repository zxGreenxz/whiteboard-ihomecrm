// =============================================================
// queue.js — xử lý job trong zalo_send_queue.
//
// Giữ nguyên 2 bất biến của bản cũ:
//   • CLAIM NGUYÊN TỬ: chỉ xử lý nếu chuyển được queued→processing (0 dòng
//     đổi = tick/instance khác đã nhận → bỏ qua, chống gửi trùng).
//   • RẢI NHỊP anti-spam giữa các job do vòng tick lo (700–1500ms).
//
// Mới:
//   • Gửi tin text: dựng QUOTE THÔ từ payload.target_raw (bài học WEB2
//     §13.17) — Zalo từ chối quote thì gửi lại KHÔNG quote, không fail cả tin.
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
import { validateZaloCommandScope, formatScopeRejection, logScopeRejection, clampHistoryCount } from './scope-guard.js';

async function jobDone(jobId, extra = {}) {
  await sb.from('zalo_send_queue').update({ status: 'sent', processed_at: new Date().toISOString(), ...extra }).eq('id', jobId);
}
async function jobFail(job, message) {
  await sb.from('zalo_send_queue').update({
    status: 'failed', last_error: String(message).slice(0, 300), attempts: (job.attempts || 0) + 1,
  }).eq('id', job.id);
  if (job.message_id) await sb.from('zalo_messages').update({ status: 'failed' }).eq('id', job.message_id);
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
  let res;
  try {
    res = await s.api.sendMessage(quote ? { ...content, quote } : content, threadId, type);
  } catch (e) {
    if (!quote) throw e;
    // Zalo từ chối quote (tin gốc quá cũ / shape lạ) → gửi KHÔNG quote.
    log('quote bị từ chối → gửi không quote', job.id, e?.message || e);
    res = await s.api.sendMessage(content, threadId, type);
  }
  const zid = res?.message?.msgId || res?.msgId || '';
  const cid = res?.message?.cliMsgId || res?.cliMsgId || '';
  if (job.message_id) {
    if (zid) {
      // selfListen có thể đã chèn echo của chính tin này → tránh trùng:
      const { data: dup } = await sb.from('zalo_messages').select('id').eq('account_id', job.account_id).eq('zalo_msg_id', String(zid)).maybeSingle();
      if (dup && dup.id !== job.message_id) {
        await sb.from('zalo_messages').delete().eq('id', job.message_id);   // bỏ row pending, giữ echo
      } else {
        await sb.from('zalo_messages').update({ status: 'sent', zalo_msg_id: String(zid), cli_msg_id: cid ? String(cid) : null }).eq('id', job.message_id);
      }
    } else {
      await sb.from('zalo_messages').update({ status: 'sent' }).eq('id', job.message_id);
    }
  }
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
  try {
    const { data: msg } = await sb.from('zalo_messages')
      .select('zalo_msg_id, cli_msg_id, zalo_raw')
      .eq('account_id', job.account_id).eq('zalo_msg_id', String(p.target_msg_id || '')).maybeSingle();
    const r = msg?.zalo_raw;
    if (!msg || !r || !r.uidFrom) { await jobDone(job.id); return; } // thiếu nguyên liệu → bỏ qua êm
    await s.api.sendSeenEvent({
      msgId: String(msg.zalo_msg_id), cliMsgId: String(msg.cli_msg_id || ''),
      uidFrom: String(r.uidFrom), idTo: String(r.idTo || ''),
      msgType: String(r.msgType || 'webchat'),
      st: Number(r.st) || 0, at: Number(r.at) || 0, cmd: Number(r.cmd) || 0,
      ts: String(r.ts || ''),
    }, type);
  } catch (e) { log('seen best-effort fail (bỏ qua)', e?.message || e); }
  await jobDone(job.id);
}

export async function processJob(job) {
  // CLAIM NGUYÊN TỬ — chống gửi trùng giữa tick chồng / 2 instance.
  const { data: claimed, error: claimErr } = await sb.from('zalo_send_queue')
    .update({ status: 'processing' }).eq('id', job.id).eq('status', 'queued').select('id');
  if (claimErr || !claimed || !claimed.length) return;

  // GUARD PHẠM VI (PZALO-C01, re-anchor 02/09/2026): SAU claim, TRƯỚC mọi lời gọi
  // provider. Job forge (thread/msg/account không thuộc hội thoại của account)
  // bị fail với REJECTED_SCOPE và KHÔNG chạm Zalo.
  const scope = await validateZaloCommandScope(job);
  if (!scope.ok) {
    logScopeRejection(job, scope);
    await jobFail(job, formatScopeRejection(scope));
    return;
  }

  const s = sessions.get(job.account_id);
  if (!s) {
    await jobFail(job, 'Tài khoản chưa kết nối');
    return;
  }
  try {
    const p = job.payload || {};
    // thread/type lấy từ hội thoại ĐÃ KIỂM (scope.conv), không tin payload.
    const threadId = scope.conv ? String(scope.conv.thread_id) : (p.thread_id ? String(p.thread_id) : null);
    const ttype = scope.conv ? scope.conv.thread_type : (p.thread_type || null);
    const type = ttype === 'group' ? ThreadType.Group : ThreadType.User;

    if (p.action === 'react') {
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
      try { await s.api.sendTypingEvent(threadId, type); } catch (e) { log('typing best-effort', e?.message || e); }
      await jobDone(job.id);
    } else if (p.action === 'find_user') {
      await findUserJob(s, job, p);
    } else if (p.action === 'sticker_list') {
      await stickerListJob(s, job, p);
    } else if (['image', 'file', 'voice', 'sticker'].includes(String(p.type))) {
      if (!threadId) throw new Error('Không tìm thấy hội thoại của job media');
      await sendMediaJob(s, job, p, threadId, type);
      await jobDone(job.id);
    } else {
      if (!threadId) throw new Error('Không tìm thấy hội thoại của job');
      await sendText(s, job, p, threadId, type);
      await jobDone(job.id);
    }
  } catch (e) {
    log('job error', job.id, e?.message || e);
    await jobFail(job, e?.message || e);
  }
}
