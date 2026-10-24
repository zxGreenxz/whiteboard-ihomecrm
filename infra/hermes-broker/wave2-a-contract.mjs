// Gói A đợt 2 — Thu tiền, công nợ, cọc. File của RIÊNG Gói A.
// Khai báo mỗi báo cáo bằng w2Report() (wave2-kit.mjs); mã báo cáo là khoá của object, khớp
// /^[a-z][a-z0-9_]{1,47}$/ và KHÔNG trùng mã của gói khác (wave2-registry.mjs kiểm khi nạp).
// SQL cùng gói: app_private.hermes_w2a_catalog_v1 (khớp từng trường với khai báo ở đây) và
// app_private.hermes_w2a_read_v1 — migration 20261018010000_hermes_w2a_receivables_read_v1.sql, thân hàm đọc thay ở
// 20261018010100_hermes_w2a_review_fixes_v1.sql (sửa sau review PR #207).
// Nguồn số liệu (chủ chốt 17/10): màn web có RPC ⇒ gọi thẳng RPC; màn web đọc bảng ⇒ hàm dùng chung
// public.<miền>_<báo cáo>_v1(..., p_building_ids) theo đúng bộ lọc web (dẫn file:line trong migration).
// A3 (BC tiền cọc, bảng legacy deposits) không làm: production 17/10 có 0 dòng.
// Tên khách (không SĐT): chỉ khi customers.view ở đúng toà của hàng và chủ hồ sơ thuộc công ty. Chữ chép trên phiếu
// (người nộp, ghi chú, tên phiếu) và ghi chú hoá đơn: chỉ khi nối được hồ sơ khách nhìn thấy dưới RLS, cùng công ty,
// đủ customers.view ở toà; không nối được ⇒ null (phiếu cọc giữ chỗ/quyết toán: luôn null).
import { w2Report, id, nullable, longText, code, amount, bool, count, date } from './wave2-kit.mjs';

const oneOf = values => value => values.includes(value);
const buildingName = nullable(longText(200)), roomName = nullable(longText(100)), personName = nullable(longText(200));
const number = nullable(longText(100));
const CUSTOMER = ['customers.view'];

