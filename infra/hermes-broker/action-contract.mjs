// Mặt tool của thao tác ghi dùng chung (Đợt 1 nền chung, docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 4).
// D1 = A (chủ chọn 21/10): ba tool chung crm_action_list / crm_action_run / crm_action_status (đo 1 830 B tools/list).
// Khuôn B (một tool cho mỗi trang, operation enum) sinh từ CÙNG danh mục: đổi ACTION_TOOL_SHAPE là đủ, lõi chạy,
// rào xác nhận, lý do và SQL không đổi. Câu đầu mỗi mô tả ≤ 60 ký tự có từ khoá ASCII: tool_search của Hermes xếp
// hạng BM25 trên token ASCII và chỉ hiện ~60 ký tự đầu (memory hermes-tool-search-bm25-ascii).
import { ACTION_ID } from './action-catalog.mjs';
import { ACTION_INPUT_REASONS, ACTION_REASONS } from './action-reasons.mjs';

export const ACTION_TOOL_SHAPES = Object.freeze(['shared', 'page']);
export const ACTION_TOOL_SHAPE = 'shared';
const LISTED_PAGES = Object.freeze(['expense', 'invoice', 'contract', 'task']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
// Tool ghi không khai idempotent: requestId tuỳ chọn, thiếu thì connector cấp mã mới ⇒ hai lời gọi y hệt là HAI lệnh.
const annotations = (write) => write
  ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RUN_GUIDANCE = 'Kết quả confirmation_required = CHƯA ghi: đọc preview cho người dùng, chỉ khi họ đồng ý rõ mới gọi lại y nguyên kèm requestId và confirmToken. ' +
  'needs_input = CHƯA ghi: hỏi lại người dùng theo detail. action_rejected: báo đúng detail; detail bảo xem trước lại thì gọi lại không kèm confirmToken, còn lại không tự thử lại. ' +
  'action_outcome_unknown: crm_action_status cùng requestId, không gọi lại.';

export const ACTION_LIST_TOOL = freeze({
  name: 'crm_action_list',
  description: 'List CRM write actions: expense, invoice, contract, task. ' +
    'Trả action, params, confirm của thao tác kết nối được làm; gọi khi chưa biết mã hay tham số.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { page: { enum: [null, ...LISTED_PAGES] } } },
  annotations: annotations(false),
});
export const ACTION_RUN_TOOL = freeze({
  name: 'crm_action_run',
  description: 'Run CRM write action (expense, invoice, contract, task). ' +
    'action, params đúng như crm_action_list; toà/phòng bằng tên, tiền là số nguyên VND. ' + RUN_GUIDANCE,
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', pattern: ACTION_ID.source }, params: { type: 'object' },
    requestId: { type: 'string', format: 'uuid' }, confirmToken: { type: 'string' } } },
  annotations: annotations(true),
});
export const ACTION_STATUS_TOOL = freeze({
  name: 'crm_action_status',
  description: 'CRM write action status by requestId. Dùng sau action_outcome_unknown, đúng requestId của lệnh gốc.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: { type: 'string', format: 'uuid' } } },
  annotations: annotations(false),
});
// Câu đầu (≤ 60 ký tự, ASCII) của tool trang ở khuôn B.
const PAGE_LABELS = Object.freeze({
  expense: 'Expense voucher action: create, edit, cancel, approve',
  invoice: 'Invoice payment action: adjust, cancel, meter reading',
  contract: 'Contract lease action: renew, notice, move-out, room lock',
  task: 'Task action: create, update, cancel, follow',
  probe: 'Probe write action for connector tests',
});
/** Khuôn B: một tool cho mỗi trang, operation = phần sau dấu chấm của mã thao tác. */
export function pageActionTool(page, operations) {
  if (!Object.hasOwn(PAGE_LABELS, page) || !Array.isArray(operations) || !operations.length) throw new TypeError('invalid_page_action_tool');
  return freeze({
    name: `crm_${page}_action`,
    description: `${PAGE_LABELS[page]}. ${RUN_GUIDANCE}`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
      operation: { enum: [...operations] }, params: { type: 'object' }, requestId: { type: 'string', format: 'uuid' }, confirmToken: { type: 'string' } } },
    annotations: annotations(true),
  });
}

