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
import { W2_TOPICS, W2_PACKAGES, W2_UNAVAILABLE, w2Record, w2Params, w2CatalogEntry, isW2ReportId, shaped, id, PRIVATE_HINT } from './wave2-kit.mjs';

// Mọi khoá đọc MỚI của đợt 2 (seed MỘT lần ở 20261018000000, enabled=false; Gói Z bật).
// Tên = khoá web đang dùng (catalog CRM), trừ hai khoá Hermes-only vì web không có khoá:
//   assistant.salary.self      — "Lương của tôi" (/finance/my-salary chỉ cần cấu hình lương của chính mình);
//   assistant.bank_events.read — "Biến động số dư" (/bien-dong-so-du chỉ RequireSuperAdmin, không khoá catalog).
// resource (capability-contract): building = SQL giao toà overlay; organization_scope = dữ liệu không
// gắn toà nhưng kết nối phải chọn phạm vi (SQL đòi Toàn tổ chức khi cần); self = dữ liệu của chính
// người hỏi, không theo toà (grant trả buildingIds=[]).
export const W2_READ_KEYS = Object.freeze({
  // Gói A — thu tiền, công nợ, cọc
  'reports_finance.payment_schedule': 'building',
  'reports_finance.overpayment': 'building',
  'reports_finance.deposits_report': 'building',
  'thu_tien.view': 'building',
  // Gói B — sổ quỹ, dòng tiền, KQKD, lợi nhuận cổ đông, ví cá nhân, biến động số dư
  'reports_finance.daily_cashbook': 'building',
  'reports_finance.cash_flow': 'building',
  'reports_finance.handover_report': 'building',
  'reports_finance.collection_cycle': 'building',
  'cashbooks.view': 'organization_scope',
  'income_expenses.restricted_view': 'building',
  'reports_finance.profit_distribution': 'building',
  'shareholder_profit.view': 'organization_scope',
  'personal_finance.view': 'self',
  'assistant.bank_events.read': 'self',
  // Gói C — xe, kho, lương, thông báo, Network Center
  'vehicles.view': 'building',
  'materials.view': 'organization_scope',
  'warehouses.view': 'building',
  'salary.view': 'organization_scope',
  'assistant.salary.self': 'self',
  'notifications.view': 'self',
  'network_center.view': 'building',
  // Gói D — danh mục, toà/phòng, báo cáo BĐS
  'buildings.view': 'building',
  'meters.view': 'building',
  'suppliers.view': 'organization_scope',
  'hotline.view': 'organization_scope',
  'task_types.view': 'organization_scope',
  'service_quotas.view': 'organization_scope',
  'categories.view': 'organization_scope',
  'reports_real_estate.vacant_rooms': 'building',
  'reports_real_estate.expiring': 'building',
  'reports_real_estate.renewals_transfers': 'building',
  'reports_real_estate.promotions': 'building',
  'reports_real_estate.new_leases': 'building',
  'reports_real_estate.terminations': 'building',
  'reports_real_estate.expense_ratio': 'building',
});
export const W2_READ_KEY_LIST = Object.freeze(Object.keys(W2_READ_KEYS));
export const W2_SELF_KEYS = Object.freeze(W2_READ_KEY_LIST.filter(key => W2_READ_KEYS[key] === 'self'));
// Khoá không có trong catalog CRM: grant do SQL tự quyết (hermes_w2_grant_v1), cần nhãn riêng ở UI.
export const W2_HERMES_ONLY_KEYS = Object.freeze(['assistant.bank_events.read', 'assistant.salary.self']);
export const W2_TOOL_NAMES = Object.freeze(['crm_read_report_list', 'crm_read_report']);

const fail = () => { throw new TypeError('invalid_w2_registry'); };
const LETTERS = Object.freeze(['a', 'b', 'c', 'd']);
const SPEC_KEYS = Object.freeze(['permission', 'source', 'scope', 'title', 'params', 'required', 'statuses', 'kinds', 'scopeKeys', 'fields', 'summary', 'private']);
const RUN_KEYS = Object.freeze(['report', 'params', 'limit', 'offset']);
const LIST_RESULT = Object.freeze(['organizationId', 'domain', 'fetchedAt', 'items']);
const RUN_RESULT = Object.freeze(['organizationId', 'domain', 'fetchedAt', 'report', 'source', 'unavailable', 'summary', 'items', 'offset', 'nextOffset', 'sourceCapped']);
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

// Phạm vi CRM đã cấp cho khoá rào đầu ra (như full-read-contract): hàng nêu toà phải nằm trong đó.
function inScope(identity, permission, buildingId) {
  const scopes = identity.scopesByPermission?.[permission]?.buildingIds;
  return Array.isArray(scopes) && scopes.includes(buildingId);
}
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
  function runResult(value, identity, input) {
    const spec = specOf(input.report) ?? fail();
    if (!granted(identity.effective, spec.permission) || value.report !== input.report || value.source !== spec.source || value.offset !== input.offset ||
        typeof value.sourceCapped !== 'boolean' || !Array.isArray(value.items) || value.items.length > input.limit ||
        !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && value.nextOffset === input.offset + value.items.length && value.items.length > 0)) fail();
    if (value.unavailable !== null) {
      if (!W2_UNAVAILABLE.includes(value.unavailable) || value.unavailable === 'no_building_scope' && !['rows', 'buildings'].includes(spec.scope) ||
          value.items.length || value.summary !== null || value.nextOffset !== null) fail();
      return { report: value.report, source: value.source, unavailable: value.unavailable, summary: null, items: [], offset: value.offset, nextOffset: null, sourceCapped: false };
    }
    if (!(spec.summary === null ? value.summary === null : shaped(value.summary, spec.summary))) fail();
    const building = input.params.buildingId ?? null;
    for (const row of value.items) {
      if (!shaped(row, spec.fields)) fail();
      if (Object.hasOwn(row, 'buildingId') && row.buildingId !== null &&
          (!id(row.buildingId) || !inScope(identity, spec.permission, row.buildingId) || building !== null && row.buildingId !== building)) fail();
    }
    return structuredClone({ report: value.report, source: value.source, unavailable: null, summary: value.summary, items: value.items,
      offset: value.offset, nextOffset: value.nextOffset, sourceCapped: value.sourceCapped });
  }
  const define = (toolName, description, inputSchema, input, resultKeys, result, mayUse) => Object.freeze({ family: 'v3', permission: null,
    label: description, description, fields: Object.freeze({}), statuses: Object.freeze([]), dated: false, requiresDates: false, perBuilding: false,
    source: null, toolName, inputSchema, input, resultKeys, result, mayUse });
  const reads = Object.freeze({
    report_list: define(W2_TOOL_NAMES[0], LIST_DESCRIPTION, LIST_SCHEMA, listInput, LIST_RESULT, listResult, effective => any(effective)),
    report: define(W2_TOOL_NAMES[1], RUN_DESCRIPTION, RUN_SCHEMA, runInput, RUN_RESULT, runResult,
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
