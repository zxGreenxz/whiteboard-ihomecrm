export const PROFIT_VERIFICATION_TOLERANCE = 2;

export interface ProfitVerificationInvariantInput {
  totalIncome: number;
  totalExpense: number;
  shownIncomeSum: number;
  shownExpenseSum: number;
  hiddenIncomeSum: number;
  hiddenExpenseSum: number;
  tolerance?: number;
}

export interface ProfitVerificationInvariant {
  incomeDiff: number;
  expenseDiff: number;
  incomeMatches: boolean;
  expenseMatches: boolean;
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

  return {
    income: Math.max(0, allIncome - amount(kqkd.cash_income)),
    expense: Math.max(0, allExpense - amount(kqkd.cash_expense)),
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
  const incomeDiff =
    input.totalIncome - (input.shownIncomeSum + input.hiddenIncomeSum);
  const expenseDiff =
    input.totalExpense - (input.shownExpenseSum + input.hiddenExpenseSum);

  return {
    incomeDiff,
    expenseDiff,
    incomeMatches: Math.abs(incomeDiff) < tolerance,
    expenseMatches: Math.abs(expenseDiff) < tolerance,
  };
}

export function resolveProfitVerificationVisualState(input: {
  loading: boolean;
  unavailable: boolean;
  capWarning: boolean;
  incomeMatches: boolean;
  expenseMatches: boolean;
  faMatches: boolean | null;
}): ProfitVerificationVisualState {
  if (input.unavailable) return "UNAVAILABLE";
  if (input.loading) return "LOADING";
  if (
    input.faMatches === false ||
    (!input.capWarning && (!input.incomeMatches || !input.expenseMatches))
  ) {
    return "ERROR";
  }
  if (input.capWarning) return "WARNING";
  return "OK";
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
