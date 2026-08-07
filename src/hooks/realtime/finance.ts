import type { SyncEntry } from "./types";

/**
 * Descriptor realtime của miền TIỀN: hoá đơn, phiếu thu chi, khoản thu, hạng mục,
 * sổ quỹ, bàn giao.
 *
 * LƯU Ý BẢO TRÌ (giữ nguyên từ hub cũ, vì nó vẫn đúng và vẫn là cái bẫy chính):
 * invalidate khớp theo PREFIX mảng — key cùng phần tử đầu được phủ sẵn (vd
 * ["income-expenses","stats",…]). Nhưng màn nào đọc các bảng này bằng key CÓ PHẦN
 * TỬ ĐẦU KHÁC thì PHẢI liệt kê tường minh ở đây, nếu không nó kẹt dữ liệu cũ khi
 * thay đổi đến từ client khác. Thêm màn/hook mới đọc các bảng này ⇒ bổ sung key.
 */
export const FINANCE_SYNC_ENTRIES: readonly SyncEntry[] = [
  {
    table: "invoices",
    keys: [
      ["invoices"],
      ["invoice"], // chi tiết 1 hoá đơn (số ít ≠ "invoices")
      ["invoices-legacy"],
      ["invoice-statistics"],
      ["invoice-totals-by-ids"],
      ["first-invoice-details"],
      ["invoice-rent-periods"],
      ["invoice-collectors"], // quy công thu (đọc invoices + income_expenses)
      ["unpaid-invoices"],
      ["dashboard-alerts"],
      ["recent-activities"],
      ["dashboard-summary"],
      ["business-performance"],
    ],
    domain: "invoices",
  },
  {
    table: "income_expenses",
    keys: [
      ["income-expenses"],
      ["deposit-dashboard"],
      ["reservation-deposits"],
      ["dashboard-summary"],
      // --- màn nghiệp vụ đọc income_expenses bằng key riêng (Nhóm A) ---
      ["utility-payments"], // "Đóng điện nước" — trạng thái đã đóng
      ["utility-accounts"],
      ["accounts-with-balance"], // số dư sổ quỹ
      ["cash-book"],
      ["cash-book-summary"],
      ["cash-flow-by-day"],
      ["handover-vouchers"], // bàn giao tiền
      ["invoice-collectors"], // quy công thu
      ["manager-salary"], // bảng lương quản lý
      ["voucher-with-batch"], // chi tiết phiếu
      ["orphan-deposit-vouchers"],
      ["contract-deposit-vouchers"],
      ["shareholder-distributions"],
      ["manager-salary-payouts"],
      ["change-breakdown"], // sổ thối
      ["commission-prefill"],
      ["business-performance"],
      // --- Đợt 2→6: màn đọc phiếu bằng key riêng, trước đây bỏ sót ---
      ["settlement-report"],
      ["financial-analysis"],
      ["monthly-building-profit"],
      ["income-expense-batches"],
      ["voucher-detail"],
      ["voucher-cancellation"],
      ["voucher-change-log"],
      ["ie-history"],
      ["flex-cancel-eligibility"],
      ["can-reverse-collection"],
    ],
    domain: "income-expenses",
  },

  // ── Ba bảng TIỀN mà plan (Rủi ro #5) nêu là thiếu hẳn ─────────────
  // payments: hoàn tác thu tiền đổi payments.reversed_at, và
  // recompute_invoice_for_id tính paid_amount TỪ bảng này chứ không từ phiếu.
  {
    table: "payments",
    keys: [
      ["invoice-payments-summary"],
      ["invoices"],
      ["payments"],
      ["invoice-statistics"],
      ["invoice-collectors"],
      ["can-reverse-collection"],
      ["settlement-report"],
    ],
  },
  // income_expense_items: sửa hạng mục đổi total_amount của phiếu qua trigger,
  // tức đổi luôn tồn quỹ — mà trước đây không phát tín hiệu nào.
  {
    table: "income_expense_items",
    keys: [
      ["income-expenses"],
      ["voucher-with-batch"],
      ["voucher-detail"],
      ["accounts-with-balance"],
      ["cash-book-summary"],
      ["financial-analysis"],
    ],
  },
  // accounts: chốt sổ đặt lock_date, đổi số dư đầu, đổi người phụ trách.
  {
    table: "accounts",
    keys: [
      ["accounts"],
      ["accounts-with-balance"],
      ["cashbook-closings"],
      ["cashbook-closing-blockers"],
      ["cashbook-balance-as-of"],
      ["cash-book-summary"],
    ],
  },
  // cash_handovers: phiên bàn giao đổi trạng thái là hai bên phải thấy ngay.
  {
    table: "cash_handovers",
    keys: [
      ["cash-handovers"],
      ["handover-vouchers"],
      ["settlement-report"],
      ["cashbook-closing-blockers"],
    ],
  },
];
