// Gói B đợt 2 — Sổ quỹ, dòng tiền, kết quả kinh doanh, lợi nhuận cổ đông, ví cá nhân, biến động
// số dư. File của RIÊNG Gói B. SQL cùng gói: app_private.hermes_w2b_catalog_v1 (khớp từng trường với
// khai báo ở đây, test wave2-b.test.mjs so khớp) và app_private.hermes_w2b_read_v1 — migration
// 20261018020200_hermes_w2b_finance_read_v1.sql (hàm dùng chung, áp trước: 20261018020050_hermes_w2b_finance_shared_v1.sql);
// sửa sau review PR #208 (thay bản định nghĩa, áp sau hai file trên): 20261018020250_hermes_w2b_finance_shared_fixes_v1.sql (top
// khoản chi _v2, isManager tổng quan cổ đông, report_text_v1, cờ hạn chế theo công ty) rồi 20261018020300_hermes_w2b_finance_read_fixes_v1.sql (ví).
// Mọi báo cáo của gói là private=true (số liệu tài chính nội bộ: chỉ trả lời riêng người hỏi, không đăng vào nhóm — PRIVATE_HINT).
// Q4 (siết khoá lãi lỗ tháng crm_read_monthly_pnl của đợt 1) KHÔNG ở gói này: phải phát hành cùng Gói Z bật khoá
// reports_finance.profit_distribution (bản soạn sẵn: 20261018090100_hermes_w2_monthly_pnl_keys_v1.sql ở commit 85ef7ed của
// nhánh claude/hermes-w2b-continued-828j1x; bản gốc 20261018020100_hermes_w2b_monthly_pnl_keys_v1.sql ở nhánh claude/hermes-w2b).
//
// Quyền mỗi báo cáo = khoá web của màn đó (SQL quyết định cuối, cổng hermes_w2_gate_v1); chỗ web hở
// thì Hermes chặt hơn:
//  - hạng mục/phiếu HẠN CHẾ (lương, cổ đông…) chỉ hiện khi quyền income_expenses.restricted_view (CRM ∩
//    Read của kết nối) phủ MỌI toà của báo cáo — web để fa_type_breakdown (SECURITY DEFINER) lộ tổng
//    hạng mục hạn chế cho mọi người có reports_finance.analysis;
//  - chốt sổ: chỉ sổ người hỏi nhìn thấy (web list_cashbook_closings_v1 trả chênh lệch MỌI sổ của
//    công ty cho mọi thành viên); sổ quỹ theo phạm vi cashbooks của cổng (Toàn tổ chức hoặc sổ CRM cấp);
//  - sổ quỹ chỉ của công ty kết nối (RPC web lọc my_org_ids() nên người nhiều công ty bị trộn).
import { w2Report, id, nullable, longText, code, amount, bool, count, date, instant } from './wave2-kit.mjs';

const name = nullable(longText(200));
const money = amount;
const side = value => value === 'INCOME' || value === 'EXPENSE';
const year = value => Number.isInteger(value) && value >= 2000 && value <= 2100;
const RESTRICTED = 'income_expenses.restricted_view';
const BREAKDOWN = Object.freeze({ buildingId: nullable(id), month: date, side, typeId: nullable(id), typeName: name, category: nullable(longText(100)), totalAmount: money, voucherCount: count });