/** Mọi định nghĩa tool của họ thao tác cho một danh mục + khuôn (để broker biết tên; liệt kê còn tuỳ quyền). */
export function actionTools(catalog, shape = ACTION_TOOL_SHAPE) {
  if (!ACTION_TOOL_SHAPES.includes(shape)) throw new TypeError('invalid_action_tool_shape');
  if (shape === 'shared') return [ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL];
  const pages = catalog.pages.map(page => pageActionTool(page, catalog.ids.filter(id => catalog.actions[id].page === page).map(id => id.split('.')[1])));
  return [ACTION_LIST_TOOL, ...pages, ACTION_STATUS_TOOL];
}
/** Tên tool → {op, page?}; undefined nếu không phải tool của họ thao tác ở khuôn này. */
export function actionToolRoute(name, catalog, shape = ACTION_TOOL_SHAPE) {
  if (name === ACTION_LIST_TOOL.name) return { op: 'list' };
  if (name === ACTION_STATUS_TOOL.name) return { op: 'status' };
  if (shape === 'shared') return name === ACTION_RUN_TOOL.name ? { op: 'run' } : undefined;
  const match = typeof name === 'string' ? /^crm_([a-z]+)_action$/.exec(name) : null;
  return match && catalog.pages.includes(match[1]) ? { op: 'run', page: match[1] } : undefined;
}
/** Tool nào của họ thao tác hiện với kết nối này: không có thao tác nào được cấp ⇒ không hiện gì. */
export function listedActionTools(catalog, effective, shape = ACTION_TOOL_SHAPE) {
  if (catalog.empty || !catalog.any(effective)) return [];
  if (shape === 'shared') return [ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL];
  const pages = catalog.pages.filter(page => catalog.ids.some(id => catalog.actions[id].page === page && catalog.granted(effective, id)));
  return actionTools(catalog, shape).filter(tool => [ACTION_LIST_TOOL.name, ACTION_STATUS_TOOL.name].includes(tool.name) ||
    pages.some(page => tool.name === `crm_${page}_action`));
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const onlyKeys = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const requestIdOf = value => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('invalid_action_envelope');
  return value.toLowerCase();
};
/** Phong bì đối số (đã tách confirmToken). Sai kiểu ở cấp phong bì ⇒ TypeError (invalid_request); mã thao tác lạ
 * KHÔNG lỗi ở đây — broker trả needs_input unknown_action. */
export function actionEnvelope(route, args) {
  if (route?.op === 'list') {
    if (!onlyKeys(args, ['page']) || !(args.page === undefined || args.page === null || LISTED_PAGES.includes(args.page) || args.page === 'probe')) throw new TypeError('invalid_action_envelope');
    return { page: args.page ?? null };
  }
  if (route?.op === 'status') {
    if (!onlyKeys(args, ['requestId'])) throw new TypeError('invalid_action_envelope');
    const requestId = requestIdOf(args.requestId);
    if (requestId === undefined) throw new TypeError('invalid_action_envelope');
    return { requestId };
  }
  if (route?.op !== 'run') throw new TypeError('invalid_action_envelope');
  const selector = route.page === undefined ? 'action' : 'operation';
  if (!onlyKeys(args, [selector, 'params', 'requestId']) || typeof args[selector] !== 'string') throw new TypeError('invalid_action_envelope');
  const action = route.page === undefined ? args[selector].trim() : `${route.page}.${args[selector].trim()}`;
  return { action, params: paramsOf(args.params), requestId: requestIdOf(args.requestId) };
}
// Mô hình đôi khi gửi params là chuỗi JSON: đọc nếu ra object thuần (≤ 4 000 ký tự); còn lại để validator trả needs_input.
function paramsOf(value) {
  if (typeof value !== 'string' || value.length > 4000 || !value.trim().startsWith('{')) return value;
  try { const parsed = JSON.parse(value); return plain(parsed) ? parsed : value; } catch { return value; }
}

const INPUT_GUIDANCE = 'CHƯA ghi. Hỏi lại người dùng theo detail (không đoán, không tự điền) rồi gọi lại crm_action_run.';
const UNKNOWN_GUIDANCE = 'CHƯA ghi. Gọi crm_action_list để lấy đúng mã thao tác và khuôn tham số.';
const CONFIRM_GUIDANCE = 'CHƯA ghi. Đọc preview cho người dùng (toà, phòng, số tiền, ngày…); chỉ khi họ đồng ý rõ ràng SAU khi xem mới gọi lại crm_action_run ' +
  'y nguyên action, params, requestId kèm confirmToken. Token dùng một lần, hết hạn sau 10 phút; người dùng đổi nội dung thì gọi lại không kèm confirmToken để xem trước lại. ' +
  'Lỗi confirmation_invalid: gọi lại không kèm confirmToken để lấy bản xem trước mới.';
