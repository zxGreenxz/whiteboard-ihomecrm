// Fixed, typed read projections. This catalog describes supported operations;
// grants always come from live CRM authority intersected with the saved overlay.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const domainId = value => typeof value === 'string' && UUID.test(value);
export const domainRecord = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export const domainExact = (value, keys) => domainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new TypeError('invalid_domain_contract'); };
const nullable = check => value => value === null || check(value);
const text = value => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value);
const amount = value => typeof value === 'string' && /^-?\d{1,18}(?:\.\d{1,6})?$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ids = value => Array.isArray(value) && value.length <= 256 && value.every(domainId) && new Set(value).size === value.length;
const define = (permission, label, fields, statuses = []) => Object.freeze({ permission, label,
  fields: Object.freeze(fields), statuses: Object.freeze(statuses) });
export const DOMAIN_READS = Object.freeze({
  customers: define('customers.view', 'Tra khách hàng trong hợp đồng thuộc phạm vi được cấp', {
    id: domainId, name: text, phoneMasked: nullable(text), contractId: domainId, buildingId: domainId, roomId: domainId }),
  leads: define('leads.view', 'Tra khách hẹn và mốc liên hệ tiếp theo', {
    id: domainId, name: text, status: text, buildingId: nullable(domainId), roomId: nullable(domainId), nextFollowUp: nullable(text) },
  ['B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTATION', 'CONVERTED', 'FAILED']),
  contracts: define('contracts.view', 'Tra hợp đồng và thời hạn thuê', {
    id: domainId, number: nullable(text), status: text, buildingId: domainId, roomId: domainId, startDate: nullable(date), endDate: nullable(date) },
  ['DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED']),
  invoices: define('invoices.view', 'Tra hóa đơn; số tiền giữ dạng chuỗi thập phân', {
    id: domainId, number: nullable(text), status: text, buildingId: domainId, roomId: domainId, billingMonth: nullable(text), totalAmount: amount }),
  assets: define('assets.view', 'Tra tài sản, vị trí và số lượng', {
    id: domainId, name: text, code: nullable(text), condition: nullable(text), buildingId: nullable(domainId), roomId: nullable(domainId), quantity: amount }),
  services: define('services.view', 'Tra danh mục dịch vụ và các tòa áp dụng được phép xem', {
    id: domainId, name: text, code: nullable(text), unit: nullable(text), unitPrice: amount, buildingIds: ids }),
  tasks: define('tasks.view', 'Tra công việc và hạn hoàn thành', {
    id: domainId, title: text, code: nullable(text), status: text, buildingId: nullable(domainId), roomId: nullable(domainId), deadline: nullable(text) },
  ['IN_PROGRESS', 'COMPLETED']),
  occupancy: define('reports_real_estate.occupancy', 'Số phòng theo trạng thái hiện tại cho từng tòa; không phải báo cáo lịch sử hoặc dự báo', {
    id: domainId, buildingId: domainId, name: text, total: integer, occupied: integer, available: integer }),
});
export const DOMAIN_READ_CAPABILITIES = Object.freeze(Object.values(DOMAIN_READS).map(value => value.permission));
export const domainOperation = name => typeof name === 'string' && name.startsWith('crm_read_') && Object.hasOwn(DOMAIN_READS, name.slice(9)) ? name.slice(9) : undefined;
export const mayUseDomain = (effective, operation) => Object.hasOwn(DOMAIN_READS, operation) && effective?.read?.includes(DOMAIN_READS[operation].permission) === true;
export function domainInput(operation, input) {
  if (!Object.hasOwn(DOMAIN_READS, operation) || !domainRecord(input) || Object.keys(input).some(key => !['query', 'limit', 'cursor', 'buildingId', 'status'].includes(key))) fail();
  const result = { query: '', limit: 20, cursor: null, buildingId: null, status: null, ...input };
  if (!text(result.query) || !Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50 ||
      !nullable(domainId)(result.cursor) || !nullable(domainId)(result.buildingId) ||
      !(result.status === null || DOMAIN_READS[operation].statuses.includes(result.status))) fail();
  return { ...result, query: result.query.trim() };
}
export function domainResult(operation, value, identity, input) {
  const definition = DOMAIN_READS[operation];
  if (!definition || !domainExact(value, ['organizationId', 'domain', 'items', 'nextCursor']) ||
      value.organizationId !== identity.row.organizationId || value.domain !== operation || !Array.isArray(value.items) ||
      value.items.length > input.limit || !nullable(domainId)(value.nextCursor)) fail();
  const scopes = identity.scopesByPermission?.[definition.permission]?.buildingIds;
  // SQL is final authority. If supplied, the earlier CRM scope also fences output;
  // it is never a substitute for the saved authorization_scopes overlay in SQL.
  const items = value.items.map(row => {
    if (!domainExact(row, Object.keys(definition.fields)) || Object.entries(definition.fields).some(([key, check]) => !check(row[key]))) fail();
    const buildings = row.buildingIds ?? (row.buildingId ? [row.buildingId] : []);
    if (Array.isArray(scopes) && buildings.some(building => !scopes.includes(building))) fail();
    if (input.buildingId && !buildings.includes(input.buildingId)) fail();
    if (operation === 'occupancy' && (row.id !== row.buildingId || row.occupied + row.available > row.total)) fail();
    return structuredClone(row);
  });
  if (items.some((row, index) => row.id <= (index ? items[index - 1].id : input.cursor ?? '')) ||
      value.nextCursor !== null && (items.length !== input.limit || value.nextCursor !== items.at(-1)?.id)) fail();
  return { organizationId: value.organizationId, domain: operation, items, nextCursor: value.nextCursor };
}
export const DOMAIN_TOOLS = Object.freeze(Object.entries(DOMAIN_READS).map(([operation, definition]) => Object.freeze({
  name: `crm_read_${operation}`, description: definition.label,
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: ['string', 'null'], format: 'uuid' }, buildingId: { type: ['string', 'null'], format: 'uuid' },
    status: { enum: [null, ...definition.statuses] },
  } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
})));
