// R2b (21/10/2026). Gợi ý định tuyến 0 byte tools/list: khi validator của broker từ chối một tool đọc VÀ lời gọi có dạng
// "sai cách" quen thuộc trong trace production (full50c: T1 chọn nhầm tool, T2 gọi sai tham số rồi lặp lại), broker gắn một
// chuỗi TĨNH vào `detail` của invalid_request; mcp-http chỉ chuyển `detail` của invalid_request khi chuỗi nằm trong
// READ_MISUSE_HINT_TEXTS (danh sách đóng). Chuỗi không bao giờ chứa dữ liệu người dùng hay giá trị đã gửi — chỉ nêu tool và
// tham số đúng. Thuần, không I/O; chỉ xem TÊN khoá và giá trị dữ liệu (không gọi accessor: đối số đã qua
// normalizeToolArguments có thể mang getter). Lời gọi hợp lệ không bao giờ bị từ chối vì có hint
// (crm_read_assets {query:"xe đẩy"} vẫn chạy): hint chỉ đi kèm mã lỗi mà validator đã quyết.
//
// Giới hạn đã đo (21/10; mã Hermes upstream tools/tool_search.py + trace full50c): Hermes kiểm đối số `tool_call` theo schema
// QUẢNG BÁO (validate_deferred_call_args: additionalProperties:false, enum) TRƯỚC khi gọi connector — 17/17 lời gọi sai
// của full50c dừng ở đó ("The tool was NOT invoked"). Các luật theo khoá lạ dưới đây (ngày ở hợp đồng/hoá đơn, type ở thu
// chi, toà ở hộp duyệt) vì vậy chỉ tới mô hình khi client không tự kiểm schema; luật buildingId không phải UUID tới được
// ngay (schema quảng bá của tool đọc đã bỏ format uuid). Trụ chính vẫn là mô tả tool + SOUL.
import { READ_NAMES } from './domain-contract.mjs';
import { W2 } from './wave2-registry.mjs';
import { W2_NAME_PARAMS } from './wave2-kit.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sent = (args, ...keys) => keys.some(key => Object.hasOwn(args, key));
// Khoá ngày/kỳ mô hình hay đoán (cả snake_case: normalizeToolArguments chỉ đổi khi tool CÓ khoá camelCase tương ứng).
const DATE_KEY = /^(?:(?:from|to|start|end|due)_?date|(?:billing_?)?month|days|date)$/i;
const dated = args => Object.keys(args).some(key => DATE_KEY.test(key));
const dataText = (args, key) => {
  const descriptor = Object.hasOwn(args, key) ? Object.getOwnPropertyDescriptor(args, key) : undefined;
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : '';
};
const word = (args, key) => dataText(args, key).trim().toLowerCase();
// "xe"/"biển số" là một từ riêng ("xem", "xếp" không khớp); so trên dạng NFC.
const VEHICLE_QUERY = /(?<![\p{L}\p{M}\p{N}])(?:xe|biển số)(?![\p{L}\p{M}\p{N}])/iu;

