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
//
// MỌI LỜI GỌI Ở ĐÂY ĐỀU PHẢI KIỂM `error`. Bản trước bỏ qua hết, và đó không
// phải chuyện nhỏ: tin gửi đi thành công nhưng dòng trong DB kẹt vĩnh viễn ở
// `pending`, khung chat hiện một ô "đang gửi" không bao giờ xong, còn hàng đợi
// thì báo `sent` nên không ai biết có gì sai. Lỗi im lặng ở đây tự che chính nó.
// Nay ném lên để `processJob` ghi vào `zalo_send_queue.last_error` — đọc được
// từ DB, không cần bới log.
//
// `count: 'exact'` để phân biệt "update chạy nhưng không khớp dòng nào" với
// "update chạy và trúng" — hai ca đó cần chữa khác nhau, và bản cũ không phân
// biệt được vì nó không nhìn kết quả.
async function markSent(accountId, dbMsgIds, zaloMsgIds) {
  const ids = Array.isArray(dbMsgIds) ? dbMsgIds : [];
  if (!ids.length) {
    log('markSent: KHÔNG có message_id nào để cập nhật — dòng tin sẽ kẹt ở pending');
    return;
  }
  for (let i = 0; i < ids.length; i++) {
    const zid = zaloMsgIds && zaloMsgIds[i] ? String(zaloMsgIds[i]) : null;
    if (zid) {
      const { data: dup, error: eDup } = await sb.from('zalo_messages').select('id')
        .eq('account_id', accountId).eq('zalo_msg_id', zid).maybeSingle();
      if (eDup) throw new Error(`markSent/tìm echo trùng: ${eDup.message}`);
      if (dup && dup.id !== ids[i]) {
        const { error } = await sb.from('zalo_messages').delete().eq('id', ids[i]); // bỏ row pending, giữ echo
        if (error) throw new Error(`markSent/xoá dòng chờ: ${error.message}`);
        continue;
      }
      const { error, count } = await sb.from('zalo_messages')
        .update({ status: 'sent', zalo_msg_id: zid }, { count: 'exact' }).eq('id', ids[i]);
      if (error) throw new Error(`markSent/cập nhật kèm zalo_msg_id: ${error.message}`);
      if (!count) throw new Error(`markSent: không tìm thấy dòng tin ${ids[i]} để cập nhật (tin đã gửi nhưng DB không ghi nhận)`);
    } else {
      const { error, count } = await sb.from('zalo_messages')
        .update({ status: 'sent' }, { count: 'exact' }).eq('id', ids[i]);
      if (error) throw new Error(`markSent/cập nhật trạng thái: ${error.message}`);
      if (!count) throw new Error(`markSent: không tìm thấy dòng tin ${ids[i]} để cập nhật (tin đã gửi nhưng DB không ghi nhận)`);
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
