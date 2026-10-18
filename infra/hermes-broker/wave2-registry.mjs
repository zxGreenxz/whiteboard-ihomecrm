// Đợt 2 Hermes đọc đầy đủ — ĐIỂM ĐĂNG KÝ CỐ ĐỊNH (Gói 0, 18/10/2026). Gói A/B/C/D không sửa file
// này: mỗi gói chỉ điền wave2-<gói>-contract.mjs của mình; file này gom bốn gói, kiểm trùng mã và
// dựng mặt tool. domain-contract.mjs nạp W2_READS một lần.
//
// Mặt tool (chốt Gói 0): HAI tool meta thay cho ~60 báo cáo — crm_read_report_list (mục lục theo
// quyền hiện tại) và crm_read_report (chạy một báo cáo). tools/list đủ quyền trước đợt 2 là 61 883 B
// (sau PR #192); một tool/báo cáo cần +45–50 KB, một tool/miền +17,6 KB (vượt 64 000 B mà client
// Hermes upstream đã xác minh), còn hai tool meta ≈ +1,5 KB. Ít tool cũng giúp mô hình chọn đúng.
// Hai tool chỉ hiện khi có ÍT NHẤT MỘT báo cáo đã đăng ký mà kết nối giữ đúng khoá; crm_read_report
// còn đòi đúng khoá của báo cáo được gọi (broker: forbidden; SQL: 42501).
import { W2A_REPORTS } from './wave2-a-contract.mjs';
import { W2B_REPORTS } from './wave2-b-contract.mjs';
import { W2C_REPORTS } from './wave2-c-contract.mjs';
import { W2D_REPORTS } from './wave2-d-contract.mjs';
import { W2_TOPICS, W2_BUILDING_SCOPES, W2_PACKAGES, W2_UNAVAILABLE, W2_READ_KEYS, W2_SELF_KEYS, W2_REUSED_KEYS, w2Record, w2Params, w2CatalogEntry, isW2ReportId, shaped, id,
  PRIVATE_HINT } from './wave2-kit.mjs';
export { W2_READ_KEYS, W2_SELF_KEYS, W2_REUSED_KEYS };

// Khoá đợt 2 khai ở wave2-kit.mjs (w2Report kiểm loại khoá ↔ scope ngay khi khai báo); xuất lại ở đây.
export const W2_READ_KEY_LIST = Object.freeze(Object.keys(W2_READ_KEYS));
// Khoá không có trong catalog CRM: grant do SQL tự quyết (hermes_w2_grant_v1), cần nhãn riêng ở UI.
export const W2_HERMES_ONLY_KEYS = Object.freeze(['assistant.bank_events.read', 'assistant.salary.self']);
export const W2_TOOL_NAMES = Object.freeze(['crm_read_report_list', 'crm_read_report']);

const fail = () => { throw new TypeError('invalid_w2_registry'); };
const LETTERS = Object.freeze(['a', 'b', 'c', 'd']);
const SPEC_KEYS = Object.freeze(['permission', 'source', 'scope', 'title', 'params', 'required', 'statuses', 'kinds', 'scopeKeys', 'fields', 'summary', 'private']);
const RUN_KEYS = Object.freeze(['report', 'params', 'limit', 'offset']);
const LIST_RESULT = Object.freeze(['organizationId', 'domain', 'fetchedAt', 'items']);
// Phong bì SQL có thêm "fence" (toà/sổ quỹ/org_wide cổng đã dùng); broker rào theo nó rồi BỎ khỏi đầu ra.
const RUN_OUTPUT = Object.freeze(['organizationId', 'domain', 'fetchedAt', 'report', 'source', 'unavailable', 'summary', 'items', 'offset', 'nextOffset', 'sourceCapped']);
const RUN_RESULT = Object.freeze([...RUN_OUTPUT, 'fence']);
const uuids = value => Array.isArray(value) && value.length <= 256 && value.every(id) && new Set(value).size === value.length;
const FENCE = Object.freeze({ buildings: uuids, cashbooks: uuids, orgWide: value => typeof value === 'boolean' });
// Mô tả gọn (tools/list): đủ ý chọn tool, phân trang, "không có toà" ≠ số 0, riêng tư.
const LIST_DESCRIPTION = 'Mục lục báo cáo CRM mở rộng kết nối được xem lúc này: report, mô tả, params, private. Gọi trước crm_read_report. ' +
  'topic: thu_tien=thu tiền/công nợ/cọc; tai_chinh=sổ quỹ/KQKD/lợi nhuận/ví; van_hanh=xe/kho/lương/thông báo/mạng; danh_muc=tài sản/danh mục/toà phòng/BĐS.';
const RUN_DESCRIPTION = 'Chạy một báo cáo của crm_read_report_list; params đúng tên mục lục, bỏ trống = không lọc. Tiền là chuỗi VND. ' +
  'Trang sau: offset=nextOffset; sourceCapped=true thì thu hẹp lọc. unavailable: no_building_scope = kết nối không còn toà (không phải số 0), ' +
  `organization_scope_required = cần kết nối Toàn tổ chức. private=true: ${PRIVATE_HINT}`;
