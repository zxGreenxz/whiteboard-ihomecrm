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
  const bytes = await downloadForwardUrl(url, {
    storageOrigin: origin,
    // Tighten the shared bounded downloader: every redirect stays in this sale
    // bucket on this host, even if the shared downloader permits Zalo CDNs.
    fetchImpl: (target, options) => {
      sourceUrl(target, origin, prefix);
      return fetchImpl(target, options);
    },
  });
  const info = imageDetails(bytes.data);
  if (!info.width || !info.height) throw new Error('Ảnh phòng không có kích thước hợp lệ');
  const filename = `phong-${createHash('sha256').update(bytes.data).digest('hex')}.${info.extension}`;
  const path = `${accountId}/automation/${filename}`;
  const mime = info.extension === 'jpg' ? 'image/jpeg' : `image/${info.extension}`;
  const { error } = await db.storage.from(SEND_BUCKET).upload(path, bytes.data, { contentType: mime, upsert: true });
  if (error) throw new Error('Không lưu được ảnh phòng để gửi Zalo');
  const { data } = db.storage.from(SEND_BUCKET).getPublicUrl(path);
  return { bucket: SEND_BUCKET, path, filename, url: data.publicUrl,
    width: info.width, height: info.height, size: bytes.data.length, mime };
}