/** Kết quả thường "cần thêm thông tin" (KHÔNG phải lỗi MCP — tránh rào 3 lần bị từ chối của Hermes). */
export function needsInput({ action, reason, detail, candidates }) {
  if (!ACTION_INPUT_REASONS.includes(reason)) throw new TypeError('invalid_needs_input_reason');
  return { outcome: 'needs_input', applied: false, action, reason, detail: typeof detail === 'string' && detail ? detail : ACTION_REASONS[reason].text,
    ...(Array.isArray(candidates) && candidates.length ? { candidates } : {}), huongDan: reason === 'unknown_action' ? UNKNOWN_GUIDANCE : INPUT_GUIDANCE };
}
export function confirmationRequired({ action, requestId, preview, warnings, confirmToken, expiresAt }) {
  return { outcome: 'confirmation_required', applied: false, action, requestId, preview, warnings, confirmToken, expiresAt, huongDan: CONFIRM_GUIDANCE };
}

export const NAME_FIELDS = Object.freeze(['building', 'room', 'jobType', 'customer', 'person', 'voucher', 'invoice', 'job']);
// unspecified (trang Công việc, Đợt 2b): người dùng chưa nêu trường này (wanted rỗng); candidates là gợi ý để hỏi lại một câu (Q31).
export const NAME_WHYS = Object.freeze(['ambiguous', 'outside_scope', 'not_visible', 'unspecified']);
const LABELS = Object.freeze({ building: 'toà', room: 'phòng', jobType: 'loại việc', customer: 'khách', person: 'người', voucher: 'phiếu', invoice: 'hoá đơn', job: 'việc' });
const CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/gu;
const quoted = value => `'${String(value).replace(CONTROL, ' ').trim().slice(0, 60)}'`;
/** detail của name_unresolved từ kết quả hàm giải tên SQL (hermes_write_name_resolve_v1): chỉ chuỗi mô hình gửi + ứng viên mà
 * RLS của người hỏi đã cho thấy. why: ambiguous (≥ 2 trong phạm vi được ghi) / outside_scope (thấy nhưng ngoài phạm vi toà của
 * khoá ghi) / not_visible. Không bao giờ nói "không có": hàm INVOKER không biết điều đó (RLS có thể ẩn đối tượng có thật). */
export function nameUnresolvedDetail({ field, wanted, why, candidates = [], more = false }) {
  if (!Object.hasOwn(LABELS, field) || typeof wanted !== 'string' || !Array.isArray(candidates) || !(why === undefined || NAME_WHYS.includes(why))) throw new TypeError('invalid_name_detail');
  const label = LABELS[field], Label = `${label[0].toUpperCase()}${label.slice(1)}`;
  const names = candidates.slice(0, 8).map(entry => entry.buildingName ? `${entry.name} (${entry.buildingName})` : entry.name).map(name => String(name).replace(CONTROL, ' ').trim());
  const list = `${names.join(', ')}${more || candidates.length > 8 ? ', …' : ''}`;
  const kind = why ?? (candidates.length ? 'ambiguous' : 'not_visible');
  if (kind === 'unspecified') return names.length ? `Chưa nêu ${label}; gợi ý: ${list} — hỏi người dùng chọn một, không tự chọn.` : `Chưa nêu ${label}; hỏi người dùng.`;
  // outside_scope: câu tĩnh, không bao giờ nêu tên ứng viên (SQL không trả tên ngoài phạm vi được ghi; review #253).
  if (kind === 'outside_scope') return `${Label} ${quoted(wanted)} nằm ngoài phạm vi toà mà kết nối được ghi; không làm được ở đó, báo người dùng.`;
  if (kind === 'ambiguous' && names.length) return `${Label} ${quoted(wanted)} khớp nhiều: ${list} — hỏi người dùng nêu rõ.`;
  return `Không thấy ${label} ${quoted(wanted)} trong phạm vi quyền của anh/chị; hỏi lại người dùng.`;
}
