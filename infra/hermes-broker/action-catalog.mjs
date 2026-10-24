// Sổ danh mục thao tác ghi dùng chung (Đợt 1 nền chung, docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 5).
// Mỗi trang khai thao tác của mình bằng defineAction(); createActionCatalog() gom lại và kiểm khi nạp (mã trùng,
// khoá không có trong tập khoá Action được phép, lý do ngoài danh sách đóng, khuôn tham số sai ⇒ lỗi nạp, không
// chạy). Thêm thao tác KHÔNG tốn byte tools/list: khuôn tham số nằm trong KẾT QUẢ của crm_action_list.
// Hermes không tự kiểm được `params` (object tự do) nên connector kiểm theo khuôn ở đây và trả gợi ý TĨNH dựng từ
// khuôn (tên tham số + mô tả kiểu), không bao giờ nhắc lại giá trị mô hình gửi.
import { ACTION_INPUT_REASONS, ACTION_REASON_CODES } from './action-reasons.mjs';
import { HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';
import { CONSENT_HINT, consentRequired } from './consent-guard.mjs';

export const ACTION_PAGES = Object.freeze(['expense', 'invoice', 'contract', 'task', 'probe']);
// money / irreversible: sàn xác nhận nằm trong mã (D2) — cấu hình chỉ siết được. reversible: theo chính sách DB.
export const ACTION_CLASSES = Object.freeze(['money', 'irreversible', 'reversible']);
export const ACTION_ID = /^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,31}$/;
// Câu 11: đường nhận ảnh bill qua Zalo làm ở đợt Thu chi. Tới khi có luồng ảnh, thao tác nào khai attachments bị
// từ chối lúc nạp (không để mô hình tưởng gửi ảnh được).
export const ATTACHMENTS_READY = false;
const PARAM = /^[a-z][A-Za-z0-9]{0,31}$/;
// MAX_LIST: trần chung của danh sách; khuôn nào cần nhiều hơn khai ceiling riêng (≤ MAX_LIST_CEILING, HDN7 — chỉ số cả toà 60 dòng).
const MAX_PARAMS = 16, MAX_ACTIONS = 128, MAX_LIST = 20, MAX_LIST_CEILING = 60, MAX_RECORD_FIELDS = 12;
// Khuôn vô hướng: được làm phần tử của list hoặc trường của record (không lồng list/record/ảnh). time (Công việc Mốc 4): giờ hạn của từng
// mục trong lô task.create_batch.
const SCALARS = Object.freeze(['text', 'name', 'int', 'vnd', 'date', 'month', 'time', 'oneOf', 'bool']);
const NAME_LABELS = Object.freeze({ building: 'toà', room: 'phòng', customer: 'khách', person: 'người', voucher: 'mã phiếu', invoice: 'mã hoá đơn',
  category: 'hạng mục', cashbook: 'sổ quỹ', jobType: 'loại việc' });
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
// Mảng dữ liệu thuần: prototype Array, chỉ chỉ số + length, mọi phần tử là value (không accessor, không lỗ).
const dataArray = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
  Reflect.ownKeys(value).every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) && Object.keys(value).length === value.length;

