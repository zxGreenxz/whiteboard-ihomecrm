// Phần LỢI NHUẬN trong bảng lương theo sổ tổng (Đợt 2 · D2.10) — hàm thuần, không gọi mạng.
//
// Nguồn số: E12 salary_profit_inputs_v1 (máy chủ tính Y_m, D_m, mốc "đã trả đủ", phiếu đã gắn).
// Hai luật của chủ (15/11/2026):
//   - Trừ tạm ứng lợi nhuận CHỈ trong phần lợi nhuận đầu tư của tháng (D_m máy chủ đã kẹp theo phần
//     đó; phần tạm ứng còn lại tự chuyển tháng sau) — lương cơ bản không bị đụng.
//   - Tháng nằm trong mốc "đã trả đủ": dòng đầu tư hiện "đã trả theo mốc", không trả lại — tổng lương
//     giữ nguyên, chỉ tiền thực chi giảm phần đó.
// Cả D lẫn phần đã trả theo mốc vào `advance` (⇒ advances_total khi chốt, salCalc trừ khỏi thực nhận):
// lock_salary_month_v2 (nhánh hỗ trợ tiền phòng) đòi take_home = gross − advances_total − room_rent −
// HH sổ thật, nên mọi khoản trừ ngoài HH sổ thật phải nằm trong advances_total.
// Nhân viên KHÔNG phải cổ đông: `profit = null`, không có dòng mới, không gọi E13/E15.

import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { salCalc, type SalAdvanceItem, type SalInvestBy, type SalManager, type SalProfitInfo } from '@/lib/managerSalary';
import { profitLedgerErrorMessage } from '@/lib/profitLedger/errors';
import type { SalaryFreezeResult, SalaryProfitStaff, SalaryQuoteResult } from '@/lib/profitLedger/salaryReaders';

/** Sai số so tiền (đồng): số máy chủ có 2 chữ số lẻ, cộng số thực JS có nhiễu rất nhỏ. */
const EPS = 0.005;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;
/** Bỏ nhiễu cộng số thực trước khi gửi máy chủ (máy chủ so `sel > Y_m` chặt). */
const round2 = (n: number): number => Math.round(n * 100) / 100;

const PROFIT_ADVANCE_LABEL = 'Trừ tạm ứng lợi nhuận';
const PROFIT_MARKER_LABEL = 'Lợi nhuận đã trả theo mốc';

/** "2026-09-01" → "09/2026". */
export function salaryMonthLabel(month: string | null): string | null {
  const m = month ? /^(\d{4})-(\d{2})/.exec(month) : null;
  return m ? `${m[2]}/${m[1]}` : null;
}

/** Dòng "Lợi nhuận đầu tư" theo toà: CHỈ toà đã chốt lợi nhuận, nhãn toà do máy chủ đặt. */
export function investmentByFromProfit(staff: SalaryProfitStaff | null | undefined): SalInvestBy[] {
  return (staff?.allocations ?? [])
    .filter((a) => a.status === 'LOCKED')
    .map((a) => ({ b: a.building_label, amount: a.amount }));
}

/**
 * Gắn phần lợi nhuận của sổ tổng vào một dòng lương (SAU applySalaryExtras — cần `investment` đã
 * áp ghi đè; TRƯỚC salCalc). Trả bản MỚI.
 *  - Bảng nháp: D = max(phần đã trừ, D_m) — không bao giờ nhỏ hơn phần đã trừ ở phiếu trước; tháng
 *    trong mốc ⇒ D = 0 và phần đầu tư dương (đã trả theo mốc) cũng thành khoản trừ.
 *  - Bảng đã chốt: thực nhận lấy số đóng băng; chỉ thêm dòng để hiển thị khớp `advances_total`. D =
 *    D của bản đóng băng khớp bảng (máy chủ trả 0 khi không khớp). Tháng trong mốc: phần đầu tư chỉ
 *    coi là đã trừ khi bảng chốt qua màn mới (bản đóng băng khớp) VÀ số ứng đã chốt có chỗ cho nó;
 *    không thì `relockForMarker` — trả lương bị chặn tới khi mở chốt rồi chốt lại.
 */
