// Gói B đợt 2 — Sổ quỹ, dòng tiền, kết quả kinh doanh, lợi nhuận cổ đông, ví cá nhân, biến động
// số dư. File của RIÊNG Gói B.
// Khai báo mỗi báo cáo bằng w2Report() (wave2-kit.mjs); mã báo cáo là khoá của object, khớp
// /^[a-z][a-z0-9_]{1,47}$/ và KHÔNG trùng mã của gói khác (wave2-registry.mjs kiểm khi nạp).
// SQL cùng gói: app_private.hermes_w2b_catalog_v1 (khớp từng trường với khai báo ở đây) và
// app_private.hermes_w2b_read_v1 — chỉ CREATE OR REPLACE trong migration 2026101802xxxx_hermes_w2b_*.sql.
// Gợi ý mã (kế hoạch khảo sát đợt 2, chưa ràng buộc): cashbook_daily, cash_flow, cashbooks,
// cashbook_closings, handover, collection_cycle, fa_type_breakdown, fa_snapshot_kpis, fa_occupancy,
// fa_lease_events, fa_invoice_collection, top_expenses, bp_pnl, bp_snapshot, bp_occupancy, bp_upcoming,
// bp_cohort, bp_cash_received, bp_categories, shareholder_profit, personal_wallet, bank_events.
// Ví dụ:
//   import { w2Report, id, nullable, longText, amount, date } from './wave2-kit.mjs';
//   export const W2B_REPORTS = Object.freeze({
//     cash_flow: w2Report({ permission: 'reports_finance.cash_flow', source: 'crm.cashflow_by_day', scope: 'buildings',
//       title: '<mô tả cho mô hình>', params: ['year', 'buildingId'], required: ['year'],
//       fields: { period: longText(20), income: amount, expense: amount, net: amount } }),
//   });
export const W2B_REPORTS = Object.freeze({});
