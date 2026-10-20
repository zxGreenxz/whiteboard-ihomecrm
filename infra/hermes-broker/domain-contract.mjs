// Fixed, typed read projections. This catalog describes supported operations;
// grants always come from live CRM authority intersected with the saved overlay.
// One registry drives tools, input/result validation and the SQL family (fixed
// RPC pair) of each domain; the model never names a table, RPC or actor.
import { FULL_READS, PRIVATE_HINT } from './full-read-contract.mjs';
import { W2, W2_READS, W2_READ_KEY_LIST } from './wave2-registry.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const domainId = value => typeof value === 'string' && UUID.test(value);
export const domainRecord = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export const domainExact = (value, keys) => domainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
// MODEL INPUT ONLY (never SQL results): an RFC 3339 instant with an explicit zone,
// "YYYY-MM-DDTHH:MM[:SS[.f{1,3}]]" + "Z" or "±HH:MM". Returns the canonical
// toISOString() form the SQL writers require, or null. A zone-less string is
// refused: Date.parse would read it as host-local time. 16/10 21:27Z production:
// "2026-10-16T05:00:00Z" was refused only for lacking ".000".
const RFC3339 = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
export function canonicalInstant(value) {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second = 0, fraction = '0', sign, zoneHour = 0, zoneMinute = 0] =
    match.slice(1).map((part, index) => part === undefined || index === 6 || index === 7 ? part : Number(part));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
  const offset = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  const canonical = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0'))) - offset * 60_000).toISOString();
  return /^[1-9]\d{3}-/.test(canonical) ? canonical : null;
}
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
// Phát hành an toàn B5c (21/10/2026): SQL (3 migration 20261020171321/173818/173819, mỗi migration backup ~2,5 phút ⇒
// cửa sổ ~8 phút) và connector KHÔNG đổi cùng lúc. Trong cửa sổ đó SQL cũ trả dòng chưa có khoá mới, hoặc connector cũ
// nhận dòng có khoá mới. `tolerant` liệt kê các khoá MỚI của một miền (buildingName, buildingCode, roomName ở miền trước
// đây chưa có): vắng = chưa áp SQL ⇒ vẫn qua; có mặt ⇒ kiểm kiểu như mọi khoá; khoá lạ vẫn bị từ chối (domainResult).
// Tolerant MỘT bản phát hành: gỡ `tolerant` (về khuôn chính xác) ở bản sau khi prod đã áp đủ 3 migration.
const define = (permission, label, fields, statuses = [], options = {}) => Object.freeze({ family: 'v1', permission, label,
  fields: Object.freeze(fields), statuses: Object.freeze(statuses), dated: false, requiresDates: false, perBuilding: false, source: null, ...options,
  tolerant: Object.freeze([...(options.tolerant ?? [])]) });

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
  // Đọc đầy đủ cho người hỏi (20261016162104): đợt 1 dùng lại khoá ĐÃ CÓ do v1/v2/base cấp.
  // Đợt 2 (20261018000000) thêm hàm capabilities riêng cho các khoá đọc mới (wave2-registry);
  // chưa deploy (PGRST202) ⇒ null, các họ khác vẫn chạy. SQL quyết định cuối.
  v3: Object.freeze({ readRpc: 'hermes_domain_read_v3', capabilitiesRpc: 'hermes_domain_capabilities_v3', inputKeys: BASE_INPUT,
    resultKeys: Object.freeze([...BASE_RESULT, 'fetchedAt']), capabilities: W2_READ_KEY_LIST }),
  // Hai tool meta đợt 2 (20261018000600): lối vào INVOKER riêng, hàm gói chạy dưới RLS của người hỏi.
  // Khoá do capabilities v3 cấp; input/kết quả do wave2-registry kiểm (inputKeys/resultKeys không dùng).
  w2: Object.freeze({ readRpc: 'hermes_w2_read_v1', capabilitiesRpc: null, inputKeys: Object.freeze([]), resultKeys: Object.freeze([]),
    capabilities: Object.freeze([]) }),
});
export const DOMAIN_READS = Object.freeze({
  // 20/10: phòng/HĐ trong dòng là hợp đồng ĐANG hiệu lực (không phải "gần nhất"); bốn trường trống không nói gì về
  // việc đã trả phòng hay chưa thuê. Chỉ câu chữ; validator/chiếu trường không đổi.
  customers: define('customers.view', `Tra khách (tên, SĐT đầy đủ). contractId/buildingId/roomId/roomName = hợp đồng ĐANG hiệu lực, cần quyền hợp đồng; trống = không thấy HĐ đang hiệu lực trong phạm vi được xem (không suy ra đã trả phòng/chưa thuê); lịch sử HĐ: crm_read_customer_detail. Toàn tổ chức thấy cả khách chưa có HĐ. Lỗi ≠ rỗng; số dòng một trang ≠ tổng số. ${PRIVATE_HINT}`, {
    id: domainId, name: text, phone: nullable(text), contractId: nullable(domainId), buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId),
    roomName: nullable(text) }, [], { family: 'v3', tolerant: ['buildingName'] }),
  // B5c bước 2 (20261020173818/173819): mọi tool danh sách trả buildingName (chữ, có thể rỗng) cạnh buildingId và
  // roomName cạnh roomId — chỉ UUID thì model không gom theo toà được (prod 21/10). Mô tả không đổi; khoá mới `tolerant`
  // (vắng được) cho tới bản sau khi prod đã áp SQL — xem chú thích ở define.
  leads: define('leads.view', 'Tra khách hẹn và mốc liên hệ tiếp theo', {
    id: domainId, name: text, status: text, buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId), roomName: nullable(text), nextFollowUp: nullable(text) },
  ['B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTATION', 'CONVERTED', 'FAILED'], { tolerant: ['buildingName', 'roomName'] }),
  // 21/10: status=ACTIVE là trạng thái DB. "Đang ở" như màn Hợp đồng web = mọi trạng thái trừ TERMINATED; "đang ở" của
  // một phòng = HĐ ACTIVE. Sắp hết hạn/quá hạn/thanh lý: crm_read_contract_search. Chỉ câu chữ; validator không đổi.
  contracts: define('contracts.view', 'Tra hợp đồng và thời hạn thuê. status=ACTIVE là trạng thái DB; "đang ở" như màn Hợp đồng = trừ TERMINATED, của phòng = ACTIVE; sắp hết hạn/quá hạn/thanh lý: crm_read_contract_search', {
    id: domainId, number: nullable(text), status: text, buildingId: domainId, buildingName: text, roomId: domainId, roomName: nullable(text), startDate: nullable(date), endDate: nullable(date) },
  ['DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED'], { tolerant: ['buildingName', 'roomName'] }),
  invoices: define('invoices.view', 'Tra hóa đơn; số tiền giữ dạng chuỗi thập phân', {
    id: domainId, number: nullable(text), status: text, buildingId: domainId, buildingName: text, roomId: domainId, roomName: nullable(text), billingMonth: nullable(text), totalAmount: amount },
  [], { tolerant: ['buildingName', 'roomName'] }),
  assets: define('assets.view', 'Tra tài sản, vị trí và số lượng', {
    id: domainId, name: text, code: nullable(text), condition: nullable(text), buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId), roomName: nullable(text), quantity: amount },
  [], { tolerant: ['buildingName', 'roomName'] }),
  services: define('services.view', 'Tra danh mục dịch vụ và các tòa áp dụng được phép xem', {
    id: domainId, name: text, code: nullable(text), unit: nullable(text), unitPrice: amount, buildingIds: ids }),
  tasks: define('tasks.view', 'Tra công việc và hạn hoàn thành', {
    id: domainId, title: text, code: nullable(text), status: text, buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId), roomName: nullable(text), deadline: nullable(text) },
  ['IN_PROGRESS', 'COMPLETED'], { tolerant: ['buildingName', 'roomName'] }),
  // Đọc snapshot như trang Báo cáo lấp đầy (occupancy_snapshot_v2), không đếm rooms.status (họ v3, 20261017021554).
  occupancy: define('reports_real_estate.occupancy', 'Số phòng đang ở/trống/tổng từng toà hôm nay như Báo cáo lấp đầy; giữ chỗ, tỷ lệ, dự báo: crm_read_occupancy_report', {
    id: domainId, buildingId: domainId, name: text, total: integer, occupied: integer, available: integer }, [], { perBuilding: true, family: 'v3' }),
  income_expenses: define('income_expenses.view', 'Tra phiếu thu/chi theo ngày phiếu và trạng thái duyệt (UNAPPROVED = chờ duyệt; hỏi "phiếu chờ duyệt" thì dùng tool này với status=UNAPPROVED). Không gồm phiếu có hạng mục hạn chế, lương, cổ đông; không trả người nộp/nhận, tài khoản, ghi chú, chứng từ. Số tiền là chuỗi VND', {
    id: domainId, code: nullable(text), type: oneOf(['INCOME', 'EXPENSE']), name: text, buildingId: domainId, buildingName: text, roomId: nullable(domainId),
    roomName: nullable(text), voucherDate: date, totalAmount: amount, approvalStatus: oneOf(['UNAPPROVED', 'APPROVED', 'CANCELLED']) },
  ['UNAPPROVED', 'APPROVED', 'CANCELLED'], { family: 'v2', dated: true, source: 'crm.income_expenses', tolerant: ['buildingName'] }),
  // B5c (20261020171321): buildingName/buildingCode on each debt — with buildingId (UUID) alone the model could not
  // group "phòng nào chưa đóng tiền" by building (room "201" repeats across buildings). Both SQL lanes project them.
  receivables: define('invoices.view', 'Tra công nợ: hoá đơn đã duyệt/thu một phần/quá hạn còn tiền chưa thu (remainingAmount do CRM tính); lọc theo hạn thanh toán; có tên toà — gom theo toà khi nhiều phòng', {
    id: domainId, number: nullable(text), status: oneOf(['APPROVED', 'PARTIAL_PAID', 'OVERDUE']), buildingId: domainId, buildingName: text, buildingCode: nullable(text),
    roomId: domainId, roomName: nullable(text), billingMonth: nullable(text), dueDate: nullable(date), totalAmount: amount, paidAmount: amount, remainingAmount: amount },
  ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'], { family: 'v2', dated: true, source: 'crm.invoices', tolerant: ['buildingName', 'buildingCode'] }),
  meter_readings: define('meter_readings.view', 'Tra chỉ số công tơ điện/nước theo ngày đọc và trạng thái duyệt; tiêu thụ do CRM tính', {
    id: domainId, code: nullable(text), buildingId: domainId, buildingName: text, roomId: nullable(domainId), roomName: nullable(text),
    meterType: oneOf(['ELECTRICITY', 'WATER', 'GAS', 'OTHER']), settlementMonth: nullable(text), readingDate: date,
    previousReading: amount, currentReading: amount, consumption: amount, status: oneOf(['UNAPPROVED', 'APPROVED']) },
  ['UNAPPROVED', 'APPROVED'], { family: 'v2', dated: true, source: 'crm.meter_readings', tolerant: ['buildingName'] }),
  deposits_held: define('deposits.view', 'Tổng cọc của hợp đồng đang hiệu lực theo từng toà từ báo cáo cọc CRM (phải thu, đã giữ, còn thiếu); không có chi tiết khách', {
    id: domainId, buildingId: domainId, name: text, contractCount: integer, expected: amount, held: amount, shortfallAll: amount,
    shortfallShort: amount, fullCount: integer, shortCount: integer, firstInvoiceCount: integer },
  [], { family: 'v2', perBuilding: true, source: 'crm.get_held_deposit_summary' }),
  building_profit: define('reports_finance.analysis', 'Lãi lỗ kết quả kinh doanh theo toà trong kỳ fromDate..toDate (≤ 366 ngày) từ báo cáo tài chính CRM: phiếu đã duyệt, tính theo ngày phiếu; toà không có số liệu không xuất hiện', {
    id: domainId, buildingId: domainId, name: text, revenue: amount, expense: amount, net: amount, months: integer },
  [], { family: 'v2', perBuilding: true, dated: true, requiresDates: true, source: 'crm.fa_monthly_pnl' }),
  // Họ v3 chi tiết/báo cáo (full-read-contract): sau cùng để thứ tự tool cũ không đổi.
  ...FULL_READS,
  // Đợt 2: hai tool meta crm_read_report_list / crm_read_report (wave2-registry.mjs, điểm đăng ký cố định).
  ...W2_READS,
});
// Family v1 keys keep their historic export (capability contract, schedule and
// CDE fixtures). v2 keys are separate until the capability contract adds them.
export const DOMAIN_READ_CAPABILITIES = DOMAIN_FAMILIES.v1.capabilities;
export const DOMAIN_READ_CAPABILITIES_V2 = DOMAIN_FAMILIES.v2.capabilities;
export const DOMAIN_READ_CAPABILITIES_V3 = DOMAIN_FAMILIES.v3.capabilities;
export const ALL_DOMAIN_READ_CAPABILITIES = Object.freeze([...DOMAIN_FAMILIES.v1.capabilities, ...DOMAIN_FAMILIES.v2.capabilities, ...DOMAIN_FAMILIES.v3.capabilities]);
export const domainFamily = operation => Object.hasOwn(DOMAIN_READS, operation) ? DOMAIN_FAMILIES[DOMAIN_READS[operation].family] : undefined;
export const domainOperation = name => typeof name === 'string' && name.startsWith('crm_read_') && Object.hasOwn(DOMAIN_READS, name.slice(9)) ? name.slice(9) : undefined;
// Fixed private read plan (hermes_domain_read_fast_v1, 20261019040111; receivables
// since 20261020101836 B2): the domains the broker routes through the fast mount
// when the host opts in (readFastPath). Missing SQL fails closed, never falls back.
export const FAST_READ_OPERATIONS = Object.freeze(['customers', 'contracts', 'invoices', 'receivables']);
// B2-2 (20/10): under the same host opt-in, every other domain keeps its reviewed RPC and the seven-key
// binding built from the live connection snapshot, but admits through the bounded read catalog and skips
// the broker's second authority build: hermes_domain_read_v1/v2/v3 and hermes_w2_read_v1 compare the caller
// JWT session and all seven binding fields themselves (42501/PT409), so verifySession/checkUnchanged only
// repeated that decision. Only keys the read catalog authority can grant qualify (server.mjs: base Auth
// self/rooms.view + the three capability families); chat_zalo.view comes from the group adapter, so
// zalo_conversations stays on the full authority — the cached lane could only refuse it.
const READ_CATALOG_KEYS = Object.freeze(['assistant.context.read', 'rooms.view', ...ALL_DOMAIN_READ_CAPABILITIES]);
const readKeys = definition => definition.family === 'w2' ? W2.permissions : [definition.permission];
export const CACHED_READ_OPERATIONS = Object.freeze(Object.keys(DOMAIN_READS).filter(operation =>
  !FAST_READ_OPERATIONS.includes(operation) && readKeys(DOMAIN_READS[operation]).every(key => READ_CATALOG_KEYS.includes(key))));
