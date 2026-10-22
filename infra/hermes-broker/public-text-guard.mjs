// Rào chữ công khai (chủ chốt 18/10/2026). Broker tự ép, không dựa vào chỉ dẫn cho mô hình: MỌI lời gọi
// ghi chữ tự do mới (chuỗi không rỗng) ra bề mặt công khai đều không ghi ngay mà trả confirmation_required
// kèm bản xem trước nguyên văn và confirmToken, bất kể kết nối trước đó đã đọc gì. Chỉ lần gọi lại kèm
// đúng token (một lần, 10 phút, cùng kết nối, cùng tool, cùng đối tượng, cùng nội dung chuẩn hoá) mới
// ghi. Không có chữ mới (vắng/trống = giữ, null = xoá; chỉ đổi giá/ngày/cờ) thì ghi thẳng như cũ.
//
// Khoá token = id kết nối broker (identity.row.id): HTTP MCP không có phiên (mcp-http.mjs), id kết nối
// là khoá hẹp nhất có sẵn và giữ nguyên qua xoay token. Token chờ nằm trong bộ nhớ tiến trình; khởi
// động lại broker chỉ làm mất token chờ (phải xin xác nhận lại), không mở đường ghi thẳng.
// Đợt 1 nền chung (21/10): phần token (cấp, dùng một lần, TTL, trần token chờ, tách confirmToken) nằm ở
// confirm-guard.mjs, dùng chung với thao tác ghi; file này chỉ còn chính sách "chữ nào ra công khai".
import { CONFIRM_TTL_MS, confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';

export { CONFIRM_TTL_MS };
// Tool ghi có trường chữ tự do hiện ra bề mặt công khai. crm_room_pass_upsert: tên/SĐT liên hệ và
// chính sách sale in trên trang Sale phòng công khai; rào theo trường, không theo cờ active/contactManager.
export const PUBLIC_TEXT_TOOLS = Object.freeze({
  crm_room_pass_upsert: Object.freeze({ object: 'roomId', fields: Object.freeze(['customerName', 'customerPhone', 'salePolicy']) }),
  crm_sale_room_patch: Object.freeze({ object: 'roomId', fields: Object.freeze(['room_type', 'amenities', 'sale_note', 'description']), bindAllFields: true }),
  crm_sale_bulk_patch: Object.freeze({ object: 'requestId', array: 'items', fields: Object.freeze(['room_type', 'amenities', 'sale_note', 'description']), bindAllFields: true }),
  crm_sale_policy_save: Object.freeze({ object: 'roomId', fields: Object.freeze(['title', 'content']), bindAllFields: true }),
});
const GUIDANCE = 'CHƯA ghi. Chữ trong preview sẽ lên trang công khai nên cần người dùng duyệt: ' +
  'cho người dùng xem nguyên văn preview; chỉ khi họ đồng ý rõ ràng mới gọi lại đúng lệnh này (giữ requestId) kèm confirmToken. ' +
  'Token dùng một lần, hết hạn sau 10 phút, chỉ khớp đúng nội dung này; đổi nội dung thì xin duyệt lại. ' +
  'Lỗi confirmation_invalid: gọi lại không kèm confirmToken để lấy bản xem trước mới.';

// Chỉ tool có trong danh sách mới tách confirmToken; tool khác giữ nguyên đối số để validator từ chối như cũ.
export function splitConfirmToken(name, args) {
  if (!Object.hasOwn(PUBLIC_TEXT_TOOLS, name)) return { args, confirmToken: undefined, invalid: false };
  return splitConfirmField(args);
}

export function createPublicTextGuard({ clock }) {
  if (typeof clock !== 'function') throw new TypeError('invalid_public_text_clock');
  const store = createConfirmStore({ clock });
  const binding = (connectionId, name, spec, input) => confirmBinding([connectionId, name, input[spec.object],
    spec.bindAllFields ? Object.keys(input).sort().map(field => [field, input[field]]) :
      spec.fields.map(field => Object.hasOwn(input, field) ? [input[field]] : [])]);
  return Object.freeze({
    // input = đầu vào ĐÃ chuẩn hoá của tool. Trả { allow } | { confirmation } | { refused }.
    review(connectionId, name, input, confirmToken) {
      const spec = Object.hasOwn(PUBLIC_TEXT_TOOLS, name) ? PUBLIC_TEXT_TOOLS[name] : null;
      if (spec === null) return { allow: true };
      // null = xoá, vắng = giữ: không có chữ mới nào ra công khai.
      const publicFields = value => spec.fields.filter(field => typeof value[field] === 'string' && value[field] !== '' ||
        Array.isArray(value[field]) && value[field].some(item => typeof item === 'string' && item !== ''));
      const rows = spec.array ? input[spec.array].map(item => ({ roomId: item.roomId,
        ...Object.fromEntries(publicFields(item).map(field => [field, item[field]])) })).filter(item => Object.keys(item).length > 1) : null;
      const text = spec.array ? [] : publicFields(input);
      if (!(rows ? rows.length : text.length)) return { allow: true };
      const now = clock(), bound = binding(connectionId, name, spec, input);
      if (confirmToken !== undefined) return store.redeem(confirmToken, bound, now).ok ? { allow: true } : { refused: true };
      const issued = store.issue(bound, null, now);
      return { confirmation: { outcome: 'confirmation_required', applied: false, tool: name, [spec.object]: input[spec.object],
        preview: rows ? { items: rows } : Object.fromEntries(text.map(field => [field, input[field]])), confirmToken: issued.token,
        expiresAt: issued.expiresAt, huongDan: GUIDANCE } };
    },
  });
}
