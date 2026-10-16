import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY } from './request-id-contract.mjs';
import { canonicalInstant, domainExact, domainId, domainRecord } from './domain-contract.mjs';
// "Gửi ảnh phòng trống" of the CRM (zalo_automations kind=broadcast_vacant) is the
// ONLY scheduler for this job. These tools read it, send/schedule one run through
// zalo_hen_gui_phong_trong_v1, cancel a pending run and patch the recurring
// settings. Existing capability keys only; SQL hermes_zalo_broadcast_v1 re-checks
// the connection overlay and current CRM grants on every call.
export const ZALO_BROADCAST_READ = 'chat_zalo.view';
export const ZALO_BROADCAST_MANAGE = 'chat_zalo.manage_automation';
export const ZALO_BROADCAST_SEND = 'chat_zalo.send';
const TOOL_OPERATIONS = Object.freeze({ crm_zalo_broadcast_status: 'status', crm_zalo_broadcast_recipients: 'recipients',
  crm_zalo_broadcast_send: 'send', crm_zalo_broadcast_cancel: 'cancel', crm_zalo_broadcast_update: 'update' });
const OPERATIONS = Object.freeze(Object.values(TOOL_OPERATIONS));
export const ZALO_BROADCAST_WRITES = Object.freeze(['send', 'cancel', 'update']);
export const zaloBroadcastOperation = name => typeof name === 'string' && Object.hasOwn(TOOL_OPERATIONS, name) ? TOOL_OPERATIONS[name] : null;
export function mayUseZaloBroadcast(effective, operation) {
  if (!OPERATIONS.includes(operation) || effective?.read?.includes(ZALO_BROADCAST_READ) !== true) return false;
  if (!ZALO_BROADCAST_WRITES.includes(operation)) return true;
  if (effective.action?.includes(ZALO_BROADCAST_MANAGE) !== true) return false;
  return operation !== 'send' || effective.action.includes(ZALO_BROADCAST_SEND);
}
export const ZALO_BROADCAST_LIMITS = Object.freeze({ sendGroups: 50, listGroups: 100, query: 120, pageSize: 50 });
const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const MODES = Object.freeze(['full', 'compact', 'off']);
const fail = () => { throw new TypeError('invalid_zalo_broadcast'); };
const points = value => [...value].length;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u;
const LABEL_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:-?[0-9]{1,10}$/;
function ids(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) fail();
  const out = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !domainId(descriptor.value) || out.includes(descriptor.value)) fail();
    out.push(descriptor.value);
  }
  return out;
}
// Search text: trimmed, inner whitespace collapsed; blank = no filter.
function query(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail();
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (points(text) > ZALO_BROADCAST_LIMITS.query || CONTROL.test(text)) fail();
  return text;
}
// "H:MM"/"HH:MM" in Vietnam time, returned as "HH:MM".
function time(value) {
  const match = typeof value === 'string' ? /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) fail();
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}
function days(value) {
  if (!domainRecord(value)) fail();
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !DAYS.includes(key) || !MODES.includes(value[key]))) fail();
  return Object.fromEntries(DAYS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
const UPDATE_KEYS = Object.freeze(['requestId', 'expectedVersion', 'enabled', 'time', 'days', 'addConversationIds', 'removeConversationIds', 'setConversationIds']);
export function zaloBroadcastInput(operation, input) {
  if (!domainRecord(input)) fail();
  if (operation === 'status') { if (Object.keys(input).length) fail(); return {}; }
  if (operation === 'recipients') {
    if (Object.keys(input).some(key => !['groupName', 'labelName', 'labelKey', 'limit'].includes(key))) fail();
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > ZALO_BROADCAST_LIMITS.pageSize) fail();
    const labelKey = input.labelKey === undefined || input.labelKey === null || input.labelKey === '' ? null : input.labelKey;
    if (labelKey !== null && (typeof labelKey !== 'string' || !LABEL_KEY.test(labelKey))) fail();
    return { groupName: query(input.groupName), labelName: query(input.labelName), labelKey, limit };
  }
  if (operation === 'send') {
    if (Object.keys(input).some(key => !['requestId', 'conversationIds', 'mode', 'runAt'].includes(key)) || !domainId(input.requestId)) fail();
    const mode = input.mode ?? 'full';
    if (!['full', 'compact'].includes(mode)) fail();
    let runAt = null;
    if (input.runAt !== undefined && input.runAt !== null) { runAt = canonicalInstant(input.runAt); if (runAt === null) fail(); }
    return { requestId: input.requestId, conversationIds: ids(input.conversationIds, ZALO_BROADCAST_LIMITS.sendGroups), mode, runAt };
  }
  if (operation === 'cancel') {
    if (!domainExact(input, ['oneshotId']) || !domainId(input.oneshotId)) fail();
    return { oneshotId: input.oneshotId };
  }
  if (operation !== 'update') fail();
  const keys = Object.keys(input);
  if (keys.some(key => !UPDATE_KEYS.includes(key)) || !domainId(input.requestId) || typeof input.expectedVersion !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.expectedVersion) || keys.length < 3 ||
      (Object.hasOwn(input, 'setConversationIds') && (Object.hasOwn(input, 'addConversationIds') || Object.hasOwn(input, 'removeConversationIds')))) fail();
  const out = { requestId: input.requestId, expectedVersion: input.expectedVersion };
  if (Object.hasOwn(input, 'enabled')) { if (typeof input.enabled !== 'boolean') fail(); out.enabled = input.enabled; }
  if (Object.hasOwn(input, 'time')) out.time = time(input.time);
  if (Object.hasOwn(input, 'days')) out.days = days(input.days);
  for (const key of ['addConversationIds', 'removeConversationIds', 'setConversationIds'])
    if (Object.hasOwn(input, key)) out[key] = ids(input[key], ZALO_BROADCAST_LIMITS.listGroups);
  if (out.addConversationIds?.some(id => out.removeConversationIds?.includes(id))) fail();
  return out;
}

