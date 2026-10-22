// Dependency-free Zalo media bytes. The native bridge CI mounts worker/lib
// without node_modules, so nothing here may import a package or ctx.js.
// CRM forwarding (forward-media.js) reuses the same CDN allowlist, bounded
// downloader and magic-byte reader.
import { createHash } from 'node:crypto';

export const MAX_FORWARD_BYTES = 25 * 1024 * 1024;
const CDN = /(^|\.)(zdn\.vn|zadn\.vn|dlmd\.me|mdchat\.me|dlfl\.vn)$/i;
const DEADLINE_MS = 30_000;
// `code` lets the native bridge report a closed reason set; CRM callers keep
// using the Vietnamese message.
const coded = (message, code) => Object.assign(new Error(message), { code });

export function allowedMediaUrl(value, storageOrigin) {
  let url;
  try { url = new URL(value); } catch { throw coded('Đường dẫn media không hợp lệ', 'not_allowed'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || (!CDN.test(url.hostname) && url.origin !== storageOrigin)) {
    throw coded('Máy chủ media không được phép chuyển tiếp', 'not_allowed');
  }
  return url;
}

// No cookies or credentials are sent to CDN hosts. Each redirect is checked,
// and both the advertised size and streamed bytes have a hard bound.
export async function downloadForwardUrl(value, { fetchImpl = fetch, storageOrigin, maxBytes = MAX_FORWARD_BYTES, timeoutMs = DEADLINE_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = allowedMediaUrl(value, storageOrigin);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const res = await fetchImpl(url.toString(), { redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const next = res.headers.get('location');
        if (!next || redirects === 3) throw coded('Media chuyển hướng quá nhiều lần', 'download_failed');
        url = allowedMediaUrl(new URL(next, url).toString(), storageOrigin);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw coded(`Không tải được media nguồn (${res.status}); tệp có thể đã hết hạn trên Zalo`,
          [403, 404, 410].includes(res.status) ? 'expired' : 'download_failed');
      }
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (['text/html', 'application/xhtml+xml'].includes(mime)) { await res.body?.cancel(); throw coded('Máy chủ trả trang lỗi thay cho media', 'download_failed'); }
      if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel(); throw coded('Media vượt giới hạn 25MB', 'too_large'); }
      if (!res.body) throw coded('Media nguồn rỗng', 'download_failed');
      const reader = res.body.getReader();
      const parts = []; let length = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          length += chunk.byteLength;
          if (length > maxBytes) { await reader.cancel(); throw coded('Media vượt giới hạn 25MB', 'too_large'); }
          parts.push(Buffer.from(chunk));
        }
      } finally { reader.releaseLock(); }
      if (!length) throw coded('Media nguồn rỗng', 'download_failed');
      return { data: Buffer.concat(parts, length), mime };
    }
    throw coded('Không tải được media', 'download_failed');
  } catch (error) {
    if (controller.signal.aborted) throw coded('Tải media quá lâu; chưa chuyển tiếp', 'download_failed');
    throw error;
  } finally { clearTimeout(timer); }
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
  throw coded('Ảnh nguồn không có định dạng JPEG, PNG hoặc WebP hợp lệ', 'not_image');
}

// ── Metadata removal without decoding pixels ──
// EXIF/GPS, XMP, IPTC, comments, thumbnails and trailing data are dropped. A
// non-default EXIF Orientation is the only value carried over, in a minimal
// IFD0 of its own, so a phone photo still displays upright.
const ORIENTATION = 0x0112;
const fail = () => { throw coded('Ảnh nguồn không có cấu trúc hợp lệ', 'not_image'); };
const starts = (data, text) => data.length >= text.length && data.toString('latin1', 0, text.length) === text;

