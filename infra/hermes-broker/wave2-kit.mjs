// Đợt 2 Hermes đọc đầy đủ — bộ khung chung (Gói 0, 18/10/2026). Gói A/B/C/D CHỈ import file
// này, KHÔNG sửa: mọi thay đổi ở đây là yêu cầu cho agent tích hợp (Gói Z).
//
// Mỗi báo cáo đợt 2 là MỘT mục khai báo bằng w2Report() trong wave2-<gói>-contract.mjs, khớp
// từng trường với app_private.hermes_w2<gói>_catalog_v1 (SQL). Mô hình gặp báo cáo qua hai tool
// meta (crm_read_report_list → crm_read_report), không phải mỗi báo cáo một tool (ngân sách
// tools/list, xem wave2-registry.mjs). Quyền mỗi báo cáo = MỘT khoá đọc (permission) của web;
// SQL quyết định cuối: quyền CRM thật ∩ registry ∩ chính sách công ty ∩ Read của kết nối ∩ toà
// overlay (app_private.hermes_w2_scope_v1). Không hàm copilot_* nào.
//
// INVOKER + RLS (20261018000600): broker gọi public.hermes_w2_read_v1 bằng JWT người hỏi. Bước kiểm quyền
// (DEFINER) dựng ctx, rồi hàm đọc của gói app_private.hermes_w2<gói>_read_v1 chạy SECURITY INVOKER dưới
// RLS của CHÍNH người hỏi (current_user = authenticated), rồi bước kết thúc (DEFINER) rào đầu ra/phân trang.
// Gói thay thân hàm đọc và GIỮ dòng đầu "LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET
// search_path=pg_catalog,public". Thân plpgsql KHÔNG gọi app_private.* theo tên (authenticated không có
// USAGE trên app_private ⇒ 42501); gọi hàm dùng chung public.<miền>_<báo cáo>_v<n> (INVOKER, từ chối khi
// current_user <> 'authenticated', NHẬN p_organization_id := ctx.organizationId và lọc organization_id tường
// minh — RLS của super admin / người nhiều công ty phủ cả công ty khác —, p_building_ids := ctx.buildings).
// Helper DEFINER chỉ để trả TẬP ID của
// chính người gọi, đặt ở public; cần app_private thì thân SQL chuẩn (gắn OID lúc tạo) + GRANT EXECUTE TO
// authenticated (hermes-durable-schema.test.mjs phải liệt kê).
//
// NGOẠI LỆ NỀN đã duyệt (Gói Z 18/10/2026 — cùng danh sách ở docs/CODEBASE_STRUCTURE.md "Công thức dùng chung"):
//  1. Helper DEFINER nhỏ ở public trả MỘT boolean, không trả danh sách: public.salary_is_admin_v1(p_organization_id) —
//     về CHÍNH người gọi (admin trang lương); public.finance_type_restricted_v1(p_type_id,p_merged) — về một hạng mục
//     trong công ty của người gọi (khác công ty/id lạ ⇒ NULL). EXECUTE chỉ authenticated, search_path cố định.
//  2. Hàng tổng hợp toàn công ty buildingId=null (cashbook_daily, cash_flow, fa_type_breakdown) chỉ khi kết nối phạm vi
//     Toàn tổ chức (cổng 20261018000700 nhận null chỉ khi orgWide); organizationId = p_organization_id hàm đã lọc.
//  3. Hàng dùng chung (organization_id NULL) bị bỏ và đếm ở summary.globalRowsOmitted (ie_types); trùng tên thì hàng
//     của công ty thắng khi khử trùng (20261018080000).
//  4. Báo cáo theo toà nhận tối đa 256 toà: network_fleet toàn công ty > 256 toà ⇒ 22023 hermes_domain_scope_too_large.
//  5. Chữ tự do gắn hợp đồng (ghi chú, người nộp, tên phiếu) chỉ khi MỌI khách của HĐ nhìn thấy dưới RLS customers.
import { id, nullable, longText, code, amount, bool, count, date, instant, shaped, PRIVATE_HINT } from './full-read-contract.mjs';
export { id, nullable, longText, code, amount, bool, count, date, instant, shaped, PRIVATE_HINT };

const fail = () => { throw new TypeError('invalid_w2_contract'); };
export const w2Record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

