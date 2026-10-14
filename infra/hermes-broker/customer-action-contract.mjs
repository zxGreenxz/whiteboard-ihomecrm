import { domainExact, domainId } from './domain-contract.mjs';
export const CUSTOMER_ACTIONS = Object.freeze(['customers.create', 'leads.create']);
const kinds = Object.freeze({ 'customer.create': 'customer', 'customer.status': 'customer', 'lead.create': 'lead', 'lead.status': 'lead' });
const sources = ['FACEBOOK', 'ZALO', 'PHONE', 'REFERRAL', 'WALK_IN', 'WEBSITE', 'OTHER'];
const text = (v, max) => typeof v === 'string' && [...v].length <= max && !v.includes('\0');
const name = v => text(v, 200) && v.length > 0 && v.replace(/^ +| +$/g, '') === v && !/[\r\n\t]/.test(v);
const phone = v => typeof v === 'string' && /^[0-9]{10,11}$/.test(v);
const email = v => v === null || text(v, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const notes = v => v === null || text(v, 4000);
const fail = () => { throw new TypeError('invalid_customer_action'); };
export const customerActionKind = operation => Object.hasOwn(kinds, operation) ? kinds[operation] : null;
export const mayUseCustomerAction = (effective, operation) => {
  const kind = customerActionKind(operation);
  return kind !== null && effective?.action?.includes(kind === 'customer' ? 'customers.create' : 'leads.create') === true;
};
export function customerActionInput(operation, input) {
  const kind = customerActionKind(operation); if (!kind) fail();
  if (operation.endsWith('.status')) {
    if (!domainExact(input, ['requestId']) || !domainId(input.requestId)) fail();
  } else if (!domainExact(input, ['requestId', 'name', 'phone', 'email', 'notes', ...(kind === 'lead' ? ['source'] : [])]) ||
    !domainId(input.requestId) || !name(input.name) || !phone(input.phone) || !email(input.email) || !notes(input.notes) ||
    kind === 'lead' && !sources.includes(input.source)) fail();
  return { ...input };
}
export function customerActionResult(operation, value, identity, input) {
  const kind = customerActionKind(operation), status = operation.endsWith('.status');
  if (!kind || !domainExact(value, ['organizationId', 'requestId', 'kind', 'outcome', 'record']) ||
    value.organizationId !== identity.row.organizationId || value.requestId !== input.requestId || value.kind !== kind ||
    !['applied', 'not_found', 'unknown'].includes(value.outcome)) fail();
  if (value.outcome !== 'applied') { if (!status || value.record !== null) fail(); return { ...value }; }
  const row = value.record;
  if (!domainExact(row, ['id', 'name', 'phone', 'email', 'notes', 'status', 'customerType', 'source', 'createdBy']) ||
    !domainId(row.id) || !name(row.name) || !phone(row.phone) || !email(row.email) || !notes(row.notes) || row.createdBy !== identity.row.userId ||
    (kind === 'customer' ? row.status !== 'WALK_IN' || row.customerType !== 'INDIVIDUAL' || row.source !== null :
      row.status !== 'B1_LEAD' || row.customerType !== null || !sources.includes(row.source)) ||
    !status && ['name', 'phone', 'email', 'notes', ...(kind === 'lead' ? ['source'] : [])].some(key => row[key] !== input[key])) fail();
  return { ...value, record: { ...row } };
}
const uuid = { type: 'string', format: 'uuid' };
export const CUSTOMER_ACTION_TOOLS = Object.freeze(['customer', 'lead'].flatMap(kind => [
  { name: `crm_${kind}_create`, description: `${kind === 'customer' ? 'Tạo khách hàng cá nhân WALK_IN' : 'Tạo lead B1_LEAD'} chưa gắn tòa, theo quyền CRM của người kết nối và phạm vi tổ chức Hermes Action. requestId UUID ổn định; mất phản hồi chỉ đối soát status. CRM cho phép trùng số điện thoại; không tự coi cùng số là cùng khách.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'name', 'phone', 'email', 'notes', ...(kind === 'lead' ? ['source'] : [])],
      properties: { requestId: uuid, name: { type: 'string', minLength: 1, maxLength: 200 }, phone: { type: 'string', pattern: '^[0-9]{10,11}$' },
        email: { type: ['string', 'null'], maxLength: 254 }, notes: { type: ['string', 'null'], maxLength: 4000 }, ...(kind === 'lead' ? { source: { enum: sources } } : {}) } } },
  { name: `crm_${kind}_status`, description: 'Đối soát requestId đã dùng; not_found hoặc unknown không cho phép tự gửi lại yêu cầu tạo.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: uuid } } },
]));
