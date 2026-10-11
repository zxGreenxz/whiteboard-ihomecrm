import { sb, SUPABASE_URL } from './ctx.js';
import { readForwardSources } from './forward-source.js';
import { finalizeSend, sendReceipt } from './send-finalization.js';

export const MAX_FORWARD_BYTES = 25 * 1024 * 1024;
const CDN = /(^|\.)(zdn\.vn|zadn\.vn|dlmd\.me|mdchat\.me|dlfl\.vn)$/i;
const BUCKETS = new Set(['zalo-media', 'room-sale-images']);
const DEADLINE_MS = 30_000;

function allowedUrl(value, storageOrigin) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Đường dẫn media không hợp lệ'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || (!CDN.test(url.hostname) && url.origin !== storageOrigin)) {
    throw new Error('Máy chủ media không được phép chuyển tiếp');
  }
  return url;
}

// No cookies or credentials are sent to CDN hosts. Each redirect is checked,
// and both the advertised size and streamed bytes have a hard bound.
export async function downloadForwardUrl(value, { fetchImpl = fetch, storageOrigin, maxBytes = MAX_FORWARD_BYTES, timeoutMs = DEADLINE_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = allowedUrl(value, storageOrigin);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const res = await fetchImpl(url.toString(), { redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const next = res.headers.get('location');
        if (!next || redirects === 3) throw new Error('Media chuyển hướng quá nhiều lần');
        url = allowedUrl(new URL(next, url).toString(), storageOrigin);
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`Không tải được media nguồn (${res.status}); tệp có thể đã hết hạn trên Zalo`); }
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (['text/html', 'application/xhtml+xml'].includes(mime)) { await res.body?.cancel(); throw new Error('Máy chủ trả trang lỗi thay cho media'); }
      if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel(); throw new Error('Media vượt giới hạn 25MB'); }
      if (!res.body) throw new Error('Media nguồn rỗng');
      const reader = res.body.getReader();
      const parts = []; let length = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          length += chunk.byteLength;
          if (length > maxBytes) { await reader.cancel(); throw new Error('Media vượt giới hạn 25MB'); }
          parts.push(Buffer.from(chunk));
        }
      } finally { reader.releaseLock(); }
      if (!length) throw new Error('Media nguồn rỗng');
      return { data: Buffer.concat(parts, length), mime };
    }
    throw new Error('Không tải được media');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Tải media quá lâu; chưa chuyển tiếp');
    throw error;
  } finally { clearTimeout(timer); }
}

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

// Read dimensions from the actual bytes. Never let an arbitrary filename turn
// an image into a file in zca-js (its upload classification uses the extension).
export function imageDetails(data) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    return { extension: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { extension: 'webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && data.subarray(23,26).equals(Buffer.from([157,1,42]))) return { extension: 'webp', width: data.readUInt16LE(26) & 16383, height: data.readUInt16LE(28) & 16383 };
    if (kind === 'VP8L' && data[20] === 47) {
      const packed = data.readUInt32LE(21);
      return { extension: 'webp', width: (packed & 16383) + 1, height: ((packed >>> 14) & 16383) + 1 };
    }
  }
  if (data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 255) break;
      const marker = data[offset + 1]; offset += 2;
      if (marker === 216 || marker === 1) continue;
      if (marker === 217 || marker === 218) break;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7) {
        return { extension: 'jpg', width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      }
      offset += size;
    }
  }
  throw new Error('Ảnh nguồn không có định dạng JPEG, PNG hoặc WebP hợp lệ');
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