const LIST_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: { topic: { enum: [null, ...Object.keys(W2_TOPICS)] } } });
const RUN_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['report'], properties: {
  report: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,47}$' }, params: { type: 'object' },
  limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, maximum: 2000 } } });

const granted = (effective, permission) => Array.isArray(effective?.read) && effective.read.includes(permission);

/** Gom bốn gói thành một sổ báo cáo + hai định nghĩa đọc meta. Dùng cho sổ thật (W2) và cho test
 * (sổ thăm dò). Mã trùng giữa hai gói, gói lạ hoặc khai báo không qua w2Report() ⇒ lỗi khi nạp. */
export function createW2Registry(packages) {
  if (!w2Record(packages) || Object.keys(packages).length !== LETTERS.length || !LETTERS.every(letter => Object.hasOwn(packages, letter))) fail();
  const reports = {};
  for (const letter of LETTERS) {
    if (!w2Record(packages[letter])) fail();
    for (const [reportId, spec] of Object.entries(packages[letter])) {
      if (!isW2ReportId(reportId) || Object.hasOwn(reports, reportId) || !Object.isFrozen(spec) || !w2Record(spec) ||
          Object.keys(spec).length !== SPEC_KEYS.length || !SPEC_KEYS.every(key => Object.hasOwn(spec, key))) fail();
      reports[reportId] = Object.freeze({ ...spec, package: letter });
    }
  }
  Object.freeze(reports);
  const permissions = Object.freeze([...new Set(Object.values(reports).map(spec => spec.permission))].sort());
  const any = effective => permissions.some(permission => granted(effective, permission));
  const specOf = reportId => typeof reportId === 'string' && Object.hasOwn(reports, reportId) ? reports[reportId] : null;

  // Bất biến khi kiểm lại: broker, dịch vụ bound-user và adapter đều gọi lại domainInput trên bản đã
  // chuẩn hoá, nên chữ cái gói (bản chuẩn hoá) cũng được nhận như tên nhóm.
  function listInput(input) {
    if (!w2Record(input) || Object.keys(input).some(key => key !== 'topic')) fail();
    const topic = input.topic ?? null;
    if (topic === null) return { topic: null };
    if (typeof topic === 'string' && Object.hasOwn(W2_TOPICS, topic)) return { topic: W2_TOPICS[topic] };
    if (typeof topic === 'string' && Object.hasOwn(W2_PACKAGES, topic)) return { topic };
    return fail();
  }
  // SQL trả [{report, permission}] cho báo cáo mà khoá còn được cấp NGAY LÚC GỌI; broker chiếu
  // thành mục lục từ khai báo (mã SQL lạ với bản broker này bị bỏ qua: chưa chạy được ở đây).
  function listResult(value, identity, input) {
    if (!Array.isArray(value.items) || value.items.length > 1000) fail();
    const entries = [];
    let previous = '';
    for (const row of value.items) {
      if (!shaped(row, { report: isW2ReportId, permission: item => typeof item === 'string' }) || row.report <= previous) fail();
      previous = row.report;
      const spec = specOf(row.report);
      if (spec === null) continue;
      if (row.permission !== spec.permission || input.topic !== null && spec.package !== input.topic || !granted(identity.effective, spec.permission)) fail();
      entries.push(w2CatalogEntry(row.report, spec, spec.package));
    }
    return { items: entries };
  }
  function runInput(input) {
    if (!w2Record(input) || Object.keys(input).some(key => !RUN_KEYS.includes(key))) fail();
    const spec = specOf(input.report) ?? fail();
    const limit = input.limit ?? 20, offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 2000) fail();
    return { report: input.report, params: w2Params(spec, input.params), limit, offset };
  }
  // Rào thứ hai (SQL quyết định cuối): fence của cổng phải nằm trong phạm vi CRM của khoá mà broker vừa
  // đọc; hàng nêu toà phải thuộc fence.buildings (null chỉ khi fence.orgWide), mảng buildingIds cũng vậy;
  // báo cáo không theo toà không được nêu toà; scope cashbooks chỉ trong fence.cashbooks khi không org_wide.
  function fenceOf(value, identity, spec, input) {
    const fence = value.fence, crm = identity.scopesByPermission?.[spec.permission]?.buildingIds;
    const byBuilding = W2_BUILDING_SCOPES.includes(spec.scope), building = input.params.buildingId ?? null;
    // rls_buildings (như route web không truyền toà): fence = toà công ty ∩ phạm vi kết nối, không ⊆ tập toà của khoá; broker chỉ
    // đòi khoá có ở ít nhất một toà (SQL quyết định cuối, hàng vẫn phải thuộc fence).
    if (!shaped(fence, FENCE) || !Array.isArray(crm) ||
        (spec.scope === 'rls_buildings' ? !crm.length : fence.buildings.some(item => !crm.includes(item))) ||
        !byBuilding && fence.buildings.length || spec.scope !== 'cashbooks' && fence.cashbooks.length ||
        building !== null && (fence.orgWide || fence.buildings.length > 1 || fence.buildings.length === 1 && fence.buildings[0] !== building)) fail();
    return fence;
  }
  function runResult(value, identity, input) {
    const spec = specOf(input.report) ?? fail();
    if (!granted(identity.effective, spec.permission) || value.report !== input.report || value.source !== spec.source || value.offset !== input.offset ||
        typeof value.sourceCapped !== 'boolean' || !Array.isArray(value.items) || value.items.length > input.limit ||
        !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && value.nextOffset === input.offset + value.items.length && value.items.length > 0)) fail();
    const fence = fenceOf(value, identity, spec, input), byBuilding = W2_BUILDING_SCOPES.includes(spec.scope);
    if (value.unavailable !== null) {
      if (!W2_UNAVAILABLE.includes(value.unavailable) || value.unavailable === 'no_building_scope' && !byBuilding ||
          value.items.length || value.summary !== null || value.nextOffset !== null) fail();
      return { report: value.report, source: value.source, unavailable: value.unavailable, summary: null, items: [], offset: value.offset, nextOffset: null, sourceCapped: false };
    }
    if (!(spec.summary === null ? value.summary === null : shaped(value.summary, spec.summary))) fail();
    const inFence = item => id(item) && fence.buildings.includes(item);
    for (const row of value.items) {
      if (!shaped(row, spec.fields)) fail();
      const hasBuilding = Object.hasOwn(row, 'buildingId'), hasBuildings = Object.hasOwn(row, 'buildingIds');
      // Theo toà: mọi hàng nêu toà; organizationId là trường rào SQL đã gỡ (chỉ platform giữ).
      if (byBuilding && !hasBuilding || spec.scope !== 'platform' && Object.hasOwn(row, 'organizationId') ||
          !byBuilding && (hasBuilding || hasBuildings) ||
          hasBuilding && !(row.buildingId === null ? fence.orgWide : inFence(row.buildingId)) ||
          hasBuildings && !(Array.isArray(row.buildingIds) && row.buildingIds.every(inFence)) ||
          spec.scope === 'cashbooks' && !fence.orgWide && Object.hasOwn(row, 'cashbookId') &&
            !(id(row.cashbookId) && fence.cashbooks.includes(row.cashbookId))) fail();
    }
    return structuredClone({ report: value.report, source: value.source, unavailable: null, summary: value.summary, items: value.items,
      offset: value.offset, nextOffset: value.nextOffset, sourceCapped: value.sourceCapped });
  }
  const define = (toolName, description, inputSchema, input, resultKeys, outputKeys, result, mayUse) => Object.freeze({ family: 'w2', permission: null,
    label: description, description, fields: Object.freeze({}), statuses: Object.freeze([]), dated: false, requiresDates: false, perBuilding: false,
    source: null, toolName, inputSchema, input, resultKeys, outputKeys, result, mayUse });
  const reads = Object.freeze({
    report_list: define(W2_TOOL_NAMES[0], LIST_DESCRIPTION, LIST_SCHEMA, listInput, LIST_RESULT, LIST_RESULT, listResult, effective => any(effective)),
    report: define(W2_TOOL_NAMES[1], RUN_DESCRIPTION, RUN_SCHEMA, runInput, RUN_RESULT, RUN_OUTPUT, runResult,
      (effective, input) => input === undefined ? any(effective) : granted(effective, specOf(input?.report)?.permission)),
  });
  // Bản chiếu đúng những trường mà app_private.hermes_w2<gói>_catalog_v1 phải trả (test so khớp).
  const sqlSpec = reportId => {
    const spec = specOf(reportId) ?? fail();
    return { permission: spec.permission, source: spec.source, scope: spec.scope, params: [...spec.params], required: [...spec.required],
      statuses: spec.statuses ? [...spec.statuses] : null, kinds: spec.kinds ? [...spec.kinds] : null, scopeKeys: [...spec.scopeKeys], package: spec.package };
  };
  return Object.freeze({ reports, permissions, reads, sqlSpec, topicOf: letter => W2_PACKAGES[letter] });
}

export const W2 = createW2Registry({ a: W2A_REPORTS, b: W2B_REPORTS, c: W2C_REPORTS, d: W2D_REPORTS });
export const W2_READS = W2.reads;
// Công tắc Gói Z (20261018090000_hermes_w2_enable_v1, test wave2-z.test.mjs so khớp): bật khoá đợt 2 là khoá của ÍT NHẤT
// MỘT báo cáo đã đăng ký, hoặc khoá phụ (scopeKeys) mà báo cáo cần mới có số liệu — income_expenses.restricted_view: hạng
// mục/phiếu hạn chế và tab P&L Hiệu quả kinh doanh. Khoá seed mà không báo cáo nào dùng giữ TẮT (W2_DISABLED_KEYS).
export const W2_ENABLED_KEYS = Object.freeze(W2_READ_KEY_LIST.filter(key =>
  Object.values(W2.reports).some(spec => spec.permission === key || spec.scopeKeys.includes(key))));
export const W2_DISABLED_KEYS = Object.freeze(W2_READ_KEY_LIST.filter(key => !W2_ENABLED_KEYS.includes(key)));
