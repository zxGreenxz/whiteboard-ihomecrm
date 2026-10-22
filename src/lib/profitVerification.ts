export const PROFIT_VERIFICATION_TOLERANCE = 2;

/** F48: bộ lọc loại phiếu của trang — chỉ so chiều đang xem. */
export type ProfitVerificationVoucherType = "all" | "INCOME" | "EXPENSE";

/** Chiều nào đang được so (F48). 'all' = cả hai. */
export function profitVerificationSides(
  voucherType: ProfitVerificationVoucherType | undefined,
): { income: boolean; expense: boolean } {
  return {
    income: voucherType !== "EXPENSE",
    expense: voucherType !== "INCOME",
  };
}

export interface ProfitVerificationInvariantInput {
  totalIncome: number;
  totalExpense: number;
  shownIncomeSum: number;
  shownExpenseSum: number;
  hiddenIncomeSum: number;
  hiddenExpenseSum: number;
  tolerance?: number;
  /** F48: khi lọc "Chỉ khoản thu/chi" chỉ so chiều đang xem (mặc định 'all'). */
  voucherType?: ProfitVerificationVoucherType;
}

export interface ProfitVerificationInvariant {
  incomeDiff: number;
  expenseDiff: number;
  incomeMatches: boolean;
  expenseMatches: boolean;
  /** false = chiều này không được so vì đang lọc chiều kia (diff = 0, matches = true). */
  incomeCompared: boolean;
  expenseCompared: boolean;
}

interface LayerStatsLike {
  cash_income?: unknown;
  cash_expense?: unknown;
  internal_income?: unknown;
  internal_expense?: unknown;
  pending_income?: unknown;
  pending_expense?: unknown;
}

function amount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateNonKqkdAmounts(
  all: LayerStatsLike,
  kqkd: LayerStatsLike,
): { income: number; expense: number } {
  const allIncome =
    amount(all.cash_income) +
    amount(all.internal_income) +
    amount(all.pending_income);
  const allExpense =
    amount(all.cash_expense) +
    amount(all.internal_expense) +
    amount(all.pending_expense);

  // F34: KHÔNG cắt về 0 — số âm (KQKD > tổng mọi khoản) là dấu hiệu dữ liệu lạ,
  // phải hiện ra chứ không được che.
  return {
    income: allIncome - amount(kqkd.cash_income),
    expense: allExpense - amount(kqkd.cash_expense),
  };
}

export type ProfitVerificationVisualState =
  | "OK"
  | "WARNING"
  | "ERROR"
  | "LOADING"
  | "UNAVAILABLE";

export function calculateProfitVerificationInvariant(
  input: ProfitVerificationInvariantInput,
): ProfitVerificationInvariant {
  const tolerance = input.tolerance ?? PROFIT_VERIFICATION_TOLERANCE;
  const sides = profitVerificationSides(input.voucherType);
  const incomeDiff = sides.income
    ? input.totalIncome - (input.shownIncomeSum + input.hiddenIncomeSum)
    : 0;
  const expenseDiff = sides.expense
    ? input.totalExpense - (input.shownExpenseSum + input.hiddenExpenseSum)
    : 0;

  return {
    incomeDiff,
    expenseDiff,
    incomeMatches: Math.abs(incomeDiff) < tolerance,
    expenseMatches: Math.abs(expenseDiff) < tolerance,
    incomeCompared: sides.income,
    expenseCompared: sides.expense,
  };
}

export function resolveProfitVerificationVisualState(input: {
  loading: boolean;
  unavailable: boolean;
  capWarning: boolean;
  incomeMatches: boolean;
  expenseMatches: boolean;
  /** null = CHƯA đối chiếu được engine (không phải "khớp"). */
  faMatches: boolean | null;
  /** Số cảnh báo từ bên ngoài (vd bộ dò thiếu chi cố định) — > 0 đẩy lên WARNING. */
  extraWarnings?: number;
}): ProfitVerificationVisualState {
  if (input.unavailable) return "UNAVAILABLE";
  if (input.loading) return "LOADING";
  if (
    input.faMatches === false ||
    (!input.capWarning && (!input.incomeMatches || !input.expenseMatches))
  ) {
    return "ERROR";
  }
  // F12: "OK" chỉ khi engine ĐÃ đối chiếu và khớp; chưa đối chiếu ⇒ WARNING.
  if (
    input.capWarning ||
    input.faMatches === null ||
    (input.extraWarnings ?? 0) > 0
  ) {
    return "WARNING";
  }
  return "OK";
}

/** Nhãn chip kiểm chứng ở dải hero — F12: nói rõ chỉ khớp engine trên phần ĐÃ DUYỆT. */
export function profitVerificationChipLabel(
  state: ProfitVerificationVisualState,
  verifiedAt?: string | null,
): string {
  switch (state) {
    case "OK":
      return `✓ Khớp engine (phần đã duyệt)${verifiedAt ? ` · ${verifiedAt}` : ""}`;
    case "LOADING":
      return "Đang kiểm chứng…";
    case "WARNING":
      return "Kiểm chứng: cần xem lại";
    default:
      return "Kiểm chứng LỆCH";
  }
}

