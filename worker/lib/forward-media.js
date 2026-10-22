import { sb, SUPABASE_URL } from './ctx.js';
import { readForwardSources } from './forward-source.js';
import { finalizeSend, sendReceipt } from './send-finalization.js';
import { downloadForwardUrl, imageDetails } from './hermes-native-media.js';

export { MAX_FORWARD_BYTES, downloadForwardUrl, imageDetails } from './hermes-native-media.js';
const BUCKETS = new Set(['zalo-media', 'room-sale-images']);

function storageRef(source, storageOrigin) {
  const meta = source.media_meta || {};
  if (typeof meta.path === 'string' && meta.path) return { bucket: meta.bucket || 'zalo-media', path: meta.path };
  let url;
  try { url = new URL(source.media_url); } catch { return null; }
  if (url.origin !== storageOrigin) return null;
  const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('Đường dẫn kho media không hợp lệ');
  try { return { bucket: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) }; }
  catch { throw new Error('Đường dẫn kho media không hợp lệ'); }
}

async function sourceBytes(source, job, db, download) {
  const storageOrigin = SUPABASE_URL ? new URL(SUPABASE_URL).origin : undefined;
  const ref = storageRef(source, storageOrigin);
  let url = source.media_url;
  if (ref) {
    if (!BUCKETS.has(ref.bucket) || ref.path.startsWith('/') || /[\\\x00]/.test(ref.path)
        || ref.path.split('/').some(part => part === '.' || part === '..')) throw new Error('Đường dẫn kho media không hợp lệ');
    const { data: allowed, error } = await db.rpc('zalo_worker_attachment_allowed_v1', {
      p_org: job.organization_id, p_account: source.account_id, p_bucket: ref.bucket, p_path: ref.path,
    });
    if (error || allowed !== true) throw new Error('Không được truy cập media nguồn trong kho');
    const signed = await db.storage.from(ref.bucket).createSignedUrl(ref.path, 60);
    if (signed.error || !signed.data?.signedUrl) throw new Error('Không mở được media nguồn trong kho');
    url = signed.data.signedUrl;
  }
  return download(url, { storageOrigin });
}

function imageSource(bytes, label = 'anh') {
  const details = imageDetails(bytes.data);
  if (!details.width || !details.height) throw new Error('Ảnh nguồn không có kích thước hợp lệ');
  return { data: bytes.data, filename: `${label}.${details.extension}`, metadata: { totalSize: bytes.data.length, width: details.width, height: details.height } };
}
function filename(row, fallback) {
  const value = row.media_meta?.filename || row.media_label || fallback;
  const safe = String(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 180);
  return safe || fallback;
}
function caption(row) {
  const body = String(row.body || '').trim();
  return /^\[(Hình ảnh|Video|Tin nhắn thoại|Tệp tin|Tệp đính kèm)\]$/i.test(body) ? '' : body;
}

export async function sendForwardMediaJob(session, job, threadId, threadType, { db = sb, download = downloadForwardUrl } = {}) {
  const rows = await readForwardSources(job, db);
  const kind = rows[0].msg_type;
  if (kind === 'file' && /\.(jpg|jpeg|png|webp|gif)$/i.test(filename(rows[0], 'tep.bin'))) {
    throw new Error('Tệp ảnh này được gửi dạng tệp; chưa thể chuyển tiếp giữ nguyên dạng tệp. Hãy tải xuống và gửi lại bằng ứng dụng Zalo');
  }
  // The RPC snapshots the album/file caption and adds its canonical text row:
  // zca-js emits that text separately from the image receipts.
  const separateCaption = job.payload.caption_message_id ? String(job.payload.caption || '').trim() : '';
  if (job.payload.caption_message_id && !separateCaption) throw new Error('Thiếu chú thích media đã xếp hàng; chưa chuyển tiếp');
  const sources = [];
  for (const row of rows) {
    const bytes = await sourceBytes(row, job, db, download);
    if (kind === 'image') sources.push(imageSource(bytes));
    else sources.push({ data: bytes.data, filename: kind === 'video' ? 'video.mp4' : kind === 'voice' ? 'ghi-am.ogg' : filename(row, 'tep.bin'), metadata: { totalSize: bytes.data.length } });
  }
  let thumb;
  if (kind === 'video') {
    const value = rows[0].media_meta?.thumb;
    if (typeof value !== 'string' || !value) throw new Error('Video thiếu ảnh xem trước; chưa thể chuyển tiếp đúng định dạng');
    // Thumbnail is separately validated/downloaded before any provider effect.
    thumb = imageSource(await sourceBytes({ media_url: value, media_meta: null, account_id: rows[0].account_id }, job, db, download), 'anh-video');
  }
  await readForwardSources(job, db);
  let result;
  if (kind === 'voice' || kind === 'video') {
    const upload = await session.api.uploadAttachment(sources[0], threadId, threadType);
    const first = Array.isArray(upload) ? upload[0] : upload;
    if (!first?.fileUrl) throw new Error('Zalo chưa trả địa chỉ media sau khi tải lên');
    if (kind === 'voice') result = await session.api.sendVoice({ voiceUrl: first.fileUrl }, threadId, threadType);
    else {
      const thumbUpload = await session.api.uploadAttachment(thumb, threadId, threadType);
      const image = Array.isArray(thumbUpload) ? thumbUpload[0] : thumbUpload;
      const thumbnailUrl = image?.normalUrl || image?.hdUrl || image?.thumbUrl;
      if (!thumbnailUrl) throw new Error('Zalo chưa trả ảnh xem trước sau khi tải lên');
      const meta = rows[0].media_meta || {};
      result = await session.api.sendVideo({ videoUrl: first.fileUrl, thumbnailUrl, msg: caption(rows[0]),
        ...(Number(meta.duration_ms ?? meta.duration) > 0 ? { duration: Number(meta.duration_ms ?? meta.duration) } : {}),
        ...(Number(meta.width) > 0 ? { width: Number(meta.width) } : {}),
        ...(Number(meta.height) > 0 ? { height: Number(meta.height) } : {}),
      }, threadId, threadType);
    }
    await finalizeSend(job, [sendReceipt(job.message_id, result)]);
    return;
  }
  result = await session.api.sendMessage({ msg: kind === 'image' && rows.length === 1 ? caption(rows[0]) : separateCaption, attachments: sources }, threadId, threadType);
  const receipts = result?.attachment;
  if (!Array.isArray(receipts) || receipts.length !== rows.length) throw new Error('PROVIDER_RECEIPT_MISMATCH: thiếu biên nhận chuyển tiếp, cần đối soát');
  const mapped = rows.map((_, index) => sendReceipt(job.payload.message_ids[index], receipts[index]));
  if (job.payload.caption_message_id) mapped.push(sendReceipt(job.payload.caption_message_id, result.message));
  await finalizeSend(job, mapped);
}
