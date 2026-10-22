// Sổ danh mục thao tác ghi dùng chung (Đợt 1 nền chung, docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 5).
// Mỗi trang khai thao tác của mình bằng defineAction(); createActionCatalog() gom lại và kiểm khi nạp (mã trùng,
// khoá không có trong tập khoá Action được phép, lý do ngoài danh sách đóng, khuôn tham số sai ⇒ lỗi nạp, không
// chạy). Thêm thao tác KHÔNG tốn byte tools/list: khuôn tham số nằm trong KẾT QUẢ của crm_action_list.
// Hermes không tự kiểm được `params` (object tự do) nên connector kiểm theo khuôn ở đây và trả gợi ý TĨNH dựng từ
// khuôn (tên tham số + mô tả kiểu), không bao giờ nhắc lại giá trị mô hình gửi.
import { ACTION_REASON_CODES } from './action-reasons.mjs';
import { HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';

export const ACTION_PAGES = Object.freeze(['expense', 'invoice', 'contract', 'task', 'probe']);
// money / irreversible: sàn xác nhận nằm trong mã (D2) — cấu hình chỉ siết được. reversible: theo chính sách DB.
export const ACTION_CLASSES = Object.freeze(['money', 'irreversible', 'reversible']);
export const ACTION_ID = /^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,31}$/;
// Câu 11: đường nhận ảnh bill qua Zalo làm ở đợt Thu chi. Tới khi có luồng ảnh, thao tác nào khai attachments bị
// từ chối lúc nạp (không để mô hình tưởng gửi ảnh được).
export const ATTACHMENTS_READY = false;
const PARAM = /^[a-z][A-Za-z0-9]{0,31}$/;
const MAX_PARAMS = 16, MAX_ACTIONS = 128;
const CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
const MAX_VND = 9_999_999_999_999;
const fail = () => { throw new TypeError('invalid_action_catalog'); };
// Chỉ đầu ra của defineAction() mới vào danh mục: một object tự đông cứng (lý do ngoài danh sách, attachments, class lạ…) bị
// từ chối lúc nạp, vì mọi phép kiểm nằm trong defineAction (review #253).
const DEFINED = new WeakSet();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Bản ghi dữ liệu thuần: chỉ khoá chuỗi, enumerable, có value (không accessor).
const dataRecord = value => plain(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' &&
  Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

// ---- Khuôn tham số. Mỗi khuôn: { kind, optional, hint, ...giới hạn } đông cứng. hint là câu tĩnh cho mô hình.
const spec = (kind, optional, hint, extra = {}) => Object.freeze({ kind, optional: optional === true, hint, ...extra });
export const param = Object.freeze({
  text: (min, max, { optional = false } = {}) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 4000) fail();
    return spec('text', optional, `chữ ${min}–${max} ký tự`, { min, max });
  },
  // Tên do SQL giải (D7: hàm giải tên dùng chung, INVOKER + RLS); connector chỉ kiểm dạng chuỗi.
  name: (of, { optional = false } = {}) => {
    if (!['building', 'room', 'customer', 'person', 'voucher', 'invoice', 'jobType', 'job'].includes(of)) fail();
    // job (Công việc Mốc 3): mã việc đầy đủ, 3–4 số cuối, "vừa giao" hoặc tiêu đề — SQL tìm đúng một việc, mơ hồ thì hỏi lại.
    return spec('name', optional, of === 'job' ? 'mã việc (JOB-…, 4 số cuối) hoặc tiêu đề như người dùng nói'
      : `tên ${{ building: 'toà', room: 'phòng', customer: 'khách', person: 'người', voucher: 'mã phiếu', invoice: 'mã hoá đơn', jobType: 'loại việc' }[of]} như người dùng nói`, { of, min: 1, max: 120 });
  },
  int: (min, max, { optional = false } = {}) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) fail();
    return spec('int', optional, `số nguyên ${min}–${max}`, { min, max });
  },
  vnd: ({ min = 1, max = MAX_VND, optional = false } = {}) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min || max > MAX_VND) fail();
    return spec('vnd', optional, 'số nguyên VND (3tr5 = 3500000)', { min, max });
  },
  date: ({ optional = false } = {}) => spec('date', optional, 'ngày YYYY-MM-DD (giờ Việt Nam)'),
  month: ({ optional = false } = {}) => spec('month', optional, 'tháng YYYY-MM'),
  // Trang Công việc (Đợt 2b): giờ trong ngày của hạn việc; trống = cuối ngày như web.
  time: ({ optional = false } = {}) => spec('time', optional, 'giờ HH:MM (giờ Việt Nam)'),
  oneOf: (values, { optional = false } = {}) => {
    if (!Array.isArray(values) || !values.length || values.length > 16 || values.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(value)) ||
        new Set(values).size !== values.length) fail();
    return spec('oneOf', optional, `một trong: ${values.join(', ')}`, { values: Object.freeze([...values]) });
  },
  bool: ({ optional = false } = {}) => spec('bool', optional, 'true hoặc false'),
  // Dự phòng câu 11: tham chiếu ảnh đã tải lên (không phải ảnh thô). Chưa có luồng ảnh ⇒ defineAction từ chối.
  attachments: ({ max = 5, optional = true } = {}) => {
    if (!Number.isSafeInteger(max) || max < 1 || max > 10) fail();
    return spec('attachments', optional, `tối đa ${max} tham chiếu ảnh đã tải lên`, { max });
  },
});
const KINDS = Object.freeze(['text', 'name', 'int', 'vnd', 'date', 'month', 'time', 'oneOf', 'bool', 'attachments']);

