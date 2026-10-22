import { domainExact, domainId } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE } from './request-id-contract.mjs';
export const SALE_POLICY_CAPABILITIES = Object.freeze(['sale_phong.edit']);
const OPS = Object.freeze({ crm_sale_policy_observe: 'observe', crm_sale_policy_save: 'save', crm_sale_policy_cancel: 'cancel', crm_sale_policy_status: 'status' });
const fail = () => { throw new TypeError('invalid_sale_policy'); };
const text = (v, max, required = false) => typeof v === 'string' && [...v].length <= max && (!required || v.trim().length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(v);
const revision = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const version = v => Number.isSafeInteger(v) && v > 0;
const instant = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
export const salePolicyOperation = name => Object.hasOwn(OPS, name) ? OPS[name] : undefined;
export const mayUseSalePolicy = effective => ['rooms.edit', 'sale_phong.edit'].some(key => effective?.action?.includes(key));
export function salePolicyInput(operation, input) {
  if (operation === 'observe') {
    if (!domainExact(input, ['roomId']) || !domainId(input.roomId)) fail();
  } else if (operation === 'status') {
    if (!domainExact(input, ['requestId']) || !domainId(input.requestId)) fail();
  } else if (operation === 'save') {
    if (!domainExact(input, ['requestId', 'roomId', 'expectedRevision', 'title', 'content', 'startsAt', 'endsAt']) ||
        !domainId(input.requestId) || !domainId(input.roomId) || !revision(input.expectedRevision) ||
        !text(input.title, 120, true) || !text(input.content, 2000, true) || !instant(input.startsAt) || !instant(input.endsAt) ||
        Date.parse(input.endsAt) <= Date.parse(input.startsAt)) fail();
  } else if (operation === 'cancel') {
    if (!domainExact(input, ['requestId', 'policyId', 'expectedVersion', 'reason']) || !domainId(input.requestId) ||
        !domainId(input.policyId) || !version(input.expectedVersion) || !text(input.reason, 500, true)) fail();
  } else fail();
  return { ...input };
}
function policy(value) {
  return value === null || domainExact(value, ['id', 'version', 'title', 'content', 'startsAt', 'endsAt', 'status']) &&
    domainId(value.id) && version(value.version) && text(value.title, 120, true) && text(value.content, 2000, true) &&
    instant(value.startsAt) && instant(value.endsAt) && Date.parse(value.startsAt) < Date.parse(value.endsAt) &&
    ['SCHEDULED', 'ACTIVE', 'EXPIRED', 'CANCELLED'].includes(value.status);
}
function room(value, identity) {
  return domainExact(value, ['roomId', 'buildingId', 'revision', 'policy']) && domainId(value.roomId) && domainId(value.buildingId) &&
    revision(value.revision) && policy(value.policy) && ['rooms.edit', 'sale_phong.edit'].some(key =>
      identity.effective.action.includes(key) && identity.scopesByPermission?.[key]?.buildingIds?.includes(value.buildingId));
}
export function salePolicyResult(operation, value, identity, input) {
  if (!value || value.organizationId !== identity.row.organizationId) fail();
  if (operation === 'observe') {
    if (!domainExact(value, ['organizationId', 'room']) || !room(value.room, identity) || value.room.roomId !== input.roomId) fail();
  } else {
    if (!domainExact(value, ['organizationId', 'requestId', 'operation', 'outcome', 'receipt']) || value.requestId !== input.requestId ||
        !['applied', 'not_found', 'unknown'].includes(value.outcome)) fail();
    if (value.outcome !== 'applied') {
      if (operation !== 'status' || value.operation !== null || value.receipt !== null) fail();
    } else if (!['save', 'cancel'].includes(value.operation) || operation !== 'status' && value.operation !== operation ||
        !room(value.receipt, identity) || !value.receipt.policy ||
        operation === 'save' && (value.receipt.roomId !== input.roomId || value.receipt.policy.version !== 1 ||
          value.receipt.policy.status === 'CANCELLED' || value.receipt.policy.title !== input.title.replace(/^ +| +$/g, '') ||
          value.receipt.policy.content !== input.content.replace(/^ +| +$/g, '') ||
          Date.parse(value.receipt.policy.startsAt) !== Date.parse(input.startsAt) || Date.parse(value.receipt.policy.endsAt) !== Date.parse(input.endsAt)) ||
        operation === 'cancel' && (value.receipt.policy.id !== input.policyId || value.receipt.policy.status !== 'CANCELLED' ||
          value.receipt.policy.version !== input.expectedVersion + 1)) fail();
  }
  return structuredClone(value);
}
const uuid = { type: 'string', format: 'uuid' };
const tool = (name, description, properties, mutation = false) => ({ name,
  description: `${description} ${mutation ? REQUEST_ID_GUIDANCE + ' Mất phản hồi: crm_sale_policy_status, không đổi mã. Chỉ ghi khi người dùng đã yêu cầu rõ ràng.' : ''}`,
  inputSchema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties: {
    ...properties, ...(name === 'crm_sale_policy_save' ? { confirmToken: { type: 'string', description: 'Token xem trước sau khi người dùng đồng ý nguyên văn nội dung, phòng và thời hạn.' } } : {}),
  } }, annotations: { readOnlyHint: !mutation, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export const SALE_POLICY_TOOLS = Object.freeze([
  tool('crm_sale_policy_observe', 'Lấy revision phòng và chương trình chính sách hiện tại/sắp tới để thao tác. Cần quyền CRM xem phòng và quyền sửa phòng theo tòa.', { roomId: uuid }),
  tool('crm_sale_policy_save', 'Tạo trực tiếp chương trình có thời hạn, không gửi chờ duyệt. Không sửa giá hợp đồng, không thu tiền. Xem trước nguyên văn trước khi công khai; không chồng thời hạn chương trình đang có.', {
    requestId: REQUEST_ID_PROPERTY, roomId: uuid, expectedRevision: { type: 'string', pattern: '^[a-f0-9]{32}$' },
    title: { type: 'string', minLength: 1, maxLength: 120 }, content: { type: 'string', minLength: 1, maxLength: 2000 },
    startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' },
  }, true),
  tool('crm_sale_policy_cancel', 'Dừng chương trình theo ID và version vừa đọc, giữ lịch sử và lý do; không hoàn tiền hay sửa giá hợp đồng.', {
    requestId: REQUEST_ID_PROPERTY, policyId: uuid, expectedVersion: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
  }, true),
  tool('crm_sale_policy_status', `Đối soát lệnh lưu/dừng chính sách. not_found/unknown không chứng minh thất bại. ${REQUEST_ID_STATUS_GUIDANCE}`, { requestId: REQUEST_ID_PROPERTY }),
]);