export function withSalaryProfit(m: SalManager, staff: SalaryProfitStaff | null | undefined): SalManager {
  if (!staff || staff.shareholder_id === null) return { ...m, profit: null };
  const locked = m.status === 'LOCKED';
  const settled = staff.settled_by_marker;
  let advanceOffset = 0;
  let markerPaid = 0;
  let relockForMarker = false;
  if (!locked) {
    advanceOffset = settled ? 0 : Math.max(staff.paid_offset, staff.suggested_advance_offset);
    markerPaid = settled ? Math.max(0, m.investment) : 0;
  } else {
    advanceOffset = settled ? 0 : staff.advance_offset_month;
    const fz = m.frozen;
    if (settled && fz && fz.investment > EPS) {
      // `m.advance` lúc này chỉ là ứng lương sống; phần còn lại của số ứng đã chốt là khoản trừ khác.
      const room = fz.advance - advanceOffset - m.advance;
      if (staff.settlement?.matches_sheet === true && room >= fz.investment - EPS) markerPaid = fz.investment;
      else relockForMarker = true;
    }
  }
  const advanceItems: SalAdvanceItem[] = [...m.advanceItems];
  if (advanceOffset !== 0) advanceItems.push({ date: '', label: PROFIT_ADVANCE_LABEL, amount: advanceOffset, kind: 'PROFIT_ADVANCE' });
  if (markerPaid !== 0) advanceItems.push({ date: '', label: PROFIT_MARKER_LABEL, amount: markerPaid, kind: 'PROFIT_MARKER' });
  const profit: SalProfitInfo = {
    sheetStatus: staff.sheet_status,
    investmentMonth: staff.investment_month,
    settledByMarker: settled,
    markerThrough: staff.marker_through,
    paidInvestment: staff.paid_investment,
    paidOffset: staff.paid_offset,
    advanceOffsetMonth: staff.advance_offset_month,
    offsetConflict: staff.offset_conflict,
    settlementMatches: staff.settlement?.matches_sheet === true,
    needsReviewCount: staff.needs_review.count,
    paidLines: staff.paid_lines.map((l) => ({
      lineId: l.line_id, voucherId: l.salary_voucher_id, voucherCode: l.voucher_code, voucherLive: l.voucher_live,
      investment: l.investment, advanceOffset: l.advance_offset, state: l.state,
    })),
    advanceOffset,
    markerPaid,
    relockForMarker,
  };
  return { ...m, advance: m.advance + advanceOffset + markerPaid, advanceItems, profit };
}

/** Hai khoản trừ thuộc sổ tổng nằm trong con số "ứng" (m.advance / số ứng đã chốt). */
export function profitDeductionsOf(m: Pick<SalManager, 'profit'>): { offset: number; marker: number } {
  return { offset: m.profit?.advanceOffset ?? 0, marker: m.profit?.markerPaid ?? 0 };
}

export const isProfitDeduction = (item: Pick<SalAdvanceItem, 'kind'>): boolean =>
  item.kind === 'PROFIT_ADVANCE' || item.kind === 'PROFIT_MARKER';

/** Trạng thái trả phần đầu tư của tháng (nhãn ở dòng "Thu nhập đồng hành"). */
export type InvestmentPayState =
  | { kind: 'MARKER'; through: string | null }
  | { kind: 'REVIEW'; codes: string[] }
  | { kind: 'PAID' | 'PARTIAL'; paid: number; codes: string[] }
  | { kind: 'UNPAID' };

export function investmentPayState(m: Pick<SalManager, 'profit'>): InvestmentPayState | null {
  const p = m.profit;
  if (!p) return null;
  if (p.settledByMarker) return { kind: 'MARKER', through: p.markerThrough };
  const live = p.paidLines.filter((l) => l.voucherLive);
  const codesOf = (state: 'LINKED' | 'NEEDS_REVIEW') =>
    [...new Set(live.filter((l) => l.state === state).map((l) => l.voucherCode ?? 'chưa có mã'))];
  const review = codesOf('NEEDS_REVIEW');
  if (review.length) return { kind: 'REVIEW', codes: review };
  const linked = codesOf('LINKED');
  if (linked.length && !same(p.paidInvestment, 0)) {
    return { kind: same(p.paidInvestment, p.investmentMonth) ? 'PAID' : 'PARTIAL', paid: p.paidInvestment, codes: linked };
  }
  return { kind: 'UNPAID' };
}

/* ───────────────────────────── chặn / chọn khi trả lương ───────────────────────────── */

/**
 * Dừng một thao tác lương vì phần lợi nhuận — từ chối chắc chắn, CHƯA ghi phiếu lương / CHƯA chốt
 * (`outcome 'failure'` ⇒ lần bấm sau dùng khoá mới). `reload` = số vừa đổi, nên tải lại bảng lương.
 */
export class SalaryProfitStopError extends FinancialWorkflowError {
  constructor(message: string, readonly reload: boolean, cause?: unknown) {
    super(message, 'failure', [], cause);
  }
}