export const READ_MISUSE_HINTS = Object.freeze({
  // Câu 13/14/19: hợp đồng không lọc ngày — model điền fromDate/toDate (hay status EXPIRING của contract_search).
  contracts: Object.freeze({ when: args => dated(args) || word(args, 'status') === 'expiring',
    hint: 'crm_read_contracts không lọc ngày. Sắp hết hạn ≤30 ngày: crm_read_contract_search status=EXPIRING; N ngày: crm_read_occupancy_report report=upcoming days=N; quá hạn: crm_read_contract_search status=EXPIRED.' }),
  // Câu 21/22/25 (3/11 lời gọi bị schema từ chối ở full50c): hoá đơn họ v1 không lọc kỳ/trạng thái.
  invoices: Object.freeze({ when: args => dated(args) || word(args, 'status') !== '',
    hint: 'crm_read_invoices không lọc kỳ/trạng thái. Tổng một kỳ: crm_read_invoice_report report=stats month=YYYY-MM; theo kỳ/trạng thái: report=search; còn nợ: crm_read_receivables.' }),
  // Câu 31/33/34/35 (3 lời gọi type:"expense" ở full50c): không có tham số type; dòng mang trường type, summary.byType (R2a) gom sẵn.
  income_expenses: Object.freeze({ when: args => sent(args, 'type', 'kind'),
    hint: 'crm_read_income_expenses không có tham số type: thu/chi ở trường type từng dòng (summary.byType khi có); lọc bằng status, fromDate/toDate, buildingName.' }),
  // Câu 32/36: hộp duyệt của chính người hỏi không lọc toà/trạng thái/kỳ; "phiếu chờ duyệt" là miền thu chi.
  pending_approvals: Object.freeze({ when: args => sent(args, 'buildingName', 'buildingId', 'roomName', 'status', 'fromDate', 'toDate'),
    hint: 'crm_read_pending_approvals chỉ là việc chờ CHÍNH người hỏi duyệt, không lọc toà/trạng thái. Phiếu chờ duyệt (cả theo toà): crm_read_income_expenses status=UNAPPROVED (+buildingName).' }),
  // Câu 73: xe không phải tài sản; báo cáo vehicles của crm_read_report.
  assets: Object.freeze({ when: args => VEHICLE_QUERY.test(dataText(args, 'query').normalize('NFC')),
    hint: 'Xe không phải tài sản: crm_read_report report=vehicles (params.buildingName).' }),
});
// Mọi tool đọc nhận tên toà (READ_NAMES, trừ crm_read_report mang tên trong params): buildingId không phải UUID (vd mã toà)
// vượt được schema quảng bá (không format) nhưng validator từ chối — full50 câu 28/36: buildingId="331PHI"/"1392QT".
export const BUILDING_ID_HINT = 'buildingId là UUID của toà; tên/mã toà gửi ở buildingName.';
// Thu chi Mốc 3 (22/10, ma trận đọc lượt 2): crm_read_report {report:"top_expenses", params:{buildingName, fromDate, toDate}} — báo cáo chỉ nhận
// month — từng chỉ ra invalid_request trần (mô hình đoán lại rồi bỏ cuộc). Một câu TĨNH cho mỗi báo cáo, sinh từ sổ báo cáo lúc nạp module
// (danh sách đóng, không chứa giá trị đã gửi): tên params nhận, tham số bắt buộc, và chỗ đúng cho câu hỏi khoảng ngày/ngưỡng của top_expenses.
const W2_PARAM_REDIRECTS = Object.freeze({ top_expenses: ' Khoảng ngày/ngưỡng tiền/mọi phiếu chi: report=expense_vouchers; theo hạng mục: report=expense_categories.' });
// Tên thay của connector (read-name-resolution.mjs): buildingName khi báo cáo có buildingId HOẶC roomId (thu hẹp tìm phòng, vd room_detail),
// roomName khi có roomId.
const w2Accepted = spec => [...spec.params, ...spec.params.flatMap(name => Object.hasOwn(W2_NAME_PARAMS, name) ? [W2_NAME_PARAMS[name][0]] : []),
  ...(spec.params.includes('roomId') && !spec.params.includes('buildingId') ? [W2_NAME_PARAMS.buildingId[0]] : [])];
export const W2_PARAM_HINTS = Object.freeze(Object.fromEntries(Object.entries(W2.reports).map(([report, spec]) => [report,
  `Báo cáo ${report} nhận params: ${spec.params.length ? w2Accepted(spec).join(', ') : '(không có)'}` +
  `${spec.required.length ? `; bắt buộc: ${spec.required.join(', ')}` : ''}.${W2_PARAM_REDIRECTS[report] ?? ''}`])));
export const READ_MISUSE_HINT_TEXTS = Object.freeze([...Object.values(READ_MISUSE_HINTS).map(rule => rule.hint), BUILDING_ID_HINT,
  ...Object.values(W2_PARAM_HINTS)]);
// Tên lạ trong params, hoặc thiếu tham số bắt buộc mà cũng không có tên thay (roomId ↔ roomName, buildingId ↔ buildingName).
function w2ParamHint(args) {
  const report = dataText(args, 'report');
  if (!Object.hasOwn(W2_PARAM_HINTS, report)) return null;
  const params = Object.hasOwn(args, 'params') ? Object.getOwnPropertyDescriptor(args, 'params') : { value: undefined };
  if (!Object.hasOwn(params, 'value')) return null;
  const supplied = params.value === undefined || params.value === null ? {} : params.value;
  if (!plain(supplied)) return null;
  const spec = W2.reports[report], accepted = w2Accepted(spec), keys = Object.keys(supplied);
  const missing = spec.required.some(name => !keys.includes(name) && !(Object.hasOwn(W2_NAME_PARAMS, name) && keys.includes(W2_NAME_PARAMS[name][0])));
  return keys.some(key => !accepted.includes(key)) || missing ? W2_PARAM_HINTS[report] : null;
}

/** Chuỗi hint tĩnh cho (operation, args) hoặc null. `operation` là tên miền đọc (domainOperation(name)); `args` là đối số đã
 * chuẩn hoá TRƯỚC splitReadNames (buildingName còn trong args). Luật riêng của miền trước, luật buildingId sau. Không ném. */
export function readMisuseHint(operation, args) {
  if (typeof operation !== 'string' || !plain(args)) return null;
  try {
    if (Object.hasOwn(READ_MISUSE_HINTS, operation) && READ_MISUSE_HINTS[operation].when(args)) return READ_MISUSE_HINTS[operation].hint;
    if (operation === 'report') return w2ParamHint(args);
    const names = Object.hasOwn(READ_NAMES, operation) ? READ_NAMES[operation] : null, building = dataText(args, 'buildingId').trim();
    if (names !== null && names.room !== 'param' && building !== '' && !UUID.test(building)) return BUILDING_ID_HINT;
  } catch { /* hostile input: no hint */ }
  return null;
}