export const W2B_REPORTS = Object.freeze({
  // B1 — /reports/finance/daily-cashbook (DailyCashbookReport.tsx; useCashBook.ts:42,72,114).
  cashbook_daily: w2Report({ permission: 'reports_finance.daily_cashbook', source: 'crm.cashbook_daily_v1', scope: 'buildings', private: true,
    title: 'Sổ quỹ theo ngày: tồn đầu, thu, chi, tồn cuối từng ngày (mặc định đầu tháng → hôm nay), mọi sổ xem được hoặc một sổ (cashbookId). buildingId=null: hàng tổng hợp toàn công ty, chỉ khi kết nối Toàn tổ chức; không thì từng toà.',
    params: ['fromDate', 'toDate', 'cashbookId', 'buildingId'],
    fields: { buildingId: nullable(id), date, opening: money, income: money, expense: money, closing: money },
    summary: { fromDate: date, toDate: date, cashbookId: nullable(id), openingBalance: money, totalIncome: money, totalExpense: money, closingBalance: money } }),
  // B2 — /reports/finance/cash-flow (CashFlowReport.tsx:38-75): cashflow_by_day cả năm, gộp tháng/quý.
  cash_flow: w2Report({ permission: 'reports_finance.cash_flow', source: 'crm.cashbook_cash_flow_v1', scope: 'buildings', private: true,
    title: 'Dòng tiền năm (mặc định năm nay): thu, chi, ròng từng tháng (YYYY-MM) và quý (YYYY-Q1..Q4) trên mọi sổ xem được. buildingId=null: hàng tổng hợp toàn công ty, chỉ khi kết nối Toàn tổ chức; không thì từng toà.',
    params: ['year', 'buildingId'],
    fields: { buildingId: nullable(id), period: longText(10), income: money, expense: money, net: money },
    summary: { year, income: money, expense: money, net: money } }),
  // B3 — /finance/cashbooks (CashbooksPage.tsx; useAccounts.ts:115-202): không trả số tài khoản/ngân hàng.
  cashbooks: w2Report({ permission: 'cashbooks.view', source: 'crm.cashbook_list_v1', scope: 'cashbooks', private: true,
    title: 'Danh sách sổ quỹ người hỏi xem được: mã, tên, người phụ trách, sổ ảo; số dư đầu kỳ và tồn quỹ chỉ khi balanceVisible (như web). Không có số tài khoản. query: tên/mã sổ.',
    params: ['query'],
    fields: { cashbookId: id, code: nullable(longText(50)), name, ownerName: name, isVirtual: bool, balanceVisible: bool,
      initialAmount: nullable(money), currentAmount: nullable(money), note: nullable(longText(300)) } }),
  // B4 — /finance/cashbooks/closure/:id (CashbookClosureRecord.tsx:126-132) + đề nghị chốt chờ xác nhận.
  cashbook_closings: w2Report({ permission: 'cashbooks.view', source: 'crm.cashbook_closings_v1', scope: 'cashbooks', private: true,
    title: 'Chốt sổ quỹ: biên bản đã chốt (CONFIRMED) và đề nghị chờ xác nhận (PENDING) của các sổ người hỏi xem được: ngày chốt, tồn hệ thống, tiền đếm, chênh lệch, người đề nghị/xác nhận.',
    params: ['cashbookId', 'status'], statuses: ['PENDING', 'CONFIRMED'],
    fields: { state: code, closureId: nullable(count), requestId: nullable(id), cashbookId: id, cashbookName: name, closedThrough: date,
      countedBalance: money, systemBalance: money, difference: money, basis: nullable(longText(60)), proposedByName: name, confirmerName: name,
      confirmedAt: nullable(instant), createdAt: nullable(instant), mineToConfirm: bool, note: nullable(longText(300)) } }),

  // B7 — /reports/finance/analysis (useFinancialAnalysis.ts; ExpenseTab.tsx:61-83).
  fa_type_breakdown: w2Report({ permission: 'reports_finance.analysis', source: 'crm.finance_analysis_type_breakdown_v1', scope: 'buildings', private: true, scopeKeys: [RESTRICTED],
    title: 'Phân tích tài chính — thu/chi theo hạng mục từng tháng, fromDate..toDate, basis accrual (mặc định)|cash. buildingId=null: hàng tổng hợp toàn công ty, chỉ khi kết nối Toàn tổ chức; không thì từng toà. Hạng mục hạn chế chỉ khi restrictedIncluded=true; cash: ẩn cả hạng mục thường có hạn chế gộp vào.',
    params: ['fromDate', 'toDate', 'basis', 'buildingId'], required: ['fromDate', 'toDate'],
    fields: BREAKDOWN, summary: { basis: value => value === 'accrual' || value === 'cash', restrictedIncluded: bool } }),
  fa_snapshot_kpis: w2Report({ permission: 'reports_finance.analysis', source: 'crm.fa_snapshot_kpis', scope: 'rows', private: true,
    title: 'Phân tích tài chính — ảnh chụp từng toà hôm nay: phòng theo trạng thái, thất thu phòng trống, HĐ hiệu lực, giá thuê TB, cọc đang giữ, công nợ và tuổi nợ.',
    params: ['buildingId'],
    fields: { buildingId: id, buildingName: name, totalRooms: count, roomsAvailable: count, roomsOccupied: count, roomsReserved: count,
      roomsMaintenance: count, roomsUnavailable: count, vacancyLossMonth: money, activeContracts: count, avgRent: money, depositHeld: money,
      receivableTotal: money, agingNotDue: money, aging1To30: money, aging31To60: money, aging61To90: money, agingOver90: money } }),
  fa_occupancy_monthly: w2Report({ permission: 'reports_finance.analysis', source: 'crm.fa_occupancy_monthly', scope: 'rows', private: true,
    title: 'Phân tích tài chính — lấp đầy theo tháng từng toà (phòng có HĐ giao tháng / tổng phòng), fromDate..toDate.',
    params: ['fromDate', 'toDate', 'buildingId'], required: ['fromDate', 'toDate'],
    fields: { month: date, buildingId: id, buildingName: name, totalRooms: count, occupiedRooms: count, occupancyPct: money } }),
  fa_lease_events: w2Report({ permission: 'reports_finance.analysis', source: 'crm.fa_lease_events', scope: 'rows', private: true,
    title: 'Phân tích tài chính — HĐ ký mới, gia hạn, thanh lý theo tháng từng toà, fromDate..toDate (chỉ tháng có sự kiện).',
    params: ['fromDate', 'toDate', 'buildingId'], required: ['fromDate', 'toDate'],
    fields: { month: date, buildingId: id, buildingName: name, newContracts: count, renewals: count, terminations: count } }),
  fa_invoice_collection: w2Report({ permission: 'reports_finance.analysis', source: 'crm.fa_invoice_collection', scope: 'rows', private: true,
    title: 'Phân tích tài chính — thu hồi hoá đơn theo kỳ (billingMonth) từng toà, các kỳ từ tháng của fromDate đến tháng của toDate: phát hành, đã thu, còn nợ, số HĐ theo trạng thái.',
    params: ['fromDate', 'toDate', 'buildingId'], required: ['fromDate', 'toDate'],
    fields: { billingMonth: longText(7), buildingId: id, buildingName: name, billed: money, collected: money, remaining: money, invoiceCount: count,
      draftCount: count, pendingCount: count, approvedCount: count, paidCount: count, partialCount: count, overdueCount: count } }),
  top_expenses: w2Report({ permission: 'reports_finance.analysis', source: 'crm.finance_analysis_top_expenses_v1', scope: 'rows', private: true, scopeKeys: [RESTRICTED],
    title: 'Phân tích tài chính — 10 khoản chi KQKD đã duyệt lớn nhất của tháng month: ngày, mã, tên phiếu, toà, hạng mục, số tiền.',
    params: ['month', 'buildingId'], required: ['month'],
    fields: { voucherId: id, voucherDate: date, code: nullable(longText(60)), name, buildingId: id, buildingName: name,
      itemTypes: nullable(longText(300)), totalAmount: money } }),

  // B8 — /reports/finance/business-performance (useBusinessPerformance.ts:897-1229; useBusinessPerformanceGatedData.ts).
  bp_pnl: w2Report({ permission: 'reports_finance.analysis', source: 'crm.business_performance_pnl_v1', scope: 'rows', private: true, scopeKeys: [RESTRICTED],
    title: 'Hiệu quả kinh doanh — lãi lỗ từng tháng từng toà thật, fromDate..toDate; basis accrual (mặc định) hoặc cash. Cần quyền xem phiếu hạn chế ở mọi toà của báo cáo.',
    params: ['fromDate', 'toDate', 'basis', 'buildingId'], required: ['fromDate', 'toDate'],
    fields: { month: date, buildingId: id, buildingName: name, revenue: money, expense: money, net: money } }),
  bp_cohort: w2Report({ permission: 'reports_finance.analysis', source: 'crm.business_performance_invoice_cohort_v1', scope: 'rows', private: true, scopeKeys: [RESTRICTED],
    title: 'Hiệu quả kinh doanh — thu hồi hoá đơn kỳ month từng toà: phí kỳ đã phát hành/đã thu/còn lại, tỷ lệ thu, nợ mang sang, cọc, nháp chờ duyệt, quyết toán.',
    params: ['month', 'buildingId'], required: ['month'],
    fields: { buildingId: id, buildingName: name, cohortMonth: date, cohortAvailable: bool, billed: money, collected: money, remaining: money,
      collectionRatePct: nullable(money), invoiceCount: count, carriedInvoiceDebt: money, carriedDepositDebt: money, currentDeposit: money,
      draftPendingCount: count, draftPendingAmount: money, settlementCount: count, settlementAmount: money } }),
  bp_cash_received: w2Report({ permission: 'reports_finance.analysis', source: 'crm.business_performance_cash_received_v1', scope: 'rows', private: true, scopeKeys: [RESTRICTED],
    title: 'Hiệu quả kinh doanh — tiền thực thu trong tháng month từng toà: số tiền, số lần thu, ngày thu đầu/cuối.',
    params: ['month', 'buildingId'], required: ['month'],
    fields: { buildingId: id, buildingName: name, cashMonth: date, cashReceived: money, paymentEventCount: count,
      firstPaymentDate: nullable(date), lastPaymentDate: nullable(date) } }),
  bp_categories: w2Report({ permission: 'reports_finance.analysis', source: 'crm.business_performance_category_breakdown_v1', scope: 'buildings', private: true, scopeKeys: [RESTRICTED],
    title: 'Hiệu quả kinh doanh — cơ cấu thu/chi theo hạng mục từng tháng của từng toà thật, fromDate..toDate; basis accrual (mặc định) hoặc cash.',
    params: ['fromDate', 'toDate', 'basis', 'buildingId'], required: ['fromDate', 'toDate'],
    fields: BREAKDOWN }),

  // B10 — /reports/finance/profit-distribution: tab cổ đông tự xem (ShareholderSelfView.tsx) và tổng quan quản lý (ProfitOverviewTab.tsx).
  profit_my_share: w2Report({ permission: 'reports_finance.profit_distribution', source: 'crm.profit_my_share_v1', scope: 'rows', private: true,
    title: 'Lợi nhuận được chia của CHÍNH người hỏi nếu là cổ đông: từng kỳ chốt × toà (tỷ lệ, số tiền); summary luỹ kế được chia, đã ứng, còn lại. year lọc hàng.',
    params: ['year', 'buildingId'],
    fields: { periodMonth: date, buildingId: id, buildingName: name, status: code, percent: money, amount: money },
    summary: { isShareholder: bool, shareholderName: name, accrued: money, paid: money, remaining: money, allocations: count, payouts: count } }),
  profit_shareholders: w2Report({ permission: 'shareholder_profit.view', source: 'crm.profit_shareholder_summary_v1', scope: 'organization', private: true,
    title: 'Chia lợi nhuận cổ đông (quản lý): từng cổ đông được chia luỹ kế, đã ứng, còn lại, được chia trong year; summary tổng LN đã chốt và tổng các cột.',
    params: ['year'],
    fields: { shareholderId: id, name, accrued: money, paid: money, remaining: money, yearAccrued: nullable(money) },
    summary: { lockedProfit: money, accrued: money, paid: money, remaining: money } }),

  // B12 — /finance/personal-wallet (PersonalWalletPage.tsx; personal_finance_snapshot): chỉ của CHÍNH người hỏi.
  personal_wallets: w2Report({ permission: 'personal_finance.view', source: 'crm.personal_finance_snapshot', scope: 'self', private: true,
    title: 'Ví cá nhân của CHÍNH người hỏi: từng ví (loại, số dư đầu, số dư hiện tại, ẩn, mặc định); summary tổng số dư mọi ví, kể cả ví ẩn (như trang Ví cá nhân).',
    fields: { walletId: id, name, kind: code, openingBalance: money, balance: money, isDefault: bool, hidden: bool },
    summary: { totalBalance: money, wallets: count } }),
  personal_transactions: w2Report({ permission: 'personal_finance.view', source: 'crm.personal_finance_snapshot', scope: 'self', private: true,
    title: 'Giao dịch ví cá nhân của CHÍNH người hỏi, mới trước: ngày, thu/chi, số tiền, mô tả, danh mục, ví; lọc fromDate..toDate, kind, query (mô tả/danh mục).',
    params: ['fromDate', 'toDate', 'kind', 'query'], kinds: ['INCOME', 'EXPENSE'],
    fields: { transactionId: id, date, type: code, amount: money, description: nullable(longText(300)), categoryName: nullable(longText(100)), walletName: nullable(longText(100)) },
    summary: { income: money, expense: money, transactions: count } }),

  // B11 — /bien-dong-so-du (BankEventsPage.tsx, RequireSuperAdmin): chỉ siêu dữ liệu. Số tiền/số dư/nội dung chỉ
  // giải mã được ở Edge bank-event-admin (khoá AES ở secret Edge) ⇒ SQL không đọc được, Hermes không trả.
  bank_event_feed: w2Report({ permission: 'assistant.bank_events.read', source: 'crm.bank_event_admin_v1', scope: 'platform', private: true,
    title: 'Biến động số dư (chỉ super admin): tin ngân hàng mới nhất đã nhận (≤100): nguồn, loại, lúc xảy ra/nhận, số lần trùng; KHÔNG có số tiền/số dư/nội dung (chỉ xem trên web).',
    params: ['fromDate', 'toDate', 'kind'], kinds: ['sms', 'notification', 'email', 'test'],
    fields: { eventId: id, sourceName: name, eventType: longText(40), occurredAt: nullable(instant), receivedAt: instant, duplicateCount: count },
    summary: { totalSources: count, enabledSources: count, totalEvents: count, lastReceivedAt: nullable(instant), amountsAvailable: bool } }),
});