/** Khai một thao tác. reasons = lý do riêng của trang (phải có trong danh sách đóng action-reasons.mjs). */
export function defineAction({ id, page, key, class: kind, title, rpc, params = {}, reasons = [], ...rest } = {}) {
  // rpc: RPC của trang (INVOKER) nhận (p_binding, p_action, p_phase, p_request_id, p_params, p_resolved, p_expected_basis), khuôn
  // public.hermes_action_probe_v1 (20261021133823); adapter chỉ gọi đúng các tên đã khai ở đây.
  if (Object.keys(rest).length || typeof rpc !== 'string' || !/^hermes_[a-z0-9_]+_v[1-9][0-9]*$/.test(rpc) || typeof id !== 'string' || !ACTION_ID.test(id) || !ACTION_PAGES.includes(page) || !id.startsWith(`${page}.`) ||
      typeof key !== 'string' || !/^[a-z][a-z0-9_.]{0,127}$/.test(key) || !ACTION_CLASSES.includes(kind) ||
      typeof title !== 'string' || !title.trim() || title.length > 120 || CONTROL.test(title) ||
      !plain(params) || Object.keys(params).length > MAX_PARAMS || !Array.isArray(reasons) ||
      reasons.some(code => !ACTION_REASON_CODES.includes(code)) || new Set(reasons).size !== reasons.length) fail();
  for (const [name, value] of Object.entries(params)) {
    if (!PARAM.test(name) || !plain(value) || !Object.isFrozen(value) || !KINDS.includes(value.kind)) fail();
    if (value.kind === 'attachments' && !ATTACHMENTS_READY) fail();
  }
  const action = Object.freeze({ id, page, key, class: kind, title, rpc, params: Object.freeze({ ...params }), reasons: Object.freeze([...reasons]) });
  DEFINED.add(action);
  return action;
}

/** Gom danh mục. `keys` = tập khoá Action được nhận; mặc định và trần là HERMES_ACTION_CAPABILITIES của capability-contract
 * (truyền tập hẹp hơn được, khoá ngoài hợp đồng thì không). */
