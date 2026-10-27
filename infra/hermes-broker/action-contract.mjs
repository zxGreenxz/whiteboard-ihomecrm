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
// Lượt 12 Hợp đồng (rào đồng ý, consent-guard.mjs): thao tác không lùi được đòi thêm consentText = nguyên văn lời đồng ý ở lượt xác nhận.
const RUN_GUIDANCE = 'confirmation_required = CHƯA ghi: đọc preview cho người dùng, chỉ khi họ đồng ý rõ mới gọi lại y nguyên kèm requestId, confirmToken ' +
  '(+consentText khi huongDan đòi). ' +
  'needs_input = CHƯA ghi: hỏi lại theo detail. action_rejected: báo đúng detail; detail bảo xem trước lại thì gọi lại không kèm confirmToken, còn lại không tự thử lại. ' +
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
    requestId: { type: 'string', format: 'uuid' }, confirmToken: { type: 'string' }, consentText: { type: 'string' } } },
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
      operation: { enum: [...operations] }, params: { type: 'object' }, requestId: { type: 'string', format: 'uuid' }, confirmToken: { type: 'string' },
      consentText: { type: 'string' } } },
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
// Thu chi lượt 16 (nghiệm thu C3d: bot chép requestId thiếu một ký tự ⇒ invalid_request chung, crm_action_status hỏng theo): requestId sai
// khuôn UUID là lỗi riêng mang số ký tự đã gửi (không bao giờ chuỗi đã gửi) để broker nói rõ.
export class RequestIdShapeError extends TypeError {
  constructor(length) { super('invalid_action_envelope'); this.length = length; }
}
const requestIdOf = value => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new RequestIdShapeError(typeof value === 'string' ? Math.min([...value].length, 999) : null);
  return value.toLowerCase();
};
/** Câu tĩnh của invalid_request khi requestId sai khuôn (mcp-http chỉ chuyển đúng câu dựng bằng hàm này). */
export const requestIdShapeDetail = length => `requestId không đúng khuôn UUID (${Number.isSafeInteger(length) ? `${length} ký tự, cần 36` : 'không phải chuỗi'}) — ` +
  'chép NGUYÊN VĂN requestId mà bản xem trước / lệnh gốc trả về; lượt xác nhận kèm confirmToken thì requestId lấy theo token.';
export const isRequestIdShapeDetail = text => {
  if (typeof text !== 'string') return false;
  const count = /^requestId không đúng khuôn UUID \((\d{1,3}) ký tự, cần 36\)/.exec(text);
  return text === requestIdShapeDetail(count ? Number(count[1]) : null);
};
/** Phong bì đối số (đã tách confirmToken). Sai kiểu ở cấp phong bì ⇒ TypeError (invalid_request); mã thao tác lạ
 * KHÔNG lỗi ở đây — broker trả needs_input unknown_action. confirming (lượt 16): lượt có confirmToken — requestId sai khuôn không làm hỏng
 * phong bì (requestIdMalformed), vì requestId của lượt xác nhận lấy theo bản ghi của token. */
export function actionEnvelope(route, args, { confirming = false } = {}) {
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
  if (!onlyKeys(args, [selector, 'params', 'requestId', 'consentText']) || typeof args[selector] !== 'string') throw new TypeError('invalid_action_envelope');
  const action = route.page === undefined ? args[selector].trim() : `${route.page}.${args[selector].trim()}`;
  const consentText = consentTextOf(args.consentText);
  let requestId, requestIdMalformed = false;
  try { requestId = requestIdOf(args.requestId); } catch (error) { if (!(confirming && error instanceof RequestIdShapeError)) throw error; requestIdMalformed = true; }
  return { action, params: paramsOf(args.params), requestId, ...(requestIdMalformed ? { requestIdMalformed } : {}), ...(consentText === undefined ? {} : { consentText }) };
}
// consentText (lượt 12 Hợp đồng): chỉ lượt xác nhận của thao tác không lùi được mới đọc; vắng / null / trống = không gửi. Không vào params
// hay khoá binding của token (người dùng đáp "ok" sau một câu chưa rõ vẫn xác nhận được đúng bản xem trước đó). Dài quá trần thì rào đồng ý
// trả consent_unclear, không phải lỗi phong bì.
function consentTextOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError('invalid_action_envelope');
  return value;
}
// Mô hình đôi khi gửi params là chuỗi JSON: đọc nếu ra object thuần (≤ 4 000 ký tự); còn lại để validator trả needs_input.
function paramsOf(value) {
  if (typeof value !== 'string' || value.length > 4000 || !value.trim().startsWith('{')) return value;
  try { const parsed = JSON.parse(value); return plain(parsed) ? parsed : value; } catch { return value; }
}

