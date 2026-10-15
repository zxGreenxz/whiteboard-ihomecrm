// Fixed, typed read projections. This catalog describes supported operations;
// grants always come from live CRM authority intersected with the saved overlay.
// One registry drives tools, input/result validation and the SQL family (fixed
// RPC pair) of each domain; the model never names a table, RPC or actor.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const domainId = value => typeof value === 'string' && UUID.test(value);
export const domainRecord = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export const domainExact = (value, keys) => domainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new TypeError('invalid_domain_contract'); };
const nullable = check => value => value === null || check(value);
// SQL hermes_domain_text_v1 keeps left(...,200) characters (code points); an
// emoji is two UTF-16 units, so `.length` would reject a valid row (and page).
const text = value => typeof value === 'string' && value.length <= 400 && [...value].length <= 200 &&
  !/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u.test(value);
const amount = value => typeof value === 'string' && /^-?\d{1,18}(?:\.\d{1,6})?$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ids = value => Array.isArray(value) && value.length <= 256 && value.every(domainId) && new Set(value).size === value.length;
const oneOf = values => value => values.includes(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const define = (permission, label, fields, statuses = [], options = {}) => Object.freeze({ family: 'v1', permission, label,
  fields: Object.freeze(fields), statuses: Object.freeze(statuses), dated: false, requiresDates: false, perBuilding: false, source: null, ...options });

// Family = one reviewed SQL pair. v1 is the applied 20261014081902 contract and
// keeps its exact 5-key input/4-key result; v2 adds date range, source and time.
const BASE_INPUT = Object.freeze(['query', 'limit', 'cursor', 'buildingId', 'status']);
const BASE_RESULT = Object.freeze(['organizationId', 'domain', 'items', 'nextCursor']);
export const DOMAIN_FAMILIES = Object.freeze({
  v1: Object.freeze({ readRpc: 'hermes_domain_read_v1', capabilitiesRpc: 'hermes_domain_capabilities_v1', inputKeys: BASE_INPUT, resultKeys: BASE_RESULT,
    capabilities: Object.freeze(['customers.view', 'leads.view', 'contracts.view', 'invoices.view', 'assets.view', 'services.view', 'tasks.view', 'reports_real_estate.occupancy']) }),
  v2: Object.freeze({ readRpc: 'hermes_domain_read_v2', capabilitiesRpc: 'hermes_domain_capabilities_v2',
    inputKeys: Object.freeze([...BASE_INPUT, 'fromDate', 'toDate']), resultKeys: Object.freeze([...BASE_RESULT, 'source', 'fetchedAt']),
    capabilities: Object.freeze(['income_expenses.view', 'meter_readings.view', 'deposits.view', 'reports_finance.analysis']) }),
});
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
    id: domainId, buildingId: domainId, name: text, total: integer, occupied: integer, available: integer }, [], { perBuilding: true }),
  income_expenses: define('income_expenses.view', 'Tra phiếu thu/chi theo ngày phiếu và trạng thái duyệt (UNAPPROVED = chờ duyệt). Không gồm phiếu có hạng mục hạn chế, lương, cổ đông; không trả người nộp/nhận, tài khoản, ghi chú, chứng từ. Số tiền là chuỗi VND', {
    id: domainId, code: nullable(text), type: oneOf(['INCOME', 'EXPENSE']), name: text, buildingId: domainId, roomId: nullable(domainId),
    roomName: nullable(text), voucherDate: date, totalAmount: amount, approvalStatus: oneOf(['UNAPPROVED', 'APPROVED', 'CANCELLED']) },
  ['UNAPPROVED', 'APPROVED', 'CANCELLED'], { family: 'v2', dated: true, source: 'crm.income_expenses' }),
  receivables: define('invoices.view', 'Tra công nợ: hoá đơn đã duyệt/thu một phần/quá hạn còn tiền chưa thu (remainingAmount do CRM tính); lọc theo hạn thanh toán', {
    id: domainId, number: nullable(text), status: oneOf(['APPROVED', 'PARTIAL_PAID', 'OVERDUE']), buildingId: domainId, roomId: domainId,
    roomName: nullable(text), billingMonth: nullable(text), dueDate: nullable(date), totalAmount: amount, paidAmount: amount, remainingAmount: amount },
  ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'], { family: 'v2', dated: true, source: 'crm.invoices' }),
  meter_readings: define('meter_readings.view', 'Tra chỉ số công tơ điện/nước theo ngày đọc và trạng thái duyệt; tiêu thụ do CRM tính', {
    id: domainId, code: nullable(text), buildingId: domainId, roomId: nullable(domainId), roomName: nullable(text),
    meterType: oneOf(['ELECTRICITY', 'WATER', 'GAS', 'OTHER']), settlementMonth: nullable(text), readingDate: date,
    previousReading: amount, currentReading: amount, consumption: amount, status: oneOf(['UNAPPROVED', 'APPROVED']) },
  ['UNAPPROVED', 'APPROVED'], { family: 'v2', dated: true, source: 'crm.meter_readings' }),
  deposits_held: define('deposits.view', 'Tổng cọc của hợp đồng đang hiệu lực theo từng toà từ báo cáo cọc CRM (phải thu, đã giữ, còn thiếu); không có chi tiết khách', {
    id: domainId, buildingId: domainId, name: text, contractCount: integer, expected: amount, held: amount, shortfallAll: amount,
    shortfallShort: amount, fullCount: integer, shortCount: integer, firstInvoiceCount: integer },
  [], { family: 'v2', perBuilding: true, source: 'crm.get_held_deposit_summary' }),
  building_profit: define('reports_finance.analysis', 'Lãi lỗ kết quả kinh doanh theo toà trong kỳ fromDate..toDate (≤ 366 ngày) từ báo cáo tài chính CRM: phiếu đã duyệt, tính theo ngày phiếu; toà không có số liệu không xuất hiện', {
    id: domainId, buildingId: domainId, name: text, revenue: amount, expense: amount, net: amount, months: integer },
  [], { family: 'v2', perBuilding: true, dated: true, requiresDates: true, source: 'crm.fa_monthly_pnl' }),
});
// Family v1 keys keep their historic export (capability contract, schedule and
// CDE fixtures). v2 keys are separate until the capability contract adds them.
export const DOMAIN_READ_CAPABILITIES = DOMAIN_FAMILIES.v1.capabilities;
export const DOMAIN_READ_CAPABILITIES_V2 = DOMAIN_FAMILIES.v2.capabilities;
export const ALL_DOMAIN_READ_CAPABILITIES = Object.freeze([...DOMAIN_FAMILIES.v1.capabilities, ...DOMAIN_FAMILIES.v2.capabilities]);
export const domainFamily = operation => Object.hasOwn(DOMAIN_READS, operation) ? DOMAIN_FAMILIES[DOMAIN_READS[operation].family] : undefined;
export const domainOperation = name => typeof name === 'string' && name.startsWith('crm_read_') && Object.hasOwn(DOMAIN_READS, name.slice(9)) ? name.slice(9) : undefined;
export const mayUseDomain = (effective, operation) => Object.hasOwn(DOMAIN_READS, operation) && effective?.read?.includes(DOMAIN_READS[operation].permission) === true;
export function domainInput(operation, input) {
  if (!Object.hasOwn(DOMAIN_READS, operation)) fail();
  const definition = DOMAIN_READS[operation], family = domainFamily(operation);
  if (!domainRecord(input) || Object.keys(input).some(key => !family.inputKeys.includes(key))) fail();
  const result = { ...Object.fromEntries(family.inputKeys.map(key => [key, null])), query: '', limit: 20, ...input };
  if (!text(result.query) || !Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50 ||
      !nullable(domainId)(result.cursor) || !nullable(domainId)(result.buildingId) ||
      !(result.status === null || definition.statuses.includes(result.status))) fail();
  if (family === DOMAIN_FAMILIES.v2) {
    const { fromDate, toDate } = result;
    if (!nullable(date)(fromDate) || !nullable(date)(toDate) || !definition.dated && (fromDate !== null || toDate !== null) ||
        fromDate !== null && toDate !== null && toDate < fromDate ||
        definition.requiresDates && (fromDate === null || toDate === null || Date.parse(toDate) - Date.parse(fromDate) > 366 * 86_400_000)) fail();
  }
  return { ...result, query: result.query.trim() };
}
export function domainResult(operation, value, identity, input) {
  const definition = DOMAIN_READS[operation], family = domainFamily(operation);
  if (!definition || !domainExact(value, family.resultKeys) ||
      value.organizationId !== identity.row.organizationId || value.domain !== operation || !Array.isArray(value.items) ||
      value.items.length > input.limit || !nullable(domainId)(value.nextCursor) ||
      family === DOMAIN_FAMILIES.v2 && (value.source !== definition.source || !instant(value.fetchedAt))) fail();
  const scopes = identity.scopesByPermission?.[definition.permission]?.buildingIds;
  // SQL is final authority. If supplied, the earlier CRM scope also fences output;
  // it is never a substitute for the saved authorization_scopes overlay in SQL.
  const items = value.items.map(row => {
    if (!domainExact(row, Object.keys(definition.fields)) || Object.entries(definition.fields).some(([key, check]) => !check(row[key]))) fail();
    const buildings = row.buildingIds ?? (row.buildingId ? [row.buildingId] : []);
    if (Array.isArray(scopes) && buildings.some(building => !scopes.includes(building))) fail();
    if (input.buildingId && !buildings.includes(input.buildingId)) fail();
    if (definition.perBuilding && row.id !== row.buildingId) fail();
    if (operation === 'occupancy' && row.occupied + row.available > row.total) fail();
    if (input.status && Object.hasOwn(row, operation === 'income_expenses' ? 'approvalStatus' : 'status') &&
        row[operation === 'income_expenses' ? 'approvalStatus' : 'status'] !== input.status) fail();
    const day = { income_expenses: row.voucherDate, receivables: row.dueDate, meter_readings: row.readingDate }[operation];
    if (day !== undefined && (input.fromDate && (day === null || day < input.fromDate) || input.toDate && (day === null || day > input.toDate))) fail();
    if (operation === 'receivables' && !(Number(row.remainingAmount) > 0)) fail();
    return structuredClone(row);
  });
  if (items.some((row, index) => row.id <= (index ? items[index - 1].id : input.cursor ?? '')) ||
      value.nextCursor !== null && (items.length !== input.limit || value.nextCursor !== items.at(-1)?.id)) fail();
  return Object.fromEntries(family.resultKeys.map(key => [key, key === 'items' ? items : value[key]]));
}
// requiresDates never accepts null, so its required dates are not nullable.
const dateSchema = required => ({ type: required ? 'string' : ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
export const DOMAIN_TOOLS = Object.freeze(Object.entries(DOMAIN_READS).map(([operation, definition]) => Object.freeze({
  name: `crm_read_${operation}`, description: definition.label,
  inputSchema: { type: 'object', additionalProperties: false, ...(definition.requiresDates ? { required: ['fromDate', 'toDate'] } : {}), properties: {
    query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: ['string', 'null'], format: 'uuid' }, buildingId: { type: ['string', 'null'], format: 'uuid' },
    status: { enum: [null, ...definition.statuses] },
    ...(definition.dated ? { fromDate: dateSchema(definition.requiresDates), toDate: dateSchema(definition.requiresDates) } : {}),
  } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
})));
