// Rào chữ công khai (chủ chốt 18/10/2026). Broker tự ép, không dựa vào chỉ dẫn cho mô hình: MỌI lời gọi
// ghi chữ tự do mới (chuỗi không rỗng) ra bề mặt công khai đều không ghi ngay mà trả confirmation_required
// kèm bản xem trước nguyên văn và confirmToken, bất kể kết nối trước đó đã đọc gì. Chỉ lần gọi lại kèm
// đúng token (một lần, 10 phút, cùng kết nối, cùng tool, cùng đối tượng, cùng nội dung chuẩn hoá) mới
// ghi. Không có chữ mới (vắng/trống = giữ, null = xoá; chỉ đổi giá/ngày/cờ) thì ghi thẳng như cũ.
//
// Khoá token = id kết nối broker (identity.row.id): HTTP MCP không có phiên (mcp-http.mjs), id kết nối
// là khoá hẹp nhất có sẵn và giữ nguyên qua xoay token. Token chờ nằm trong bộ nhớ tiến trình; khởi
// động lại broker chỉ làm mất token chờ (phải xin xác nhận lại), không mở đường ghi thẳng.
import { createHash, randomBytes } from 'node:crypto';

export const CONFIRM_TTL_MS = 10 * 60_000;
// Tool ghi có trường chữ tự do hiện ra bề mặt công khai. crm_room_pass_upsert: tên/SĐT liên hệ và
// chính sách sale in trên trang Sale phòng công khai; rào theo trường, không theo cờ active/contactManager.
export const PUBLIC_TEXT_TOOLS = Object.freeze({
  crm_room_pass_upsert: Object.freeze({ object: 'roomId', fields: Object.freeze(['customerName', 'customerPhone', 'salePolicy']) }),
});
const TOKEN = /^cf_[A-Za-z0-9_-]{43}$/;
const MAX_PENDING = 1024;
const GUIDANCE = 'CHƯA ghi. Chữ trong preview sẽ lên trang công khai nên cần người dùng duyệt: ' +
  'cho người dùng xem nguyên văn preview; chỉ khi họ đồng ý rõ ràng mới gọi lại đúng lệnh này (giữ requestId) kèm confirmToken. ' +
  'Token dùng một lần, hết hạn sau 10 phút, chỉ khớp đúng nội dung này; đổi nội dung thì xin duyệt lại. ' +
  'Lỗi confirmation_invalid: gọi lại không kèm confirmToken để lấy bản xem trước mới.';

// Tách confirmToken khỏi đối số TRƯỚC validator của tool: SQL không nhận khoá lạ. Giữ nguyên descriptor
// của mọi khoá còn lại (accessor vẫn tới validator và bị từ chối ở đó). null/chuỗi trống = không gửi.
export function splitConfirmToken(name, args) {
  if (!Object.hasOwn(PUBLIC_TEXT_TOOLS, name) || args === null || typeof args !== 'object') return { args, confirmToken: undefined, invalid: false };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(args);
    if (!Object.hasOwn(descriptors, 'confirmToken')) return { args, confirmToken: undefined, invalid: false };
    const supplied = descriptors.confirmToken;
    delete descriptors.confirmToken;
    const rest = Object.defineProperties(Object.create(Object.getPrototypeOf(args)), descriptors);
    if (!supplied.enumerable || !Object.hasOwn(supplied, 'value')) return { args: rest, confirmToken: undefined, invalid: true };
    const value = typeof supplied.value === 'string' ? supplied.value.trim() : supplied.value;
    if (value === null || value === '') return { args: rest, confirmToken: undefined, invalid: false };
    return typeof value === 'string' && TOKEN.test(value) ? { args: rest, confirmToken: value, invalid: false } : { args: rest, confirmToken: undefined, invalid: true };
  } catch { return { args, confirmToken: undefined, invalid: true }; }
}

export function createPublicTextGuard({ clock }) {
  if (typeof clock !== 'function') throw new TypeError('invalid_public_text_clock');
  const pending = new Map();
  const digest = value => createHash('sha256').update(value).digest('hex');
  // Đồng hồ lùi: token coi là hết hạn.
  const live = (entry, now) => now >= entry.issuedAt && now - entry.issuedAt < CONFIRM_TTL_MS;
  const binding = (connectionId, name, spec, input) => digest(JSON.stringify([connectionId, name, input[spec.object],
    spec.fields.map(field => Object.hasOwn(input, field) ? [input[field]] : [])]));
  return Object.freeze({
    // input = đầu vào ĐÃ chuẩn hoá của tool. Trả { allow } | { confirmation } | { refused }.
    review(connectionId, name, input, confirmToken) {
      const spec = Object.hasOwn(PUBLIC_TEXT_TOOLS, name) ? PUBLIC_TEXT_TOOLS[name] : null;
      if (spec === null) return { allow: true };
      // null = xoá, vắng = giữ: không có chữ mới nào ra công khai.
      const text = spec.fields.filter(field => typeof input[field] === 'string' && input[field] !== '');
      if (!text.length) return { allow: true };
      const now = clock(), bound = binding(connectionId, name, spec, input);
      if (confirmToken !== undefined) {
        // Trình ra là dùng: khớp hay không token cũng không còn.
        const key = digest(confirmToken), entry = pending.get(key);
        pending.delete(key);
        return entry && entry.binding === bound && live(entry, now) ? { allow: true } : { refused: true };
      }
      for (const [key, entry] of pending) if (!live(entry, now)) pending.delete(key);
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      const token = `cf_${randomBytes(32).toString('base64url')}`;
      pending.set(digest(token), { binding: bound, issuedAt: now });
      return { confirmation: { outcome: 'confirmation_required', applied: false, tool: name, [spec.object]: input[spec.object],
        preview: Object.fromEntries(text.map(field => [field, input[field]])), confirmToken: token,
        expiresAt: new Date(now + CONFIRM_TTL_MS).toISOString(), huongDan: GUIDANCE } };
    },
  });
}