// Nhóm hiển thị cho mô hình (crm_read_report_list.topic) ↔ gói SQL.
export const W2_TOPICS = Object.freeze({ thu_tien: 'a', tai_chinh: 'b', van_hanh: 'c', danh_muc: 'd' });
export const W2_PACKAGES = Object.freeze(Object.fromEntries(Object.entries(W2_TOPICS).map(([topic, letter]) => [letter, topic])));
// Phạm vi báo cáo (cổng SQL quyết định; sửa sau review PR #195):
//   rows / buildings — hàng gắn toà / nguồn nhận danh sách toà: toà = CRM ∩ overlay; hết toà ⇒ no_building_scope.
//   organization     — dữ liệu không gắn toà: cần org_wide = CRM toàn công ty ∩ overlay Toàn tổ chức.
//   cashbooks        — sổ quỹ: org_wide, hoặc overlay Toàn tổ chức + sổ CRM cấp (ctx.cashbooks, scope CASHBOOK).
//   self             — dữ liệu của CHÍNH người hỏi (chỉ khoá loại self).
//   platform         — toàn nền tảng, chỉ super admin (chỉ khoá biến động số dư).
// Hàng (20261018000700, RLS người hỏi có thể rộng hơn công ty kết nối): rows/buildings — MỌI hàng có
// buildingId (fields khai buildingId); mọi phạm vi trừ self/platform — MỌI hàng gói trả có organizationId
// lấy từ CỘT nguồn (không chép ctx.organizationId), cổng so với công ty kết nối rồi GỠ trước khi trả, nên
// fields KHÔNG khai organizationId (trừ platform). Khác công ty ⇒ 42501; thiếu trường ⇒ XX000.
export const W2_SCOPES = Object.freeze(['rows', 'buildings', 'organization', 'cashbooks', 'self', 'platform']);
// Tham số mà cổng giải về toà (phải thuộc công ty + ctx.buildings, thu hẹp ctx.buildings): chỉ ở rows/buildings.
export const W2_BUILDING_PARAMS = Object.freeze(['buildingId', 'areaId', 'roomId', 'contractId', 'invoiceId']);

// Mọi khoá đọc MỚI của đợt 2 (seed MỘT lần ở 20261018000000, enabled=false; Gói Z bật).
// Tên = khoá web đang dùng (catalog CRM), trừ hai khoá Hermes-only vì web không có khoá:
//   assistant.salary.self      — "Lương của tôi" (/finance/my-salary chỉ cần cấu hình lương của chính mình);
//   assistant.bank_events.read — "Biến động số dư" (/bien-dong-so-du chỉ RequireSuperAdmin, dữ liệu toàn nền tảng).
// resource (capability-contract): building = SQL giao toà overlay; organization_scope = dữ liệu không
// gắn toà nhưng kết nối phải chọn phạm vi; self = không theo toà (grant trả buildingIds=[]).
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
// Khoá đợt 1 ĐÃ BẬT được dùng lại làm khoá báo cáo đợt 2 (khớp app_private.hermes_w2_reused_keys_v1).
// LƯU Ý: báo cáo dùng các khoá này SỐNG NGAY khi phát hành SQL + connector (registry đã bật từ 16/10),
// không chờ công tắc Gói Z. Cần khoá đợt 1 khác ⇒ yêu cầu Gói Z.
export const W2_REUSED_KEYS = Object.freeze(['invoices.view', 'deposits.view', 'reports_finance.analysis', 'assets.view', 'services.view',
  'rooms.view', 'income_expenses.view']);
// Khoá không theo toà (grant buildingIds=[]; khớp app_private.hermes_w2_self_keys_v1).
export const W2_SELF_KEYS = Object.freeze(Object.keys(W2_READ_KEYS).filter(key => W2_READ_KEYS[key] === 'self'));
export const W2_PLATFORM_KEYS = Object.freeze(['assistant.bank_events.read']);
// Khoá dữ liệu KHÔNG gắn toà (resource organization_scope; khớp app_private.hermes_w2_org_keys_v1):
// báo cáo dùng khoá này chỉ được scope organization hoặc cashbooks (chưa có ngoại lệ; cần ⇒ yêu cầu Gói Z kèm lý do).
export const W2_ORG_KEYS = Object.freeze(Object.keys(W2_READ_KEYS).filter(key => W2_READ_KEYS[key] === 'organization_scope'));
export const W2_ORG_SCOPES = Object.freeze(['organization', 'cashbooks']);
/** Loại khoá báo cáo (khớp app_private.hermes_w2_permission_kind_v1): 'platform' | 'self' | 'organization' | 'company' | null. */
export function w2PermissionKind(key) {
  if (W2_PLATFORM_KEYS.includes(key)) return 'platform';
  if (W2_SELF_KEYS.includes(key)) return 'self';
  if (W2_ORG_KEYS.includes(key)) return 'organization';
  return Object.hasOwn(W2_READ_KEYS, key) || W2_REUSED_KEYS.includes(key) ? 'company' : null;
}
// Lý do "không có số liệu" được phép (cổng SQL kiểm cùng tập; khác ⇒ backend_unavailable).
export const W2_UNAVAILABLE = Object.freeze(['organization_scope_required', 'no_building_scope', 'not_implemented', 'source_unavailable']);

