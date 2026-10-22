// T4 (R2b, 21/10/2026): câu hỏi của bộ 79 câu production (đánh số như lần chạy full50c) → tool đúng + đối số tối thiểu +
// chỗ đọc câu trả lời trong khuôn kết quả. tool-plan.test.mjs kiểm không gọi model, không gọi SQL. Chỉ tên toà/phòng;
// không tên khách, không SĐT, không số tiền. Ngày tương đối tính từ 21/10/2026 (ngày của bộ câu hỏi).
//   tool/args   lời gọi đúng: phải có trong tools/list đủ quyền, qua được schema QUẢNG BÁO (Hermes kiểm trước khi gọi
//               connector) và broker tới đúng cổng prepare.
//   answerFrom  đường trong khuôn kết quả khai báo: items[].x, summary.x(.y…), rooms[].x, truncated. summary của tool danh sách
//               do R2a khai (DOMAIN_SUMMARIES, domain-contract.mjs) ⇒ phải có trong khuôn; đường sâu hơn summary.x (vd
//               summary.byType.EXPENSE.largest, R2c) phải có thật trong summary mà connector nhận (tool-plan.test.mjs đi đường
//               trên summary của hàng mẫu). SUMMARY_PENDING chỉ dành cho khoá summary chưa khai (R2a đã khai đủ 12 mục ban đầu,
//               21/10 ⇒ rỗng; test in chẩn đoán mục nào đã khai để gỡ).
//   wrong       lời gọi sai cách lấy từ trace (full50/full50c): `hermes` = schema quảng bá chặn ('rejects') hay để qua
//               ('passes'); broker luôn trả invalid_request, `hint` = regex của detail tĩnh (null: không detail).
//   alias       đối số sai chữ của trace ⇒ normalizeToolArguments cho đúng giá trị enum (Hermes vẫn chặn trước nếu `hermes`).
//   mentions    mô tả quảng bá của tool (đúng hoặc nhầm) phải chỉ đường bằng chữ này.
//   listing     60 ký tự đầu của mô tả (phần danh sách tool_search của Hermes hiện) phải chứa cụm này.
export const SUMMARY_PENDING = Object.freeze([]);

const SALE_PAGE = Object.freeze({ tool: 'crm_available_rooms', match: /^Trang Sale công khai/ });
const CONTRACTS_NO_DATES = Object.freeze({ tool: 'crm_read_contracts', match: /KHÔNG lọc ngày \(sắp hết hạn: contract_search\)/ });
const PENDING_LISTINGS = Object.freeze([{ tool: 'crm_read_income_expenses', match: /chờ duyệt: status=UNAPPROVED/ },
  { tool: 'crm_read_pending_approvals', match: /phiếu chờ duyệt: income_expenses/ }]);

