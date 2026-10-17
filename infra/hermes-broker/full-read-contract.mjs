// Đọc đầy đủ cho NGƯỜI HỎI (chủ chốt 16/10/2026), họ SQL v3 (hermes_domain_read_v3).
// Bảng khai báo cố định: tên tool, khoá quyền đọc ĐÃ CÓ, schema tham số, chiếu
// trường và kiểm kết quả. Mô hình không bao giờ nêu tên bảng/RPC/actor. Quyền:
// quyền CRM hiện tại ∩ overlay Read/scope toà của kết nối (SQL quyết định cuối);
// broker chỉ là hàng rào thứ hai trên hình dạng và phạm vi toà của kết quả.
// Dữ liệu riêng tư (SĐT, CCCD, địa chỉ...) chỉ dùng để trả lời riêng người hỏi;
// bản tin nhóm Zalo đi đường khác (room-read-projection) và giữ lọc công khai.
// Module độc lập (không import domain-contract) để tránh vòng import.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = () => { throw new TypeError('invalid_full_read_contract'); };
const record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const id = value => typeof value === 'string' && UUID.test(value);
export const nullable = check => value => value === null || check(value);
// SQL hermes_full_text_v1: giữ \n, bỏ mọi ký tự điều khiển khác, cắt theo code point.
const LONG_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
export const longText = max => value => typeof value === 'string' && value.length <= max * 2 && [...value].length <= max && !LONG_CONTROL.test(value);
export const code = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value);
export const amount = value => typeof value === 'string' && /^-?\d{1,18}(?:\.\d{1,6})?$/.test(value);
export const bool = value => typeof value === 'boolean';
export const count = value => Number.isSafeInteger(value) && value >= 0;
export const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const list = (max, fields) => value => Array.isArray(value) && value.length <= max && value.every(row => shaped(row, fields)) &&
  (!Object.hasOwn(fields, 'id') || new Set(value.map(row => row.id)).size === value.length);