export interface ProfitVerificationEngineTieOut {
  incomeDiff: number;
  expenseDiff: number;
  /** null = chưa có số engine để so. */
  matches: boolean | null;
}

/**
 * Tie-out với engine chia cổ đông (fa_monthly_pnl_accrual, chỉ tính APPROVED):
 * so (tổng − phần chờ duyệt) với engine, chỉ chiều đang xem (F48).
 */
export function calculateEngineTieOut(input: {
  totalIncome: number;
  totalExpense: number;
  pendingIncome: number;
  pendingExpense: number;
  fa: { income: number; expense: number } | null | undefined;
  voucherType?: ProfitVerificationVoucherType;
  tolerance?: number;
}): ProfitVerificationEngineTieOut {
  const tolerance = input.tolerance ?? PROFIT_VERIFICATION_TOLERANCE;
  if (!input.fa) return { incomeDiff: 0, expenseDiff: 0, matches: null };
  const sides = profitVerificationSides(input.voucherType);
  const incomeDiff = sides.income
    ? input.totalIncome - input.pendingIncome - input.fa.income
    : 0;
  const expenseDiff = sides.expense
    ? input.totalExpense - input.pendingExpense - input.fa.expense
    : 0;
  return {
    incomeDiff,
    expenseDiff,
    matches:
      Math.abs(incomeDiff) < tolerance && Math.abs(expenseDiff) < tolerance,
  };
}

/** Một dòng báo cáo phía client (tập con của AccrualReportRow). */
export interface ProfitVerificationClientRow {
  buildingId: string | null;
  buildingName: string | null;
  income: number;
  expense: number;
  approvalStatus?: string | null;
}

export interface ProfitVerificationBuildingDiff {
  buildingId: string;
  name: string;
  incomeDiff: number;
  expenseDiff: number;
}

export const NO_BUILDING_KEY = "__no_building__";

/**
 * F35: lệch (client − engine) THEO TOÀ, khoá bằng building_id. Phía client chỉ
 * gộp phần ĐÃ DUYỆT (engine chỉ tính APPROVED). Trả đúng các toà có |chênh| ≥
 * ngưỡng ở chiều đang xem, sắp theo độ lớn giảm dần.
 */
export function calculateBuildingDiffs(input: {
  clientRows: readonly ProfitVerificationClientRow[];
  engine: ReadonlyMap<string, { name: string; income: number; expense: number }>;
  voucherType?: ProfitVerificationVoucherType;
  tolerance?: number;
}): ProfitVerificationBuildingDiff[] {
  const tolerance = input.tolerance ?? PROFIT_VERIFICATION_TOLERANCE;
  const sides = profitVerificationSides(input.voucherType);
  const acc = new Map<
    string,
    { name: string; cIncome: number; cExpense: number }
  >();
  for (const r of input.clientRows) {
    if (r.approvalStatus === "UNAPPROVED") continue;
    const key = r.buildingId ?? NO_BUILDING_KEY;
    const cur = acc.get(key) ?? {
      name: r.buildingName ?? (r.buildingId ? "Toà không tên" : "Không rõ toà"),
      cIncome: 0,
      cExpense: 0,
    };
    cur.cIncome += amount(r.income);
    cur.cExpense += amount(r.expense);
    acc.set(key, cur);
  }
  const keys = new Set<string>([...acc.keys(), ...input.engine.keys()]);
  const out: ProfitVerificationBuildingDiff[] = [];
  for (const key of keys) {
    const c = acc.get(key);
    const e = input.engine.get(key);
    const incomeDiff = sides.income ? (c?.cIncome ?? 0) - (e?.income ?? 0) : 0;
    const expenseDiff = sides.expense
      ? (c?.cExpense ?? 0) - (e?.expense ?? 0)
      : 0;
    if (Math.abs(incomeDiff) < tolerance && Math.abs(expenseDiff) < tolerance) {
      continue;
    }
    out.push({
      buildingId: key,
      name: c?.name ?? e?.name ?? "Toà không tên",
      incomeDiff,
      expenseDiff,
    });
  }
  return out.sort(
    (a, b) =>
      Math.abs(b.incomeDiff) +
      Math.abs(b.expenseDiff) -
      (Math.abs(a.incomeDiff) + Math.abs(a.expenseDiff)),
  );
}

export function requireProfitVerificationRpcData<T>(
  label: string,
  result: { data?: T | null; error?: unknown } | null | undefined,
): T {
  if (result?.error) {
    const detail =
      typeof result.error === "object" &&
      result.error !== null &&
      "message" in result.error
        ? String((result.error as { message?: unknown }).message ?? "")
        : String(result.error);
    const error = new Error(
      `UNAVAILABLE: không thể tải ${label}${detail ? ` (${detail})` : ""}`,
    );
    (error as Error & { cause?: unknown }).cause = result.error;
    throw error;
  }
  if (result?.data == null) {
    throw new Error(`UNAVAILABLE: RPC ${label} không trả dữ liệu`);
  }
  return result.data;
}