export const TOOL_PLAN_CASES = Object.freeze([
  { n: 3, q: 'Phòng 305 toà 102LVT hiện ai đang ở? Cho tôi số điện thoại của khách.',
    tool: 'crm_room_lookup', args: { buildingName: '102LVT', roomCode: '305' }, answerFrom: ['rooms[].hasActiveContract', 'rooms[].representative'],
    mentions: [{ tool: 'crm_available_rooms', match: /một phòng \(ai ở, trống\): crm_room_lookup/ }], listing: [SALE_PAGE] },
  // R2c phần 2 (a) đếm khách theo status_v2 (ba tab /customers), nhưng production 21/10 không có khách WALK_IN: khách chưa
  // từng có hợp đồng mang RENTING ⇒ byStatus không trả lời được câu này. R2d: summary.withoutContract = số khách của cả tập
  // không có hợp đồng nào (mọi trạng thái) trong phạm vi hợp đồng của kết nối — 20261021063452 (đường nhanh, query rỗng) và
  // 20261021063453 (v3). Trace full50c/d: crm_read_customers query rỗng.
  { n: 5, q: 'Có bao nhiêu khách trong CRM chưa có hợp đồng nào?',
    tool: 'crm_read_customers', args: { query: '' }, answerFrom: ['summary.withoutContract'] },
  { n: 10, q: 'Phòng 999 toà 44TL có ai ở không?',
    tool: 'crm_room_lookup', args: { buildingName: '44TL', roomCode: '999' }, answerFrom: ['rooms', 'truncated'],
    wrong: [{ tool: 'crm_available_rooms', args: { buildingName: '44TL', roomName: '999' }, hermes: 'rejects', hint: null }],
    mentions: [{ tool: 'crm_available_rooms', match: /crm_room_lookup/ }] },
  { n: 13, q: 'Hợp đồng nào sắp hết hạn trong 30 ngày tới?',
    tool: 'crm_read_contract_search', args: { status: 'EXPIRING' }, answerFrom: ['items[].endDate', 'items[].displayStatus', 'items[].roomName', 'items[].buildingName'],
    wrong: [{ tool: 'crm_read_contracts', args: { fromDate: '2026-10-21', toDate: '2026-11-20', limit: 50 }, hermes: 'rejects', hint: /crm_read_contract_search status=EXPIRING/ }],
    mentions: [{ tool: 'crm_read_contracts', match: /≤30 ngày: crm_read_contract_search status=EXPIRING/ }], listing: [CONTRACTS_NO_DATES] },
  { n: 14, q: 'Hợp đồng nào sắp hết hạn trong 60 ngày tới? Liệt kê phòng, toà và ngày hết hạn.',
    tool: 'crm_read_occupancy_report', args: { report: 'upcoming', days: 60 }, answerFrom: ['items[].effectiveEndDate', 'items[].roomName', 'items[].buildingName'],
    wrong: [{ tool: 'crm_read_contracts', args: { limit: 50, fromDate: '2026-10-21', toDate: '2026-12-20' }, hermes: 'rejects', hint: /crm_read_occupancy_report report=upcoming days=N/ }],
    mentions: [{ tool: 'crm_read_contracts', match: /N ngày: crm_read_occupancy_report upcoming days=N/ }], listing: [CONTRACTS_NO_DATES] },
  { n: 15, q: 'Có hợp đồng nào đã quá hạn mà chưa thanh lý không?',
    tool: 'crm_read_contract_search', args: { status: 'EXPIRED' }, answerFrom: ['items[].endDate', 'items[].displayLabel'],
    alias: [{ tool: 'crm_read_contract_search', args: { status: 'expired' }, expect: { status: 'EXPIRED' }, hermes: 'rejects' }],
    mentions: [{ tool: 'crm_read_contracts', match: /quá hạn\/thanh lý: contract_search EXPIRED/ }] },
  { n: 16, q: 'Toà 111PVC có bao nhiêu hợp đồng đã thanh lý?',
    tool: 'crm_read_contracts', args: { buildingName: '111PVC', status: 'TERMINATED' }, answerFrom: ['summary.count'],
    alias: [{ tool: 'crm_read_contracts', args: { buildingName: '111PVC', status: 'liquidated', limit: 50 },
      expect: { buildingName: '111PVC', status: 'TERMINATED', limit: 50 }, hermes: 'rejects' }] },
  { n: 19, q: 'Toàn công ty đang có bao nhiêu hợp đồng còn hiệu lực?',
    tool: 'crm_read_contracts', args: { status: 'ACTIVE' }, answerFrom: ['summary.count', 'summary.byStatus'],
    wrong: [{ tool: 'crm_read_contracts', args: { fromDate: '2026-10-21', toDate: '2026-11-20' }, hermes: 'rejects', hint: /contract_search/ }],
    alias: [{ tool: 'crm_read_contracts', args: { status: 'active' }, expect: { status: 'ACTIVE' }, hermes: 'rejects' }], listing: [CONTRACTS_NO_DATES] },
  { n: 21, q: 'Tháng 9 vừa rồi toà 331PHI có bao nhiêu hoá đơn, còn nợ bao nhiêu?',
    tool: 'crm_read_invoice_report', args: { report: 'stats', month: '2026-09', buildingName: '331PHI' }, answerFrom: ['summary.totalCount', 'summary.totalRemaining'],
    wrong: [{ tool: 'crm_read_invoices', args: { buildingName: '331PHI', fromDate: '2026-09-01', toDate: '2026-09-30', limit: 50 }, hermes: 'rejects',
      hint: /crm_read_invoice_report report=stats month=YYYY-MM/ }] },
  { n: 26, q: 'Tổng công nợ phải thu toàn công ty hiện tại là bao nhiêu?',
    tool: 'crm_read_receivables', args: {}, answerFrom: ['summary.sum.remainingAmount'] },
  { n: 29, q: 'Toà nào đang có công nợ nhiều nhất?',
    tool: 'crm_read_receivables', args: {}, answerFrom: ['summary.byBuilding', 'items[].buildingName', 'items[].remainingAmount'] },
  { n: 32, q: 'Có phiếu thu chi nào đang chờ duyệt không? Bao nhiêu phiếu, tổng bao nhiêu tiền?',
    tool: 'crm_read_income_expenses', args: { status: 'UNAPPROVED' }, answerFrom: ['summary.count', 'summary.sum.totalAmount'],
    alias: [{ tool: 'crm_read_income_expenses', args: { status: 'pending' }, expect: { status: 'UNAPPROVED' }, hermes: 'rejects' }],
    mentions: [{ tool: 'crm_read_pending_approvals', match: /crm_read_income_expenses status=UNAPPROVED/ }], listing: PENDING_LISTINGS },
  { n: 33, q: 'Toà 44TL tháng này thu được bao nhiêu, chi bao nhiêu (chỉ tính phiếu đã duyệt)?',
    tool: 'crm_read_income_expenses', args: { buildingName: '44TL', status: 'APPROVED', fromDate: '2026-10-01', toDate: '2026-10-31' }, answerFrom: ['summary.byType'],
    wrong: [{ tool: 'crm_read_income_expenses', args: { buildingName: '44TL', fromDate: '2026-10-01', toDate: '2026-10-31', type: 'INCOME' }, hermes: 'rejects',
      hint: /không có tham số type/ }],
    alias: [{ tool: 'crm_read_income_expenses', args: { buildingName: '44TL', fromDate: '2026-10-01', toDate: '2026-10-21', status: 'approved', limit: 50 },
      expect: { buildingName: '44TL', fromDate: '2026-10-01', toDate: '2026-10-21', status: 'APPROVED', limit: 50 }, hermes: 'rejects' }] },
  // R2c (prod 21/10): tool không lọc loại nên summary.largest (cả thu lẫn chi) là một phiếu THU; khoản CHI lớn nhất ở
  // summary.byType.EXPENSE.largest (20261021035022).
  { n: 35, q: 'Khoản chi lớn nhất tháng này là gì, bao nhiêu tiền?',
    tool: 'crm_read_income_expenses', args: { fromDate: '2026-10-01', toDate: '2026-10-31' }, answerFrom: ['summary.byType.EXPENSE.largest'],
    wrong: [{ tool: 'crm_read_income_expenses', args: { fromDate: '2026-10-01', toDate: '2026-10-21', type: 'expense', limit: 50 }, hermes: 'rejects', hint: /summary\.byType/ }] },
  { n: 36, q: 'Toà 1392QT có bao nhiêu phiếu đang chờ duyệt?',
    tool: 'crm_read_income_expenses', args: { buildingName: '1392QT', status: 'UNAPPROVED' }, answerFrom: ['summary.count'],
    wrong: [{ tool: 'crm_read_pending_approvals', args: { buildingName: '1392QT' }, hermes: 'rejects', hint: /crm_read_income_expenses status=UNAPPROVED \(\+buildingName\)/ },
      // full50: mã toà gửi ở buildingId — schema quảng bá (không format) để qua, broker từ chối: hint duy nhất tới được mô hình hôm nay.
      { tool: 'crm_read_income_expenses', args: { buildingId: '1392QT', limit: 50, query: '', status: 'UNAPPROVED' }, hermes: 'passes', hint: /tên\/mã toà gửi ở buildingName/ }],
    mentions: [{ tool: 'crm_read_pending_approvals', match: /Không lọc toà/ }], listing: PENDING_LISTINGS },
  { n: 40, q: 'Toà 15KV tháng này đã ghi chỉ số điện cho bao nhiêu phòng?',
    tool: 'crm_read_meter_readings', args: { buildingName: '15KV', fromDate: '2026-10-01', toDate: '2026-10-31' }, answerFrom: ['summary.rooms', 'items[].meterType', 'items[].roomName'] },
  { n: 47, q: 'Tỷ lệ lấp đầy toàn công ty hiện tại là bao nhiêu?',
    tool: 'crm_read_occupancy', args: {}, answerFrom: ['summary.total', 'summary.occupied', 'items[].total', 'items[].occupied'] },
  { n: 49, q: 'Phòng nào sắp trống trong 30 ngày tới?',
    tool: 'crm_read_occupancy_report', args: { report: 'upcoming', days: 30 }, answerFrom: ['items[].effectiveEndDate', 'items[].roomName'],
    mentions: [{ tool: 'crm_available_rooms', match: /sắp trống N ngày: crm_read_occupancy_report upcoming/ }], listing: [SALE_PAGE] },
  { n: 58, q: 'Toà 162NVK có bao nhiêu tài sản?',
    tool: 'crm_read_assets', args: { buildingName: '162NVK' }, answerFrom: ['summary.count'] },
  // R2c phần 2 (b): tài sản thêm gần đây nhất của cả tập lọc + ngày thêm của từng dòng (20261021044801). R2d: production
  // nhập cả kho trong MỘT đợt ⇒ latest chỉ là một món của đợt; latestCount = số tài sản cùng đúng thời điểm đó (20261021063452).
  { n: 59, q: 'Tài sản nào được thêm vào gần đây nhất?',
    tool: 'crm_read_assets', args: {}, answerFrom: ['summary.latest', 'summary.latestCount', 'items[].createdAt'] },
  { n: 72, q: 'Hotline của công ty là số nào?',
    tool: 'crm_read_report', args: { report: 'hotlines' }, answerFrom: ['items[].phoneNumber', 'summary.total'],
    mentions: [{ tool: 'crm_read_report', match: /\bhotlines\b/ }], listing: [{ tool: 'crm_read_report', match: /hotlines/ }] },
  { n: 73, q: 'Toà 1392QT có bao nhiêu xe đăng ký gửi?',
    tool: 'crm_read_report', args: { report: 'vehicles', params: { buildingName: '1392QT' } }, answerFrom: ['summary.total'],
    mentions: [{ tool: 'crm_read_assets', match: /xe: crm_read_report vehicles/ }],
    listing: [{ tool: 'crm_read_assets', match: /xe: crm_read_report vehicles/ }, { tool: 'crm_read_report', match: /xe=vehicles/ }] },
  { n: 76, q: 'Theo báo cáo bất động sản, phòng nào đang trống (không có hợp đồng hiệu lực)?',
    tool: 'crm_read_report', args: { report: 're_vacant_rooms' }, answerFrom: ['items[].roomName', 'items[].buildingName', 'summary.total'],
    mentions: [{ tool: 'crm_available_rooms', match: /crm_read_report re_vacant_rooms/ }, { tool: 'crm_read_report', match: /re_vacant_rooms/ }] },
].map(entry => Object.freeze(entry)));