const object = fields => value => shaped(value, fields);
export function shaped(value, fields) {
  return exact(value, Object.keys(fields)) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
export const PRIVATE_HINT = 'Dữ liệu riêng tư: chỉ trả lời riêng cho người hỏi, không đăng vào nhóm.';
const detailSchema = key => ({ type: 'object', additionalProperties: false, required: [key], properties: { [key]: { type: 'string', format: 'uuid' } } });
const detailInput = key => input => {
  if (!exact(input, [key]) || !id(input[key])) fail();
  return { [key]: input[key] };
};
const DETAIL_RESULT = Object.freeze(['organizationId', 'domain', 'fetchedAt', 'item']);

const CUSTOMER_CONTRACT = Object.freeze({ id, number: nullable(longText(100)), status: code, buildingId: id, buildingName: nullable(longText(200)),
  roomId: id, roomName: nullable(longText(100)), startDate: nullable(date), endDate: nullable(date), rentPrice: amount, isRepresentative: bool });
export const CUSTOMER_DETAIL_FIELDS = Object.freeze({ id, name: nullable(longText(200)), phone: nullable(longText(40)), email: nullable(longText(200)),
  customerType: nullable(code), status: nullable(code), idType: nullable(code), idNumber: nullable(longText(40)), idIssueDate: nullable(date),
  idIssuePlace: nullable(longText(200)), dateOfBirth: nullable(date), gender: nullable(longText(20)), isForeign: nullable(bool),
  occupation: nullable(longText(200)), workplace: nullable(longText(300)), detailedAddress: nullable(longText(500)), ward: nullable(longText(100)),
  district: nullable(longText(100)), province: nullable(longText(100)), currentResidence: nullable(longText(500)), permanentAddress: nullable(longText(500)),
  companyName: nullable(longText(200)), contactPerson: nullable(longText(200)), contactPersonPhone: nullable(longText(40)),
  emergencyContact: nullable(object({ name: nullable(longText(200)), phone: nullable(longText(40)), relationship: nullable(longText(100)) })),
  notes: nullable(longText(2000)), contractsVisible: bool, contracts: list(20, CUSTOMER_CONTRACT) });
const TENANT = Object.freeze({ customerId: id, name: nullable(longText(200)), phone: nullable(longText(40)), isRepresentative: bool,
  idNumber: nullable(longText(40)), idIssueDate: nullable(date), idIssuePlace: nullable(longText(200)), dateOfBirth: nullable(date),
  gender: nullable(longText(20)), isForeign: nullable(bool), permanentAddress: nullable(longText(300)), currentResidence: nullable(longText(300)),
  occupation: nullable(longText(200)), workplace: nullable(longText(200)), note: nullable(longText(300)) });
const SERVICE = Object.freeze({ serviceId: id, name: nullable(longText(200)), unit: nullable(longText(40)), type: nullable(code), pricingType: nullable(code),
  unitPrice: amount, initialReading: nullable(amount) });
export const CONTRACT_DETAIL_FIELDS = Object.freeze({ id, number: nullable(longText(100)), status: code, buildingId: id, buildingName: nullable(longText(200)),
  buildingAddress: nullable(longText(500)), roomId: id, roomName: nullable(longText(100)), signedDate: nullable(date), startDate: nullable(date),
  endDate: nullable(date), actualEndDate: nullable(date), expectedMoveOutDate: nullable(date), startBillingDate: nullable(date), endBillingDate: nullable(date),
  rentPrice: amount, paymentCycle: nullable(code), totalDeposit: amount, depositPaid: amount, depositRemaining: amount, depositDebtMode: nullable(code),
  depositDebtReason: nullable(longText(500)), depositTopupDueDate: nullable(date), initialElectricityReading: nullable(amount),
  initialWaterReading: nullable(amount), notes: nullable(longText(2000)), parentContractId: nullable(id),
  tenantsVisible: bool, tenants: list(10, TENANT), services: list(50, SERVICE) });
// The CRM building scope supplied earlier also fences output when present.
function inScope(identity, permission, buildingIds) {
  const scopes = identity.scopesByPermission?.[permission]?.buildingIds;
  return !Array.isArray(scopes) || buildingIds.every(building => scopes.includes(building));
}
// fences: [[khoá, toà của mục]] — mỗi phần chỉ được nằm trong phạm vi CRM của đúng khoá
// đã cấp nó (người ở ⇐ customers.view, hợp đồng ⇐ contracts.view, như embed của web).
const detail = (key, fields, fences, hidden) => (value, identity, input) => {
  if (value.item === null) return { item: null };
  if (!shaped(value.item, fields) || value.item.id !== input[key] || hidden(value.item) ||
      fences(value.item).some(([permission, buildings]) => !inScope(identity, permission, buildings))) fail();
  return { item: structuredClone(value.item) };
};
const define = (permission, name, description, options) => Object.freeze({ family: 'v3', permission, label: description, description, fields: Object.freeze({}),
  statuses: Object.freeze([]), dated: false, requiresDates: false, perBuilding: false, source: null, ...options, toolName: name });

// --- Báo cáo khớp màn web (khớp hermes_report_catalog_v1, 20261017021554): nguồn là RPC
// web đang gọi hoặc SQL theo bộ lọc web; Hermes không phụ thuộc copilot_* (chủ chốt 17/10).
// Mỗi tool một khoá ĐÃ CÓ; `report` chọn biến thể.
// scope: rows = hàng có toà, lọc theo toà đã giao; buildings = hàm nhận danh sách
// toà; organization = hàng không có toà ⇒ chỉ kết nối Toàn tổ chức (ngược lại SQL
// trả unavailable=organization_scope_required).
export const REPORT_INPUT_KEYS = Object.freeze(['report', 'query', 'status', 'month', 'fromDate', 'toDate', 'days', 'basis', 'buildingId', 'limit', 'offset']);
const REPORT_RESULT = Object.freeze(['organizationId', 'domain', 'fetchedAt', 'report', 'source', 'unavailable', 'summary', 'items', 'offset', 'nextOffset', 'sourceCapped']);
const name200 = nullable(longText(200)), name100 = nullable(longText(100)), money = nullable(amount), int = nullable(count);
const report = (source, scope, fields, options = {}) => Object.freeze({ source, scope, fields: Object.freeze(fields), summary: null, statuses: null,
  month: false, fromDate: false, toDate: false, requiresDates: false, days: false, basis: false, buildingFilter: scope !== 'organization', ...options });
const INVOICE_STATS = Object.freeze(Object.fromEntries(['totalAmount', 'totalPaid', 'totalRemaining', 'totalRefunded', 'rentAmount', 'electricAmount',
  'waterAmount', 'serviceAmount'].map(key => [key, amount]).concat([['totalCount', count]])));
export const REPORTS = Object.freeze({
  occupancy_report: Object.freeze({ permission: 'reports_real_estate.occupancy', reports: Object.freeze({
    snapshot: report('crm.occupancy_snapshot_v2', 'rows', { buildingId: id, buildingName: name200, total: count, occupied: count, reserved: count,
      maintenance: count, unavailable: count, available: count, occupancyPct: money, committedPct: money, missedRevenue: money }, { fromDate: true }),
    upcoming: report('crm.occupancy_upcoming_vacancy_v2', 'rows', { contractId: id, contractNumber: name100, buildingId: id, buildingName: name200,
      roomId: id, roomName: name100, effectiveEndDate: nullable(date), daysRemaining: nullable(Number.isSafeInteger), rentPrice: money, extensionApplied: nullable(bool) },
    { fromDate: true, days: true }) }) }),
  invoice_report: Object.freeze({ permission: 'invoices.view', reports: Object.freeze({
    // Như /invoices (useInvoices.ts:194-214): mặc định ẩn huỷ; unpaid = chưa thu đồng nào, không huỷ.
    search: report('crm.invoices', 'rows', { id, number: name100, billingMonth: nullable(longText(20)), dueDate: nullable(date), totalAmount: amount,
      paidAmount: amount, remainingAmount: amount, status: code, buildingId: id, buildingName: name200, roomId: nullable(id), roomName: name100 },
    { month: true, statuses: Object.freeze(['paid', 'partial', 'unpaid', 'cancelled']) }),
    stats: report('crm.invoices', 'buildings', {}, { month: true, summary: INVOICE_STATS }) }) }),
  monthly_pnl: Object.freeze({ permission: 'reports_finance.analysis', reports: Object.freeze({
    // Mặc định dồn tích như BC Doanh Thu Chi Phí / Phân tích tài chính; chờ duyệt tách riêng.
    by_month: report('crm.fa_monthly_pnl', 'rows', { month: date, buildingId: id, buildingName: name200, revenue: amount, expense: amount, net: amount },
      { fromDate: true, toDate: true, requiresDates: true, basis: true,
        summary: Object.freeze({ basis: value => value === 'accrual' || value === 'cash', pendingIncome: amount, pendingExpense: amount, pendingVouchers: count }) }) }) }),
  pending_approvals: Object.freeze({ permission: 'income_expenses.view', reports: Object.freeze({
    inbox: report('crm.list_my_pending_approvals_v1', 'organization', { requestId: id, submissionNo: int, submittedAt: nullable(instant), amount: money,
      voucherId: nullable(id), voucherCode: name100, voucherName: name200, voucherType: nullable(code), makerName: name200, stepNo: int }) }) }),
  zalo_conversations: Object.freeze({ permission: 'chat_zalo.view', reports: Object.freeze({
    list: report('crm.zalo_conversations', 'organization', { conversationId: id, peerName: name200, phone: nullable(longText(40)),
      threadType: nullable(longText(40)), kind: nullable(longText(40)), unread: count, markedUnread: bool, pinned: bool, roomName: name100,
      buildingName: name200, label: name200, lastMessageAt: nullable(instant), lastMessageDir: nullable(longText(20)), lastMessage: nullable(longText(160)) },
    { summary: Object.freeze({ conversations: count, unreadConversations: count, unreadMessages: count, pinned: count }) }) }) }),
  contract_search: Object.freeze({ permission: 'contracts.view', reports: Object.freeze({
    // Như danh sách hợp đồng (getContractDisplayStatus, src/types/contract.ts:180-196).
    search: report('crm.contracts', 'rows', { contractId: id, number: name100, customerName: name200, buildingId: id, buildingName: name200,
      roomId: id, roomName: name100, startDate: nullable(date), endDate: nullable(date), actualEndDate: nullable(date), expectedMoveOutDate: nullable(date),
      status: code, displayStatus: value => ['ACTIVE', 'EXPIRING', 'EXPIRED', 'MOVING_OUT', 'TERMINATED', 'TRANSFERRED', 'DRAFT'].includes(value),
      displayLabel: longText(20), rentPrice: amount, totalDeposit: amount, depositPaid: amount },
    { statuses: Object.freeze(['ACTIVE', 'TERMINATED', 'EXPIRING', 'EXPIRED']) }) }) }),
});
const MONTH = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$/;
const QUERY_CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
const reportInput = operation => input => {
  const { reports } = REPORTS[operation], names = Object.keys(reports);
  if (!record(input) || Object.keys(input).some(key => !REPORT_INPUT_KEYS.includes(key))) fail();
  const value = { ...Object.fromEntries(REPORT_INPUT_KEYS.map(key => [key, null])), report: names.length === 1 ? names[0] : null, query: '', limit: 20, offset: 0, ...input };
  const spec = typeof value.report === 'string' && Object.hasOwn(reports, value.report) ? reports[value.report] : fail();
  value.query = typeof value.query === 'string' ? value.query.trim() : fail();
  if ([...value.query].length > 200 || QUERY_CONTROL.test(value.query) || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50 ||
      !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 2000 ||
      !(value.status === null || spec.statuses?.includes(value.status)) ||
      !(value.month === null || spec.month && typeof value.month === 'string' && MONTH.test(value.month)) ||
      !(value.fromDate === null || spec.fromDate && date(value.fromDate)) || !(value.toDate === null || spec.toDate && date(value.toDate)) ||
      spec.requiresDates && (value.fromDate === null || value.toDate === null) ||
      value.fromDate !== null && value.toDate !== null && (value.toDate < value.fromDate || Date.parse(value.toDate) - Date.parse(value.fromDate) > 366 * 86_400_000) ||
      !(value.days === null || spec.days && Number.isInteger(value.days) && value.days >= 1 && value.days <= 365) ||
      !(value.basis === null || spec.basis && ['accrual', 'cash'].includes(value.basis)) ||
      !(value.buildingId === null || spec.buildingFilter && id(value.buildingId))) fail();
  return Object.fromEntries(REPORT_INPUT_KEYS.map(key => [key, value[key]]));
};
const reportResult = (operation, permission) => (value, identity, input) => {
  const spec = REPORTS[operation].reports[input.report];
  if (value.report !== input.report || value.source !== spec.source || value.offset !== input.offset || typeof value.sourceCapped !== 'boolean' ||
      !Array.isArray(value.items) || value.items.length > input.limit ||
      !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && value.nextOffset === input.offset + value.items.length && value.items.length > 0)) fail();
  if (value.unavailable !== null) {
    if (!(value.unavailable === 'organization_scope_required' && spec.scope === 'organization' ||
        value.unavailable === 'no_building_scope' && spec.scope !== 'organization') ||
        value.items.length || value.summary !== null || value.nextOffset !== null) fail();
    return { report: value.report, source: value.source, unavailable: value.unavailable, summary: null, items: [], offset: value.offset, nextOffset: null, sourceCapped: false };
  }
  if (!(spec.summary === null ? value.summary === null : shaped(value.summary, spec.summary))) fail();
  for (const row of value.items) {
    if (!shaped(row, spec.fields)) fail();
    if (Object.hasOwn(row, 'buildingId') && (!inScope(identity, permission, [row.buildingId]) || input.buildingId && row.buildingId !== input.buildingId)) fail();
  }
  return structuredClone({ report: value.report, source: value.source, unavailable: null, summary: value.summary, items: value.items, offset: value.offset,
    nextOffset: value.nextOffset, sourceCapped: value.sourceCapped });
};
const QUERY = { type: 'string', maxLength: 200 }, LIMIT = { type: 'integer', minimum: 1, maximum: 50 }, OFFSET = { type: 'integer', minimum: 0, maximum: 2000 };
const DATE = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, REQUIRED_DATE = { type: 'string', pattern: DATE.pattern };
const BUILDING = { type: ['string', 'null'], format: 'uuid', description: 'ID toà (lấy từ công cụ tra toà/phòng); bỏ trống = mọi toà được phép.' };
const reportSchema = (properties, required = []) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required } : {}), properties });
const PAGE = 'Trang tiếp: gọi lại với offset=nextOffset. sourceCapped=true: nguồn CRM đã chạm trần, thu hẹp bộ lọc.';
const ORG_ONLY = 'Cần kết nối phạm vi Toàn tổ chức (không lọc được theo toà); thiếu thì unavailable=organization_scope_required.';
const NO_BUILDING = 'unavailable=no_building_scope: kết nối không còn toà nào được đọc (không phải số 0).';
const reportDefine = (operation, description, properties, required) => define(REPORTS[operation].permission, `crm_read_${operation}`,
  `${description} ${PAGE}${Object.values(REPORTS[operation].reports).some(spec => spec.scope !== 'organization') ? ` ${NO_BUILDING}` : ''}`, {
  input: reportInput(operation), inputSchema: reportSchema(properties, required), resultKeys: REPORT_RESULT,
  result: reportResult(operation, REPORTS[operation].permission), reports: REPORTS[operation].reports });