// Từ điển tham số DUY NHẤT của đợt 2 (SQL: app_private.hermes_w2_params_v1 kiểm cùng luật).
// Một báo cáo chỉ khai tên trong từ điển; cần tên mới ⇒ yêu cầu Gói Z.
const MONTH = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
const NIL = '00000000-0000-0000-0000-000000000000';
const uuidParam = hint => Object.freeze({ type: 'uuid', hint });
export const W2_PARAMS = Object.freeze({
  query: Object.freeze({ type: 'text', hint: 'chữ tìm ≤200 ký tự' }),
  status: Object.freeze({ type: 'status', hint: null }),
  kind: Object.freeze({ type: 'kind', hint: null }),
  month: Object.freeze({ type: 'month', hint: 'YYYY-MM' }),
  year: Object.freeze({ type: 'year', hint: 'năm, 2000–2100' }),
  fromDate: Object.freeze({ type: 'date', hint: 'YYYY-MM-DD' }),
  toDate: Object.freeze({ type: 'date', hint: 'YYYY-MM-DD' }),
  date: Object.freeze({ type: 'date', hint: 'YYYY-MM-DD' }),
  days: Object.freeze({ type: 'days', hint: 'số ngày 1–365' }),
  floor: Object.freeze({ type: 'floor', hint: 'số tầng -5–200' }),
  basis: Object.freeze({ type: 'basis', hint: 'accrual|cash' }),
  unreadOnly: Object.freeze({ type: 'bool', hint: 'true|false' }),
  lowStock: Object.freeze({ type: 'bool', hint: 'true|false' }),
  buildingId: uuidParam('ID toà (không phải ID công ty)'),
  areaId: uuidParam('ID khu'),
  roomId: uuidParam('ID phòng'),
  customerId: uuidParam('ID khách'),
  contractId: uuidParam('ID hợp đồng'),
  invoiceId: uuidParam('ID hoá đơn'),
  cashbookId: uuidParam('ID sổ quỹ'),
  staffId: uuidParam('ID nhân viên'),
  categoryId: uuidParam('ID danh mục'),
  supplierId: uuidParam('ID nhà cung cấp'),
  materialId: uuidParam('ID vật tư'),
  itemId: uuidParam('ID mục'),
  fromId: uuidParam('ID mốc đầu'),
  toId: uuidParam('ID mốc cuối'),
});
const PARAM_CHECK = Object.freeze({
  text: value => typeof value === 'string' && [...value].length <= 200 && !CONTROL.test(value),
  month: value => typeof value === 'string' && MONTH.test(value),
  year: value => Number.isInteger(value) && value >= 2000 && value <= 2100,
  date,
  days: value => Number.isInteger(value) && value >= 1 && value <= 365,
  floor: value => Number.isInteger(value) && value >= -5 && value <= 200,
  basis: value => value === 'accrual' || value === 'cash',
  bool,
  uuid: id,
});

const KEY = /^[a-z][a-z0-9_.]{0,127}$/, REPORT_ID = /^[a-z][a-z0-9_]{1,47}$/, VALUE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const strings = (value, check) => Array.isArray(value) && value.every(item => typeof item === 'string' && check.test(item)) && new Set(value).size === value.length;
const validators = value => w2Record(value) && Object.values(value).every(check => typeof check === 'function');
export const isW2ReportId = value => typeof value === 'string' && REPORT_ID.test(value);

/** Khai báo MỘT báo cáo đợt 2. Kiểm khi nạp module: sai khai báo là lỗi ngay, không đợi lúc gọi.
 * permission: khoá đọc web — khoá đợt 2 (W2_READ_KEYS) hoặc khoá đợt 1 dùng lại (W2_REUSED_KEYS); loại khoá
 * buộc scope: khoá self ⇔ scope 'self', khoá biến động số dư ⇔ scope 'platform', khoá còn lại ⇒ rows/
 * buildings/organization/cashbooks. source: 'crm.<rpc|bảng web>'; title: mô tả cho mô hình (≤300 ký tự);
 * params ⊆ W2_PARAMS (W2_BUILDING_PARAMS chỉ ở rows/buildings); required ⊆ params; statuses/kinds bắt buộc
 * khi có param status/kind; scopeKeys: khoá CRM phụ cổng tính sẵn vào ctx.scopes (vd. customers.view cho
 * tên khách); fields/summary: hàm kiểm từng trường hàng/tổng; private: dữ liệu riêng tư (PRIVATE_HINT).
 * Hàng: trường buildingId/buildingIds CHỈ ở rows/buildings và phải thuộc toà cổng đã giao (null chỉ khi
 * org_wide); cashbookId ở scope cashbooks phải thuộc sổ được cấp — cổng SQL và broker đều rào, sai ⇒ 42501. */
