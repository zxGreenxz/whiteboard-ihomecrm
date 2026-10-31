// "Lương của tôi": tóm tắt kỳ (Tổng thu nhập − Trừ khi trả = Còn nhận), danh sách
// việc đứng sau từng khoản thưởng và mốc chuỗi v5. Hàm thuần đọc SalManager — cùng
// công thức với khung thanh toán của tab quản trị (SalaryIncomePay) khi chọn đủ mọi
// khoản, nên nhân viên và quản trị thấy cùng một con số.
import { commissionPaidElsewhere, type SalLedgerRow, type SalManager, type SalV5Info } from "@/lib/managerSalary";
import { fundLinesOf } from "@/lib/salaryFundReport";
import { effectiveMilestones } from "@/lib/v5Calendar";

export interface SelfSummary {
  gross: number;
  /** Lương vận hành = lương cứng + thưởng + phụ cấp/bổ sung + trừ nhập tay (+ phần lệch số chốt). */
  vh: number;
  base: number;
  work: number;
  allowance: number;
  manualDeduct: number;
  /** Phần lệch giữa tổng đã chốt và các dòng đọc lại — 0 với kỳ đang chạy. */
  other: number;
  dh: number;
  sale: number;
  advance: number;
  roomRent: number;
  /** Hoa hồng đã/sẽ chi từ sổ quỹ thật: là thu nhập nhưng không chuyển lại qua lương. */
  paidOut: number;
  deductTotal: number;
  paid: number;
  net: number;
}

export function selfSummaryOf(m: SalManager): SelfSummary {
  const c = m.calc;
  const locked = m.status === "LOCKED";
  // Kỳ đã chốt: đầu tư/HH/ứng lấy số đóng băng — bản live có thể trôi sau khi chốt.
  const fz = locked ? m.frozen ?? null : null;
  const gross = c?.gross ?? 0;
  const dh = fz ? fz.investment : m.investment;
  const sale = fz ? fz.commission : m.commission;
  const vh = gross - dh - sale;
  let base = 0;
  let work = 0;
  let allowance = 0;
  let manualDeduct = 0;
  for (const l of fundLinesOf(m)) {
    if (l.group === "base") base += l.amount;
    else if (l.group === "work") work += l.amount;
    else if (l.amount < 0) manualDeduct += l.amount;
    else allowance += l.amount;
  }
  const rest = vh - base - work - allowance - manualDeduct;
  const advance = fz ? fz.advance : m.advance;
  const roomRent = m.roomRent;
  const takehome = c?.takehome ?? 0;
  // Kỳ chốt: suy phần chi từ sổ thật từ số đóng băng để các dòng luôn cộng khớp.
  const paidOut = locked && c
    ? Math.max(0, gross - advance - roomRent - takehome)
    : commissionPaidElsewhere(m.commissionItems);
  return {
    gross, vh, base, work, allowance, manualDeduct,
    other: Math.round(rest) === 0 ? 0 : rest,
    dh, sale, advance, roomRent, paidOut,
    deductTotal: advance + roomRent + paidOut,
    paid: m.paid,
    net: Math.max(0, takehome - m.paid),
  };
}

// ───────────── việc đứng sau từng khoản thưởng (cùng luật với buildBonusAuto) ─────────────

const earned = (r: SalLedgerRow) => (r.bonus_amount ?? 0) > 0;
// Bảng kê về theo thứ tự của RPC; danh sách cho người đọc xếp theo ngày (giữ thứ tự trong ngày).
const byDate = (rows: SalLedgerRow[]) => rows.slice().sort((a, b) => (a.occurred_date || "").localeCompare(b.occurred_date || ""));

/** Việc có thưởng của một loại (dòng "Thưởng việc · <loại>"). */
export function jobRowsOf(m: SalManager, jobType: string): SalLedgerRow[] {
  return byDate(m.ledger.filter((r) => r.item_type === "JOB" && !r.is_contract && earned(r) && (r.job_type_name || "Việc") === jobType));
}

/** Mọi việc có thưởng (trừ ký HĐ) — số đếm của ô "Việc có thưởng". */
export function earnedJobRowsOf(m: SalManager): SalLedgerRow[] {
  return byDate(m.ledger.filter((r) => r.item_type === "JOB" && !r.is_contract && earned(r)));
}

/** Ký HĐ ngoài giờ / CN / lễ đủ điều kiện (dòng "Ký hợp đồng ngoài giờ"). */
export function contractRowsOf(m: SalManager): SalLedgerRow[] {
  return byDate(m.ledger.filter((r) => r.item_type === "CONTRACT" || (r.item_type === "JOB" && !!r.is_contract && earned(r))));
}