export function exifOrientation(tiff) {
  try {
    const order = tiff.toString('latin1', 0, 2);
    const le = order === 'II';
    if (tiff.length < 8 || (!le && order !== 'MM')) return 1;
    const u16 = at => le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
    const u32 = at => le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
    const ifd = u32(4);
    if (u16(2) !== 42 || ifd < 8 || ifd + 2 > tiff.length) return 1;
    for (let i = 0, count = u16(ifd); i < count && ifd + 14 + i * 12 <= tiff.length; i++) {
      const at = ifd + 2 + i * 12;
      if (u16(at) === ORIENTATION && u16(at + 2) === 3) {
        const value = u16(at + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch { /* malformed EXIF carries no orientation */ }
  return 1;
}

function orientationTiff(value) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry, then no next IFD (bytes 22..25 stay zero)
  tiff.writeUInt16BE(ORIENTATION, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(value, 18);
  return tiff;
}

function keepJpegSegment(marker, body) {
  if (marker === 0xe0) return starts(body, 'JFIF\0');
  if (marker === 0xe2) return starts(body, 'ICC_PROFILE\0');
  if (marker === 0xee) return starts(body, 'Adobe');
  return !(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe;
}

function stripJpeg(data) {
  const kept = [];
  let offset = 2, orientation = 0, scan = false;
  for (;;) {
    if (scan) {
      // Entropy-coded data ends at the first marker that is not byte stuffing
      // (FF00), a restart marker (FFD0-FFD7) or fill (FFFF).
      let i = offset;
      while (i + 1 < data.length && !(data[i] === 0xff && data[i + 1] !== 0 && data[i + 1] !== 0xff &&
        !(data[i + 1] >= 0xd0 && data[i + 1] <= 0xd7))) i++;
      if (i + 1 >= data.length) { kept.push(data.subarray(offset), Buffer.from([0xff, 0xd9])); break; }
      kept.push(data.subarray(offset, i)); offset = i; scan = false;
    }
    if (offset + 2 > data.length || data[offset] !== 0xff) fail();
    const marker = data[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd9) { kept.push(data.subarray(offset, offset + 2)); break; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) fail();
    if (offset + 4 > data.length) fail();
    const end = offset + 2 + data.readUInt16BE(offset + 2);
    if (end < offset + 4 || end > data.length) fail();
    const body = data.subarray(offset + 4, end);
    if (marker === 0xe1 && starts(body, 'Exif\0\0')) { if (!orientation) orientation = exifOrientation(body.subarray(6)); }
    else if (keepJpegSegment(marker, body)) kept.push(data.subarray(offset, end));
    offset = end;
    if (marker === 0xda) scan = true;
  }
  if (orientation > 1) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), orientationTiff(orientation)]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]); header.writeUInt16BE(payload.length + 2, 2);
    // After JFIF APP0 when present, as Exif readers expect.
    const at = kept.length && kept[0][1] === 0xe0 ? 1 : 0;
    kept.splice(at, 0, header, payload);
  }
  return Buffer.concat([data.subarray(0, 2), ...kept]);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = data => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT',
  'bKGD', 'pHYs', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT']);

function stripPng(data) {
  const kept = [];
  let offset = 8, orientation = 0, ended = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset), type = data.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > data.length || !/^[A-Za-z]{4}$/.test(type)) fail();
    if (type === 'eXIf') { if (!orientation) orientation = exifOrientation(data.subarray(offset + 8, offset + 8 + length)); }
    // Critical chunks (upper-case first letter) are never dropped.
    else if (PNG_KEEP.has(type) || type.charCodeAt(0) < 0x61) kept.push(data.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !kept.length || kept[0].toString('latin1', 4, 8) !== 'IHDR') fail();
  if (orientation > 1) {
    const body = Buffer.concat([Buffer.from('eXIf', 'latin1'), orientationTiff(orientation)]);
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(body.length - 4, 0); body.copy(chunk, 4); chunk.writeUInt32BE(crc32(body), body.length + 4);
    kept.splice(1, 0, chunk);
  }
  return Buffer.concat([data.subarray(0, 8), ...kept]);
}

