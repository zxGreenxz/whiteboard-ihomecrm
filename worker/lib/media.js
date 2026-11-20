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

export async function downloadAttachment(a) {
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

// The photo API accepts a native image album. The SDK's generic mixed upload
// posts MP4 as a downloadable file. Send playable videos immediately after the
// single photo album, while this room still owns the current queue job.
async function sendRoomMedia(s, job, attachments, dbIds, threadId, type) {
  if (attachments.length !== dbIds.length) throw new Error('Số media phòng và số tin đã xếp không khớp');
  const photos = [], videos = [];
  attachments.forEach((media, index) => {
    (media.mime === 'video/mp4' ? videos : photos).push({ media, id: dbIds[index] });
  });
  // Canonical rows in older enqueue RPCs start as image. Correct the media type
  // before any provider call so CRM also renders the original MP4 as video.
  const { data, error } = await sb.from('zalo_messages').update({ msg_type: 'video' })
    .eq('organization_id', job.organization_id).eq('account_id', job.account_id)
    .eq('conversation_id', job.conversation_id).eq('status', 'pending')
    .in('id', videos.map(v => v.id)).select('id');
  if (error || data?.length !== videos.length) throw new Error('Chưa xác nhận được các tin video của phòng');
  const sources = [];
  for (const { media } of photos) sources.push(await downloadAttachment(media));
  let cover = sources[0];
  if (!cover) {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(320, 180);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#28323a'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(145, 63); ctx.lineTo(145, 117); ctx.lineTo(185, 90); ctx.fill();
    const data = canvas.toBuffer('image/png');
    cover = { data, filename: 'video.png', metadata: { totalSize: data.length, width: 320, height: 180 } };
  }
  const uploaded = await s.api.uploadAttachment(cover, threadId, type);
  const thumb = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  const thumbnailUrl = thumb?.normalUrl || thumb?.hdUrl || thumb?.thumbUrl;
  if (!thumbnailUrl) throw new Error('Zalo chưa xác nhận ảnh xem trước của video');
  const prepared = [];
  for (const video of videos) {
    const source = await downloadAttachment(video.media);
    const result = await s.api.uploadAttachment(source, threadId, type);
    const videoUrl = (Array.isArray(result) ? result[0] : result)?.fileUrl;
    if (!videoUrl) throw new Error('Zalo chưa xác nhận video gốc của phòng');
    prepared.push({ id: video.id, videoUrl, media: video.media });
  }
  const receipts = [];
  if (photos.length) {
    const res = await s.api.sendMessage({ msg: '', attachments: sources }, threadId, type);
    if (res?.attachment?.length !== photos.length) throw new Error('PROVIDER_RECEIPT_MISMATCH: thiếu biên nhận album phòng');
    photos.forEach((photo, index) => receipts.push(sendReceipt(photo.id, res.attachment[index])));
  }
  for (const { id, videoUrl, media } of prepared) {
    const result = await s.api.sendVideo({ videoUrl, thumbnailUrl, duration: media.duration_ms, width: media.width, height: media.height }, threadId, type);
    receipts.push(sendReceipt(id, result));
  }
  await finalizeSend(job, receipts);
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

  if (p.tu_dong === true && p.automation_request_key?.endsWith(':album')
      && p.attachments?.some(a => a.mime === 'video/mp4')) {
    return sendRoomMedia(s, job, p.attachments, dbIds, threadId, type);
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
