import type { SyncEntry } from "./types";

/** Mỗi tên là một prefix độc lập, không phải các phần của cùng một query key. */
function queryPrefixes(prefixes: readonly string[]): SyncEntry["keys"] {
  return prefixes.map((prefix) => [prefix]);
}

const reservationSettlementPrefixes = [
  "reservation-settlements",
  "reservation-settlement-summary",
  "reservation-settlement-preview",
  "reservation-settlement-by-voucher",
] as const;
const voucherDetailPrefixes = ["income-expense", "voucher-with-batch"] as const;
/** Màn chi tiết khác (HĐ, hoá đơn, chốt sổ, huỷ phiếu thu) đọc phiếu thu chi. */
const detailVoucherPrefixes = [
  "contract-pending-forfeit", // useContractDetailData — phiếu bỏ cọc chờ
  "contract-termination-info", // thẻ Quyết toán thanh lý (đọc cả phiếu hoàn)
  "invoice-vouchers", // InvoiceDetailView — phiếu của hoá đơn
  "cashbook-closing-blockers",
  "income-cancel-eligibility",
] as const;

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
    keys: queryPrefixes(['income-expense-supplements', 'income-expenses', 'income-expense-batches',
      'voucher-with-batch', 'income-expense', 'reservation-refund-evidence', 'ie-history', 'voucher-change-log']),
    domain: 'income-expenses',
  },
  {
    table: "invoices",
    keys: queryPrefixes([
      "invoices",
      "invoice", // chi tiết 1 hoá đơn (số ít ≠ "invoices")
      "invoices-legacy",
      "invoice-statistics",
      "invoice-totals-by-ids",
      "first-invoice-details",
      "invoice-rent-periods",
      "invoice-collectors", // quy công thu (đọc invoices + income_expenses)
      "unpaid-invoices",
      "dashboard-alerts",
      "recent-activities",
      "dashboard-summary",
      "business-performance",
      // --- 21/10/2026: màn đọc hoá đơn bằng key riêng, trước đây bỏ sót ---
      "room-detail-invoices", // RT-HUB-3: chi tiết phòng/toà, dialog phòng
      "building-detail-invoices",
      "room-latest-invoice",
      "ie-related-invoice", // RT-HUB-5: chi tiết phiếu hiện hoá đơn liên quan
      "income-cancel-eligibility",
      "revenue-chart", // RT-HUB-11: biểu đồ Dashboard
      "debt-chart",
      "reports", // báo cáo lịch thu, thừa tiền… — ["reports",…]
    ]),
    domain: "invoices",
  },
  {
    table: "income_expenses",
    keys: queryPrefixes([
      "company-wallets",
      "contract-commission-followups",
      "existing-commission-vouchers",
      "sale-bonus-status",
      "reservation-refund-evidence",
      "reservation-settlement-audit",
      "income-expenses",
      "deposit-dashboard",
      "reservation-deposits",
      ...reservationSettlementPrefixes,
      "dashboard-summary",
      // --- màn nghiệp vụ đọc income_expenses bằng key riêng (Nhóm A) ---
      "utility-payments", // "Đóng điện nước" — trạng thái đã đóng
      "utility-accounts",
      "accounts-with-balance", // số dư sổ quỹ
      "cash-book-summary",
      "cash-flow-by-day",
      "handover-vouchers", // bàn giao tiền
      "invoice-collectors", // quy công thu
      "manager-salary", // bảng lương quản lý
      ...voucherDetailPrefixes, // chi tiết phiếu
      "orphan-deposit-vouchers",
      "contract-deposit-vouchers",
      "shareholder-distributions",
      "manager-salary-payouts",
      "change-breakdown", // sổ thối
      // GỠ 15/09/2026 — ở đây từng có key prefill của modal hoa hồng. Nó KHÔNG
      // đọc income_expenses (chỉ contracts/rooms/buildings/customers), nên gắn
      // vào đây vừa thừa vừa có hại: create_contract_v2 ghi phiếu cọc vào bảng
      // này, hub debounce 0,8–2,4 s rồi invalidate — đúng lúc người dùng đang gõ
      // trong modal vừa mở. Prefill trả object mới ⇒ form reset sạch, và nếu cú
      // refetch đó lỗi thì modal kẹt luôn ở "Đang tải thông tin hợp đồng...".
      // Prefill là ẢNH CHỤP hợp đồng vừa tạo, không phải dữ liệu cần live.
      "business-performance",
      // --- Đợt 2→6: màn đọc phiếu bằng key riêng, trước đây bỏ sót ---
      "settlement-report",
      "financial-analysis",
      "monthly-building-profit",
      "income-expense-batches",
      "voucher-cancellation",
      "voucher-change-log",
      "ie-history",
      "flex-cancel-eligibility",
      "can-reverse-collection",
      // --- 28/08 (C-INFRA-7): các khoá của /thanh-toan đọc phiếu theo kỳ.
      // usePeriodFees tự invalidate sau mutation CỦA MÌNH (:167-174), nhưng
      // phiếu do MÁY KHÁC tạo/duyệt thì chỉ đường realtime này gọi tới —
      // thiếu chúng là ô phí kẹt "chưa đóng" tới khi F5.
      "period-fee-status",
      "period-maintenance",
      "fee-accounts",
      // --- 31/08 (audit P2-01): sổ theo dõi của SettlementPanels
      // (useThanhToanLedgers) + biểu đồ Điện & Nước — máy khác tạo/duyệt/huỷ
      // phiếu thì các màn này giữ số cũ tới khi đổi kỳ hoặc F5.
      // 23/09/2026: gỡ period-commissions, tt-termination-queue, tt-sale-bonus —
      // ba query đó đã xoá cùng hoa hồng/chi thanh lý/thưởng Sale cũ của trang.
      "tt-deposit-ledger",
      "utility-chart",
      // --- 21/10/2026 (RT-HUB-5): chi tiết HĐ, chi tiết hoá đơn, chặn chốt sổ
      // đọc phiếu bằng key riêng. Máy khác duyệt/huỷ/vào sổ phiếu hoàn hay phiếu
      // thu gắn hoá đơn thì các thẻ này giữ số cũ tới F5.
      ...detailVoucherPrefixes,
      "revenue-chart", // RT-HUB-11
      "reports",
      // RT-HUB-4: hộp duyệt. Chỉ phủ lúc NỘP và bước duyệt CUỐI (hai lúc đó mới
      // ghi income_expenses); từ chối / duyệt bước giữa chỉ ghi
      // approval_request_steps — bảng đó KHÔNG publish được (không có policy
      // SELECT nào cho authenticated, xem migration realtime_publication_toi_uu),
      // nên usePendingApprovals tự poll 60s + làm tươi khi focus.
      "pending-approvals",
    ]),
    domain: "income-expenses",
  },

  {
    table: "reservation_deposit_settlements",
    keys: queryPrefixes([
      "reservation-refund-evidence",
      "reservation-settlement-audit",
      ...voucherDetailPrefixes,
      ...reservationSettlementPrefixes,
      "reservation-deposits",
      "orphan-deposit-vouchers",
      "deposit-dashboard",
      "rooms",
      "phong-trong",
      "contracts",
      "ie-history",
      "voucher-change-log",
    ]),
    domain: "income-expenses",
  },

  // ── Ba bảng TIỀN mà plan (Rủi ro #5) nêu là thiếu hẳn ─────────────
  // payments: hoàn tác thu tiền đổi payments.reversed_at, và
  // recompute_invoice_for_id tính paid_amount TỪ bảng này chứ không từ phiếu.
  {
    table: "payments",
    keys: queryPrefixes([
      "invoice-payments-summary",
      "invoices",
      "payments",
      "invoice-statistics",
      "invoice-collectors",
      "can-reverse-collection",
      "settlement-report",
      "payments-summary", // RT-HUB-5: usePayments — tổng thu theo kỳ
    ]),
  },
  // income_expense_items: sửa hạng mục đổi total_amount của phiếu qua trigger,
  // tức đổi luôn tồn quỹ — mà trước đây không phát tín hiệu nào.
  {
    table: "income_expense_items",
    keys: queryPrefixes([
      "company-wallets",
      "income-expenses",
      "income-expense-batches",
      ...voucherDetailPrefixes,
      "accounts-with-balance",
      "cash-book-summary",
      "financial-analysis",
      ...detailVoucherPrefixes, // RT-HUB-5: sửa hạng mục đổi tổng phiếu
    ]),
  },
  // accounts: chốt sổ đặt lock_date, đổi số dư đầu, đổi người phụ trách.
  {
    table: "accounts",
    keys: queryPrefixes([
      "company-wallets",
      "accounts",
      "accounts-with-balance",
      "cashbook-closings",
      "cashbook-closing-blockers",
      "cashbook-balance-as-of",
      "cash-book-summary",
    ]),
  },
  // cash_handovers: phiên bàn giao đổi trạng thái là hai bên phải thấy ngay.
  {
    table: "cash_handovers",
    keys: queryPrefixes([
      "cash-handovers",
      "handover-vouchers",
      "settlement-report",
      "cashbook-closing-blockers",
    ]),
  },

  // ── 28/08 (C-INFRA-7): hai bảng CẤU HÌNH PHÍ THEO TOÀ ─────────────
  // building_fee_accounts: mã NCC + số dự kiến + cờ "Không áp dụng" của từng ô
  // phí /thanh-toan (useFeeAccounts đọc thẳng bảng, key ['fee-accounts']).
  {
    table: "building_fee_accounts",
    keys: queryPrefixes([
      "fee-accounts",
      "period-fee-status", // trạng thái ô suy từ cấu hình + phiếu
    ]),
  },
  // building_utility_accounts: sổ điện/nước theo toà — "Đóng điện nước" đọc.
  {
    table: "building_utility_accounts",
    keys: queryPrefixes([
      "utility-accounts",
      "utility-payments",
    ]),
  },
];
