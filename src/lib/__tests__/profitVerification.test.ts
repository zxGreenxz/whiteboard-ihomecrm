import { describe, expect, it } from "vitest";
import {
  calculateNonKqkdAmounts,
  calculateProfitVerificationInvariant,
  requireProfitVerificationRpcData,
  resolveProfitVerificationVisualState,
} from "@/lib/profitVerification";

describe("profit verification invariants", () => {
  it("does not let an income mismatch cancel an opposite expense mismatch", () => {
    const result = calculateProfitVerificationInvariant({
      totalIncome: 1_000,
      totalExpense: 800,
      shownIncomeSum: 900,
      shownExpenseSum: 900,
      hiddenIncomeSum: 0,
      hiddenExpenseSum: 0,
    });

    expect(result).toMatchObject({
      incomeDiff: 100,
      expenseDiff: -100,
      incomeMatches: false,
      expenseMatches: false,
    });
  });

  it("includes hidden rows in the matching side only", () => {
    expect(
      calculateProfitVerificationInvariant({
        totalIncome: 1_000,
        totalExpense: 800,
        shownIncomeSum: 700,
        shownExpenseSum: 750,
        hiddenIncomeSum: 300,
        hiddenExpenseSum: 50,
      }),
    ).toMatchObject({ incomeMatches: true, expenseMatches: true });
  });
});

describe("profit verification availability", () => {
  it("throws instead of turning an RPC error into a green zero result", () => {
    expect(() =>
      requireProfitVerificationRpcData("thống kê KQKD", {
        data: null,
        error: { message: "rpc failed" },
      }),
    ).toThrow(/UNAVAILABLE.*rpc failed/);
  });

  it("keeps unavailable and loading states out of the green state", () => {
    const base = {
      capWarning: false,
      incomeMatches: true,
      expenseMatches: true,
      faMatches: true,
    } as const;

    expect(
      resolveProfitVerificationVisualState({
        ...base,
        loading: false,
        unavailable: true,
      }),
    ).toBe("UNAVAILABLE");
    expect(
      resolveProfitVerificationVisualState({
        ...base,
        loading: true,
        unavailable: false,
      }),
    ).toBe("LOADING");
  });
});

describe("profit verification layer descriptions", () => {
  it("counts approved no-book amounts in the all-voucher side before subtracting KQKD", () => {
    expect(
      calculateNonKqkdAmounts(
        {
          cash_income: 700,
          internal_income: 100,
          pending_income: 200,
          cash_expense: 400,
          internal_expense: 50,
          pending_expense: 50,
        },
        { cash_income: 850, cash_expense: 450 },
      ),
    ).toEqual({ income: 150, expense: 50 });
  });
});
