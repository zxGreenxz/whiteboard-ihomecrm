// Đợt 2 Hermes đọc đầy đủ — bộ khung chung (Gói 0, 18/10/2026). Gói A/B/C/D CHỈ import file
// này, KHÔNG sửa: mọi thay đổi ở đây là yêu cầu cho agent tích hợp (Gói Z).
//
// Mỗi báo cáo đợt 2 là MỘT mục khai báo bằng w2Report() trong wave2-<gói>-contract.mjs, khớp
// từng trường với app_private.hermes_w2<gói>_catalog_v1 (SQL). Mô hình gặp báo cáo qua hai tool
// meta (crm_read_report_list → crm_read_report), không phải mỗi báo cáo một tool (ngân sách
// tools/list, xem wave2-registry.mjs). Quyền mỗi báo cáo = MỘT khoá đọc (permission) của web;
// SQL quyết định cuối: quyền CRM thật ∩ registry ∩ chính sách công ty ∩ Read của kết nối ∩ toà
// overlay (app_private.hermes_w2_gate_v1). Không hàm copilot_* nào.
import { id, nullable, longText, code, amount, bool, count, date, instant, shaped, PRIVATE_HINT } from './full-read-contract.mjs';
export { id, nullable, longText, code, amount, bool, count, date, instant, shaped, PRIVATE_HINT };

const fail = () => { throw new TypeError('invalid_w2_contract'); };
export const w2Record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

// Nhóm hiển thị cho mô hình (crm_read_report_list.topic) ↔ gói SQL.
export const W2_TOPICS = Object.freeze({ thu_tien: 'a', tai_chinh: 'b', van_hanh: 'c', danh_muc: 'd' });
export const W2_PACKAGES = Object.freeze(Object.fromEntries(Object.entries(W2_TOPICS).map(([topic, letter]) => [letter, topic])));
// rows = hàng có toà, lọc theo toà đã giao; buildings = nguồn nhận danh sách toà; organization =
// dữ liệu không gắn toà ⇒ chỉ kết nối Toàn tổ chức; self = dữ liệu của CHÍNH người hỏi (không toà).
export const W2_SCOPES = Object.freeze(['rows', 'buildings', 'organization', 'self']);
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
 * permission: khoá đọc web (đã có hoặc khoá đợt 2 trong W2_READ_KEYS); source: 'crm.<rpc|bảng web>';
 * scope: W2_SCOPES; title: mô tả cho mô hình (≤300 ký tự, tiếng Việt); params ⊆ W2_PARAMS; required ⊆ params;
 * statuses/kinds: bắt buộc khi có param status/kind; scopeKeys: khoá phụ cổng SQL tính sẵn vào ctx.scopes
 * (vd. customers.view cho tên khách); fields/summary: hàm kiểm từng trường hàng/tổng; private: dữ liệu
 * riêng tư (PRIVATE_HINT) — chỉ trả lời riêng. Hàng có trường buildingId (khác null) bị broker rào theo
 * phạm vi CRM của permission: báo cáo scope=self không đặt tên trường là buildingId. */
export function w2Report({ permission, source, scope, title, params = [], required = [], statuses = null, kinds = null, scopeKeys = [],
  fields, summary = null, private: privateData = false, ...rest } = {}) {
  if (Object.keys(rest).length || typeof permission !== 'string' || !KEY.test(permission) ||
      typeof source !== 'string' || !/^crm\.[a-z][a-z0-9_.]{0,79}$/.test(source) ||
      !W2_SCOPES.includes(scope) || typeof title !== 'string' || !title.trim() || [...title].length > 300 || CONTROL.test(title) ||
      !strings(params, /^[a-zA-Z]+$/) || params.some(name => !Object.hasOwn(W2_PARAMS, name)) ||
      !strings(required, /^[a-zA-Z]+$/) || required.some(name => !params.includes(name)) ||
      (params.includes('status') ? !(strings(statuses, VALUE) && statuses.length > 0) : statuses !== null) ||
      (params.includes('kind') ? !(strings(kinds, VALUE) && kinds.length > 0) : kinds !== null) ||
      ['organization', 'self'].includes(scope) && params.includes('buildingId') ||
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
