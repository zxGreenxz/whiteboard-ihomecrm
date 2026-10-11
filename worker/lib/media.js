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
// Voice: Zalo cần URL audio (uploadAttachment → fileUrl → sendVoice). Không
// tự gửi lại dưới dạng file khi provider/DB lỗi: voice có thể đã tới người nhận.
// =============================================================
import { sb, log } from './ctx.js';
import { finalizeSend, sendReceipt } from './send-finalization.js';

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

// p = payload job: {type: image|file|voice|sticker, body, attachments[], sticker, message_ids[]}
export async function sendMediaJob(s, job, p, threadId, type) {
  const dbIds = [...new Set([job.message_id, ...(Array.isArray(p.message_ids) ? p.message_ids : [])].filter(Boolean))];

  if (p.type === 'sticker') {
    const st = p.sticker || {};
    const res = await s.api.sendSticker(
      { id: Number(st.id), cateId: Number(st.cateId), type: Number(st.type) }, threadId, type);
    await finalizeSend(job, dbIds.map((id, index) => sendReceipt(id, index === 0 ? res : null)));
    log('sticker sent', job.id);
    return;
  }

  const sources = [];
  for (const a of (p.attachments || [])) sources.push(await downloadAttachment(a));
  if (!sources.length) throw new Error('Job media không có attachment nào');

  if (p.type === 'voice') {
    const up = await s.api.uploadAttachment(sources[0], threadId, type);
    const first = Array.isArray(up) ? up[0] : up;
    const fileUrl = first?.fileUrl || first?.normalUrl || first?.hdUrl;
    if (!fileUrl) throw new Error('uploadAttachment không trả fileUrl');
    const res = await s.api.sendVoice({ voiceUrl: fileUrl }, threadId, type);
    // Persist nằm ngoài mọi nhánh gửi lại. Lỗi sau provider được queue ghi là
    // UNKNOWN_EFFECT để đối soát, không suy rằng khách chưa nhận voice.
    await finalizeSend(job, dbIds.map((id, index) => sendReceipt(id, index === 0 ? res : null)));
    log('voice sent', job.id);
    return;
  }

  // image / file: sendMessage với attachments (Buffer) — zca tự upload CDN.
  const res = await s.api.sendMessage({ msg: p.body || '', attachments: sources }, threadId, type);
  const attachments = Array.isArray(res?.attachment) ? res.attachment : [];
  if (attachments.length && attachments.length !== dbIds.length) {
    throw new Error('PROVIDER_RECEIPT_MISMATCH: số biên nhận media không khớp, cần đối soát');
  }
  // Preserve positions when one receipt has no ID. Filtering IDs would attach
  // the next image's provider ID to the wrong canonical row.
  const receipts = dbIds.map((id, index) => sendReceipt(id,
    attachments.length ? attachments[index] : (dbIds.length === 1 ? res?.message || res : null)));
  await finalizeSend(job, receipts);
  log(p.type, 'sent', job.id, '(' + sources.length + ' tệp)');
}