export interface BonusDay {
  row: SalLedgerRow;
  /** Việc làm trong ngày đó (căn cứ của tiền ngày CN/lễ). */
  jobs: SalLedgerRow[];
}

/** Ngày CN/lễ có sửa chữa (dòng "Tăng ca CN / lễ"), kèm các việc của ngày. */
export function bonusDaysOf(m: SalManager): BonusDay[] {
  return byDate(m.ledger.filter((r) => r.item_type === "DAY_BONUS"))
    .map((row) => ({ row, jobs: m.ledger.filter((r) => r.item_type === "JOB" && r.occurred_date === row.occurred_date) }));
}

// ───────────── mốc chuỗi v5 ─────────────

type Milestone = number | "full_month" | "n_top";

export interface V5Plan {
  attendBudget: number | null;
  streakBudget: number | null;
  milestones: Milestone[];
  deltas: number[];
}

const isMilestone = (v: unknown): v is Milestone =>
  (typeof v === "number" && Number.isFinite(v) && v > 0) || v === "full_month" || v === "n_top";

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** get_salary_v5_config → phần cần để hiện mốc chuỗi; sai dạng thì null (không đoán). */
export function parseV5Plan(cfg: unknown): V5Plan | null {
  if (!cfg || typeof cfg !== "object") return null;
  const c = cfg as Record<string, unknown>;
  const st = c.streak_v5 as Record<string, unknown> | undefined;
  const at = c.attendance_v5 as Record<string, unknown> | undefined;
  if (!st || !Array.isArray(st.milestones) || !Array.isArray(st.deltas)) return null;
  const milestones = st.milestones;
  const deltas = st.deltas;
  if (milestones.length === 0 || milestones.length !== deltas.length) return null;
  if (!milestones.every(isMilestone) || !deltas.every((d) => typeof d === "number" && Number.isFinite(d) && d >= 0)) return null;
  return {
    attendBudget: numOrNull(at?.budget),
    streakBudget: numOrNull(st.budget),
    milestones: milestones as Milestone[],
    deltas: deltas as number[],
  };
}

export interface StreakStep {
  /** Số ngày của mốc; null với mốc "trọn tháng" kiểu cũ. */
  day: number | null;
  label: string;
  delta: number;
  reached: boolean;
}

export interface StreakView {
  steps: StreakStep[];
  reached: number;
  /** Số ngày chuỗi hiển thị: chuỗi dài nhất của kỳ, không thấp hơn mốc cuối đã đạt. */
  days: number;
  nchuan: number;
  budget: number;
}

/**
 * Mốc chuỗi của kỳ. Mốc đã đạt suy từ số tiền chuỗi đang trả khi số đó đúng bằng tổng
 * các mốc đầu (gồm cả khi chủ đã sửa tay để khôi phục chuỗi); không khớp thì dùng mốc
 * máy đã ghi nhận. Mốc máy ghi nhận không nằm trong thang hiện hành (kỳ cũ trước khi
 * đổi thang) thì trả null — không đoán số mốc đạt theo thang khác.
 */
export function streakViewOf(plan: V5Plan, v5: SalV5Info, streakAmount: number | null): StreakView | null {
  const eff = effectiveMilestones(plan.milestones, plan.deltas, v5.nchuan);
  let prefix = -1;
  if (streakAmount != null) {
    let cum = 0;
    for (let k = 0; k <= eff.length; k++) {
      if (Math.round(cum) === Math.round(streakAmount)) { prefix = k; break; }
      if (k < eff.length) cum += eff[k].delta;
    }
  }
  if (prefix < 0 && v5.banked.some((d) => !eff.some((e) => e.at === d))) return null;
  const steps: StreakStep[] = eff.map((e, i) => {
    const day = typeof e.at === "number" ? e.at : null;
    const reached = prefix >= 0 ? i < prefix : day != null && v5.banked.includes(day);
    return { day, label: day != null ? String(day) : "Trọn tháng", delta: e.delta, reached };
  });
  const lastReached = steps.reduce((d, s) => (s.reached && s.day != null ? Math.max(d, s.day) : d), 0);
  return {
    steps,
    reached: steps.filter((s) => s.reached).length,
    days: Math.max(v5.streakBest, lastReached),
    nchuan: v5.nchuan,
    budget: plan.streakBudget ?? eff.reduce((s, e) => s + e.delta, 0),
  };
}