// Không input (tools/list, chặn sớm): tool có hiện không. Có input đã kiểm (đợt 2: crm_read_report):
// đúng khoá của báo cáo được gọi. Họ cũ: một khoá cố định, input không đổi kết quả.
export const mayUseDomain = (effective, operation, input) => {
  if (!Object.hasOwn(DOMAIN_READS, operation)) return false;
  const definition = DOMAIN_READS[operation];
  if (typeof definition.mayUse === 'function') return definition.mayUse(effective, input) === true;
  return effective?.read?.includes(definition.permission) === true;
};
export function domainInput(operation, input) {
  if (!Object.hasOwn(DOMAIN_READS, operation)) fail();
  const definition = DOMAIN_READS[operation], family = domainFamily(operation);
  // Đọc đầy đủ (v3): mỗi thao tác chi tiết/báo cáo có schema riêng trong full-read-contract.
  if (typeof definition.input === 'function') { try { return definition.input(input); } catch { fail(); } }
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
  if (typeof definition?.result === 'function') {
    if (!domainExact(value, definition.resultKeys) || value.organizationId !== identity.row.organizationId || value.domain !== operation ||
        !instant(value.fetchedAt)) fail();
    let projected; try { projected = definition.result(value, identity, input); } catch { fail(); }
    // outputKeys (đợt 2): khoá chỉ dùng để rào (fence) không đi tới mô hình.
    return Object.fromEntries((definition.outputKeys ?? definition.resultKeys).map(key => [key, Object.hasOwn(projected, key) ? projected[key] : value[key]]));
  }
  if (!definition || !domainExact(value, family.resultKeys) ||
      value.organizationId !== identity.row.organizationId || value.domain !== operation || !Array.isArray(value.items) ||
      value.items.length > input.limit || !nullable(domainId)(value.nextCursor) ||
      family === DOMAIN_FAMILIES.v2 && (value.source !== definition.source || !instant(value.fetchedAt)) ||
      family === DOMAIN_FAMILIES.v3 && !instant(value.fetchedAt)) fail();
  const scopes = identity.scopesByPermission?.[definition.permission]?.buildingIds;
  // SQL is final authority. If supplied, the earlier CRM scope also fences output;
  // it is never a substitute for the saved authorization_scopes overlay in SQL.
  const items = value.items.map(row => {
    // Khuôn dòng cố định: không khoá lạ, mọi khoá đã khai phải có mặt và đúng kiểu — trừ khoá `tolerant` (mới thêm,
    // một bản phát hành): vắng = SQL chưa áp ⇒ qua; có mặt ⇒ kiểm kiểu như thường.
    if (!domainRecord(row) || !Object.keys(row).every(key => Object.hasOwn(definition.fields, key)) ||
        Object.entries(definition.fields).some(([key, check]) => Object.hasOwn(row, key) ? !check(row[key]) : !definition.tolerant.includes(key))) fail();
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
// 16/10 19:44Z production: the model put a building code in `query` (text filter
// inside each row ⇒ empty), took the company id as buildingId, and repeated the
// same call 20+ times reading [] as a glitch. Wording only; validators unchanged.
// 21/10 (B5d, audit 26 tool đọc): một câu hint chung "(tên, phòng, mã)" hứa thứ SQL
// không làm (customers chỉ khớp tên/SĐT; occupancy/deposits/building_profit khớp
// TÊN TOÀ). Hint nay theo cột SQL thật của từng miền (v1 20261014081902, v2
// 20261015120000, v3 20261017033630, lõi nhanh 20261019040055).
export const READ_QUERY_HINTS = Object.freeze({
  customers: 'Tên hoặc SĐT khách; không khớp phòng.',
  leads: 'Tên khách hẹn.',
  contracts: 'Số HĐ; đường nhanh thêm tên phòng, khách.',
  invoices: 'Số hoá đơn; đường nhanh thêm tên khách.',
  assets: 'Tên hoặc mã tài sản.',
  services: 'Tên hoặc mã dịch vụ.',
  tasks: 'Tên hoặc mã công việc.',
  occupancy: 'Tên toà.',
  income_expenses: 'Tên hoặc mã phiếu; không khớp phòng.',
  receivables: 'Số hoá đơn hoặc tên phòng.',
  meter_readings: 'Mã chỉ số hoặc tên phòng.',
  deposits_held: 'Tên toà.',
  building_profit: 'Tên toà.',
});
// 21/10 rút chữ (tools/list ≤ 64 000 B sau khi thêm buildingName/roomName); giữ đủ ba ý của sự cố 16/10.
export const DOMAIN_BUILDING_HINT = 'ID toà (không phải công ty).';
export const EMPTY_RESULT_HINT = 'Rỗng là thật; không gọi lại.';
// B5d (21/10/2026; sự cố 00:11 "khách nào đang ở phòng London 5 950NK" → crm_read_customers
// {buildingId, query:"LONDON 5"} → 0): mọi tool đọc danh sách nhận TÊN toà (buildingName) và,
// nơi hàng có phòng, TÊN phòng (roomName). Connector giải tên → ID qua danh bạ trong phạm vi
// (read-name-resolution.mjs; hermes_building_directory_v1/hermes_room_directory_v1,
// 20261020175803) sau khi có JWT + identity và TRƯỚC validator; SQL đọc và tập khoá input
// không đổi (hermes_request_v1 khoá đúng tập khoá; các hàm đọc thuộc B5c). Cách lọc phòng:
//   rows  — SQL không nhận ID phòng: connector lọc hàng của trang theo roomId (trang SQL 50
//           dòng, tự lấy tới 4 trang rồi gộp, giữ thứ tự, cursor/offset vẫn dùng được);
//           queryRoom = lane mà SQL khớp room.name trong `query` ('always' | 'fast' | null):
//           khi query trống thì đặt query = tên phòng để trang hẹp hơn, rồi vẫn lọc hàng.
//   param — crm_read_report: params.roomId (SQL lọc thật; đúng một phòng).
// Phòng trùng tên ở nhiều toà mà không nêu toà: như web (gộp mọi phòng cùng tên) tới 5 phòng;
// hơn thì báo lỗi nêu toà. Toà mơ hồ (≥2 khớp) luôn báo lỗi nêu tên.
export const READ_NAME_LIMITS = Object.freeze({ buildingName: 120, roomName: 60 });
const names = (room, queryRoom = null, options = {}) => Object.freeze({ room, queryRoom, paging: 'cursor', reports: null, ...options });
export const READ_NAMES = Object.freeze({
  customers: names('rows'), leads: names(null), contracts: names('rows', 'fast'), invoices: names('rows'), assets: names('rows'),
  services: names(null), tasks: names('rows'), occupancy: names(null), income_expenses: names('rows'), receivables: names('rows', 'always'),
  meter_readings: names('rows', 'always'), deposits_held: names(null), building_profit: names(null),
  occupancy_report: names(null, null, { paging: 'offset' }), invoice_report: names('rows', null, { paging: 'offset', reports: Object.freeze(['search']) }),
  monthly_pnl: names(null, null, { paging: 'offset' }), contract_search: names('rows', 'always', { paging: 'offset' }),
  report: names('param'),
});
export const BUILDING_NAME_HINT = 'Tên/mã toà thay buildingId.';
export const ROOM_NAME_HINT = 'Tên/mã phòng (lọc trang).';
// Không quảng bá maxLength (−423 B trên tools/list 64 000 B); splitReadNames vẫn chặn theo READ_NAME_LIMITS.
export const readNameProperties = operation => {
  const spec = READ_NAMES[operation];
  if (!spec || spec.room === 'param') return {};
  return { buildingName: { type: 'string', description: BUILDING_NAME_HINT },
    ...(spec.room ? { roomName: { type: 'string', description: spec.reports ? `${ROOM_NAME_HINT} Chỉ report=${spec.reports.join('/')}.` : ROOM_NAME_HINT } } : {}) };
};
const withReadNames = (operation, schema) => {
  const extra = readNameProperties(operation);
  return Object.keys(extra).length ? { ...schema, properties: { ...schema.properties, ...extra } } : schema;
};
const NAME_CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
/** Tách buildingName/roomName khỏi đối số tool đọc TRƯỚC validator hiện có (validator và tập khoá SQL
 * không đổi). Trả { args: bản không còn tên, names: null | {buildingName?, roomName?} } — chuỗi trống/khoảng
 * trắng coi như không gửi; sai kiểu/quá dài/ký tự điều khiển ⇒ TypeError (broker: invalid_request).
 * crm_read_report mang tên trong params. Tool không khai tên (chi tiết, mục lục, zalo, chờ duyệt) trả nguyên. */
export function splitReadNames(operation, args) {
  const spec = Object.hasOwn(READ_NAMES, operation) ? READ_NAMES[operation] : null;
  if (!spec || !domainRecord(args)) return { args, names: null };
  const nested = spec.room === 'param';
  const source = nested ? args.params : args;
  if (!domainRecord(source)) return { args, names: null };
  const picked = {}, rest = { ...source };
  for (const key of Object.keys(READ_NAME_LIMITS)) {
    if (!Object.hasOwn(rest, key)) continue;
    const value = rest[key]; delete rest[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || NAME_CONTROL.test(value) || [...value].length > READ_NAME_LIMITS[key]) throw new TypeError('invalid_read_name');
    const trimmed = value.trim();
    if (trimmed !== '') picked[key] = trimmed;
  }
  const names = Object.keys(picked).length ? picked : null;
  return { args: nested ? { ...args, params: rest } : rest, names };
}
export const DOMAIN_TOOLS = Object.freeze(Object.entries(DOMAIN_READS).map(([operation, definition]) => Object.freeze(definition.inputSchema ? {
  name: `crm_read_${operation}`, description: definition.description, inputSchema: withReadNames(operation, definition.inputSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} : {
  name: `crm_read_${operation}`, description: `${definition.label}. ${EMPTY_RESULT_HINT}`,
  inputSchema: { type: 'object', additionalProperties: false, ...(definition.requiresDates ? { required: ['fromDate', 'toDate'] } : {}), properties: {
    query: { type: 'string', maxLength: 200, description: READ_QUERY_HINTS[operation] }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: ['string', 'null'], format: 'uuid' }, buildingId: { type: ['string', 'null'], format: 'uuid', description: DOMAIN_BUILDING_HINT },
    ...readNameProperties(operation), status: { enum: [null, ...definition.statuses] },
    ...(definition.dated ? { fromDate: dateSchema(definition.requiresDates), toDate: dateSchema(definition.requiresDates) } : {}),
  } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
})));