export function w2Report({ permission, source, scope, title, params = [], required = [], statuses = null, kinds = null, scopeKeys = [],
  fields, summary = null, private: privateData = false, ...rest } = {}) {
  const kind = w2PermissionKind(permission);
  if (Object.keys(rest).length || typeof permission !== 'string' || !KEY.test(permission) || kind === null ||
      (kind === 'self') !== (scope === 'self') || (kind === 'platform') !== (scope === 'platform') ||
      kind === 'organization' && !W2_ORG_SCOPES.includes(scope) ||
      // Trường rào: theo toà phải khai buildingId; organizationId do cổng gỡ (chỉ platform được khai).
      validators(fields) && (['rows', 'buildings'].includes(scope) && !Object.hasOwn(fields, 'buildingId') ||
        scope !== 'platform' && Object.hasOwn(fields, 'organizationId')) ||
      typeof source !== 'string' || !/^crm\.[a-z][a-z0-9_.]{0,79}$/.test(source) ||
      !W2_SCOPES.includes(scope) || typeof title !== 'string' || !title.trim() || [...title].length > 300 || CONTROL.test(title) ||
      !strings(params, /^[a-zA-Z]+$/) || params.some(name => !Object.hasOwn(W2_PARAMS, name)) ||
      !strings(required, /^[a-zA-Z]+$/) || required.some(name => !params.includes(name)) ||
      (params.includes('status') ? !(strings(statuses, VALUE) && statuses.length > 0) : statuses !== null) ||
      (params.includes('kind') ? !(strings(kinds, VALUE) && kinds.length > 0) : kinds !== null) ||
      !['rows', 'buildings'].includes(scope) && params.some(name => W2_BUILDING_PARAMS.includes(name)) ||
      !strings(scopeKeys, KEY) || !validators(fields) || !(summary === null || validators(summary)) || typeof privateData !== 'boolean') fail();
  return Object.freeze({ permission, source, scope, title, params: Object.freeze([...params]), required: Object.freeze([...required]),
    statuses: statuses && Object.freeze([...statuses]), kinds: kinds && Object.freeze([...kinds]), scopeKeys: Object.freeze([...scopeKeys]),
    fields: Object.freeze({ ...fields }), summary: summary && Object.freeze({ ...summary }), private: privateData });
}

/** Chuẩn hoá tham số của MỘT báo cáo: đủ mọi tên đã khai (thiếu = null), chuỗi trống/khoảng
 * trắng và UUID toàn số 0 = null (mô hình hay gửi chỗ trống), rồi kiểm kiểu/giá trị như SQL. */
export function w2Params(spec, supplied) {
  const raw = supplied === undefined || supplied === null ? {} : supplied;
  if (!w2Record(raw) || Object.keys(raw).some(name => !spec.params.includes(name))) fail();
  const value = {};
  for (const name of spec.params) {
    let item = Object.hasOwn(raw, name) ? raw[name] : null;
    if (typeof item === 'string') {
      item = item.trim();
      if (item === '' || W2_PARAMS[name].type === 'uuid' && item === NIL) item = null;
    }
    const { type } = W2_PARAMS[name];
    if (item !== null && !(type === 'status' ? spec.statuses.includes(item) : type === 'kind' ? spec.kinds.includes(item) : PARAM_CHECK[type](item))) fail();
    if (item === null && spec.required.includes(name)) fail();
    value[name] = item;
  }
  const { fromDate = null, toDate = null } = value;
  if (fromDate !== null && toDate !== null && (toDate < fromDate || Date.parse(toDate) - Date.parse(fromDate) > 366 * 86_400_000)) fail();
  return value;
}

/** Dòng mục lục cho mô hình: tham số kèm gợi ý, status/kind liệt kê giá trị, "bắt buộc". */
export function w2CatalogEntry(reportId, spec, letter) {
  return { report: reportId, topic: W2_PACKAGES[letter], title: spec.title, private: spec.private,
    params: Object.fromEntries(spec.params.map(name => {
      const values = name === 'status' ? spec.statuses : name === 'kind' ? spec.kinds : null;
      const hint = values ? values.join('|') : W2_PARAMS[name].hint;
      return [name, spec.required.includes(name) ? `${hint}, bắt buộc` : hint];
    })) };
}
