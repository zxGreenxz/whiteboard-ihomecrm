// Rào xác nhận hai lượt dùng chung (Đợt 1 nền chung thao tác ghi, 21/10/2026;
// docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 3). Tách từ rào chữ công khai của crm_room_pass_upsert
// (public-text-guard.mjs, chủ chốt 18/10): lượt 1 không ghi mà cấp confirmToken; chỉ lượt gọi lại kèm đúng
// token mới ghi. Token dùng một lần (trình ra là mất, khớp hay không), sống 10 phút, gắn một khoá binding mà
// người gọi dựng từ những gì đã cho người dùng xem (kết nối + tool/thao tác + nội dung chuẩn hoá). Bản ghi chờ
// giữ được payload riêng của người gọi (vd đầu vào đã giải tên, dấu trạng thái): mô hình không gửi lại nó nên
// không giả được. Token chờ nằm trong bộ nhớ tiến trình; khởi động lại broker chỉ làm mất token chờ (phải xin
// xác nhận lại), không mở đường ghi thẳng.
import { createHash, randomBytes } from 'node:crypto';

export const CONFIRM_TTL_MS = 10 * 60_000;
export const CONFIRM_MAX_PENDING = 1024;
export const CONFIRM_TOKEN = /^cf_[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
/** Khoá binding: sha256 của JSON các phần (thứ tự do người gọi cố định). */
export const confirmBinding = parts => digest(JSON.stringify(parts));

// Tách confirmToken khỏi đối số TRƯỚC validator: SQL không nhận khoá lạ. Giữ nguyên descriptor của mọi khoá
// còn lại (accessor vẫn tới validator và bị từ chối ở đó). null/chuỗi trống = không gửi.
export function splitConfirmField(args) {
  if (args === null || typeof args !== 'object') return { args, confirmToken: undefined, invalid: false };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(args);
    if (!Object.hasOwn(descriptors, 'confirmToken')) return { args, confirmToken: undefined, invalid: false };
    const supplied = descriptors.confirmToken;
    delete descriptors.confirmToken;
    const rest = Object.defineProperties(Object.create(Object.getPrototypeOf(args)), descriptors);
    if (!supplied.enumerable || !Object.hasOwn(supplied, 'value')) return { args: rest, confirmToken: undefined, invalid: true };
    const value = typeof supplied.value === 'string' ? supplied.value.trim() : supplied.value;
    if (value === null || value === '') return { args: rest, confirmToken: undefined, invalid: false };
    return typeof value === 'string' && CONFIRM_TOKEN.test(value) ? { args: rest, confirmToken: value, invalid: false } : { args: rest, confirmToken: undefined, invalid: true };
  } catch { return { args, confirmToken: undefined, invalid: true }; }
}

/** Sổ token chờ. `now` do người gọi đưa (một lần đọc đồng hồ cho cả lượt); vắng thì đọc clock(). */
export function createConfirmStore({ clock, ttlMs = CONFIRM_TTL_MS, maxPending = CONFIRM_MAX_PENDING } = {}) {
  if (typeof clock !== 'function') throw new TypeError('invalid_confirm_clock');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > CONFIRM_TTL_MS || !Number.isSafeInteger(maxPending) || maxPending < 1 ||
      maxPending > CONFIRM_MAX_PENDING) throw new TypeError('invalid_confirm_limits');
  const pending = new Map();
  // Đồng hồ lùi: token coi là hết hạn.
  const live = (entry, now) => now >= entry.issuedAt && now - entry.issuedAt < ttlMs;
  const instant = now => now === undefined ? clock() : now;
  return Object.freeze({
    ttlMs,
    issue(binding, payload = null, now) {
      if (typeof binding !== 'string' || !/^[0-9a-f]{64}$/.test(binding)) throw new TypeError('invalid_confirm_binding');
      const at = instant(now);
      for (const [key, entry] of pending) if (!live(entry, at)) pending.delete(key);
      if (pending.size >= maxPending) pending.delete(pending.keys().next().value);
      const token = `cf_${randomBytes(32).toString('base64url')}`;
      pending.set(digest(token), { binding, payload, issuedAt: at });
      return { token, issuedAt: at, expiresAt: new Date(at + ttlMs).toISOString() };
    },
    // Trình ra là dùng: khớp hay không token cũng không còn.
    redeem(token, binding, now) {
      const at = instant(now);
      if (typeof token !== 'string' || !CONFIRM_TOKEN.test(token)) return { ok: false };
      const key = digest(token), entry = pending.get(key);
      pending.delete(key);
      return entry && entry.binding === binding && live(entry, at) ? { ok: true, payload: entry.payload, issuedAt: entry.issuedAt } : { ok: false };
    },
    get size() { return pending.size; },
  });
}