export function createActionCatalog(actions, { keys = HERMES_ACTION_CAPABILITIES } = {}) {
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS || !Array.isArray(keys) || keys.some(value => typeof value !== 'string' || !HERMES_ACTION_CAPABILITIES.includes(value))) fail();
  const byId = {};
  for (const action of actions) {
    if (!DEFINED.has(action) || !plain(action) || !Object.isFrozen(action) || !ACTION_ID.test(action.id) || Object.hasOwn(byId, action.id) || !keys.includes(action.key)) fail();
    byId[action.id] = action;
  }
  Object.freeze(byId);
  const ids = Object.freeze(Object.keys(byId));
  const actionKeys = Object.freeze([...new Set(ids.map(id => byId[id].key))].sort());
  const get = id => typeof id === 'string' && Object.hasOwn(byId, id) ? byId[id] : null;
  const granted = (effective, action) => Array.isArray(effective?.action) && effective.action.includes(action.key);
  return Object.freeze({
    actions: byId, ids, keys: actionKeys, get,
    get empty() { return ids.length === 0; },
    pages: Object.freeze([...new Set(ids.map(id => byId[id].page))]),
    rpcs: Object.freeze([...new Set(ids.map(id => byId[id].rpc))].sort()),
    /** Ít nhất một thao tác của danh mục mà kết nối giữ khoá. */
    any: effective => ids.some(id => granted(effective, byId[id])),
    granted: (effective, id) => { const action = get(id); return action !== null && granted(effective, action); },
    /** Mục lục cho crm_action_list: chỉ thao tác kết nối giữ khoá; params kèm khuôn tĩnh. */
    listing(effective, page = null) {
      return ids.map(id => byId[id]).filter(action => granted(effective, action) && (page === null || action.page === page)).map(action => ({
        action: action.id, page: action.page, title: action.title,
        confirm: action.class === 'reversible' ? 'if_required' : 'always',
        params: Object.fromEntries(Object.entries(action.params).map(([name, value]) => [name,
          { type: value.kind, required: !value.optional, hint: value.hint, ...(value.kind === 'oneOf' ? { values: [...value.values] } : {}) }])),
      }));
    },
  });
}

const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-01' && value <= '2100-12-31' &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const month = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '2000-01' && value <= '2100-12';
const snakeToCamel = key => key.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
// Số dạng chuỗi chỉ gồm chữ số (mô hình hay gửi "3500000"); "3tr5", "3.5" hay "3,500,000" là việc của mô hình.
const integerOf = value => typeof value === 'string' && /^\d{1,16}$/.test(value.trim()) ? Number(value.trim()) : value;

function checkValue(spec, raw) {
  switch (spec.kind) {
    case 'text': case 'name': {
      if (typeof raw !== 'string') return undefined;
      const value = raw.trim();
      return value.length >= spec.min && [...value].length <= spec.max && !CONTROL.test(value) ? value : undefined;
    }
    case 'int': case 'vnd': {
      const value = integerOf(raw);
      return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max ? value : undefined;
    }
    case 'date': return date(raw) ? raw : undefined;
    case 'month': return month(raw) ? raw : undefined;
    case 'time': return typeof raw === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(raw.trim()) ? raw.trim() : undefined;
    case 'oneOf': return typeof raw === 'string' && spec.values.includes(raw.trim()) ? raw.trim() : undefined;
    case 'bool': return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : undefined;
    default: return undefined;
  }
}

/** Kiểm + chuẩn hoá params theo khuôn. {ok:true, value} | {ok:false, detail}. detail chỉ dựng từ khuôn. */
export function validateActionParams(action, raw) {
  const accepted = Object.keys(action.params);
  const shape = () => accepted.length ? accepted.map(name => `${name}${action.params[name].optional ? '' : '*'} (${action.params[name].hint})`).join('; ') : 'không có tham số';
  const refuse = (problem) => ({ ok: false, detail: `${problem} Khuôn ${action.id}: ${shape()}. (* = bắt buộc)` });
  if (raw === undefined || raw === null) raw = {};
  if (!dataRecord(raw)) return refuse('params phải là object.');
  // snake_case → camelCase như normalizeToolArguments; gửi cả hai dạng của cùng một tham số là sai.
  const input = {};
  for (const [supplied, value] of Object.entries(raw)) {
    const name = Object.hasOwn(action.params, supplied) ? supplied : snakeToCamel(supplied);
    if (!Object.hasOwn(action.params, name)) return refuse('Có tham số không nhận.');
    if (Object.hasOwn(input, name)) return refuse(`Tham số ${name} gửi hai lần.`);
    input[name] = value;
  }
  const value = {}, wrong = [];
  for (const name of accepted) {
    const spec = action.params[name], supplied = input[name];
    const blank = supplied === undefined || supplied === null || (typeof supplied === 'string' && supplied.trim() === '');
    if (blank) { if (!spec.optional) wrong.push(name); continue; }
    const checked = checkValue(spec, supplied);
    if (checked === undefined) wrong.push(name); else value[name] = checked;
  }
  if (wrong.length) return refuse(`Thiếu hoặc sai: ${wrong.map(name => `${name} (${action.params[name].hint})`).join('; ')}.`);
  return { ok: true, value };
}

/** JSON chuẩn hoá (khoá sắp xếp) — dùng cho khoá binding xác nhận: cùng nội dung ⇒ cùng chuỗi. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