const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function riffChunk(fourcc, payload) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length & 1));
  chunk.write(fourcc, 0, 'latin1'); chunk.writeUInt32LE(payload.length, 4); payload.copy(chunk, 8);
  return chunk;
}

function stripWebp(data) {
  const end = 8 + data.readUInt32LE(4);
  if (end > data.length || end < 20) fail();
  const kept = [];
  let offset = 12, orientation = 0;
  while (offset + 8 <= end) {
    const fourcc = data.toString('latin1', offset, offset + 4), size = data.readUInt32LE(offset + 4);
    if (offset + 8 + size > end) fail();
    const payload = data.subarray(offset + 8, offset + 8 + size);
    if (fourcc === 'EXIF') { if (!orientation) orientation = exifOrientation(starts(payload, 'Exif\0\0') ? payload.subarray(6) : payload); }
    else if (WEBP_KEEP.has(fourcc)) kept.push(riffChunk(fourcc, payload));
    offset += 8 + size + (size & 1);
  }
  if (!kept.length) fail();
  if (kept[0].toString('latin1', 0, 4) === 'VP8X') {
    // Clear EXIF (0x08) and XMP (0x04) flags; set EXIF again only for the
    // carried orientation. Simple-format WebP cannot hold EXIF at all.
    kept[0][8] &= ~0x0c;
    if (orientation > 1) { kept[0][8] |= 0x08; kept.push(riffChunk('EXIF', orientationTiff(orientation))); }
  }
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/** Copies the container without its metadata blocks; pixels are never decoded.
 * The result must keep the same format and dimensions, otherwise not_image. */
export function stripImageMetadata(data) {
  const before = imageDetails(data);
  let stripped;
  try {
    stripped = before.extension === 'jpg' ? stripJpeg(data) : before.extension === 'png' ? stripPng(data) : stripWebp(data);
  } catch (error) { if (error.code === 'not_image') throw error; fail(); }
  const after = imageDetails(stripped);
  if (after.extension !== before.extension || after.width !== before.width || after.height !== before.height) fail();
  return stripped;
}

// ── Native bridge photo pipeline ──
export const NATIVE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const NATIVE_PHOTO_ERRORS = Object.freeze(['too_large', 'not_image', 'bad_dimensions', 'expired', 'download_failed', 'busy']);
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
// The model side decodes the image: a 144 MP photo would inflate its RAM, so the
// total pixel count is capped as well as each side.
const MIN_SIDE = 32, MAX_SIDE = 12000, MAX_PIXELS = 40_000_000;

/** First allowed Zalo CDN URL → bounded bytes → format/size check → metadata
 * removed → sha256. Bytes stay in the caller's memory only. */
export async function loadNativePhoto(urls, { fetchImpl = fetch, maxBytes = NATIVE_PHOTO_MAX_BYTES, timeoutMs = DEADLINE_MS } = {}) {
  const url = urls.find(value => { try { allowedMediaUrl(value); return true; } catch { return false; } });
  if (!url) throw coded('Ảnh không có đường dẫn Zalo hợp lệ', 'download_failed');
  let data;
  try { ({ data } = await downloadForwardUrl(url, { fetchImpl, maxBytes, timeoutMs })); }
  catch (error) { throw NATIVE_PHOTO_ERRORS.includes(error?.code) ? error : coded('Không tải được ảnh', 'download_failed'); }
  const { extension, width, height } = imageDetails(data);
  if (![width, height].every(side => side >= MIN_SIDE && side <= MAX_SIDE) || width * height > MAX_PIXELS) {
    throw coded('Kích thước ảnh không hợp lệ', 'bad_dimensions');
  }
  const bytes = stripImageMetadata(data);
  return { bytes, mime: MIME[extension], width, height, sha256: createHash('sha256').update(bytes).digest('hex') };
}
