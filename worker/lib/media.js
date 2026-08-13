// =============================================================
// media.js — gửi ảnh / file / voice / sticker từ web qua zca-js.
//
// Luồng (bài học WEB2 §13.12): FE upload lên bucket private `zalo-media`
// (Supabase Storage) → RPC ghi N dòng message pending + 1 job có
// payload.attachments [{bucket,path,url,filename,mime,size,width,height}] →
// worker DOWNLOAD bytes từ storage (service-role) → đưa cho zca dưới dạng
// Buffer {data, filename, metadata} → zca tự upload lên CDN Zalo. media_url
// trong DB vẫn là URL TỰ HOST — reload web luôn render được, không phụ thuộc
// CDN Zalo cho chiều gửi.
//
// Voice: Zalo cần URL audio (uploadAttachment → fileUrl → sendVoice). File
// webm/opus từ MediaRecorder có thể bị Zalo từ chối — khi đó degrade thành
// gửi file đính kèm thường (người nhận vẫn nghe được, chỉ không có UI voice).
// =============================================================
import { ThreadType } from 'zca-js';
import { sb, log } from './ctx.js';

function safeFilename(name, fallbackExt) {
  let n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!n) n = 'file';
  if (!/\.[A-Za-z0-9]+$/.test(n)) n = `${n}.${fallbackExt || 'bin'}`;
  return n;
}

async function downloadAttachment(a) {
  const bucket = a.bucket || 'zalo-media';
  if (!a.path) throw new Error('Attachment thiếu path storage');
  const { data, error } = await sb.storage.from(bucket).download(a.path);
  if (error || !data) throw new Error(`Không tải được media từ storage (${a.path}): ${error?.message || 'rỗng'}`);
  const buf = Buffer.from(await data.arrayBuffer());
  const meta = { totalSize: buf.length };
  if (a.width) meta.width = Number(a.width);
  if (a.height) meta.height = Number(a.height);
  return { data: buf, filename: safeFilename(a.filename || a.path.split('/').pop()), metadata: meta };
}

// Cập nhật tick cho từng dòng message của lô — có dedup echo selfListen
// (echo về trước khi mình kịp update thì bỏ row pending, giữ echo).
async function markSent(accountId, dbMsgIds, zaloMsgIds) {
  const ids = Array.isArray(dbMsgIds) ? dbMsgIds : [];
  for (let i = 0; i < ids.length; i++) {
    const zid = zaloMsgIds && zaloMsgIds[i] ? String(zaloMsgIds[i]) : null;
    if (zid) {
      const { data: dup } = await sb.from('zalo_messages').select('id')
        .eq('account_id', accountId).eq('zalo_msg_id', zid).maybeSingle();
      if (dup && dup.id !== ids[i]) {
        await sb.from('zalo_messages').delete().eq('id', ids[i]);   // bỏ row pending, giữ echo
        continue;
      }
      await sb.from('zalo_messages').update({ status: 'sent', zalo_msg_id: zid }).eq('id', ids[i]);
    } else {
      await sb.from('zalo_messages').update({ status: 'sent' }).eq('id', ids[i]);
    }
  }
}

// p = payload job: {type: image|file|voice|sticker, body, attachments[], sticker, message_ids[]}
export async function sendMediaJob(s, job, p, threadId, type) {
  const dbIds = Array.isArray(p.message_ids) ? p.message_ids : (job.message_id ? [job.message_id] : []);

  if (p.type === 'sticker') {
    const st = p.sticker || {};
    const res = await s.api.sendSticker(
      { id: Number(st.id), cateId: Number(st.cateId), type: Number(st.type) }, threadId, type);
    await markSent(job.account_id, dbIds, [res?.msgId]);
    log('sticker sent', job.id);
    return;
  }

  const sources = [];
  for (const a of (p.attachments || [])) sources.push(await downloadAttachment(a));
  if (!sources.length) throw new Error('Job media không có attachment nào');

  if (p.type === 'voice') {
    try {
      const up = await s.api.uploadAttachment(sources[0], threadId, type);
      const first = Array.isArray(up) ? up[0] : up;
      const fileUrl = first?.fileUrl || first?.normalUrl || first?.hdUrl;
      if (!fileUrl) throw new Error('uploadAttachment không trả fileUrl');
      const res = await s.api.sendVoice({ voiceUrl: fileUrl }, threadId, type);
      await markSent(job.account_id, dbIds, [res?.msgId]);
      log('voice sent', job.id);
      return;
    } catch (e) {
      // Degrade: gửi như file thường + đổi msg_type để UI không vẽ player sai.
      log('voice degrade → file', job.id, e?.message || e);
      const res = await s.api.sendMessage({ msg: p.body || '', attachments: sources }, threadId, type);
      const zids = (res?.attachment || []).map((r) => r?.msgId).filter(Boolean);
      if (dbIds[0]) await sb.from('zalo_messages').update({ msg_type: 'file' }).eq('id', dbIds[0]);
      await markSent(job.account_id, dbIds, zids);
      return;
    }
  }

  // image / file: sendMessage với attachments (Buffer) — zca tự upload CDN.
  const res = await s.api.sendMessage({ msg: p.body || '', attachments: sources }, threadId, type);
  let zids = (res?.attachment || []).map((r) => r?.msgId).filter(Boolean);
  if (!zids.length && res?.message?.msgId) zids = [res.message.msgId];
  // Không map 1-1 được (Zalo trả thiếu) → mark sent không gắn zid; echo
  // selfListen + unique (account_id, zalo_msg_id) sẽ tự vá.
  await markSent(job.account_id, dbIds, zids);
  log(p.type, 'sent', job.id, '(' + sources.length + ' tệp)');
}