const INPUT_GUIDANCE = 'CHƯA ghi. Hỏi lại người dùng theo detail (không đoán, không tự điền) rồi gọi lại crm_action_run.';
const UNKNOWN_GUIDANCE = 'CHƯA ghi. Gọi crm_action_list để lấy đúng mã thao tác và khuôn tham số.';
const CONSENT_GUIDANCE = 'CHƯA ghi; token xác nhận chưa dùng, còn hạn thì dùng lại được. Hỏi người dùng có đồng ý ghi không; họ đồng ý rõ thì gọi lại y nguyên action, ' +
  'params, requestId, confirmToken kèm consentText = nguyên văn câu trả lời đó. Họ chỉ nói thêm chi tiết hay đổi nội dung thì không gửi xác nhận.';
// Bản xem trước của thao tác không lùi được (lượt 12 Hợp đồng): nói trước rằng lượt xác nhận phải kèm consentText.
const CONSENT_CONFIRM_NOTE = ' Thao tác KHÔNG lùi được: lượt xác nhận phải kèm consentText = NGUYÊN VĂN câu người dùng vừa đáp; họ chỉ bổ sung chi tiết (chưa nói ' +
  'đồng ý) thì hỏi lại "anh/chị đồng ý ghi không?", không gửi xác nhận.';
const CONFIRM_GUIDANCE = 'CHƯA ghi. Đọc preview cho người dùng (toà, phòng, số tiền, ngày…); chỉ khi họ đồng ý rõ ràng SAU khi xem mới gọi lại crm_action_run ' +
  'y nguyên action, params, requestId kèm confirmToken. Token dùng một lần, hết hạn sau 10 phút; người dùng đổi nội dung thì gọi lại không kèm confirmToken để xem trước lại. ' +
  'Lỗi confirmation_invalid: gọi lại không kèm confirmToken để lấy bản xem trước mới.';
// Thu chi lượt 14 (nghiệm thu 24/10: xác nhận bị confirmation_invalid rồi bot ra bản xem trước mới, lặp): câu TĨNH nói phần nào lệch — danh
// sách đóng, mcp-http chỉ chuyển đúng các câu này (không chứa giá trị đã gửi).
export const CONFIRM_INVALID_DETAILS = Object.freeze({
  request: 'Token thuộc bản xem trước có requestId khác: xác nhận bằng ĐÚNG requestId mà bản xem trước trả về; gọi lại không kèm confirmToken để lấy bản xem trước mới.',
  params: 'Params khác bản xem trước: gửi y nguyên params đã xem; người dùng đổi nội dung thì gọi lại không kèm confirmToken để xem trước lại.',
  expired: 'Token xác nhận đã quá 10 phút: gọi lại không kèm confirmToken để lấy bản xem trước mới.',
  unknown: 'Token xác nhận đã dùng (mỗi token một lần) hoặc không đúng: gọi lại không kèm confirmToken để lấy bản xem trước mới.',
  missing_request: 'Thiếu requestId: xác nhận phải gửi kèm requestId của bản xem trước.',
});
export const CONFIRM_INVALID_TEXTS = Object.freeze(Object.values(CONFIRM_INVALID_DETAILS));
/** Kết quả thường "cần thêm thông tin" (KHÔNG phải lỗi MCP — tránh rào 3 lần bị từ chối của Hermes). */
export function needsInput({ action, reason, detail, candidates }) {
  if (!ACTION_INPUT_REASONS.includes(reason)) throw new TypeError('invalid_needs_input_reason');
  return { outcome: 'needs_input', applied: false, action, reason, detail: typeof detail === 'string' && detail ? detail : ACTION_REASONS[reason].text,
    ...(Array.isArray(candidates) && candidates.length ? { candidates } : {}), huongDan: reason === 'unknown_action' ? UNKNOWN_GUIDANCE : reason === 'consent_unclear' ? CONSENT_GUIDANCE : INPUT_GUIDANCE };
}
export function confirmationRequired({ action, requestId, preview, warnings, confirmToken, expiresAt, consent = false }) {
  return { outcome: 'confirmation_required', applied: false, action, requestId, preview, warnings, confirmToken, expiresAt,
    huongDan: consent ? `${CONFIRM_GUIDANCE}${CONSENT_CONFIRM_NOTE}` : CONFIRM_GUIDANCE };
}