// ---- results: SQL hermes_zalo_broadcast_v1 shapes, validated before release ----
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const text = (value, max = 200) => typeof value === 'string' && value.length <= max * 2 && points(value) <= max && !CONTROL.test(value);
const nullableText = (value, max) => value === null || text(value, max);
const iso = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const count = (value, max = 100000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const uuidList = (value, max) => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && ANY_UUID.test(item)) &&
  new Set(value).size === value.length;
function hours(value) {
  if (!domainExact(value, ['from', 'to']) || !HHMM.test(value.from) || !HHMM.test(value.to)) fail();
  return { from: value.from, to: value.to };
}
function settings(value) {
  if (!domainExact(value, ['version', 'enabled', 'emergencyStop', 'timeZone', 'time', 'days', 'allowedHours', 'dailyCap', 'queuedToday',
    'recipientCount', 'recipients']) || !/^[0-9a-f]{64}$/.test(value.version) || typeof value.enabled !== 'boolean' ||
      typeof value.emergencyStop !== 'boolean' || value.timeZone !== 'Asia/Ho_Chi_Minh' || !HHMM.test(value.time) ||
      !domainExact(value.days, DAYS) || DAYS.some(day => !MODES.includes(value.days[day])) || !count(value.dailyCap, 2000) || value.dailyCap < 1 ||
      !count(value.queuedToday) || !count(value.recipientCount) || !Array.isArray(value.recipients) || value.recipients.length > 50 ||
      value.recipients.length > value.recipientCount) fail();
  const seen = new Set();
  const recipients = value.recipients.map(item => {
    if (!domainExact(item, ['conversationId', 'name', 'accountName', 'valid']) || typeof item.conversationId !== 'string' ||
        !ANY_UUID.test(item.conversationId) || seen.has(item.conversationId) || !nullableText(item.name) || !nullableText(item.accountName) ||
        typeof item.valid !== 'boolean' || item.valid && (item.name === null || item.accountName === null)) fail();
    seen.add(item.conversationId); return { ...item };
  });
  return { version: value.version, enabled: value.enabled, emergencyStop: value.emergencyStop, timeZone: value.timeZone, time: value.time,
    days: Object.fromEntries(DAYS.map(day => [day, value.days[day]])), allowedHours: hours(value.allowedHours), dailyCap: value.dailyCap,
    queuedToday: value.queuedToday, recipientCount: value.recipientCount, recipients };
}
const ONESHOT_STATUS = ['queued', 'running', 'done', 'cancelled', 'failed'];
function oneshot(value, full) {
  const keys = ['oneshotId', 'status', 'mode', 'runAt', 'sendNow', 'origin', 'requestId', 'createdAt', 'recipientCount', 'resultCode'];
  if (!domainExact(value, full ? [...keys, 'recipients'] : keys) || !domainId(value.oneshotId) || !ONESHOT_STATUS.includes(value.status) ||
      !['full', 'compact'].includes(value.mode) || !iso(value.runAt) || typeof value.sendNow !== 'boolean' || !['ui', 'hermes'].includes(value.origin) ||
      !text(value.requestId, 200) || !iso(value.createdAt) || !count(value.recipientCount, 50) || value.recipientCount < 1 ||
      !(value.resultCode === null || CODE.test(value.resultCode)) ||
      full && (!uuidList(value.recipients, 50) || value.recipients.length !== value.recipientCount)) fail();
  return { ...value, ...(full ? { recipients: [...value.recipients] } : {}) };
}
// Vietnam has no DST: a fixed +07:00 rendering for the guidance sentence.
const vietnamTime = instant => {
  const at = new Date(Date.parse(instant) + 7 * 3600000), pad = n => String(n).padStart(2, '0');
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} ngày ${pad(at.getUTCDate())}/${pad(at.getUTCMonth() + 1)}/${at.getUTCFullYear()}`;
};
// Plain-Vietnamese next step per CRM refusal code. The CRM code and reason are
// returned verbatim beside it; an unknown future code gets a generic sentence.
function guidance(value) {
  const hoursText = value.allowedHours ? `${value.allowedHours.from}–${value.allowedHours.to}` : 'được phép';
  const suggested = value.suggestedRunAt ? ` Gợi ý hẹn lúc ${vietnamTime(value.suggestedRunAt)} (runAt=${value.suggestedRunAt}).` : '';
  switch (value.code) {
    case 'ngoai_khung_gio': return `Bây giờ ngoài khung giờ gửi ${hoursText} (giờ Việt Nam).${suggested} Hỏi người dùng có muốn hẹn giờ không; đồng ý thì gọi lại với runAt đó và requestId mới.`;
    case 'het_tran_ngay': return `Hôm nay đã chạm trần tin tự động của công ty.${suggested} Đề nghị hẹn sang ngày khác với requestId mới.`;
    case 'dang_dung_khan_cap': return 'Tự động hoá Zalo đang dừng khẩn cấp. Người quản lý phải mở Chat Zalo > Tự động hoá trên CRM và lưu lại cài đặt gửi phòng trống; Hermes không tự gỡ.';
    case 'nguoi_nhan_khong_hop_le': return 'Có hội thoại không phải nhóm Zalo của công ty đã đánh dấu sale. Lấy lại danh sách bằng crm_zalo_broadcast_recipients, không đoán id.';
    case 'tai_khoan_chua_ket_noi': return 'Nick Zalo của các nhóm này đang mất kết nối nên chưa gửi ngay được. Kết nối lại nick trên CRM hoặc hẹn giờ gửi sau.';
    case 'qua_nhieu_luot_cho': return 'Đang có quá nhiều lượt gửi một lần chờ chạy. Huỷ bớt bằng crm_zalo_broadcast_cancel hoặc chờ chạy xong.';
    case 'gio_hen_khong_hop_le': return 'Giờ hẹn phải nằm trong 30 ngày tới (không ở quá khứ). Hỏi lại người dùng giờ hẹn.';
    case 'ma_yeu_cau_da_dung': return 'requestId này đã dùng cho một yêu cầu khác. Lấy mã mới bằng crm_new_request_id rồi gửi lại.';
    case 'da_chay': return 'Lượt này đã chạy hoặc đang chạy nên không huỷ được. Muốn chặn tin còn chờ thì người quản lý bấm Dừng khẩn cấp trên CRM.';
    case 'khong_tim_thay': return 'Không thấy lượt hẹn này trong công ty. Xem lại danh sách bằng crm_zalo_broadcast_status.';
    case 'cau_hinh_vua_doi': return 'Cài đặt vừa bị sửa ở nơi khác sau lần đọc. Đọc lại bằng crm_zalo_broadcast_status, áp lại đúng thay đổi người dùng muốn với version mới và requestId mới.';
    case 'trung_lich_hermes_cu': return 'Nhóm nhận đang thuộc một lịch chữ cũ của Hermes. Thu hồi lịch đó bằng crm_room_schedule_revoke trước rồi làm lại.';
    case 'qua_nhieu_nguoi_nhan': return 'Lịch gửi phòng trống tối đa 100 nhóm nhận; bớt nhóm rồi làm lại.';
    default: return 'CRM từ chối yêu cầu; báo người dùng nguyên văn lý do (reason).';
  }
}
const WARNINGS = Object.freeze({
  gio_gui_ngoai_khung_gio: 'Giờ gửi nằm ngoài khung giờ được phép nên CRM sẽ bỏ lượt; báo người dùng.',
  chua_co_nguoi_nhan_hop_le: 'Lịch đang bật nhưng chưa có nhóm nhận hợp lệ nào; chưa có tin nào được gửi.',
});
function refusal(value, keys, extra) {
  if (!domainExact(value, ['ok', 'code', 'reason', ...keys]) || value.ok !== false || typeof value.code !== 'string' || !CODE.test(value.code) ||
      !text(value.reason, 500)) fail();
  const out = { ok: false, code: value.code, reason: value.reason, ...extra(value) };
  return { ...out, huongDan: guidance(out) };
}
export function zaloBroadcastResult(operation, value, _identity, input) {
  if (!domainRecord(value)) fail();
  if (operation === 'status') {
    const { oneshots, ...rest } = value;
    if (!Object.hasOwn(value, 'oneshots') || !Array.isArray(oneshots) || oneshots.length > 10) fail();
    const items = oneshots.map(item => oneshot(item, false));
    if (new Set(items.map(item => item.oneshotId)).size !== items.length) fail();
    return { ...settings(rest), oneshots: items };
  }
  if (operation === 'recipients') {
    if (!domainExact(value, ['groups', 'labels', 'total', 'truncated']) || !Array.isArray(value.groups) || value.groups.length > input.limit ||
        !Array.isArray(value.labels) || value.labels.length > 50 || !count(value.total) || value.groups.length > value.total ||
        value.truncated !== value.total > input.limit || (!value.truncated && value.groups.length !== value.total)) fail();
    const seen = new Set();
    const groups = value.groups.map(group => {
      if (!domainExact(group, ['conversationId', 'name', 'accountName', 'inSchedule', 'labels']) || !domainId(group.conversationId) ||
          seen.has(group.conversationId) || !text(group.name) || !text(group.accountName) || typeof group.inSchedule !== 'boolean' ||
          !Array.isArray(group.labels) || group.labels.length > 10 ||
          group.labels.some(label => !domainExact(label, ['key', 'name']) || !LABEL_KEY.test(label.key) || !text(label.name))) fail();
      seen.add(group.conversationId); return { ...group, labels: group.labels.map(label => ({ ...label })) };
    });
    const keys = new Set();
    const labels = value.labels.map(label => {
      if (!domainExact(label, ['key', 'name', 'accountName', 'groupCount']) || !LABEL_KEY.test(label.key) || keys.has(label.key) ||
          !text(label.name) || !text(label.accountName) || !count(label.groupCount) ||
          (input.labelKey !== null && label.key !== input.labelKey)) fail();
      keys.add(label.key); return { ...label };
    });
    return { groups, labels, total: value.total, truncated: value.truncated };
  }
  if (operation === 'send' || operation === 'cancel') {
    if (value.ok === true) {
      if (!domainExact(value, ['ok', 'reused', 'oneshot']) || typeof value.reused !== 'boolean') fail();
      const shot = oneshot(value.oneshot, true);
      if (operation === 'cancel' && (shot.oneshotId !== input.oneshotId || shot.status !== 'cancelled')) fail();
      if (operation === 'send' && (shot.mode !== input.mode || shot.sendNow !== (input.runAt === null) ||
          (input.runAt !== null && shot.runAt !== input.runAt) || shot.requestId !== input.requestId ||
          JSON.stringify([...shot.recipients].sort()) !== JSON.stringify([...input.conversationIds].sort()))) fail();
      return { ok: true, reused: value.reused, oneshot: shot };
    }
    if (operation === 'cancel') return refusal(value, ['oneshot'], item => {
      const shot = item.oneshot === null ? null : oneshot(item.oneshot, true);
      if (shot !== null && shot.oneshotId !== input.oneshotId) fail();
      return { oneshot: shot };
    });
    return refusal(value, ['allowedHours', 'suggestedRunAt', 'invalidRecipients'], item => {
      if (!(item.suggestedRunAt === null || iso(item.suggestedRunAt)) || !uuidList(item.invalidRecipients, 50) ||
          item.invalidRecipients.some(id => !input.conversationIds.includes(id))) fail();
      return { allowedHours: item.allowedHours === null ? null : hours(item.allowedHours), suggestedRunAt: item.suggestedRunAt,
        invalidRecipients: [...item.invalidRecipients] };
    });
  }
  if (operation === 'update') {
    if (value.ok === true) {
      if (!domainExact(value, ['ok', 'reused', 'changed', 'settings', 'warnings']) || typeof value.reused !== 'boolean' ||
          !Array.isArray(value.changed) || value.changed.some(field => !['enabled', 'time', 'days', 'recipients'].includes(field)) ||
          new Set(value.changed).size !== value.changed.length || !Array.isArray(value.warnings) ||
          value.warnings.some(code => !Object.hasOwn(WARNINGS, code)) || new Set(value.warnings).size !== value.warnings.length) fail();
      const current = settings(value.settings);
      if ((Object.hasOwn(input, 'enabled') && current.enabled !== input.enabled) || (input.time && current.time !== input.time) ||
          (input.days && Object.entries(input.days).some(([day, mode]) => current.days[day] !== mode))) fail();
      return { ok: true, reused: value.reused, changed: [...value.changed], settings: current,
        warnings: value.warnings.map(code => ({ code, message: WARNINGS[code] })) };
    }
    return refusal(value, ['version', 'invalidRecipients'], item => {
      if (!(item.version === null || /^[0-9a-f]{64}$/.test(item.version)) || (item.code === 'cau_hinh_vua_doi') !== (item.version !== null) ||
          !uuidList(item.invalidRecipients, 100)) fail();
      return { version: item.version, invalidRecipients: [...item.invalidRecipients] };
    });
  }
  fail();
}

// ---- tool definitions (model-facing text is Vietnamese, by meaning) ----
const uuid = { type: 'string', format: 'uuid' };
const uuidArray = (max, description) => ({ type: 'array', items: uuid, minItems: 1, maxItems: max, uniqueItems: true, description });
const modes = { type: 'string', enum: [...MODES] };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SCHEDULER = 'Đây là bộ lập lịch DUY NHẤT cho việc gửi ảnh phòng trống: không tạo cron/lịch riêng của Hermes.';
export const ZALO_BROADCAST_TOOLS = Object.freeze([
  Object.freeze({ name: 'crm_zalo_broadcast_status',
    description: `Xem tự động hoá "Gửi ảnh phòng trống" qua Zalo của CRM: đang bật hay tắt, giờ gửi hằng ngày, chế độ từng thứ (full = đầy đủ: link trang sale + ảnh bảng phòng + tin chi tiết từng phòng; compact = gọn; off = nghỉ), các nhóm nhận (valid=false là nhóm không còn hợp lệ), khung giờ được phép, trần tin/ngày, có đang dừng khẩn cấp không, và các lượt gửi một lần đang chờ hoặc gần nhất (oneshots). version dùng cho crm_zalo_broadcast_update. Chỉ đọc. ${SCHEDULER}`,
    inputSchema: { type: 'object', additionalProperties: false, required: [], properties: {} }, annotations: read }),
  Object.freeze({ name: 'crm_zalo_broadcast_recipients',
    description: 'Tìm nhóm Zalo nhận được ảnh phòng trống: chỉ NHÓM của nick công ty đã đánh dấu sale. Lọc theo tên nhóm (groupName) hoặc phân loại Zalo (labelName, vd "Group MG IHOME"); không phân biệt hoa thường/dấu. Mỗi phân loại thuộc một nick và hai nick có thể trùng tên phân loại: labels cho biết tên nick và số nhóm; nếu người dùng chưa nói nick nào thì hỏi lại hoặc dùng labelKey của đúng nick. Trả conversationId để gửi hoặc sửa lịch (không bao giờ dùng tên tự do làm người nhận); inSchedule = đang nằm trong lịch định kỳ. Chỉ đọc.',
    inputSchema: { type: 'object', additionalProperties: false, required: [], properties: {
      groupName: { type: ['string', 'null'], maxLength: 120, description: 'Một phần tên nhóm.' },
      labelName: { type: ['string', 'null'], maxLength: 120, description: 'Tên (một phần) phân loại Zalo.' },
      labelKey: { type: ['string', 'null'], maxLength: 48, description: 'Khoá accountId:labelId lấy từ labels khi cần chọn đúng nick.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 30 } } }, annotations: read }),
  Object.freeze({ name: 'crm_zalo_broadcast_send',
    description: `Gửi ảnh danh sách phòng trống kèm thông tin (giống hệt bản gửi định kỳ: link trang sale, ảnh bảng phòng, tin chi tiết từng phòng) tới các nhóm Zalo đã chọn — gửi ngay (bỏ trống runAt) hoặc hẹn MỘT lần (runAt có múi giờ rõ, vd 2026-10-17T09:00:00+07:00, trong 30 ngày tới). mode mặc định full (đầy đủ); chỉ dùng compact khi người dùng muốn bản gọn. conversationIds (1–50) lấy từ crm_zalo_broadcast_recipients. CRM vẫn áp khung giờ, giãn nhịp, trần tin/ngày và dừng khẩn cấp; bị từ chối (ok=false) thì báo người dùng theo huongDan kèm code/reason của CRM (vd ngoài khung giờ thì đề nghị hẹn lúc suggestedRunAt). Gọi lại cùng requestId và cùng tham số trả reused=true, không tạo lượt mới. Không cần hỏi xác nhận lại khi yêu cầu đã rõ. ${REQUEST_ID_GUIDANCE} Mất phản hồi (zalo_broadcast_outcome_unknown) thì gọi lại đúng lệnh đó với cùng requestId để đối soát.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'conversationIds', 'runAt'], properties: {
      requestId: REQUEST_ID_PROPERTY, conversationIds: uuidArray(ZALO_BROADCAST_LIMITS.sendGroups, 'conversationId của các nhóm nhận.'),
      mode: { type: 'string', enum: ['full', 'compact'], default: 'full' },
      runAt: { type: ['string', 'null'], format: 'date-time', description: 'Giờ hẹn có múi giờ (Z hoặc +07:00); null = gửi ngay.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }),
  Object.freeze({ name: 'crm_zalo_broadcast_cancel',
    description: 'Huỷ một lượt gửi phòng trống một lần CHƯA chạy (oneshotId lấy từ crm_zalo_broadcast_status). Lượt đã chạy không huỷ được; gọi lại một lượt đã huỷ trả reused=true.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['oneshotId'], properties: { oneshotId: uuid } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }),
  Object.freeze({ name: 'crm_zalo_broadcast_update',
    description: `Sửa lịch gửi ảnh phòng trống định kỳ của CRM: bật/tắt (enabled), giờ gửi hằng ngày (time, giờ Việt Nam), chế độ từng thứ (days), thêm/bớt nhóm nhận hoặc thay cả danh sách (chỉ nhóm lấy từ crm_zalo_broadcast_recipients). Chỉ gửi trường cần đổi; mẫu tin, khung giờ, giãn nhịp và phần còn lại giữ nguyên. expectedVersion = version vừa đọc bằng crm_zalo_broadcast_status; gặp cau_hinh_vua_doi thì đọc lại rồi làm lại. Không tự gỡ dừng khẩn cấp. ${SCHEDULER} ${REQUEST_ID_GUIDANCE}`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'expectedVersion'], properties: {
      requestId: REQUEST_ID_PROPERTY, expectedVersion: { type: 'string', pattern: '^[0-9a-f]{64}$' }, enabled: { type: 'boolean' },
      time: { type: 'string', pattern: '^[0-9]{1,2}:[0-9]{2}$', description: 'HH:MM, vd 08:30.' },
      days: { type: 'object', additionalProperties: false, minProperties: 1, description: 'Chỉ các thứ cần đổi; mon = thứ Hai … sun = Chủ nhật.',
        properties: Object.fromEntries(DAYS.map(day => [day, modes])) },
      addConversationIds: uuidArray(ZALO_BROADCAST_LIMITS.listGroups), removeConversationIds: uuidArray(ZALO_BROADCAST_LIMITS.listGroups),
      setConversationIds: uuidArray(ZALO_BROADCAST_LIMITS.listGroups, 'Thay toàn bộ danh sách; không dùng cùng add/remove.') } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }),
]);
