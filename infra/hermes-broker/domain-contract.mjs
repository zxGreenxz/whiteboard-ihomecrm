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
// Cửa sổ phát hành khi đổi khuôn dòng: SQL (migration qua forward lane, mỗi migration backup ~2,5 phút) và connector
// KHÔNG đổi cùng lúc, nên SQL cũ có thể trả dòng chưa có khoá mới. `tolerant` liệt kê các khoá MỚI của một miền cho đúng
// MỘT bản phát hành: vắng = chưa áp SQL ⇒ vẫn qua; có mặt ⇒ kiểm kiểu như mọi khoá; khoá lạ vẫn bị từ chối (domainResult).
// B5c (21/10/2026; 3 migration 20261020171321/173818/173819: buildingName, buildingCode, roomName) đã dùng cơ chế này;
// đã gỡ 21/10 sau khi prod áp đủ 3 migration B5c. R2c phần 2 (assets.createdAt, 20261021044801) cũng đã gỡ ở bản R2d:
// production áp đủ bốn migration R2c 21/10 (13:16–13:31 giờ VN). Mốc 3b Công việc (22/10): tasks.assigneeName
// (20261022153345) — connector lên TRƯỚC migration; gỡ ở bản connector kế tiếp sau khi production áp.
// flags (Công việc lượt 14): khoá boolean THÊM của riêng một miền, chỉ gửi SQL khi true ⇒ input năm khoá của SQL cũ không đổi khi
// không dùng; { tên: mô tả trong tools/list }.
const define = (permission, label, fields, statuses = [], options = {}) => Object.freeze({ family: 'v1', permission, label,
  fields: Object.freeze(fields), statuses: Object.freeze(statuses), dated: false, requiresDates: false, perBuilding: false, source: null, ...options,
  tolerant: Object.freeze([...(options.tolerant ?? [])]), flags: Object.freeze({ ...(options.flags ?? {}) }) });

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
  // R2b (21/10, C4): bỏ câu "Lỗi ≠ rỗng; số dòng một trang ≠ tổng số." — SOUL v4 và `summary` (R2a) đã phủ; −58 B tools/list.
  customers: define('customers.view', `Tra khách (tên, SĐT đầy đủ). contractId/buildingId/roomId/roomName = hợp đồng ĐANG hiệu lực, cần quyền hợp đồng; trống = không thấy HĐ đang hiệu lực trong phạm vi được xem (không suy ra đã trả phòng/chưa thuê); lịch sử HĐ: crm_read_customer_detail. Toàn tổ chức thấy cả khách chưa có HĐ. ${PRIVATE_HINT}`, {
    id: domainId, name: text, phone: nullable(text), contractId: nullable(domainId), buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId),
    roomName: nullable(text) }, [], { family: 'v3' }),
  // B5c bước 2 (20261020173818/173819): mọi tool danh sách trả buildingName (chữ, có thể rỗng) cạnh buildingId và
  // roomName cạnh roomId — chỉ UUID thì model không gom theo toà được (prod 21/10). Mô tả không đổi; hai khoá nay BẮT
  // BUỘC có mặt (`tolerant` đã gỡ 21/10 sau khi prod áp đủ SQL — xem chú thích ở define).
  leads: define('leads.view', 'Tra khách hẹn và mốc liên hệ tiếp theo', {
    id: domainId, name: text, status: text, buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId), roomName: nullable(text), nextFollowUp: nullable(text) },
  ['B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTATION', 'CONVERTED', 'FAILED']),
  // 21/10: status=ACTIVE là trạng thái DB. "Đang ở" như màn Hợp đồng web = mọi trạng thái trừ TERMINATED. R2b (câu 13/14):
  // tool KHÔNG lọc ngày — câu đầu (≤ 60 ký tự, phần danh sách tool_search hiện) chỉ thẳng contract_search; sau đó EXPIRING
  // (≤30 ngày) / occupancy_report upcoming days=N / EXPIRED, TERMINATED. Gọi kèm ngày nhận hint (read-misuse-hints.mjs).
  // Chỉ câu chữ; validator không đổi.
  contracts: define('contracts.view', 'Tra hợp đồng; KHÔNG lọc ngày (sắp hết hạn: contract_search). ≤30 ngày: crm_read_contract_search status=EXPIRING; N ngày: crm_read_occupancy_report upcoming days=N; quá hạn/thanh lý: contract_search EXPIRED/TERMINATED. status=ACTIVE là trạng thái DB ("đang ở" web = trừ TERMINATED)', {
    id: domainId, number: nullable(text), status: text, buildingId: domainId, buildingName: text, roomId: domainId, roomName: nullable(text), startDate: nullable(date), endDate: nullable(date) },
  ['DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED']),
  invoices: define('invoices.view', 'Tra hóa đơn; số tiền giữ dạng chuỗi thập phân', {
    id: domainId, number: nullable(text), status: text, buildingId: domainId, buildingName: text, roomId: domainId, roomName: nullable(text), billingMonth: nullable(text), totalAmount: amount }),
  // R2b (câu 73): xe không phải tài sản — báo cáo vehicles của crm_read_report; câu đầu đúng 60 ký tự (danh sách tool_search).
  // R2c phần 2 (câu "tài sản nào thêm gần đây nhất"): createdAt = ngày thêm (múi giờ nghiệp vụ của công ty, 20261021044801);
  // bắt buộc từ bản R2d (cửa sổ một bản đã đóng: production áp 20261021044801). Mô tả không đổi (0 byte tools/list).
  assets: define('assets.view', 'Tra tài sản, vị trí, số lượng; xe: crm_read_report vehicles', {
    id: domainId, name: text, code: nullable(text), condition: nullable(text), buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId), roomName: nullable(text), quantity: amount,
    createdAt: date }),
  services: define('services.view', 'Tra danh mục dịch vụ và các tòa áp dụng được phép xem', {
    id: domainId, name: text, code: nullable(text), unit: nullable(text), unitPrice: amount, buildingIds: ids }),
  // Mốc 3b (ma trận Công việc 22/10, CV-R03/R04): assigneeName = tên người nhận như web /tasks (null = chưa giao); query
  // khớp thêm tên người nhận (bỏ dấu) — lọc theo người không thêm khoá input (20261022153345). Cửa sổ một bản: tolerant.
  // Lượt 14 (nghiệm thu C3f): givenByMe=true ⇒ dòng VÀ mọi phần summary (byBuilding, byAssignee, overdue) chỉ gồm việc người hỏi giao
  // cho người khác (20261025003100); không lọc thì summary.givenByMe chỉ là số đếm.
  tasks: define('tasks.view', 'Tra công việc và hạn hoàn thành; việc anh/chị giao cho người khác: givenByMe=true', {
    id: domainId, title: text, code: nullable(text), status: text, buildingId: nullable(domainId), buildingName: text, roomId: nullable(domainId), roomName: nullable(text), deadline: nullable(text),
    assigneeName: nullable(text) },
  ['IN_PROGRESS', 'COMPLETED'], { tolerant: ['assigneeName'],
    flags: { givenByMe: 'true = chỉ việc anh/chị giao cho người khác (đếm theo toà/người nhận cũng chỉ trên tập đó)' } }),
  // Đọc snapshot như trang Báo cáo lấp đầy (occupancy_snapshot_v2), không đếm rooms.status (họ v3, 20261017021554).
  occupancy: define('reports_real_estate.occupancy', 'Số phòng đang ở/trống/tổng từng toà hôm nay như Báo cáo lấp đầy; giữ chỗ, tỷ lệ, dự báo: crm_read_occupancy_report', {
    id: domainId, buildingId: domainId, name: text, total: integer, occupied: integer, available: integer }, [], { perBuilding: true, family: 'v3' }),
  // R2b (câu 32/36): "phiếu chờ duyệt" — toàn công ty hay theo toà — là tool này với status=UNAPPROVED, không phải hộp
  // duyệt cá nhân crm_read_pending_approvals (mô tả bên đó chỉ ngược về đây; hint khi gọi nhầm ở read-misuse-hints.mjs).
  // Câu đầu ≤ 60 ký tự mang cụm phân biệt (danh sách tool_search chỉ hiện chừng đó); tên tool kia trong mô tả cũng đưa
  // các từ "pending approvals" vào chỉ mục BM25 của tool này.
  income_expenses: define('income_expenses.view', 'Phiếu thu/chi; chờ duyệt: status=UNAPPROVED (cả theo toà). Không dùng crm_read_pending_approvals cho phiếu. Lọc ngày phiếu, trạng thái duyệt, toà. Không gồm phiếu hạng mục hạn chế, lương, cổ đông; không trả người nộp/nhận, tài khoản, ghi chú, chứng từ. Tiền là chuỗi VND. Phiếu CHI chờ duyệt quá N ngày: crm_read_report report=expense_vouchers days=N', {
    id: domainId, code: nullable(text), type: oneOf(['INCOME', 'EXPENSE']), name: text, buildingId: domainId, buildingName: text, roomId: nullable(domainId),
    roomName: nullable(text), voucherDate: date, totalAmount: amount, approvalStatus: oneOf(['UNAPPROVED', 'APPROVED', 'CANCELLED']) },
  ['UNAPPROVED', 'APPROVED', 'CANCELLED'], { family: 'v2', dated: true, source: 'crm.income_expenses' }),
  // B5c (20261020171321): buildingName/buildingCode on each debt — with buildingId (UUID) alone the model could not
  // group "phòng nào chưa đóng tiền" by building (room "201" repeats across buildings). Both SQL lanes project them.
  receivables: define('invoices.view', 'Tra công nợ: hoá đơn đã duyệt/thu một phần/quá hạn còn tiền chưa thu (remainingAmount do CRM tính); lọc theo hạn thanh toán; có tên toà — gom theo toà khi nhiều phòng', {
    id: domainId, number: nullable(text), status: oneOf(['APPROVED', 'PARTIAL_PAID', 'OVERDUE']), buildingId: domainId, buildingName: text, buildingCode: nullable(text),
    roomId: domainId, roomName: nullable(text), billingMonth: nullable(text), dueDate: nullable(date), totalAmount: amount, paidAmount: amount, remainingAmount: amount },
  ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'], { family: 'v2', dated: true, source: 'crm.invoices' }),
  meter_readings: define('meter_readings.view', 'Tra chỉ số công tơ điện/nước theo ngày đọc và trạng thái duyệt; tiêu thụ do CRM tính', {
    id: domainId, code: nullable(text), buildingId: domainId, buildingName: text, roomId: nullable(domainId), roomName: nullable(text),
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
  // Họ v3 chi tiết/báo cáo (full-read-contract): sau cùng để thứ tự tool cũ không đổi.
  ...FULL_READS,
  // Đợt 2: hai tool meta crm_read_report_list / crm_read_report (wave2-registry.mjs, điểm đăng ký cố định).
  ...W2_READS,
});
// R2a (21/10/2026): `summary` của mọi tool danh sách — SQL tính trên TOÀN tập đã lọc (query/buildingId/status/fromDate/
// toDate), bỏ cursor/limit, cùng phạm vi với items (20261020233934: v1, v2, đọc nhanh; 20261021004841: v3 customers/
// occupancy). Mô hình đọc count/tổng ở đây thay vì tự đếm/cộng hàng (T9) hay đọc thêm trang để đếm (T5). Khuôn chung
// {count, byStatus, sum}: count = số dòng cả tập; byStatus = số dòng theo cột trạng thái (assets: condition), chỉ giá trị
// có mặt; sum = tiền/số lượng dạng chuỗi như items. Phần riêng: tasks.overdue; income_expenses byType/largest (tiền
// KHÔNG gồm phiếu CANCELLED, count/byStatus gồm); receivables byBuilding (≤ 50 toà, remainingAmount giảm dần);
// meter_readings byType/rooms; occupancy/deposits_held/building_profit tổng các toà. Đường nhanh: contracts.byStatus = null
// khi có query (lõi khớp ILIKE nhiều cột, SQL không chép lại); customers/contracts/invoices đếm như lõi (có thể > số
// dòng chiếu khi lõi gồm dòng không phòng) ⇒ connector chỉ đòi count ≥ items.length, đẳng thức kiểm ở test SQL.
// Mỗi summary kiểm chính xác theo miền (khoá lạ/sai kiểu ⇒ backend_unavailable) và các bất biến ở domainSummary.
// R2c (21/10/2026; prod: "khoản chi lớn nhất tháng này" ⇒ crm_read_income_expenses {fromDate,toDate} không lọc loại, nên
// summary.largest là một phiếu THU): mỗi phần tử byType thêm `largest` — phiếu lớn nhất CỦA LOẠI đó trên tập đã lọc, bỏ
// CANCELLED, cùng khuôn summary.largest; summary.largest (cả hai loại) giữ nguyên cho tương thích.
const summaryCounts = (keys = null) => value => domainRecord(value) && Object.keys(value).length <= 32 &&
  Object.entries(value).every(([key, n]) => (keys === null ? text(key) && key !== '' : keys.includes(key)) && integer(n));
const summarySums = keys => value => domainExact(value, keys) && keys.every(key => amount(value[key]));
const LARGEST_FIELDS = Object.freeze({ id: domainId, code: nullable(text), name: text, type: oneOf(['INCOME', 'EXPENSE']), totalAmount: amount, voucherDate: date });
const summaryLargest = value => domainExact(value, Object.keys(LARGEST_FIELDS)) && Object.entries(LARGEST_FIELDS).every(([key, check]) => check(value[key]));
// {count, sum, largest}; {count, sum} (SQL R2a) chỉ qua trong cửa sổ DOMAIN_SUMMARY_ENTRY_TOLERANT (đã đóng ở bản R2d) và đồng
// loạt (domainSummary).
const summaryTyped = value => (domainExact(value, ['count', 'sum']) || domainExact(value, ['count', 'sum', 'largest']) && nullable(summaryLargest)(value.largest)) &&
  integer(value.count) && amount(value.sum);
const BY_BUILDING_FIELDS = Object.freeze({ buildingId: domainId, buildingName: text, count: integer, remainingAmount: amount });
// Mốc 3b Công việc (ma trận 22/10, CV-R01/R06: mô hình tự cộng các trang và cộng sai; 20261022153345): việc của CẢ tập lọc theo
// toà / người nhận (≤50 nhóm, nhiều việc trước; null = việc không toà / chưa giao) và việc người hỏi đã giao cho người khác.
const TASK_GROUP_FIELDS = Object.freeze({
  byBuilding: Object.freeze({ buildingId: nullable(domainId), buildingName: text, count: integer, overdue: integer }),
  byAssignee: Object.freeze({ assigneeName: nullable(text), count: integer, overdue: integer }) });
const taskGroups = fields => value => Array.isArray(value) && value.length <= 50 && value.every(entry => domainExact(entry, Object.keys(fields)) &&
  Object.entries(fields).every(([key, check]) => check(entry[key])));
const taskGiven = value => domainExact(value, ['count', 'overdue']) && integer(value.count) && integer(value.overdue);
// R2c phần 2: phần tử mới nhất của tài sản (assets.latest) — như dòng, thêm ngày thêm vào (createdAt).
const ASSET_LATEST_FIELDS = Object.freeze({ id: domainId, name: text, code: nullable(text), buildingId: nullable(domainId), buildingName: text,
  roomName: nullable(text), createdAt: date });
const summaryAssetLatest = value => domainExact(value, Object.keys(ASSET_LATEST_FIELDS)) && Object.entries(ASSET_LATEST_FIELDS).every(([key, check]) => check(value[key]));
// R2c phần 2: tình trạng hợp đồng của khách = customers.status_v2, đúng ba tab của trang /customers.
export const CUSTOMER_CONTRACT_STATUSES = Object.freeze(['RENTING', 'MOVED_OUT', 'WALK_IN']);
const summaryShape = (fields, statusKey = null) => Object.freeze({ fields: Object.freeze(fields), statusKey });
const COMMON = (byStatus, sum = []) => ({ count: integer, byStatus, sum: summarySums(sum) });
export const DOMAIN_SUMMARIES = Object.freeze({
  // R2c phần 2: byStatus đếm khách theo status_v2 — RENTING đang thuê, MOVED_OUT đã chuyển đi, WALK_IN vãng lai
  // (20261021044801 đường nhanh, 20261021044814 v3); đường nhanh trả null khi có query (mẫu tìm của lõi không chép lại,
  // như contracts); SQL trước đó trả {} (vẫn hợp lệ). R2d ("bao nhiêu khách chưa có hợp đồng nào", production 21/10: không
  // khách nào WALK_IN — khách chưa từng có HĐ mang RENTING ⇒ byStatus trả lời sai): withoutContract = số khách của CẢ tập
  // lọc không có hợp đồng nào (mọi trạng thái, trừ HĐ đã xoá) ở toà thuộc phạm vi hợp đồng của kết nối (20261021063452 đường
  // nhanh qua hàm DEFINER chỉ trả số, 20261021063453 v3); null khi có query (đường nhanh) hoặc khi phạm vi hợp đồng không
  // phủ phạm vi khách (số đó chỉ có thể sai). Cửa sổ một bản: DOMAIN_SUMMARY_KEY_TOLERANT.
  customers: summaryShape({ ...COMMON(nullable(summaryCounts(CUSTOMER_CONTRACT_STATUSES))), withoutContract: nullable(integer) }),
  leads: summaryShape(COMMON(summaryCounts()), 'status'),
  contracts: summaryShape(COMMON(nullable(summaryCounts())), 'status'),
  invoices: summaryShape(COMMON(summaryCounts([]))),
  // R2c phần 2: latest = tài sản thêm gần đây nhất của cả tập lọc (created_at đầy đủ giảm dần rồi id), null khi tập rỗng.
  // R2d (production nhập cả kho tài sản trong MỘT đợt, cùng một created_at ⇒ latest chỉ là một món tuỳ ý của đợt):
  // latestCount = số tài sản của tập lọc có created_at BẰNG ĐÚNG mốc của latest (cùng thời điểm, không phải cùng ngày); 0
  // khi tập rỗng (20261021063452). null = không biết (summarizeRows: dòng chỉ mang NGÀY). Cửa sổ một bản như withoutContract.
  assets: summaryShape({ ...COMMON(summaryCounts(), ['quantity']), latest: nullable(summaryAssetLatest), latestCount: nullable(integer) }, 'condition'),
  services: summaryShape(COMMON(summaryCounts([]))),
  // Mốc 3b: byBuilding / byAssignee / givenByMe (null = không biết: summarizeRows, dòng không mang người tạo). Cửa sổ một bản:
  // DOMAIN_SUMMARY_KEY_TOLERANT.
  tasks: summaryShape({ ...COMMON(summaryCounts()), overdue: integer, byBuilding: taskGroups(TASK_GROUP_FIELDS.byBuilding),
    byAssignee: taskGroups(TASK_GROUP_FIELDS.byAssignee), givenByMe: nullable(taskGiven) }, 'status'),
  occupancy: summaryShape({ count: integer, total: integer, occupied: integer, available: integer }),
  income_expenses: summaryShape({ ...COMMON(summaryCounts(['UNAPPROVED', 'APPROVED', 'CANCELLED']), ['totalAmount']),
    byType: value => domainRecord(value) && Object.keys(value).every(key => ['INCOME', 'EXPENSE'].includes(key)) && Object.values(value).every(summaryTyped),
    largest: nullable(summaryLargest) },
  'approvalStatus'),
  receivables: summaryShape({ ...COMMON(summaryCounts(['APPROVED', 'PARTIAL_PAID', 'OVERDUE']), ['totalAmount', 'paidAmount', 'remainingAmount']),
    byBuilding: value => Array.isArray(value) && value.length <= 50 && value.every(entry => domainExact(entry, Object.keys(BY_BUILDING_FIELDS)) &&
      Object.entries(BY_BUILDING_FIELDS).every(([key, check]) => check(entry[key]))) }, 'status'),
  meter_readings: summaryShape({ ...COMMON(summaryCounts(['UNAPPROVED', 'APPROVED']), ['consumption']),
    byType: summaryCounts(['ELECTRICITY', 'WATER', 'GAS', 'OTHER']), rooms: integer }, 'status'),
  deposits_held: summaryShape({ count: integer, sum: summarySums(['expected', 'held', 'shortfallAll']), contractCount: integer, fullCount: integer, shortCount: integer }),
  building_profit: summaryShape({ count: integer, sum: summarySums(['revenue', 'expense', 'net']) }),
});
// Cửa sổ phát hành (như `tolerant` B5c): connector lên TRƯỚC migration ⇒ một bản phát hành chấp nhận VẮNG summary ở các
// miền liệt kê (SQL chưa áp); có mặt ⇒ kiểm đủ. R2a (13 miền) đã đóng 21/10 sau khi prod áp 20261020233934 +
// 20261021004841 (09:46–09:51) ⇒ rỗng: summary BẮT BUỘC ở mọi miền khai DOMAIN_SUMMARIES (domain-tolerance.test.mjs khoá).
// Cơ chế giữ cho lần đổi khuôn sau.
export const DOMAIN_SUMMARY_TOLERANT = Object.freeze([]);
// Cửa sổ phát hành cho khoá con MỚI trong phần tử của một khoá summary: { miền: { khoá summary: [khoá con] } }. Vắng = SQL
// chưa áp ⇒ qua, nhưng vắng ĐỒNG LOẠT ở mọi phần tử; có mặt ở một phần tử ⇒ đủ ở mọi phần tử, kiểm kiểu + bất biến. R2c
// (byType.<INCOME|EXPENSE>.largest, 20261021035022) đã đóng ở bản R2d — production áp 21/10 ⇒ {}: largest bắt buộc ở mọi
// phần tử byType. Cơ chế giữ cho lần đổi khuôn sau (domain-tolerance.test.mjs khoá).
export const DOMAIN_SUMMARY_ENTRY_TOLERANT = Object.freeze({});
const entryTolerant = (operation, key, entry) => DOMAIN_SUMMARY_ENTRY_TOLERANT[operation]?.[key]?.includes(entry) === true;
// Cửa sổ phát hành cho khoá summary MỚI ở cấp một: { miền: [khoá] } được vắng (SQL chưa áp), có mặt ⇒ kiểm như mọi khoá.
// R2c phần 2 (assets.latest, 20261021044801) đã đóng ở bản R2d (production áp 21/10). R2d (21/10/2026): customers.
// withoutContract (20261021063452 đường nhanh + 20261021063453 v3) và assets.latestCount (20261021063452) — connector lên
// TRƯỚC hai migration; bản connector kế tiếp (sau khi prod áp) đưa về {} (domain-tolerance.test.mjs khoá cả hai trạng thái).
// Mốc 3b Công việc (22/10): tasks.byBuilding/byAssignee/givenByMe (20261022153345), cùng thứ tự connector trước migration.
export const DOMAIN_SUMMARY_KEY_TOLERANT = Object.freeze({ customers: Object.freeze(['withoutContract']), assets: Object.freeze(['latestCount']),
  tasks: Object.freeze(['byBuilding', 'byAssignee', 'givenByMe']) });
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
  const flags = Object.keys(definition.flags ?? {});
  if (!domainRecord(input) || Object.keys(input).some(key => !family.inputKeys.includes(key) && !flags.includes(key)) ||
      flags.some(key => !(input[key] === undefined || input[key] === null || typeof input[key] === 'boolean'))) fail();
  // Khoá cờ chỉ đi SQL khi true (SQL cũ vẫn nhận đúng năm khoá khi không dùng).
  const on = Object.fromEntries(flags.filter(key => input[key] === true).map(key => [key, true]));
  const plain = Object.fromEntries(Object.entries(input).filter(([key]) => !flags.includes(key)));
  const result = { ...Object.fromEntries(family.inputKeys.map(key => [key, null])), query: '', limit: 20, ...plain };
  if (!text(result.query) || !Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50 ||
      !nullable(domainId)(result.cursor) || !nullable(domainId)(result.buildingId) ||
      !(result.status === null || definition.statuses.includes(result.status))) fail();
  if (family === DOMAIN_FAMILIES.v2) {
    const { fromDate, toDate } = result;
    if (!nullable(date)(fromDate) || !nullable(date)(toDate) || !definition.dated && (fromDate !== null || toDate !== null) ||
        fromDate !== null && toDate !== null && toDate < fromDate ||
        definition.requiresDates && (fromDate === null || toDate === null || Date.parse(toDate) - Date.parse(fromDate) > 366 * 86_400_000)) fail();
  }
  return { ...result, query: result.query.trim(), ...on };
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
  // R2a: `summary` là một khoá thêm ngoài family.resultKeys; vắng chỉ được trong cửa sổ DOMAIN_SUMMARY_TOLERANT (đã đóng: rỗng).
  const shape = Object.hasOwn(DOMAIN_SUMMARIES, operation) ? DOMAIN_SUMMARIES[operation] : null;
  const withSummary = shape !== null && domainRecord(value) && Object.hasOwn(value, 'summary');
  if (!definition || !domainExact(value, withSummary ? [...family.resultKeys, 'summary'] : family.resultKeys) ||
      shape !== null && !withSummary && !DOMAIN_SUMMARY_TOLERANT.includes(operation) ||
      value.organizationId !== identity.row.organizationId || value.domain !== operation || !Array.isArray(value.items) ||
      value.items.length > input.limit || !nullable(domainId)(value.nextCursor) ||
      family === DOMAIN_FAMILIES.v2 && (value.source !== definition.source || !instant(value.fetchedAt)) ||
      family === DOMAIN_FAMILIES.v3 && !instant(value.fetchedAt)) fail();
  const scopes = identity.scopesByPermission?.[definition.permission]?.buildingIds;
  // SQL is final authority. If supplied, the earlier CRM scope also fences output;
  // it is never a substitute for the saved authorization_scopes overlay in SQL.
  const items = value.items.map(row => {
    // Khuôn dòng cố định: không khoá lạ, mọi khoá đã khai phải có mặt và đúng kiểu — trừ khoá `tolerant` (mới thêm,
    // một bản phát hành; hiện rỗng ở mọi miền): vắng = SQL chưa áp ⇒ qua; có mặt ⇒ kiểm kiểu như thường.
    if (!domainRecord(row) || !Object.keys(row).every(key => Object.hasOwn(definition.fields, key)) ||
        Object.entries(definition.fields).some(([key, check]) => Object.hasOwn(row, key) ? !check(row[key]) : !definition.tolerant.includes(key))) fail();
    const buildings = row.buildingIds ?? (row.buildingId ? [row.buildingId] : []);
    if (Array.isArray(scopes) && buildings.some(building => !scopes.includes(building))) fail();
    // customers: bộ lọc buildingId = khách TỪNG có hợp đồng ở toà (lõi: p_location_building_ids), còn dòng mang toà của
    // hợp đồng ĐANG hiệu lực (hoặc null khi không có) ⇒ không đòi trùng; kiểm phạm vi ngay trên vẫn giữ. Miền khác: dòng
    // phải thuộc đúng toà lọc. (21/10: đòi trùng làm crm_read_customers {buildingId} đỏ backend_unavailable với mọi toà.)
    if (input.buildingId && operation !== 'customers' && !buildings.includes(input.buildingId)) fail();
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
  if (!withSummary) return Object.fromEntries(family.resultKeys.map(key => [key, key === 'items' ? items : value[key]]));
  // Summary ngay sau domain: mô hình gặp số tổng trước các dòng của trang.
  const summary = domainSummary(operation, shape, value.summary, items, input, scopes);
  return Object.fromEntries(family.resultKeys.flatMap(key => key === 'items' ? [['items', items]] :
    key === 'domain' ? [['domain', value.domain], ['summary', summary]] : [[key, value[key]]]));
}
// Tiền là chuỗi thập phân (numeric::text): so/cộng bằng BigInt theo thang lớn nhất, như sum(numeric) của PostgreSQL
// (thang kết quả = thang lớn nhất của các số hạng) — để summarizeRows trả đúng từng ký tự như SQL.
const decimalParts = value => {
  const [, sign, whole, fraction = ''] = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  return [BigInt(`${sign}${whole}${fraction}`), fraction.length];
};
const scaled = ([units, scale], target) => units * 10n ** BigInt(target - scale);
const compareAmounts = (left, right) => {
  const a = decimalParts(left), b = decimalParts(right), scale = Math.max(a[1], b[1]), x = scaled(a, scale), y = scaled(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
};
const sumAmounts = values => {
  const parts = values.map(decimalParts), scale = parts.reduce((max, [, part]) => Math.max(max, part), 0);
  const units = parts.reduce((sum, part) => sum + scaled(part, scale), 0n), negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
};
/** Kiểm summary của MỘT trang: khuôn chính xác theo miền + bất biến giữa summary, các dòng, bộ lọc và phạm vi khoá.
 * Không đòi count === items.length (đường nhanh contracts/invoices đếm như lõi); đẳng thức kiểm ở test SQL. */
function domainSummary(operation, shape, summary, items, input, scopes) {
  // Khoá của cửa sổ phát hành (DOMAIN_SUMMARY_KEY_TOLERANT) được vắng; có mặt thì kiểm như mọi khoá.
  const optional = DOMAIN_SUMMARY_KEY_TOLERANT[operation] ?? [];
  const keys = Object.keys(shape.fields).filter(key => !optional.includes(key) || domainRecord(summary) && Object.hasOwn(summary, key));
  if (!domainExact(summary, keys) || keys.some(key => !shape.fields[key](summary[key])) || summary.count < items.length) fail();
  const total = values => values.reduce((sum, n) => sum + n, 0), within = n => n <= summary.count;
  if (domainRecord(summary.byStatus) && (!within(total(Object.values(summary.byStatus))) ||
      input.status && shape.statusKey !== null && Object.keys(summary.byStatus).some(key => key !== input.status))) fail();
  if (operation === 'tasks') {
    if (!within(summary.overdue)) fail();
    // Lượt 14: lọc givenByMe ⇒ cả tập là việc người hỏi giao ⇒ givenByMe trùng count / overdue (SQL cũ không lọc ⇒ lệch ⇒ từ chối).
    if (input?.givenByMe === true && (summary.givenByMe === null || summary.givenByMe === undefined ||
        summary.givenByMe.count !== summary.count || summary.givenByMe.overdue !== summary.overdue)) fail();
    // Mốc 3b (vắng trong cửa sổ): mỗi nhóm ≥1 việc, quá hạn ≤ số việc, không trùng khoá, nhiều việc trước; cộng các nhóm không
    // vượt tổng — dưới 50 nhóm (không bị cắt) thì bằng đúng count và overdue.
    for (const [key, name] of [['byBuilding', 'buildingId'], ['byAssignee', 'assigneeName']]) {
      if (!Object.hasOwn(summary, key)) continue;
      const groups = summary[key], seen = new Set();
      groups.forEach((entry, index) => {
        if (seen.has(entry[name]) || entry.count < 1 || entry.overdue > entry.count || index > 0 && groups[index - 1].count < entry.count) fail();
        seen.add(entry[name]);
      });
      const counted = total(groups.map(entry => entry.count)), late = total(groups.map(entry => entry.overdue));
      if (!within(counted) || late > summary.overdue || groups.length < 50 && (counted !== summary.count || late !== summary.overdue)) fail();
    }
    // Toà của byBuilding như toà của dòng: trong phạm vi khoá, đúng toà lọc (lọc toà ⇒ không có nhóm null); hoà ⇒ id tăng, null cuối.
    (summary.byBuilding ?? []).forEach((entry, index) => {
      const previous = summary.byBuilding[index - 1];
      if (entry.buildingId !== null && Array.isArray(scopes) && !scopes.includes(entry.buildingId) || input.buildingId && entry.buildingId !== input.buildingId ||
          previous?.count === entry.count && (previous.buildingId === null || entry.buildingId !== null && previous.buildingId >= entry.buildingId)) fail();
    });
    const given = summary.givenByMe;
    if (domainRecord(given) && (!within(given.count) || given.overdue > given.count || given.overdue > summary.overdue)) fail();
  }
  // R2d: withoutContract (vắng trong cửa sổ; null = đường nhanh có query, hoặc phạm vi hợp đồng không phủ phạm vi khách).
  // Khách hiện kèm hợp đồng đang hiệu lực (contractId) trên trang đã có hợp đồng trong phạm vi ⇒ không thể nằm trong số đó.
  if (operation === 'customers' && Number.isInteger(summary.withoutContract) &&
      summary.withoutContract > summary.count - items.filter(row => row.contractId !== null).length) fail();
  if (operation === 'assets') {
    // R2c phần 2 (createdAt của dòng và latest bắt buộc từ bản R2d): mới nhất của CẢ tập — null ⇔ tập rỗng; toà như toà của
    // dòng (phạm vi khoá, đúng toà lọc); không cũ hơn dòng nào của trang.
    const { latest, latestCount } = summary;
    if ((latest === null) !== (summary.count === 0) || latest !== null && (Array.isArray(scopes) && latest.buildingId !== null &&
        !scopes.includes(latest.buildingId) || input.buildingId && latest.buildingId !== input.buildingId ||
        items.some(row => row.createdAt > latest.createdAt))) fail();
    // R2d: latestCount (vắng trong cửa sổ; null = không biết) = số tài sản cùng đúng thời điểm với latest: 0 ⇔ không có
    // latest; không vượt count.
    if (Number.isInteger(latestCount) && ((latestCount === 0) !== (latest === null) || !within(latestCount))) fail();
  }
  if (operation === 'occupancy' && summary.occupied + summary.available > summary.total) fail();
  if (operation === 'meter_readings' && (!within(summary.rooms) || !within(total(Object.values(summary.byType))))) fail();
  if (operation === 'income_expenses') {
    const { largest, byType } = summary, entries = Object.entries(byType);
    const outside = day => input.fromDate && day < input.fromDate || input.toDate && day > input.toDate;
    // byType và largest cùng tính trên phiếu chưa huỷ: không có phiếu nào ⇔ byType rỗng ⇔ largest null; có thì loại của
    // largest có mặt trong byType.
    if (!within(total(entries.map(([, entry]) => entry.count))) || (largest === null) !== (entries.length === 0) ||
        largest !== null && (summary.count < 1 || outside(largest.voucherDate) || !Object.hasOwn(byType, largest.type))) fail();
    // R2c: byType.<loại>.largest có ở MỌI phần tử (vắng ở mọi phần tử chỉ khi cửa sổ phát hành mở — đã đóng ở bản R2d).
    const typed = entries.filter(([, entry]) => Object.hasOwn(entry, 'largest'));
    if (typed.length < entries.length && (typed.length > 0 || !entryTolerant(operation, 'byType', 'largest'))) fail();
    for (const [type, { count, sum, largest: best }] of typed) {
      // Phiếu lớn nhất CỦA LOẠI: null chỉ khi loại không có phiếu (SQL không trả phần tử count 0); đúng loại, trong kỳ; không
      // vượt tổng của loại (tiền ≥ 0: CHECK income_expenses_total_amount_non_negative) và không đứng trước largest toàn bộ
      // theo cùng thứ tự SQL (tiền giảm dần, rồi id).
      const order = best === null ? 0 : compareAmounts(best.totalAmount, largest.totalAmount);
      if ((best === null) !== (count === 0) || best !== null && (best.type !== type || outside(best.voucherDate) ||
          compareAmounts(best.totalAmount, sum) > 0 || order > 0 || order === 0 && best.id < largest.id)) fail();
    }
    // largest toàn bộ chính là largest của loại nó.
    if (typed.length > 0 && !Object.keys(LARGEST_FIELDS).every(key => byType[largest.type]?.largest?.[key] === largest[key])) fail();
  }
  if (operation === 'receivables') {
    // Toà của byBuilding như toà của dòng: trong phạm vi khoá, đúng toà lọc; giảm dần theo remainingAmount, hoà thì theo id.
    const seen = new Set();
    summary.byBuilding.forEach((entry, index) => {
      const previous = summary.byBuilding[index - 1], order = previous ? compareAmounts(previous.remainingAmount, entry.remainingAmount) : 1;
      if (seen.has(entry.buildingId) || Array.isArray(scopes) && !scopes.includes(entry.buildingId) || input.buildingId && entry.buildingId !== input.buildingId ||
          entry.count < 1 || compareAmounts(entry.remainingAmount, '0') <= 0 || order < 0 || order === 0 && previous.buildingId >= entry.buildingId) fail();
      seen.add(entry.buildingId);
    });
    if (!within(total(summary.byBuilding.map(entry => entry.count)))) fail();
  }
  return structuredClone(summary);
}
/** Hậu xử lý SAU validator (và sau khi gộp trang lọc phòng), không nới validator: kết quả phân trang offset (báo cáo họ v3
 * crm_read_occupancy_report/invoice_report/pending_approvals/zalo_conversations/contract_search và crm_read_report của đợt
 * 2 — cùng khuôn items/offset/nextOffset/sourceCapped/unavailable/summary) mà SQL trả `summary: null` (báo cáo không có
 * tổng riêng) và tập đã TRỌN — bắt đầu từ offset 0, không còn trang sau (nextOffset null), nguồn không bị cắt
 * (sourceCapped false), không unavailable — thì số dòng chính là tổng: summary = {count: items.length}. Ca thật (full50e
 * câu 14, production 21/10): upcoming days=60 trả 15 dòng, summary null ⇒ mô hình tự đếm bảng và nói "14 hợp đồng". Còn
 * trang sau, bị cắt, offset > 0 (không biết các trang trước) hay unavailable ⇒ giữ null: không bao giờ là số của một phần.
 * summary khác null giữ nguyên. Tool danh sách con trỏ (nextCursor) không đổi: summary của SQL bắt buộc từ R2a, và gộp
 * lọc phòng đã thay bằng summary của các hàng giữ lại khi đọc hết. Trả object mới, không sửa đầu vào. */
export function completeListSummary(value) {
  if (!domainRecord(value) || value.summary !== null || !Array.isArray(value.items) || !Object.hasOwn(value, 'nextOffset') ||
      value.offset !== 0 || value.nextOffset !== null || value.sourceCapped !== false || value.unavailable !== null) return value;
  return { ...value, summary: { count: value.items.length } };
}
/** Cùng khuôn summary tính từ một mảng dòng ĐÃ kiểm (thuần, không I/O): lọc phòng ở connector (read-name-resolution
 * rowsPlan.merge — summary SQL mô tả tập CHƯA lọc phòng) và oracle của test SQL (summary SQL = summarizeRows(mọi dòng
 * của tập lọc)). now: mốc của tasks.overdue (SQL dùng now() của câu lệnh). */
export function summarizeRows(operation, rows, { now = Date.now() } = {}) {
  if (!Object.hasOwn(DOMAIN_SUMMARIES, operation) || !Array.isArray(rows)) fail();
  const count = rows.length;
  const tally = (key, keep = () => true) => {
    const seen = new Map();
    for (const row of rows) if (keep(row) && row[key] !== null && row[key] !== undefined) seen.set(row[key], (seen.get(row[key]) ?? 0) + 1);
    return Object.fromEntries(seen);
  };
  const money = (key, keep = () => true) => sumAmounts(rows.filter(keep).map(row => row[key]));
  const add = key => rows.reduce((sum, row) => sum + row[key], 0);
  switch (operation) {
    // R2c phần 2: dòng khách không mang tình trạng hợp đồng (status_v2) ⇒ byStatus không suy ra được từ dòng: null. R2d:
    // contractId của dòng chỉ là HĐ đang hiệu lực (vắng không có nghĩa là chưa từng có HĐ) ⇒ withoutContract null.
    case 'customers': return { count, byStatus: null, sum: {}, withoutContract: null };
    case 'invoices': case 'services': return { count, byStatus: {}, sum: {} };
    case 'leads': case 'contracts': return { count, byStatus: tally('status'), sum: {} };
    case 'tasks': {
      // Mốc 3b: nhóm như SQL — nhiều việc trước; hoà: id toà / tên theo đơn vị mã (= COLLATE "C" với chữ BMP), null cuối; ≤50.
      // byAssignee chỉ khi mọi dòng mang assigneeName (dòng của SQL cũ trong cửa sổ phát hành thì không: không đoán "chưa giao").
      // givenByMe: dòng không mang người tạo ⇒ null.
      const late = row => row.status === 'IN_PROGRESS' && row.deadline !== null && Date.parse(row.deadline) < now;
      const group = (key, extra) => {
        const seen = new Map();
        for (const row of rows) {
          const entry = seen.get(row[key]) ?? { [key]: row[key], ...extra(row), count: 0, overdue: 0 };
          entry.count += 1; entry.overdue += late(row) ? 1 : 0; seen.set(row[key], entry);
        }
        return [...seen.values()].sort((a, b) => b.count - a.count || (a[key] === null) - (b[key] === null) ||
          (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0)).slice(0, 50);
      };
      return { count, byStatus: tally('status'), sum: {}, overdue: rows.filter(late).length,
        byBuilding: group('buildingId', row => ({ buildingName: row.buildingName })),
        ...(rows.every(row => Object.hasOwn(row, 'assigneeName')) ? { byAssignee: group('assigneeName', () => ({})) } : {}), givenByMe: null };
    }
    case 'assets': {
      // R2c phần 2: latest như SQL nhưng chỉ theo NGÀY của dòng (cùng ngày ⇒ id nhỏ hơn; SQL xếp theo thời điểm thật). R2d:
      // latestCount đếm cùng THỜI ĐIỂM — dòng chỉ mang ngày ⇒ không suy ra được: null (không bao giờ đoán theo ngày).
      const latest = rows.reduce((best, row) => best === null || row.createdAt > best.createdAt || row.createdAt === best.createdAt && row.id < best.id ? row : best, null);
      return { count, byStatus: tally('condition'), sum: { quantity: money('quantity') }, latest: latest === null ? null : { id: latest.id, name: latest.name,
        code: latest.code, buildingId: latest.buildingId, buildingName: latest.buildingName, roomName: latest.roomName, createdAt: latest.createdAt }, latestCount: null };
    }
    case 'occupancy': return { count, total: add('total'), occupied: add('occupied'), available: add('available') };
    case 'income_expenses': {
      // Phiếu lớn nhất như ORDER BY total_amount DESC, id LIMIT 1 của SQL; R2c: cả toàn bộ lẫn từng loại.
      const live = row => row.approvalStatus !== 'CANCELLED', byType = {};
      const top = of => of.reduce((best, row) => best === null || compareAmounts(row.totalAmount, best.totalAmount) > 0 ||
        compareAmounts(row.totalAmount, best.totalAmount) === 0 && row.id < best.id ? row : best, null);
      const project = row => row === null ? null : { id: row.id, code: row.code, name: row.name, type: row.type, totalAmount: row.totalAmount,
        voucherDate: row.voucherDate };
      for (const type of ['INCOME', 'EXPENSE']) {
        const of = rows.filter(row => live(row) && row.type === type);
        if (of.length) byType[type] = { count: of.length, sum: sumAmounts(of.map(row => row.totalAmount)), largest: project(top(of)) };
      }
      return { count, byStatus: tally('approvalStatus'), sum: { totalAmount: money('totalAmount', live) }, byType,
        largest: project(top(rows.filter(live))) };
    }
    case 'receivables': {
      const buildings = new Map();
      for (const row of rows) {
        const entry = buildings.get(row.buildingId) ?? { buildingId: row.buildingId, buildingName: row.buildingName, count: 0, amounts: [] };
        if (row.buildingName > entry.buildingName) entry.buildingName = row.buildingName;
        entry.count += 1; entry.amounts.push(row.remainingAmount); buildings.set(row.buildingId, entry);
      }
      const byBuilding = [...buildings.values()].map(({ amounts, ...entry }) => ({ ...entry, remainingAmount: sumAmounts(amounts) }))
        .sort((a, b) => compareAmounts(b.remainingAmount, a.remainingAmount) || (a.buildingId < b.buildingId ? -1 : 1)).slice(0, 50);
      return { count, byStatus: tally('status'), sum: { totalAmount: money('totalAmount'), paidAmount: money('paidAmount'),
        remainingAmount: money('remainingAmount') }, byBuilding };
    }
    case 'meter_readings': return { count, byStatus: tally('status'), sum: { consumption: money('consumption') }, byType: tally('meterType'),
      rooms: new Set(rows.map(row => row.roomId).filter(room => room !== null)).size };
    case 'deposits_held': return { count, sum: { expected: money('expected'), held: money('held'), shortfallAll: money('shortfallAll') },
      contractCount: add('contractCount'), fullCount: add('fullCount'), shortCount: add('shortCount') };
    default: return { count, sum: { revenue: money('revenue'), expense: money('expense'), net: money('net') } };
  }
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
  tasks: 'Tên/mã việc hoặc tên người nhận.',
  occupancy: 'Tên toà.',
  income_expenses: 'Tên hoặc mã phiếu; không khớp phòng.',
  receivables: 'Số hoá đơn hoặc tên phòng.',
  meter_readings: 'Mã chỉ số hoặc tên phòng.',
  deposits_held: 'Tên toà.',
  building_profit: 'Tên toà.',
});
// 21/10 rút chữ (tools/list ≤ 64 000 B sau khi thêm buildingName/roomName); giữ đủ ba ý của sự cố 16/10.
export const DOMAIN_BUILDING_HINT = 'ID toà (không phải công ty).';
export const EMPTY_RESULT_HINT = 'Rỗng sau lọc đúng = không có.';
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
    ...Object.fromEntries(Object.entries(definition.flags ?? {}).map(([key, description]) => [key, { type: 'boolean', description }])),
    ...(definition.dated ? { fromDate: dateSchema(definition.requiresDates), toDate: dateSchema(definition.requiresDates) } : {}),
  } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
})));
