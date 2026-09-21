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
    table: 'income_expense_supplements',
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'], ['income-expense-supplements'], ['income-expenses'], ['income-expense-batches'],
      ['voucher-with-batch'], ['income-expense'], ['reservation-refund-evidence'], ['ie-history'], ['voucher-change-log']],
    domain: 'income-expenses',
  },
  {
    table: "invoices",
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'],
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
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'],
      ["reservation-refund-evidence"],
      ["reservation-settlement-audit"],
      ["income-expenses"],
      ["deposit-dashboard"],
      ["reservation-deposits"],
      ["reservation-settlements"],
      ["reservation-settlement-summary"],
      ["reservation-settlement-preview"],
      ["reservation-settlement-by-voucher"],
      ["dashboard-summary"],
      // --- màn nghiệp vụ đọc income_expenses bằng key riêng (Nhóm A) ---
      ["utility-payments"], // "Đóng điện nước" — trạng thái đã đóng
      ["utility-accounts"],
      ["accounts-with-balance"], // số dư sổ quỹ
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
      // GỠ 15/09/2026 — ở đây từng có key prefill của modal hoa hồng. Nó KHÔNG
      // đọc income_expenses (chỉ contracts/rooms/buildings/customers), nên gắn
      // vào đây vừa thừa vừa có hại: create_contract_v2 ghi phiếu cọc vào bảng
      // này, hub debounce 0,8–2,4 s rồi invalidate — đúng lúc người dùng đang gõ
      // trong modal vừa mở. Prefill trả object mới ⇒ form reset sạch, và nếu cú
      // refetch đó lỗi thì modal kẹt luôn ở "Đang tải thông tin hợp đồng...".
      // Prefill là ẢNH CHỤP hợp đồng vừa tạo, không phải dữ liệu cần live.
      ["business-performance"],
      // --- Đợt 2→6: màn đọc phiếu bằng key riêng, trước đây bỏ sót ---
      ["settlement-report"],
      ["financial-analysis"],
      ["monthly-building-profit"],
      ["income-expense-batches"],
      ["voucher-cancellation"],
      ["voucher-change-log"],
      ["ie-history"],
      ["flex-cancel-eligibility"],
      ["can-reverse-collection"],
      // --- 28/08 (C-INFRA-7): bốn khoá của /thanh-toan đọc phiếu theo kỳ.
      // usePeriodFees tự invalidate sau mutation CỦA MÌNH (:167-174), nhưng
      // phiếu do MÁY KHÁC tạo/duyệt thì chỉ đường realtime này gọi tới —
      // thiếu chúng là ô phí kẹt "chưa đóng" tới khi F5.
      ["period-fee-status"],
      ["period-maintenance"],
      ["fee-accounts"],
      // Sổ Cọc đã thu còn dùng reader cũ; ba khoản quyết toán đã dùng các key
      // contract-settlement ở đầu descriptor.
      ["tt-deposit-ledger"],
      ["utility-chart"],
    ],
    domain: "income-expenses",
  },

  {
    table: "reservation_deposit_settlements",
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'],
      ["reservation-refund-evidence"],
      ["reservation-settlement-audit"],
      ["voucher-with-batch"],
      ["reservation-settlements"],
      ["reservation-settlement-summary"],
      ["reservation-settlement-preview"],
      ["reservation-settlement-by-voucher"],
      ["reservation-deposits"],
      ["orphan-deposit-vouchers"],
      ["deposit-dashboard"],
      ["rooms"],
      ["phong-trong"],
      ["contracts"],
      ["ie-history"],
      ["voucher-change-log"],
    ],
    domain: "income-expenses",
  },

  // ── Ba bảng TIỀN mà plan (Rủi ro #5) nêu là thiếu hẳn ─────────────
  // payments: hoàn tác thu tiền đổi payments.reversed_at, và
  // recompute_invoice_for_id tính paid_amount TỪ bảng này chứ không từ phiếu.
  {
    table: "payments",
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'],
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
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'],
      ["income-expenses"],
      ["voucher-with-batch"],
      ["accounts-with-balance"],
      ["cash-book-summary"],
      ["financial-analysis"],
    ],
  },
  // accounts: chốt sổ đặt lock_date, đổi số dư đầu, đổi người phụ trách.
  {
    table: "accounts",
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'], ['income-expense-posting-cashbooks'],
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
    keys: [['income-expense-action-snapshots'], ['income-expense-action-cancellation'], ['contract-settlement'], ['contract-settlement-events'], ['room-cash-lifecycle'], ['income-expense-posting-cashbooks'],
      ["cash-handovers"],
      ["handover-vouchers"],
      ["settlement-report"],
      ["cashbook-closing-blockers"],
    ],
  },

  // ── 28/08 (C-INFRA-7): hai bảng CẤU HÌNH PHÍ THEO TOÀ ─────────────
  // building_fee_accounts: mã NCC + số dự kiến + cờ "Không áp dụng" của từng ô
  // phí /thanh-toan (useFeeAccounts đọc thẳng bảng, key ['fee-accounts']).
  {
    table: "building_fee_accounts",
    keys: [
      ["fee-accounts"],
      ["period-fee-status"], // trạng thái ô suy từ cấu hình + phiếu
    ],
  },
  // building_utility_accounts: sổ điện/nước theo toà — "Đóng điện nước" đọc.
  {
    table: "building_utility_accounts",
    keys: [
      ["utility-accounts"],
      ["utility-payments"],
    ],
  },
];
