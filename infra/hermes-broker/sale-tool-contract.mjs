// One public Sale tool keeps the fixed MCP catalogue bounded. Operation schemas
// are discovered on demand; each operation still uses its existing validator,
// authorization, canonical RPC, request receipt and uncertainty handling.
import { SALE_ACTION_TOOLS } from './sale-action-contract.mjs';
import { SALE_POLICY_TOOLS } from './sale-policy-contract.mjs';
import { SALE_BULK_TOOLS } from './sale-bulk-contract.mjs';
import { ACTION_REJECT_REASONS } from './action-reasons.mjs';

export const SALE_TOOL = Object.freeze({
  name: 'crm_sale_action',
  description: 'Sale phòng: sửa thông tin, ảnh, chính sách (room sale). Không cọc, không giữ phòng. operation=list lấy thao tác và khuôn input được cấp; sau đó dùng đúng operation/input. requestId lấy từ crm_new_request_id, giữ nguyên khi thử lại/tra trạng thái. confirmation_required: chỉ gửi lại input kèm confirmToken khi người dùng đồng ý preview. unknown: tra thao tác status tương ứng, không tạo mã mới.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { type: 'string', maxLength: 40 }, input: { type: 'object' },
  } },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
});
// 05/11/2026: cọc có tiền / sửa cọc làm trên web (trang Quản lý cọc) và giữ / bỏ giữ phòng đi crm_action_run contract.room_lock /
// contract.room_unlock (SOUL + skill ihome-crm-phong-sale-nhom). Trước đây chỉ lời dặn của skill chặn: reservation_update / _assign
// (khoá deposits.edit đang bật) và room_lock / room_release vẫn hiện trong operation=list, reservation_create / _topup chỉ ẩn nhờ khoá
// riêng báo cọc đang TẮT (sale-action-contract.mjs). Từ nay sáu thao tác này rời cầu crm_sale_action bất kể khoá nào bật: không
// quảng bá, gọi thẳng ⇒ action_rejected với lý do của khối sale (action-reasons.mjs), không tới validator, dịch vụ hay RPC. Định nghĩa
// nội bộ và validator (sale-action-contract.mjs) giữ nguyên: SQL hermes_sale_actions_v1 không đổi, operation=action_status vẫn đối
// soát biên nhận cũ.
export const SALE_RETIRED_OPERATIONS = Object.freeze({
  room_lock: 'sale_lock_via_contract', room_release: 'sale_lock_via_contract',
  reservation_create: 'sale_deposit_web_only', reservation_update: 'sale_deposit_web_only',
  reservation_topup: 'sale_deposit_web_only', reservation_assign: 'sale_deposit_web_only',
});
const tools = [...SALE_ACTION_TOOLS, ...SALE_POLICY_TOOLS, ...SALE_BULK_TOOLS];
export const saleToolOperation = tool => tool.name.slice('crm_sale_'.length);
// Bảng gõ sai (operation không có, lý do ngoài danh sách đóng) thì connector không khởi động, không lặng lẽ để lọt hay ra crm_refused.
for (const [operation, reason] of Object.entries(SALE_RETIRED_OPERATIONS)) {
  if (!tools.some(tool => saleToolOperation(tool) === operation) || !ACTION_REJECT_REASONS.includes(reason)) {
    throw new TypeError('invalid_sale_retired_operation');
  }
}
const operations = new Map(tools.filter(tool => !Object.hasOwn(SALE_RETIRED_OPERATIONS, saleToolOperation(tool)))
  .map(tool => [saleToolOperation(tool), tool]));
export const saleToolDefinition = operation => typeof operation === 'string' ? operations.get(operation) : undefined;
/** Lý do (dạng rejected, action-reasons.mjs) của thao tác đã rời crm_sale_action; undefined với mọi operation khác. */
export const saleToolRetired = operation => typeof operation === 'string' && Object.hasOwn(SALE_RETIRED_OPERATIONS, operation)
  ? SALE_RETIRED_OPERATIONS[operation] : undefined;
/** Tool nội bộ mà crm_sale_action quảng bá và chuyển được (không thuộc SALE_RETIRED_OPERATIONS). */
export const saleToolPublic = tool => operations.get(saleToolOperation(tool)) === tool;
export const isInternalSaleTool = name => tools.some(tool => tool.name === name);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
// Thao tác đã rời cầu vẫn qua đúng vỏ ngoài chặt (broker trả lỗi rõ thay vì invalid_request); input của nó không bao giờ được đọc.
export function saleToolInput(value) {
  if (!record(value) || Object.keys(value).some(key => !['operation', 'input'].includes(key)) ||
      !(value.operation === 'list' || saleToolDefinition(value.operation) || saleToolRetired(value.operation)) ||
      (Object.hasOwn(value, 'input') && !record(value.input))) throw new TypeError('invalid_sale_tool');
  const input = value.input ?? {};
  if (value.operation === 'list' && Object.keys(input).length) throw new TypeError('invalid_sale_tool');
  return { operation: value.operation, input };
}
const bridgeNames = text => tools.reduce((result, tool) => result.replaceAll(tool.name,
  `${SALE_TOOL.name} operation=${saleToolOperation(tool)}`), text);
export const saleToolListing = granted => ({ operations: granted.map(tool => ({
  operation: saleToolOperation(tool), description: bridgeNames(tool.description),
  inputSchema: structuredClone(tool.inputSchema), annotations: { ...tool.annotations },
})) });
// Kết quả CHƯA ghi do rào của broker dựng (bản xem trước của rào chữ công khai; needs_input / bản xem trước của rào dừng chương trình,
// policy-cancel-guard.mjs) mang tên tool nội bộ ⇒ đổi sang tên cầu + operation để mô hình gọi lại đúng chỗ.
export function saleToolResult(result, operation) {
  return ['confirmation_required', 'needs_input'].includes(result?.outcome) && result.applied === false
    ? { ...result, tool: SALE_TOOL.name, operation }
    : result;
}
