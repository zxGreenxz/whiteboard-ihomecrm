// Gói A đợt 2 — Thu tiền, công nợ, cọc. File của RIÊNG Gói A.
// Khai báo mỗi báo cáo bằng w2Report() (wave2-kit.mjs); mã báo cáo là khoá của object, khớp
// /^[a-z][a-z0-9_]{1,47}$/ và KHÔNG trùng mã của gói khác (wave2-registry.mjs kiểm khi nạp).
// SQL cùng gói: app_private.hermes_w2a_catalog_v1 (khớp từng trường với khai báo ở đây) và
// app_private.hermes_w2a_read_v1 — chỉ CREATE OR REPLACE trong migration 2026101801xxxx_hermes_w2a_*.sql.
// Gợi ý mã (kế hoạch khảo sát đợt 2, chưa ràng buộc): payment_schedule, overpayment, deposits_report,
// collection, invoice_detail, reservation_vouchers, reservation_settlements, reservation_refunds,
// held_contracts, change_ledger.
// Ví dụ:
//   import { w2Report, id, nullable, longText, amount, date } from './wave2-kit.mjs';
//   export const W2A_REPORTS = Object.freeze({
//     payment_schedule: w2Report({ permission: 'reports_finance.payment_schedule', source: 'crm.invoices', scope: 'rows',
//       title: '<mô tả cho mô hình>', params: ['fromDate', 'toDate', 'buildingId', 'query'],
//       fields: { invoiceId: id, buildingId: id, buildingName: nullable(longText(200)), dueDate: nullable(date), total: amount } }),
//   });
export const W2A_REPORTS = Object.freeze({});
