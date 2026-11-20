import { createHash } from 'node:crypto';
import { sb, SUPABASE_URL } from './ctx.js';
import { downloadForwardUrl, imageDetails } from './forward-media.js';

const SALE_BUCKET = 'room-sale-images';
const SEND_BUCKET = 'zalo-media';

function sourceUrl(value, base, prefix) {
  const url = new URL(value);
  const root = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== root.origin
      || !url.pathname.startsWith(prefix)) throw new Error('Ảnh phòng không thuộc kho ảnh đã cấu hình');
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!path || /[\\%\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Đường dẫn ảnh phòng không hợp lệ');
  }
  return { url, path };
}

/** All room photos, in their stored order, using the existing media queue.
 * Only call with a room from docPhongTrong(orgId), never with an arbitrary client URL.
 * Copy public R2 bytes into account-scoped zalo-media so the enqueue RPC still checks
 * the stored attachment's organization. Never treat a failed download as "no photo".
 */
export async function chuanBiAnhPhong(room, {
  accountId, orgId, db = sb, fetchImpl = fetch,
  r2Base = process.env.R2_PUBLIC_BASE || '', storageBase = SUPABASE_URL,
} = {}) {
  const photos = [];
  const occurrences = new Map();
  for (const original of (room.images || []).filter(u => typeof u === 'string' && u.trim())) {
    const photo = await chuanBiMotAnh(original, { accountId, orgId, db, fetchImpl, r2Base, storageBase });
    // The source, not its display position or temporary signing token, owns
    // the receipt. Distinct source photos may legitimately have identical bytes.
    const source = new URL(original);
    const key = createHash('sha256').update(source.origin + source.pathname).digest('hex');
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    photos.push({ ...photo, sourceKey: `${key}:${occurrence}` });
  }
  return photos;
}

// ISO BMFF boxes are length-prefixed. Read only movie metadata, never scan
// compressed video bytes for a coincidental "mvhd" or "tkhd" string.
function boxContents(bytes, type) {
  const found = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(at), header = 8;
    if (size === 1) {
      if (at + 16 > bytes.length) break;
      size = Number(bytes.readBigUInt64BE(at + 8)); header = 16;
    }
    if (size === 0) size = bytes.length - at;
    if (!Number.isSafeInteger(size) || size < header || size > bytes.length - at) break;
    if (bytes.toString('ascii', at + 4, at + 8) === type) found.push(bytes.subarray(at + header, at + size));
    at += size;
  }
  return found;
}

function mp4Info(bytes) {
  const movie = boxContents(bytes, 'moov')[0];
  const clock = movie && boxContents(movie, 'mvhd')[0];
  const extended = clock?.[0] === 1;
  if (!clock || clock.length < (extended ? 32 : 20)) throw new Error('Video phòng thiếu thời lượng');
  const scale = clock.readUInt32BE(extended ? 20 : 12);
  const ticks = extended ? Number(clock.readBigUInt64BE(24)) : clock.readUInt32BE(16);
  const duration_ms = Math.round(ticks * 1000 / scale);
  if (!Number.isSafeInteger(duration_ms) || duration_ms <= 0) throw new Error('Thời lượng video phòng không hợp lệ');
  for (const track of boxContents(movie, 'trak')) {
    const info = boxContents(track, 'tkhd')[0];
    const media = boxContents(track, 'mdia')[0];
    const handler = media && boxContents(media, 'hdlr')[0];
    if (!info || info.length < 84 || handler?.toString('ascii', 8, 12) !== 'vide') continue;
    let width = info.readUInt32BE(info.length - 8) >>> 16, height = info.readUInt32BE(info.length - 4) >>> 16;
    if (info.readInt32BE(info.length - 44) === 0 && info.readInt32BE(info.length - 40) !== 0) [width, height] = [height, width];
    if (width && height) return { extension: 'mp4', duration_ms, width, height };
  }
  throw new Error('Video phòng thiếu kích thước khung hình');
}

async function chuanBiMotAnh(original, { accountId, orgId, db, fetchImpl, r2Base, storageBase }) {
  let url; let prefix;
  const supabasePrefix = `/storage/v1/object/`;
  if (storageBase && new URL(original).origin === new URL(storageBase).origin) {
    const match = new URL(original).pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/room-sale-images\//);
    if (!match) throw new Error('Ảnh phòng không thuộc kho ảnh sale');
    const source = sourceUrl(original, storageBase, match[0]);
    const { data: allowed, error } = await db.rpc('zalo_worker_attachment_allowed_v1', {
      p_org: orgId, p_account: accountId, p_bucket: SALE_BUCKET, p_path: source.path,
    });
    if (error || allowed !== true) throw new Error('Ảnh phòng không thuộc công ty đang gửi');
    const signed = await db.storage.from(SALE_BUCKET).createSignedUrl(source.path, 60);
    if (signed.error || !signed.data?.signedUrl) throw new Error('Không mở được ảnh phòng trong kho');
    url = signed.data.signedUrl;
    prefix = `${supabasePrefix}sign/${SALE_BUCKET}/`;
    sourceUrl(url, storageBase, prefix);
  } else {
    if (!r2Base) throw new Error('Chưa cấu hình kho ảnh R2 cho worker');
    prefix = `${new URL(r2Base).pathname.replace(/\/+$/, '')}/${SALE_BUCKET}/`;
    url = sourceUrl(original, r2Base, prefix).url.toString();
  }
  const origin = new URL(url).origin;
  const video = /\.mp4$/i.test(new URL(original).pathname);
  const bytes = await downloadForwardUrl(url, {
    ...(video ? { maxBytes: 32 * 1024 * 1024 } : {}),
    storageOrigin: origin,
    // Tighten the shared bounded downloader: every redirect stays in this sale
    // bucket on this host, even if the shared downloader permits Zalo CDNs.
    fetchImpl: (target, options) => {
      sourceUrl(target, origin, prefix);
      return fetchImpl(target, options);
    },
  });
  let info;
  if (video) {
    if (bytes.data.length < 16 || bytes.data.toString('ascii', 4, 8) !== 'ftyp'
        || !['isom','iso2','mp41','mp42','avc1','M4V ','dash'].some(brand =>
          bytes.data.subarray(8, Math.min(bytes.data.readUInt32BE(0), 128)).includes(brand))) {
      throw new Error('Video phòng không phải MP4 hợp lệ');
    }
    info = mp4Info(bytes.data);
  } else {
    info = imageDetails(bytes.data);
    if (!info.width || !info.height) throw new Error('Ảnh phòng không có kích thước hợp lệ');
  }
  const filename = `phong-${createHash('sha256').update(bytes.data).digest('hex')}.${info.extension}`;
  const path = `${accountId}/automation/${filename}`;
  const mime = video ? 'video/mp4' : info.extension === 'jpg' ? 'image/jpeg' : `image/${info.extension}`;
  const { error } = await db.storage.from(SEND_BUCKET).upload(path, bytes.data, { contentType: mime, upsert: true });
  if (error) throw new Error('Không lưu được ảnh phòng để gửi Zalo');
  const { data } = db.storage.from(SEND_BUCKET).getPublicUrl(path);
  return { bucket: SEND_BUCKET, path, filename, url: data.publicUrl,
    width: info.width, height: info.height, ...(video ? { duration_ms: info.duration_ms } : {}), size: bytes.data.length, mime };
}