const REPORT_READS = Object.freeze({
  occupancy_report: reportDefine('occupancy_report', 'Báo cáo lấp đầy: report=snapshot — từng toà có bao nhiêu phòng đang ở/giữ chỗ/bảo trì/không khai thác/trống, tỷ lệ lấp đầy và doanh thu bỏ lỡ tại ngày fromDate (mặc định hôm nay); report=upcoming — hợp đồng sắp hết hạn, phòng sắp trống trong days ngày tới (mặc định 30) kể từ fromDate.',
    { report: { enum: ['snapshot', 'upcoming'] }, fromDate: DATE, days: { type: ['integer', 'null'], minimum: 1, maximum: 365 }, buildingId: BUILDING, query: QUERY, limit: LIMIT, offset: OFFSET }, ['report']),
  invoice_report: reportDefine('invoice_report', 'Hoá đơn như trang Hoá đơn. report=search: lọc month (YYYY-MM), status (paid đã thu đủ, partial thu một phần, unpaid chưa thu đồng nào, cancelled chỉ hoá đơn huỷ; mặc định ẩn huỷ), query (số HĐ; tên khách nếu có quyền khách hàng); trả hạn, tổng/đã thu/còn lại, toà/phòng. Còn nợ kể cả thu một phần: crm_read_receivables. report=stats: tổng kỳ month trên các toà được đọc (số HĐ, tổng, đã thu, còn nợ, hoàn, phòng/điện/nước/dịch vụ; không gồm huỷ). Số tiền là chuỗi VND.',
    { report: { enum: ['search', 'stats'] }, month: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}$' }, status: { enum: [null, 'paid', 'partial', 'unpaid', 'cancelled'] },
      buildingId: BUILDING, query: QUERY, limit: LIMIT, offset: OFFSET }, ['report']),
  monthly_pnl: reportDefine('monthly_pnl', 'Lãi lỗ từng THÁNG của từng toà (doanh thu, chi phí, lãi ròng), fromDate..toDate ≤ 366 ngày, như "Phân tích tài chính": basis=accrual (mặc định, dồn tích theo kỳ phân bổ) hoặc cash (theo ngày phiếu). Hàng chỉ gồm phiếu ĐÃ DUYỆT; summary.pendingIncome/pendingExpense = thu/chi CHỜ DUYỆT cùng kỳ mà "BC Doanh Thu Chi Phí" cộng thêm — nói rõ phần này. Số tiền là chuỗi VND.',
    { fromDate: REQUIRED_DATE, toDate: REQUIRED_DATE, basis: { enum: [null, 'accrual', 'cash'] }, buildingId: BUILDING, query: QUERY, limit: LIMIT, offset: OFFSET }, ['fromDate', 'toDate']),
  pending_approvals: reportDefine('pending_approvals', `Việc chờ CHÍNH người hỏi duyệt (hộp /approvals): yêu cầu duyệt phiếu đang tới lượt bạn (mã, tên phiếu, số tiền, người lập, bước duyệt, lúc gửi). KHÔNG phải mọi phiếu thu/chi chưa duyệt: hỏi "phiếu chờ duyệt" thì dùng crm_read_income_expenses với status=UNAPPROVED. ${PRIVATE_HINT} ${ORG_ONLY}`,
    { query: QUERY, limit: LIMIT, offset: OFFSET }),
  zalo_conversations: reportDefine('zalo_conversations', `Danh sách hội thoại Zalo của công ty như trang Chat Zalo (cần quyền xem Chat Zalo toàn công ty như web): người nhắn, SĐT, phòng/toà gắn, số tin chưa đọc, ghim, tin cuối (≤160 ký tự) và tổng hợp chưa đọc; query tìm theo tên/SĐT/nhãn (không tìm trong nội dung tin). ${PRIVATE_HINT} ${ORG_ONLY}`,
    { query: QUERY, limit: LIMIT, offset: OFFSET }),
  contract_search: reportDefine('contract_search', `Tìm hợp đồng như danh sách Hợp đồng: query theo số HĐ, tên phòng, tên/SĐT khách; status như bộ lọc web (ACTIVE = mọi HĐ trừ đã thanh lý, TERMINATED, EXPIRING = còn ≤30 ngày, EXPIRED = quá endDate). Trả toà/phòng, ngày bắt đầu, endDate, expectedMoveOutDate, giá thuê, cọc và displayLabel như web (Còn hạn, Sắp hết hạn, Quá hạn, Sắp chuyển đi, Đã thanh lý, Đã nhượng). Tên khách đại diện và tìm theo tên/SĐT chỉ khi có quyền khách hàng (customers.view) ở mọi toà của kết quả, thiếu thì customerName=null. Chi tiết: crm_read_contract_detail. ${PRIVATE_HINT}`,
    { status: { enum: [null, 'ACTIVE', 'TERMINATED', 'EXPIRING', 'EXPIRED'] }, buildingId: BUILDING, query: QUERY, limit: LIMIT, offset: OFFSET }),
});

