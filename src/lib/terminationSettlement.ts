/**
 * Phép toán quyết toán thanh lý "Khách rời phòng" — bản thuần, không phụ thuộc
 * React hay Supabase, để cả giao diện lẫn test đo đúng MỘT nguồn sự thật.
 *
 * Đây là bản sao TS của phần toán trong `public.terminate_contract_move_out_impl`.
 * Hai bản PHẢI khớp: màn hình xác nhận nói với người dùng con số nào thì server
 * phải ghi đúng con số đó, và thao tác này KHÔNG hoàn tác được.
 *
 * ─── RÀNG BUỘC KHÔNG ĐƯỢC PHÁ ────────────────────────────────────────────
 * `contract_terminations.refund_amount` là cột GENERATED ALWAYS:
 *
 *     refund_amount = total_deposit − (outstanding_debt + prorated_rent + …)
 *
 * và cơ chế "nghĩa vụ hoàn cọc" (preview_termination_refund_v1) đối chiếu chính
 * cột đó với cọc thật đang giữ để gắn cờ VUOT_COC_THAT. Nên `refundDeposit`
 * phải LUÔN bằng max(deposit − charges, 0) và KHÔNG được phụ thuộc vào khoản
 * "Hoàn lại khách". Vì thế khoản hoàn chỉ được cấn vào phần công nợ CÒN LẠI sau
 * khi cọc và credit đã cấn xong — xem `chargesLeft`.
 */

/** Làm tròn về 2 số lẻ, khớp numeric(15,2) bên Postgres. */
function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

const atLeastZero = (value: number): number => Math.max(money(value), 0);

export interface TerminationSettlementInput {
  /** Cọc THỰC THU — trần cứng của số hoàn cọc (server kẹp LEAST). */
  depositPaid: number;
  /** Số hoàn cọc người dùng nhập. */
  depositRefundRequested: number;
  /** Credit khách đang có, phần được áp vào quyết toán. */
  excessRent?: number;
  /** Công nợ từ các hoá đơn chưa thu. */
  outstandingDebt?: number;
  /** Phí phạt thanh lý. */
  penaltyFee?: number;
  /** Tổng mục "Thu thêm" — khách phải trả thêm. */
  extraChargesTotal?: number;
  /** Tổng mục "Hoàn lại khách" — mình trả lại khách (tiền phòng ngày không ở…). */
  customerRefundTotal?: number;
}

export interface TerminationSettlement {
  /** Cọc sau khi kẹp bởi cọc thực thu. */
  deposit: number;
  /** Tổng khách nợ mình = công nợ + phạt + thu thêm. */
  charges: number;
  /** Tổng mình nợ khách. */
  owed: number;
  /** Cọc bị cấn vào khấu trừ (thành doanh thu thanh lý). */
  appliedDeposit: number;
  /** Cọc còn dư → hoàn khách. NGOÀI KQKD. */
  refundDeposit: number;
  /** Credit còn dư → hoàn khách. */
  refundExcess: number;
  /** Công nợ còn lại sau khi cọc + credit đã cấn. */
  chargesLeft: number;
  /** Phần "Hoàn lại khách" bị cấn vào công nợ còn lại (không ra tiền mặt). */
  owedApplied: number;
  /** Phần "Hoàn lại khách" chi ra tiền thật. VÀO KQKD. */
  refundOwed: number;
  /** Tổng nguồn đã cấn vào khấu trừ (dùng cho ngân sách gạch nợ chế độ DEBT). */
  applied: number;
  /** Số quyết toán ròng: dương = trả khách, âm = khách trả thêm. */
  net: number;
  /** Tổng tiền thật chi ra cho khách (một phiếu chi duy nhất). */
  totalRefund: number;
  /** Số khách phải trả thêm (0 nếu không). */
  shortfall: number;
}

export function computeTerminationSettlement(
  input: TerminationSettlementInput,
): TerminationSettlement {
  const depositPaid = atLeastZero(input.depositPaid);
  const deposit = money(
    Math.min(atLeastZero(input.depositRefundRequested), depositPaid),
  );
  const excess = atLeastZero(input.excessRent ?? 0);
  const debt = atLeastZero(input.outstandingDebt ?? 0);
  const penalty = atLeastZero(input.penaltyFee ?? 0);
  const extra = atLeastZero(input.extraChargesTotal ?? 0);
  const owed = atLeastZero(input.customerRefundTotal ?? 0);

  const charges = money(debt + penalty + extra);

  // ── Ba dòng dưới GIỮ NGUYÊN so với trước khi có "Hoàn lại khách". ────────
  // Đụng vào chúng là phá thế khớp giữa refund_amount (cột generated) và phiếu
  // hoàn cọc thật ⇒ nghĩa vụ hoàn cọc báo sai.
  const appliedDeposit = money(Math.min(deposit, charges));
  const refundDeposit = money(deposit - appliedDeposit);
  const refundExcess = money(
    excess - Math.min(excess, Math.max(money(charges - deposit), 0)),
  );

  // ── Khoản hoàn chỉ cấn vào phần công nợ CÒN LẠI. ─────────────────────────
  const chargesLeft = Math.max(money(charges - deposit - excess), 0);
  const owedApplied = money(Math.min(owed, chargesLeft));
  const refundOwed = money(owed - owedApplied);

  const applied = money(Math.min(deposit + excess + owed, charges));
  const net = money(deposit + excess + owed - charges);

  return {
    deposit,
    charges,
    owed,
    appliedDeposit,
    refundDeposit,
    refundExcess,
    chargesLeft,
    owedApplied,
    refundOwed,
    applied,
    net,
    totalRefund: money(refundDeposit + refundExcess + refundOwed),
    shortfall: Math.max(money(-net), 0),
  };
}