/** Lý do chưa trả lương được vì phần lợi nhuận; null = trả được. */
export function salaryProfitPayoutBlock(m: Pick<SalManager, 'status' | 'profit'>): string | null {
  const p = m.profit;
  if (!p || m.status !== 'LOCKED') return null;
  if (p.relockForMarker) {
    const through = salaryMonthLabel(p.markerThrough);
    return `Tháng này nằm trong mốc "đã trả đủ${through ? ` đến hết ${through}` : ''}" nhưng bảng lương chốt trước mốc — thực nhận đã chốt còn gồm phần lợi nhuận đầu tư. Mở chốt rồi chốt lại để bỏ phần đã trả theo mốc, rồi mới trả lương.`;
  }
  if (p.offsetConflict) {
    return 'Bảng lương đã chốt chưa gồm phần trừ tạm ứng lợi nhuận đã trừ ở phiếu trước. Mở chốt lương rồi chốt lại trước khi trả tiếp.';
  }
  return null;
}

/** Phần đầu tư khi trả hết (màn không có ô chọn: hộp trả lương, điện thoại, trả hàng loạt). */
export function fullInvestmentSelection(m: Pick<SalManager, 'status' | 'profit' | 'investment' | 'investmentLocked'>): number {
  const p = m.profit;
  if (!p || p.settledByMarker) return 0;
  if (m.status === 'LOCKED') return p.investmentMonth;
  return m.investmentLocked ? m.investment : 0;
}

/**
 * Phần trừ tạm ứng đi cùng phần đầu tư được chọn (LUỸ KẾ): chọn đủ ⇒ đủ D; bỏ bớt dòng đầu tư ⇒ chỉ
 * trừ trong phần đầu tư còn chọn — không lấy lương cơ bản trừ tạm ứng lợi nhuận — nhưng không dưới
 * phần đã trừ ở phiếu trước (số luỹ kế không lùi được).
 */
export function profitOffsetFor(m: Pick<SalManager, 'status' | 'profit' | 'investment' | 'investmentLocked'>, investmentSelected: number): number {
  const d = m.profit?.advanceOffset ?? 0;
  if (d <= 0) return 0;
  if (investmentSelected >= fullInvestmentSelection(m) - EPS) return d;
  const alreadyDeducted = Math.min(d, m.profit?.paidOffset ?? 0);
  return Math.max(alreadyDeducted, Math.min(d, Math.max(0, investmentSelected)));
}

/** Màn có ô chọn từng khoản gửi phần đầu tư được chọn (luỹ kế của tháng). */
export interface SalaryPayoutChoice {
  investmentSelected: number;
}

/** Số gửi E15 (luỹ kế của tháng tính tới hết phiếu sắp lập). */
export interface SalaryProfitQuoteSelection {
  investmentSelected: number;
  offsetSelected: number;
}

/**
 * Phần lợi nhuận của phiếu lương sắp lập. null = không phải cổ đông (trả như cũ, không báo giá).
 * Ném SalaryProfitStopError khi phần lợi nhuận chặn trả lương.
 *  - Tháng trong mốc: 0/0 (máy chủ từ chối số > 0).
 *  - Bảng đã chốt: Y_m và D của bảng cho MỌI lần trả (máy chủ tự trừ phần đã trả).
 *  - Bảng nháp: phần đầu tư được chọn (mặc định: tất cả) + phần trừ tạm ứng tương ứng.
 */
export function salaryProfitQuoteFor(m: SalManager, choice?: SalaryPayoutChoice | null): SalaryProfitQuoteSelection | null {
  const p = m.profit;
  if (!p) return null;
  const block = salaryProfitPayoutBlock(m);
  if (block) throw new SalaryProfitStopError(block, false);
  if (p.settledByMarker) return { investmentSelected: 0, offsetSelected: 0 };
  if (m.status === 'LOCKED') return { investmentSelected: round2(p.investmentMonth), offsetSelected: round2(p.advanceOffset) };
  const investment = choice ? choice.investmentSelected : fullInvestmentSelection(m);
  return { investmentSelected: round2(investment), offsetSelected: round2(profitOffsetFor(m, investment)) };
}

/** Tổng phiếu lương salary_payout_v1 sẽ lập: thực nhận + tiền phòng máy chủ kẹp theo nợ còn. */
export function salaryVoucherTotal(takeHome: number, rent: { amount: number; remaining?: number | null } | null | undefined): number {
  if (!rent) return round2(takeHome);
  const remaining = rent.remaining ?? rent.amount;
  return round2(takeHome + Math.max(0, Math.min(rent.amount, remaining)));
}