export const W2A_REPORTS = Object.freeze({
  // /reports/finance/payment-schedule (financeReports.ts:17-65; PaymentScheduleReport.tsx:36-69).
  payment_schedule: w2Report({ permission: 'reports_finance.payment_schedule', source: 'crm.finance_payment_schedule_v1', scope: 'rows',
    title: 'Lịch thanh toán: mỗi phòng một dòng, "đã lên hoá đơn đến" = hạn hoá đơn xa nhất (hoá đơn chưa huỷ, hạn ≤ hôm nay+365); fromDate/toDate lọc theo ngày đó; mới nhất trước.',
    params: ['buildingId', 'fromDate', 'toDate'], scopeKeys: CUSTOMER, private: true,
    fields: { buildingId: id, buildingName, roomId: nullable(id), roomName, customerName: personName, billedThrough: date },
    summary: { rooms: count } }),
  // /reports/finance/overpayment (financeReports.ts:71-138): tổng = RPC get_overpayment_summary.
  overpayment: w2Report({ permission: 'reports_finance.overpayment', source: 'crm.finance_overpayment_invoices_v1', scope: 'rows',
    title: 'Tiền thừa: hoá đơn khách trả nhiều hơn tổng tiền (đã thu > tổng), số tiền thừa từng hoá đơn; summary: tổng tiền thừa và số hoá đơn.',
    params: ['buildingId'], scopeKeys: CUSTOMER, private: true,
    fields: { invoiceId: id, invoiceNumber: number, buildingId: id, buildingName, roomId: nullable(id), roomName, customerName: personName,
      totalAmount: amount, paidAmount: amount, overpaidAmount: amount },
    summary: { total: amount, count } }),
  // /thu-tien (useCollectionReport.ts:28-65; ThuTien.tsx:110-174; collect.ts:40-224; useInvoiceCollectors.ts:27-80).
  collection: w2Report({ permission: 'thu_tien.view', source: 'crm.thu_tien_collection_v1', scope: 'rows',
    title: 'Thu tiền theo kỳ month như trang Thu tiền. Không ngày = cả kỳ; fromDate=toDate=hôm nay = Hôm nay; có ngày = thu trong khoảng + phòng còn nợ tới ngày cuối. status paid/unpaid như tab Đã thu/Chưa thu; summary là thanh tổng.',
    params: ['month', 'buildingId', 'status', 'fromDate', 'toDate'], required: ['month'], statuses: ['paid', 'unpaid'], scopeKeys: CUSTOMER, private: true,
    fields: { invoiceId: id, invoiceNumber: number, buildingId: id, buildingName, roomId: nullable(id), roomName, customerName: personName,
      invoiceStatus: code, collectStatus: oneOf(['paid', 'partial', 'unpaid']), totalAmount: amount, paidAmount: amount, remainingAmount: amount,
      collectedInRange: nullable(amount), collectors: nullable(longText(300)) },
    summary: { mode: oneOf(['all', 'today', 'date']), invoiceCount: count, collectedSum: amount, remainingSum: amount, paidRooms: count, dueRooms: count } }),
  // /invoices/:id (useInvoices.ts:116-130,365-383; InvoiceDetailView.tsx:180-195).
  invoice_detail: w2Report({ permission: 'invoices.view', source: 'crm.invoice_detail_v1', scope: 'rows',
    title: 'Chi tiết một hoá đơn (invoiceId): summary là đầu hoá đơn + tổng thu/chi như chân thẻ web (found=false nếu không có/ngoài phạm vi); hàng kind=item dòng hoá đơn, payment khoản thu (REVERSED = đã hoàn tác), voucher phiếu thu/chi đã duyệt.',
    params: ['invoiceId'], required: ['invoiceId'], scopeKeys: CUSTOMER, private: true,
    fields: { kind: oneOf(['item', 'payment', 'voucher']), id, buildingId: id, code: number, label: nullable(longText(300)), category: nullable(longText(40)),
      amount, unitPrice: nullable(amount), quantity: nullable(amount), date: nullable(date), endDate: nullable(date), status: nullable(longText(40)),
      person: personName, previousReading: nullable(amount), currentReading: nullable(amount) },
    summary: { found: bool, invoiceId: nullable(id), invoiceNumber: number, status: nullable(code), kind: nullable(longText(40)),
      billingMonth: nullable(longText(20)), issueDate: nullable(date), dueDate: nullable(date), paidDate: nullable(date), buildingId: nullable(id),
      buildingName, roomId: nullable(id), roomName, contractNumber: number, customerName: personName, subtotal: nullable(amount),
      discountAmount: nullable(amount), previousDebt: nullable(amount), totalAmount: nullable(amount), paidAmount: nullable(amount),
      remainingAmount: nullable(amount), notes: nullable(longText(1000)), adjustmentCount: nullable(count), adjustmentReviewStatus: nullable(longText(40)),
      totalReceived: nullable(amount), totalRefunded: nullable(amount) } }),
  // /deposits tab Phiếu giữ chỗ (useDeposits.ts:145-258; useReservationHoldDeadlines.ts:36-70).
  // scope rls_buildings (19/10): như /deposits (route không truyền toà) — tập phiếu do RLS income_expenses quyết, kể cả phiếu vào sổ
  // quỹ người hỏi giữ ở toà không có deposits.view; toà = toà công ty ∩ phạm vi kết nối.
  reservation_vouchers: w2Report({ permission: 'deposits.view', source: 'crm.deposit_reservation_vouchers_v1', scope: 'rls_buildings',
    title: 'Phiếu cọc giữ chỗ (phiếu thu cọc chưa gắn hợp đồng): số cọc, trạng thái duyệt, đã quyết toán chưa, hạn làm hợp đồng/bổ sung cọc; query tìm theo mã phiếu/tên phòng (không trả tên phiếu/người nộp). summary: tổng cọc đang giữ.',
    params: ['buildingId', 'status', 'query'], statuses: ['APPROVED', 'UNAPPROVED', 'CANCELLED'], scopeKeys: CUSTOMER, private: true,
    fields: { voucherId: id, code: number, name: nullable(longText(300)), payerName: personName, depositAmount: amount, voucherDate: nullable(date),
      approvalStatus: code, buildingId: id, buildingName, roomId: nullable(id), roomName, settled: bool, holdUntil: nullable(date),
      topupDueDate: nullable(date), depositTarget: nullable(amount) },
    summary: { holdingAmount: amount, approvedCount: count, unapprovedCount: count, cancelledCount: count } }),
  // /deposits quyết toán cọc giữ chỗ (RPC get_reservation_settlements_v1 + get_reservation_settlement_summary_v1).
  reservation_settlements: w2Report({ permission: 'deposits.view', source: 'crm.get_reservation_settlements_v1', scope: 'rows',
    title: 'Quyết toán cọc giữ chỗ: cọc, giữ lại, phải hoàn, đã hoàn, còn phải hoàn; status PENDING = chờ hoàn, PAID = đã hoàn đủ, NOT_REQUIRED = không phải hoàn.',
    params: ['buildingId', 'status'], statuses: ['PENDING', 'PAID', 'NOT_REQUIRED'], scopeKeys: CUSTOMER, private: true,
    fields: { settlementId: id, voucherCode: number, buildingId: id, buildingName, roomId: nullable(id), roomName, payerName: personName,
      depositAmount: amount, retainedAmount: amount, refundAmount: amount, refundedAmount: amount, refundRemaining: amount,
      refundState: oneOf(['PENDING', 'PAID', 'NOT_REQUIRED']), settlementDate: nullable(date), reasonCode: nullable(longText(40)), roomReleased: bool },
    summary: { retainedAmount: amount, retainedCount: count, refundPendingAmount: amount, refundPendingCount: count, refundPaidAmount: amount,
      refundPaidCount: count } }),
  // /deposits tab Đủ/Thiếu cọc (useDepositDashboard.ts:329-386; KPI get_held_deposit_summary).
  held_deposits: w2Report({ permission: 'deposits.view', source: 'crm.deposit_held_contracts_v1', scope: 'rows',
    title: 'Cọc đang giữ theo hợp đồng hiệu lực: cọc phải thu, đã thu, còn thiếu; status FULL (thiếu < 10.000đ), SHORT (thiếu cọc), FIRST_INVOICE (thiếu, trừ vào hoá đơn đầu). "HĐ chưa thu đủ cọc" = SHORT + FIRST_INVOICE: gọi mỗi status một lần; số = shortCount + firstInvoiceCount.',
    params: ['buildingId', 'status'], statuses: ['FULL', 'SHORT', 'FIRST_INVOICE'], scopeKeys: CUSTOMER, private: true,
    fields: { contractId: id, contractNumber: number, buildingId: id, buildingName, roomId: id, roomName, customerName: personName,
      totalDeposit: amount, depositPaid: amount, depositRemaining: amount, debtMode: nullable(longText(40)), topupDueDate: nullable(date),
      state: oneOf(['FULL', 'SHORT', 'FIRST_INVOICE']) },
    summary: { contractCount: count, expected: amount, held: amount, shortfall: amount, shortfallAll: amount, fullCount: count, shortCount: count,
      firstInvoiceCount: count } }),
  // /deposits tab Hoàn / Bỏ cọc (useDepositDashboard.ts:427-534; KPI get_refund_forfeit_summary).
  deposit_refunds: w2Report({ permission: 'deposits.view', source: 'crm.deposit_refunds_forfeits_v1', scope: 'rows',
    title: 'Hoàn cọc / bỏ cọc theo hồ sơ thanh lý: "đã hoàn" chỉ khi có phiếu chi hoàn đã vào sổ; refundDrift = net quyết toán − đã hoàn. kind REFUND/FORFEIT. summary: KPI tiền hoàn đã ra két (kể cả phiếu không nối hồ sơ).',
    params: ['buildingId', 'kind'], kinds: ['REFUND', 'FORFEIT'], scopeKeys: CUSTOMER, private: true,
    fields: { terminationId: id, contractId: nullable(id), contractNumber: number, buildingId: id, buildingName, roomId: id, roomName,
      customerName: personName, terminationDate: nullable(date), terminationType: nullable(longText(40)), kind: oneOf(['REFUND', 'FORFEIT']),
      totalDeposit: amount, totalDeductions: amount, settlementNet: amount, status: nullable(longText(40)), postedRefund: amount,
      postedRefundCount: count, refundDone: bool, refundDrift: amount },
    summary: { refundTotal: amount, refundCount: count, refundLinkedTotal: amount, refundOrphanTotal: amount, refundPendingTotal: amount,
      forfeitTotal: amount, forfeitCount: count, customerDebtTotal: amount } }),
  // /finance/refund-log?account_id= (RefundLogPage.tsx:60-120): sổ tiền thối / làm tròn.
  change_ledger: w2Report({ permission: 'deposits.view', source: 'crm.cashbook_change_ledger_v1', scope: 'rows',
    title: 'Sổ tiền thối / làm tròn của một sổ quỹ (cashbookId; sổ "Làm tròn tiền thiếu" = làm tròn, sổ khác = tiền thối), phiếu đã duyệt; mặc định tháng này. Không phải hoàn cọc.',
    params: ['cashbookId', 'fromDate', 'toDate'], required: ['cashbookId'], scopeKeys: CUSTOMER, private: true,
    fields: { voucherId: id, voucherDate: nullable(date), code: number, invoiceId: nullable(id), invoiceNumber: number, buildingId: id, buildingName,
      roomName, payerName: personName, amount, totalAmount: amount, notes: nullable(longText(1000)) },
    summary: { mode: oneOf(['refund', 'rounding']), fromDate: date, toDate: date, total: amount, count } }),
  // ---- Đợt 3 trang Hoá đơn: đọc bù (a)–(f) + soạn tin nhắc nợ Q18 (docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 7). Hàm dùng chung
  // 20261022051118, hàm đọc + bảng báo cáo 20261022051620. Nợ = nợ thực invoice_effective_outstanding_v1; quá hạn = is_overdue (hạn < hôm nay).
  invoice_room_detail: w2Report({ permission: 'invoices.view', source: 'crm.invoice_room_invoices_v1', scope: 'rows',
    title: 'Hoá đơn của MỘT phòng theo kỳ (roomName + month, mặc định tháng này): hạn đóng, ngày trả đủ, quá hạn mấy ngày, nợ thực; hàng = từng khoản (tiền phòng, điện/nước có số đầu–cuối và số tiêu thụ, dịch vụ) và các lần thu (hình thức, ngày). Không có ⇒ found=false.',
    params: ['roomId', 'month'], required: ['roomId'], scopeKeys: CUSTOMER, private: true,
    fields: { kind: oneOf(['item', 'payment']), id, buildingId: id, code: number, label: nullable(longText(300)), category: nullable(longText(40)), amount,
      unitPrice: nullable(amount), quantity: nullable(amount), previousReading: nullable(amount), currentReading: nullable(amount),
      consumption: nullable(amount), date: nullable(date), status: nullable(longText(40)) },
    summary: { found: bool, invoiceId: nullable(id), invoiceNumber: number, status: nullable(code), billingMonth: nullable(longText(20)),
      issueDate: nullable(date), dueDate: nullable(date), paidDate: nullable(date), isOverdue: bool, overdueDays: nullable(count),
      buildingId: nullable(id), buildingName, roomId: nullable(id), roomName, customerName: personName, totalAmount: nullable(amount),
      paidAmount: nullable(amount), remainingAmount: nullable(amount), effectiveOutstanding: nullable(amount), carriedOutAmount: nullable(amount),
      otherInvoices: count } }),
  invoice_lateness: w2Report({ permission: 'invoices.view', source: 'crm.invoice_lateness_v1', scope: 'rows',
    title: 'Đóng trễ ("ai hay trả trễ"): hoá đơn có hạn trong fromDate–toDate (mặc định 90 ngày qua, tối đa 366 ngày), ngày trả đủ, số ngày trễ (còn nợ = trễ tới hôm nay); summary gộp sẵn theo phòng (topLateRooms) — dùng số này, không tự đếm.',
    params: ['buildingId', 'roomId', 'fromDate', 'toDate'], scopeKeys: CUSTOMER, private: true,
    fields: { invoiceId: id, invoiceNumber: number, buildingId: id, buildingName, roomId: nullable(id), roomName, billingMonth: nullable(longText(20)),
      dueDate: date, settledDate: nullable(date), open: bool, late: bool, daysLate: count, totalAmount: amount, remainingAmount: amount },
    summary: { fromDate: date, toDate: date, invoiceCount: count, lateCount: count, openLateCount: count, avgDaysLate: amount, rooms: count,
      lateRooms: count, topLateRooms: nullable(longText(600)) } }),
  collection_by_method: w2Report({ permission: 'thu_tien.view', source: 'crm.invoice_collection_by_method_v1', scope: 'rows',
    title: 'Đã thu theo hình thức (TM tiền mặt, TK chuyển khoản, TT thanh toán, CT cấn trừ) theo NGÀY THU, số áp vào hoá đơn như trang Thu tiền (khác thẻ thống kê trang Hoá đơn): month = cả tháng, hoặc fromDate–toDate; mặc định tháng này.',
    params: ['month', 'buildingId', 'fromDate', 'toDate'], scopeKeys: CUSTOMER, private: true,
    fields: { buildingId: id, buildingName, method: code, label: longText(40), paymentCount: count, invoiceCount: count, amount },
    summary: { fromDate: date, toDate: date, total: amount, tm: amount, tk: amount, tt: amount, ct: amount, paymentCount: count } }),
  invoice_adjustments: w2Report({ permission: 'invoices.view', source: 'crm.invoice_adjustments_list_v1', scope: 'rows',
    title: 'Điều chỉnh hoá đơn (bỏ hoá đơn huỷ) và xác nhận kiểm tra: tổng trước/sau, chênh, lý do, người/lúc điều chỉnh, người/lúc kiểm; mặc định 366 ngày qua. status PENDING = chờ kiểm (chỉ phiên bản current kiểm được), CHECKED = đã kiểm. summary.pendingCount = số đang chờ kiểm.',
    params: ['buildingId', 'roomId', 'status', 'fromDate', 'toDate'], statuses: ['PENDING', 'CHECKED'], scopeKeys: CUSTOMER, private: true,
    fields: { adjustmentId: id, invoiceId: id, invoiceNumber: number, buildingId: id, buildingName, roomId: nullable(id), roomName,
      billingMonth: nullable(longText(20)), revision: count, current: bool, beforeTotal: amount, afterTotal: amount, delta: amount,
      reason: nullable(longText(1000)), adjustedBy: personName, adjustedDate: date, adjustedTime: nullable(longText(5)), reviewStatus: code,
      checkedBy: personName, checkedDate: nullable(date) },
    summary: { fromDate: date, toDate: date, count, pendingCount: count, checkedCount: count, oldestPendingDate: nullable(date),
      oldestPendingDays: nullable(count) } }),
  invoice_missing: w2Report({ permission: 'invoices.view', source: 'crm.invoice_missing_v1', scope: 'rows',
    title: 'Phòng có hợp đồng hiệu lực mà CHƯA có hoá đơn tháng kỳ month (bỏ hoá đơn huỷ/xoá); summary: số phòng và theo toà. Khác "phòng chưa đóng tiền" (báo cáo collection).',
    params: ['month', 'buildingId'], required: ['month'], scopeKeys: CUSTOMER, private: true,
    fields: { contractId: id, contractNumber: number, buildingId: id, buildingName, roomId: id, roomName, customerName: personName,
      startDate: nullable(date), endDate: nullable(date) },
    summary: { month: longText(7), rooms: count, byBuilding: nullable(longText(600)) } }),
  invoice_room_debts: w2Report({ permission: 'invoices.view', source: 'crm.invoice_open_debts_v1', scope: 'rows',
    title: 'Công nợ GỘP SẴN theo PHÒNG (nợ thực, không đếm trùng nợ kéo): mỗi phòng tổng nợ, số hoá đơn, quá hạn, hạn cũ nhất, các tháng. days = chỉ tính hoá đơn quá hạn ≥ N ngày, mọi số chỉ cộng các hoá đơn đó ("quá hạn hơn 1 tháng" ⇒ days=31). summary.rooms = số PHÒNG.',
    params: ['buildingId', 'roomId', 'days'], scopeKeys: CUSTOMER, private: true,
    fields: { buildingId: id, buildingName, roomId: nullable(id), roomName, customerName: personName, invoiceCount: count, overdueInvoiceCount: count,
      debtTotal: amount, overdueTotal: amount, oldestDueDate: nullable(date), maxOverdueDays: nullable(count), months: nullable(longText(200)) },
    summary: { rooms: count, invoices: count, debtTotal: amount, overdueRooms: count, overdueInvoices: count, overdueTotal: amount,
      minOverdueDays: nullable(count) } }),
  invoice_reminders: w2Report({ permission: 'invoices.view', source: 'crm.invoice_open_debts_v1', scope: 'rows',
    title: 'Soạn tin nhắc nợ theo phòng (người dùng tự bấm gửi): messageText chép nguyên văn (đã kèm link), tổng nợ thực gộp sẵn; publicLink = link tra hoá đơn công khai, gửi nguyên văn; null ⇒ không có link, không tự ghép tên miền (chỉ khi được xem khách). days = chỉ phòng quá hạn ≥ N ngày.',
    params: ['buildingId', 'roomId', 'days'], scopeKeys: CUSTOMER, private: true,
    fields: { buildingId: id, buildingName, roomId: nullable(id), roomName, customerName: personName, debtTotal: amount, invoiceCount: count,
      oldestDueDate: nullable(date), maxOverdueDays: nullable(count), details: longText(600), publicPath: nullable(longText(60)),
      messageText: longText(1000) },
    summary: { rooms: count, debtTotal: amount, withLink: count } }),
});
