// T4 (R2b, 21/10/2026): câu hỏi của bộ 79 câu production (đánh số như lần chạy full50c) → tool đúng + đối số tối thiểu +
// chỗ đọc câu trả lời trong khuôn kết quả. tool-plan.test.mjs kiểm không gọi model, không gọi SQL. Chỉ tên toà/phòng;
// không tên khách, không SĐT, không số tiền. Ngày tương đối tính từ 21/10/2026 (ngày của bộ câu hỏi).
//   tool/args   lời gọi đúng: phải có trong tools/list đủ quyền, qua được schema QUẢNG BÁO (Hermes kiểm trước khi gọi
//               connector) và broker tới đúng cổng prepare.
//   answerFrom  đường trong khuôn kết quả khai báo: items[].x, summary.x(.y), rooms[].x, truncated. summary của tool danh sách
//               là của R2a (chưa có trong khuôn trên nhánh này) ⇒ phải nằm trong SUMMARY_PENDING; khi R2a gộp, test in
//               chẩn đoán những mục đã khai để gỡ khỏi danh sách.
//   wrong       lời gọi sai cách lấy từ trace (full50/full50c): `hermes` = schema quảng bá chặn ('rejects') hay để qua
//               ('passes'); broker luôn trả invalid_request, `hint` = regex của detail tĩnh (null: không detail).
//   alias       đối số sai chữ của trace ⇒ normalizeToolArguments cho đúng giá trị enum (Hermes vẫn chặn trước nếu `hermes`).
//   mentions    mô tả quảng bá của tool (đúng hoặc nhầm) phải chỉ đường bằng chữ này.
//   listing     60 ký tự đầu của mô tả (phần danh sách tool_search của Hermes hiện) phải chứa cụm này.
export const SUMMARY_PENDING = Object.freeze([
  'crm_read_contracts summary.count', 'crm_read_contracts summary.byStatus',
  'crm_read_receivables summary.sum.remainingAmount', 'crm_read_receivables summary.byBuilding',
  'crm_read_income_expenses summary.count', 'crm_read_income_expenses summary.sum.totalAmount', 'crm_read_income_expenses summary.byType',
  'crm_read_income_expenses summary.largest', 'crm_read_meter_readings summary.rooms', 'crm_read_occupancy summary.total',
  'crm_read_occupancy summary.occupied', 'crm_read_assets summary.count',
]);

const SALE_PAGE = Object.freeze({ tool: 'crm_available_rooms', match: /^Trang Sale công khai/ });
const CONTRACTS_NO_DATES = Object.freeze({ tool: 'crm_read_contracts', match: /KHÔNG lọc ngày \(sắp hết hạn: contract_search\)/ });
const PENDING_LISTINGS = Object.freeze([{ tool: 'crm_read_income_expenses', match: /chờ duyệt: status=UNAPPROVED/ },
  { tool: 'crm_read_pending_approvals', match: /phiếu chờ duyệt: income_expenses/ }]);

export const TOOL_PLAN_CASES = Object.freeze([
  { n: 3, q: 'Phòng 305 toà 102LVT hiện ai đang ở? Cho tôi số điện thoại của khách.',
    tool: 'crm_room_lookup', args: { buildingName: '102LVT', roomCode: '305' }, answerFrom: ['rooms[].hasActiveContract', 'rooms[].representative'],
    mentions: [{ tool: 'crm_available_rooms', match: /một phòng \(ai ở, trống\): crm_room_lookup/ }], listing: [SALE_PAGE] },
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
  { n: 35, q: 'Khoản chi lớn nhất tháng này là gì, bao nhiêu tiền?',
    tool: 'crm_read_income_expenses', args: { fromDate: '2026-10-01', toDate: '2026-10-31' }, answerFrom: ['summary.largest'],
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