// ---- Khuôn tham số. Mỗi khuôn: { kind, optional, hint, ...giới hạn } đông cứng. hint là câu tĩnh cho mô hình.
const spec = (kind, optional, hint, extra = {}) => Object.freeze({ kind, optional: optional === true, hint, ...extra });
export const param = Object.freeze({
  text: (min, max, { optional = false } = {}) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 4000) fail();
    return spec('text', optional, `chữ ${min}–${max} ký tự`, { min, max });
  },
  // Tên do SQL giải (D7: hàm giải tên dùng chung, INVOKER + RLS); connector chỉ kiểm dạng chuỗi.
  name: (of, { optional = false } = {}) => {
    if (!Object.hasOwn(NAME_LABELS, of) && of !== 'job' && of !== 'recurrence') fail();
    // job (Công việc Mốc 3): mã việc đầy đủ, 3–4 số cuối, "vừa giao" hoặc tiêu đề — SQL tìm đúng một việc, mơ hồ thì hỏi lại.
    // recurrence (Mốc 5): mã việc định kỳ DK-… hoặc nội dung — SQL tìm đúng một quy tắc, mơ hồ thì hỏi lại.
    return spec('name', optional, of === 'job' ? 'mã việc (JOB-…, 4 số cuối) hoặc tiêu đề như người dùng nói'
      : of === 'recurrence' ? 'mã việc định kỳ (DK-…) hoặc nội dung như người dùng nói' : `tên ${NAME_LABELS[of]} như người dùng nói`,
      { of, min: 1, max: 120 });
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
  // Lô (Đợt 2: Thu chi ≤ 5 khoản/≤ 10 phiếu, Hợp đồng gia hạn ≤ 20 HĐ). Phần tử là khuôn vô hướng hoặc record (chỉ dùng
  // trong list). Cả lô là MỘT params: token xác nhận gắn cả lô (canonicalJson giữ thứ tự phần tử).
  record: (fields) => {
    if (!plain(fields) || !Object.keys(fields).length || Object.keys(fields).length > MAX_RECORD_FIELDS || Object.entries(fields).some(([name, value]) =>
      !PARAM.test(name) || !plain(value) || !Object.isFrozen(value) || !SCALARS.includes(value.kind))) fail();
    return spec('record', false, `{${Object.entries(fields).map(([name, value]) => `${name}${value.optional ? '' : '*'} (${value.hint})`).join('; ')}}`,
      { fields: Object.freeze({ ...fields }) });
  },
  // overflow (Công việc lượt 13): lý do needs_input riêng khi danh sách DÀI HƠN max (vd batch_too_large "chia lô"), thay cho
  // invalid_params chung; thao tác phải khai lý do đó trong reasons. Không đổi khuôn liệt kê ở crm_action_list.
  list: (item, { min = 1, max, ceiling = MAX_LIST, optional = false, overflow } = {}) => {
    if (!plain(item) || !Object.isFrozen(item) || ![...SCALARS, 'record'].includes(item.kind) || item.optional ||
        !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !Number.isSafeInteger(ceiling) || ceiling < MAX_LIST || ceiling > MAX_LIST_CEILING ||
        min < 1 || max < min || max > ceiling || !(overflow === undefined || ACTION_INPUT_REASONS.includes(overflow))) fail();
    return spec('list', optional, `danh sách ${min}–${max} mục, mỗi mục ${item.hint}`, { item, min, max, ...(overflow ? { overflow } : {}) });
  },
});
const KINDS = Object.freeze(['text', 'name', 'int', 'vnd', 'date', 'month', 'time', 'oneOf', 'bool', 'attachments', 'list']);

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
    if (value.kind === 'list' && value.overflow !== undefined && !reasons.includes(value.overflow)) fail();
  }
  const action = Object.freeze({ id, page, key, class: kind, title, rpc, params: Object.freeze({ ...params }), reasons: Object.freeze([...reasons]) });
  DEFINED.add(action);
  return action;
}