export const FULL_READS = Object.freeze({
  customer_detail: define('customers.view', 'crm_read_customer_detail',
    `Hồ sơ đầy đủ của MỘT khách như trang /customers/:id: họ tên, SĐT, email, CCCD/CMND (số dạng chữ, ngày/nơi cấp), ngày sinh, giới tính, địa chỉ chi tiết, chỗ ở hiện tại, thường trú, nghề nghiệp, nơi làm việc, người liên hệ khẩn cấp, ghi chú và các hợp đồng (≤20) ở toà mà quyền đọc hợp đồng (contracts.view) cho phép — thiếu thì contracts=[] (contractsVisible=false). Không có ảnh CCCD. customerId lấy từ crm_read_customers. item=null: không thấy hoặc ngoài phạm vi. ${PRIVATE_HINT}`,
    { input: detailInput('customerId'), inputSchema: detailSchema('customerId'), resultKeys: DETAIL_RESULT,
      result: detail('customerId', CUSTOMER_DETAIL_FIELDS, item => [['contracts.view', item.contracts.map(row => row.buildingId)]],
        item => !item.contractsVisible && item.contracts.length > 0) }),
  contract_detail: define('contracts.view', 'crm_read_contract_detail',
    `Chi tiết MỘT hợp đồng như trang /contracts/:id: số HĐ, trạng thái, toà/phòng, ngày ký/bắt đầu/kết thúc/dự kiến trả phòng, kỳ tính tiền, giá thuê, chu kỳ thanh toán, cọc (phải thu/đã thu/còn thiếu, nợ cọc), chỉ số điện nước ban đầu, ghi chú, người ở (≤10: SĐT, CCCD, ngày sinh, thường trú...; chỉ khi kết nối có quyền đọc khách hàng customers.view như web, thiếu thì tenants=[] và tenantsVisible=false) và dịch vụ kèm đơn giá. Không có file hợp đồng/ảnh CCCD. contractId lấy từ crm_read_contracts hoặc crm_read_customer_detail. item=null: không thấy hoặc ngoài phạm vi. ${PRIVATE_HINT}`,
    { input: detailInput('contractId'), inputSchema: detailSchema('contractId'), resultKeys: DETAIL_RESULT,
      result: detail('contractId', CONTRACT_DETAIL_FIELDS, item => [['contracts.view', [item.buildingId]], ...(item.tenantsVisible ? [['customers.view', [item.buildingId]]] : [])],
        item => !item.tenantsVisible && item.tenants.length > 0) }),
  ...REPORT_READS,
});
