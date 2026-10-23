import { domainExact, domainId } from './domain-contract.mjs';
import { saleActionInput, mayUseSaleAction } from './sale-action-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY } from './request-id-contract.mjs';

export const SALE_BULK_MAX_ITEMS = 10;
export const SALE_BULK_MAX_BYTES = 12_288;
const fail = () => { throw new TypeError('invalid_sale_bulk'); };
export const saleBulkOperation = name => name === 'crm_sale_bulk_patch' ? 'patch' : name === 'crm_sale_bulk_status' ? 'status' : undefined;
// Admission permits the operation family; each item's full service and SQL
// decide its exact field grant so one denied item cannot hide partial outcomes.
export const mayUseSaleBulk = (effective, operation) => ['patch', 'status'].includes(operation) && mayUseSaleAction(effective, 'patch');
export function saleBulkInput(operation, input) {
  if (!['patch', 'status'].includes(operation) || !domainExact(input, ['requestId', 'items']) || !domainId(input.requestId) ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > SALE_BULK_MAX_ITEMS ||
      Reflect.ownKeys(input.items).length !== input.items.length + 1) fail();
  const items = input.items.map(item => {
    if (operation === 'patch') return saleActionInput('patch', item);
    if (!domainExact(item, ['requestId', 'roomId']) || !domainId(item.requestId) || !domainId(item.roomId)) fail();
    return { ...item };
  });
  if (new Set(items.map(item => item.roomId)).size !== items.length ||
      new Set([input.requestId, ...items.map(item => item.requestId)]).size !== items.length + 1) fail();
  const value = { requestId: input.requestId, items };
  if (new TextEncoder().encode(JSON.stringify(value)).length > SALE_BULK_MAX_BYTES) fail();
  return value;
}
const patchProperties = {
  requestId: REQUEST_ID_PROPERTY, roomId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'string', pattern: '^[a-f0-9]{32}$' },
  rent_price: { type: 'integer', minimum: 0, maximum: 9_999_999_999_999 }, area: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
  room_type: { type: ['string', 'null'], maxLength: 200 }, sale_note: { type: ['string', 'null'], maxLength: 2000 },
  sale_bonus_note: { type: ['string', 'null'], maxLength: 2000 }, description: { type: ['string', 'null'], maxLength: 2000 },
  amenities: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } },
  images: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', format: 'uri', maxLength: 2048 } },
};
export const SALE_BULK_TOOLS = Object.freeze(['patch', 'status'].map(operation => ({
  name: `crm_sale_bulk_${operation}`,
  description: operation === 'patch'
    ? `Cập nhật tối đa 10 phòng, tổng nội dung tối đa 12 KiB. Mỗi phòng là một giao dịch riêng: có thể thành công một phần; dừng sau kết quả chưa rõ. Không tự chia lô. Preview chữ công khai ràng buộc toàn danh sách và phiên bản. ${REQUEST_ID_GUIDANCE} Mã lô và mã từng phòng phải khác nhau; giữ tất cả mã khi thử lại/đối soát bằng crm_sale_bulk_status. Chỉ ghi khi người dùng yêu cầu rõ ràng.`
    : 'Đối soát lô bằng đúng mã lô và từng cặp requestId/roomId đã gửi. not_found/unknown không chứng minh thất bại. Không tạo mã mới. Kiểm quyền từng phòng.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'items'], properties: {
    requestId: REQUEST_ID_PROPERTY,
    items: { type: 'array', minItems: 1, maxItems: SALE_BULK_MAX_ITEMS, items: { type: 'object', additionalProperties: false,
      required: operation === 'patch' ? ['requestId', 'roomId', 'expectedRevision'] : ['requestId', 'roomId'],
      properties: operation === 'patch' ? patchProperties : { requestId: REQUEST_ID_PROPERTY, roomId: patchProperties.roomId } } },
    ...(operation === 'patch' ? { confirmToken: { type: 'string', description: 'Token preview sau khi người dùng đồng ý đúng nguyên văn và danh sách phòng.' } } : {}),
  } },
  annotations: { readOnlyHint: operation === 'status', destructiveHint: false, idempotentHint: true, openWorldHint: false },
})));