export const NAME_FIELDS = Object.freeze(['building', 'room', 'jobType', 'customer', 'person', 'voucher', 'invoice', 'category', 'cashbook', 'job',
  'recurrence']);
// unspecified (trang Công việc, Đợt 2b): người dùng chưa nêu trường này (wanted rỗng); candidates là gợi ý để hỏi lại một câu (Q31).
export const NAME_WHYS = Object.freeze(['ambiguous', 'outside_scope', 'not_visible', 'unspecified']);
const LABELS = Object.freeze({ building: 'toà', room: 'phòng', jobType: 'loại việc', customer: 'khách', person: 'người', voucher: 'phiếu', invoice: 'hoá đơn',
  category: 'hạng mục', cashbook: 'sổ quỹ', job: 'việc', recurrence: 'việc định kỳ' });
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
  // C3n (nghiệm thu TC c3m/c3n A14): hạng mục chi có ĐÚNG MỘT gợi ý ⇒ xem trước ngay với gợi ý đó (bản xem trước nêu hạng mục) rồi hỏi đồng ý
  // MỘT lần — người dùng vẫn quyết trên bản xem trước; hỏi riêng "chọn hạng mục X?" rồi mới xem trước làm thừa một lượt hỏi.
  if (kind === 'unspecified' && field === 'category' && names.length === 1 && !more)
    return `Chưa nêu ${label}; gợi ý duy nhất: ${list} — gọi lại NGAY với category = gợi ý này để lấy bản xem trước rồi hỏi người dùng đồng ý một lần (nêu rõ hạng mục); họ muốn hạng mục khác thì xem trước lại.`;
  if (kind === 'unspecified') return names.length ? `Chưa nêu ${label}; gợi ý: ${list} — hỏi người dùng chọn một, không tự chọn.` : `Chưa nêu ${label}; hỏi người dùng.`;
  // outside_scope: câu tĩnh, không bao giờ nêu tên ứng viên (SQL không trả tên ngoài phạm vi được ghi; review #253).
  if (kind === 'outside_scope') return `${Label} ${quoted(wanted)} nằm ngoài phạm vi toà mà kết nối được ghi; không làm được ở đó, báo người dùng.`;
  // Thu chi lượt 11 (nghiệm thu): mã phiếu bị dùng lại giữa các toà ⇒ chỉ mã thì không chọn được; SQL nhận mã kèm ngày / toà (hoặc nguyên nhãn
  // ứng viên). Hạng mục là danh mục của cả công ty (không theo toà) ⇒ "không thấy" nghĩa là không có trong danh mục chi dùng được qua bot.
  if (kind === 'ambiguous' && names.length && field === 'voucher')
    return `${Label} ${quoted(wanted)} khớp nhiều: ${list} — hỏi người dùng chọn một, rồi gọi lại với voucherCode kèm ngày hoặc toà của phiếu (vd 'PC2610777 05/10') hoặc chép nguyên nhãn ứng viên.`;
  if (kind === 'ambiguous' && names.length) return `${Label} ${quoted(wanted)} khớp nhiều: ${list} — hỏi người dùng nêu rõ.`;
  if (field === 'category') return `Không có hạng mục ${quoted(wanted)} trong danh mục chi dùng được qua bot (hạng mục hệ thống, hạn chế, cọc, chuyển nội bộ chỉ lập trên web); hỏi người dùng nêu hạng mục khác.`;
  return `Không thấy ${label} ${quoted(wanted)} trong phạm vi quyền của anh/chị; hỏi lại người dùng.`;
}