/** Báo giá E15 không lập phiếu được: lý do cho người dùng. null = lập tiếp. */
export function salaryQuoteProblem(quote: SalaryQuoteResult, staffName: string): SalaryProfitStopError | null {
  if (quote.kind === 'NOT_SHAREHOLDER') {
    return new SalaryProfitStopError(`Thông tin cổ đông của ${staffName} vừa đổi — tải lại bảng lương rồi lập lại phiếu.`, true);
  }
  switch (quote.needs_review_reason) {
    case null:
      return null;
    case 'OFFSET_CONFLICT':
      return new SalaryProfitStopError(`Bảng lương đã chốt của ${staffName} chưa gồm phần trừ tạm ứng lợi nhuận đã trừ ở phiếu trước — chưa lập phiếu. Mở chốt lương rồi chốt lại trước khi trả.`, true);
    case 'MIXED_SIGN_SELECTION':
      return new SalaryProfitStopError(`Phần lợi nhuận đầu tư chọn trả cho ${staffName} ngược chiều phần còn lại của tháng — chưa lập phiếu. Chọn đủ các dòng lợi nhuận đầu tư hoặc tải lại bảng lương rồi chọn lại.`, true);
    default:
      return new SalaryProfitStopError(`Phần lợi nhuận trong phiếu lương của ${staffName} sẽ phải chờ chủ xem lại — chưa lập phiếu. Tải lại bảng lương rồi thử lại.`, true);
  }
}

/* ───────────────────────────── chốt lương ───────────────────────────── */

/** Số gửi E13 ngay trước chốt lương; null = không phải cổ đông hoặc dòng đã chốt (không đóng băng). */
export interface SalaryFreezePlan {
  expectedInvestment: number;
  maxOffset: number;
  /** ĐÚNG số thực nhận sẽ gửi lock_salary_month_v2 (không làm tròn ở đây: máy chủ làm tròn cả hai). */
  expectedTakeHome: number;
}

export function salaryFreezePlanFor(m: SalManager): SalaryFreezePlan | null {
  if (!m.profit || m.status === 'LOCKED') return null;
  const c = m.calc || salCalc(m);
  return { expectedInvestment: round2(m.investment), maxOffset: round2(m.profit.advanceOffset), expectedTakeHome: c.takehome };
}

/** Đóng băng không khớp số đang chốt ⇒ KHÔNG chốt, tải lại. null = khớp. */
export function salaryFreezeProblem(m: SalManager, plan: SalaryFreezePlan, result: SalaryFreezeResult): SalaryProfitStopError | null {
  const changed = () => new SalaryProfitStopError(`Số lợi nhuận hoặc tạm ứng của ${m.name} vừa đổi — chưa chốt lương. Tải lại bảng lương rồi chốt lại.`, true);
  if (result.kind === 'NOT_SHAREHOLDER') return changed();
  if (result.kind === 'ALREADY_LOCKED') {
    return new SalaryProfitStopError(`Bảng lương của ${m.name} vừa được chốt ở nơi khác — tải lại bảng lương trước khi làm tiếp.`, true);
  }
  if (!same(result.advance_offset_month, plan.maxOffset)) return changed();
  if (!same(result.investment_month, plan.expectedInvestment)) return changed();
  if (result.settled_by_marker !== (m.profit?.settledByMarker ?? false)) return changed();
  return null;
}

/**
 * Lỗi của E13/E15 ⇒ dừng TRƯỚC khi chốt / lập phiếu lương (không có tiền nào đi), câu tiếng Việt
 * theo mã máy. Kể cả lỗi mạng: báo giá / đóng băng mồ côi vô hại (lần sau huỷ và làm lại).
 */
export function salaryProfitFailure(error: unknown, op: 'salary_freeze' | 'salary_quote', staffName: string): SalaryProfitStopError {
  const info = profitLedgerErrorMessage(error, op);
  if (info.kind === 'UNKNOWN_OUTCOME') {
    // Câu chung "chưa rõ kết quả, đừng lập lại" sai ở đây: chưa có phiếu lương nào được lập.
    const what = op === 'salary_freeze' ? 'chốt lương' : 'lập phiếu lương';
    return new SalaryProfitStopError(`Chưa ghi được phần lợi nhuận trong lương của ${staffName} — chưa ${what}. Thử lại sau giây lát.`, true, error);
  }
  return new SalaryProfitStopError(info.message, info.reload, error);
}