// Khuôn một tham số trong mục lục crm_action_list (list ⇒ khuôn phần tử; record ⇒ khuôn từng trường).
function listedParam(value) {
  const base = { type: value.kind, required: !value.optional, hint: value.hint, ...(value.kind === 'oneOf' ? { values: [...value.values] } : {}) };
  if (value.kind === 'record') return { ...base, fields: Object.fromEntries(Object.entries(value.fields).map(([name, field]) => [name, listedParam(field)])) };
  if (value.kind === 'list') return { ...base, min: value.min, max: value.max, item: listedParam(value.item) };
  return base;
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
        // Lượt 12 Hợp đồng (rào đồng ý): thao tác không lùi được nói rõ lượt xác nhận phải kèm consentText (ngoài params).
        ...(consentRequired(action) ? { consentText: CONSENT_HINT } : {}),
        params: Object.fromEntries(Object.entries(action.params).map(([name, value]) => [name, listedParam(value)])),
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

/** Kiểm + chuẩn hoá params theo khuôn. {ok:true, value} | {ok:false, detail} | {ok:false, overflow:{reason,path,count,max}} (danh sách
 * cấp ngoài khai overflow dài hơn max). detail chỉ dựng từ khuôn. */
export function validateActionParams(action, raw) {
  const accepted = Object.keys(action.params);
  const shape = () => accepted.length ? accepted.map(name => `${name}${action.params[name].optional ? '' : '*'} (${action.params[name].hint})`).join('; ') : 'không có tham số';
  const refuse = (problem) => ({ ok: false, detail: `${problem} Khuôn ${action.id}: ${shape()}. (* = bắt buộc)` });
  if (raw === undefined || raw === null) raw = {};
  if (!dataRecord(raw)) return refuse('params phải là object.');
  for (const [name, spec] of Object.entries(action.params)) {
    const supplied = raw[name] ?? raw[name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)];
    if (spec.kind === 'list' && spec.overflow && dataArray(supplied) && supplied.length > spec.max)
      return { ok: false, overflow: { reason: spec.overflow, path: name, count: supplied.length, max: spec.max } };
  }
  const checked = checkFields(action.params, raw, '');
  if (checked.unknown) return refuse('Có tham số không nhận.');
  if (checked.duplicate) return refuse(`Tham số ${checked.duplicate} gửi hai lần.`);
  if (checked.wrong.length) return refuse(`Thiếu hoặc sai: ${checked.wrong.map(entry => `${entry.path} (${entry.hint})`).join('; ')}.`);
  return { ok: true, value: checked.value };
}

// Kiểm một tập trường (params cấp ngoài, hoặc record trong list). snake_case → camelCase như normalizeToolArguments; gửi cả
// hai dạng của cùng một tham số là sai. wrong = [{path, hint}] — path chỉ gồm tên trong khuôn và số thứ tự (#1 = mục đầu),
// không bao giờ nhắc lại giá trị hay khoá lạ mô hình gửi.
function checkFields(fields, raw, prefix) {
  const input = {};
  let unknown = false, duplicate = null;
  for (const [supplied, value] of Object.entries(raw)) {
    const name = Object.hasOwn(fields, supplied) ? supplied : snakeToCamel(supplied);
    if (!Object.hasOwn(fields, name)) { unknown = true; continue; }
    if (Object.hasOwn(input, name)) { duplicate ??= name; continue; }
    input[name] = value;
  }
  const value = {}, wrong = [];
  for (const [name, spec] of Object.entries(fields)) {
    const supplied = input[name], path = `${prefix}${name}`;
    const blank = supplied === undefined || supplied === null || (typeof supplied === 'string' && supplied.trim() === '');
    if (blank) { if (!spec.optional) wrong.push({ path, hint: spec.hint }); continue; }
    if (spec.kind === 'list') {
      const list = checkList(spec, supplied, path);
      if (list.wrong.length) wrong.push(...list.wrong); else value[name] = list.value;
      continue;
    }
    const checked = checkValue(spec, supplied);
    if (checked === undefined) wrong.push({ path, hint: spec.hint }); else value[name] = checked;
  }
  return { value, wrong, unknown, duplicate };
}

function checkList(spec, raw, path) {
  if (!dataArray(raw) || raw.length < spec.min || raw.length > spec.max) return { wrong: [{ path, hint: `danh sách ${spec.min}–${spec.max} mục` }] };
  const value = [], wrong = [];
  raw.forEach((element, index) => {
    const at = `${path}#${index + 1}`;
    if (spec.item.kind !== 'record') {
      const checked = checkValue(spec.item, element);
      if (checked === undefined) wrong.push({ path: at, hint: spec.item.hint }); else value.push(checked);
      return;
    }
    if (!dataRecord(element)) { wrong.push({ path: at, hint: 'mỗi mục là object' }); return; }
    const checked = checkFields(spec.item.fields, element, `${at}.`);
    if (checked.unknown) wrong.push({ path: at, hint: 'có trường không nhận' });
    if (checked.duplicate) wrong.push({ path: `${at}.${checked.duplicate}`, hint: 'gửi hai lần' });
    wrong.push(...checked.wrong);
    value.push(checked.value);
  });
  return { value, wrong };
}

/** JSON chuẩn hoá (khoá sắp xếp) — dùng cho khoá binding xác nhận: cùng nội dung ⇒ cùng chuỗi. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