// Đợt 1 nền chung (NEN-CHUNG-THAO-TAC-GHI.md §12.1, review #253): ca khung của họ thao tác ghi — kết quả nào dẫn tới lời gọi
// kế tiếp nào. Kiểm trên câu hướng dẫn tĩnh (mô tả crm_action_run, huongDan của kết quả), không gọi model, không gọi SQL.
//   source  'run' = mô tả quảng bá của crm_action_run; 'unknown_action' / 'confirmation_required' = huongDan của kết quả đó.
export const ACTION_PLAN_CASES = Object.freeze([
  { when: 'thao tác lạ (needs_input unknown_action)', next: 'crm_action_list', source: 'unknown_action', match: /Gọi crm_action_list/ },
  { when: 'mất phản hồi sau lệnh ghi (action_outcome_unknown)', next: 'crm_action_status', source: 'run',
    match: /action_outcome_unknown: crm_action_status cùng requestId, không gọi lại/ },
  { when: 'confirmation_required', next: 'không tự gọi lượt 2', source: 'confirmation_required', match: /chỉ khi họ đồng ý rõ ràng SAU khi xem/ },
  { when: 'action_rejected state_changed (lỗi tạm, dữ liệu đổi)', next: 'crm_action_run không kèm confirmToken', source: 'run',
    match: /detail bảo xem trước lại thì gọi lại không kèm confirmToken/ },
].map(entry => Object.freeze(entry)));
