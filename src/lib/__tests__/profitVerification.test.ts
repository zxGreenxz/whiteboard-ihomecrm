import { describe, expect, it } from "vitest";
import {
  calculateBuildingDiffs,
  calculateEngineTieOut,
  calculateNonKqkdAmounts,
  calculateProfitVerificationInvariant,
  profitVerificationChipLabel,
  requireProfitVerificationRpcData,
  resolveProfitVerificationVisualState,
} from "@/lib/profitVerification";

const okBase = {
  loading: false,
  unavailable: false,
  capWarning: false,
  incomeMatches: true,
  expenseMatches: true,
} as const;

describe("F12: OK chỉ khi engine đã đối chiếu và khớp", () => {
  it("faMatches null ⇒ WARNING, không OK", () => {
    expect(resolveProfitVerificationVisualState({ ...okBase, faMatches: null })).toBe("WARNING");
    expect(resolveProfitVerificationVisualState({ ...okBase, faMatches: true })).toBe("OK");
    expect(resolveProfitVerificationVisualState({ ...okBase, faMatches: false })).toBe("ERROR");
  });

  it("cảnh báo từ ngoài đẩy OK lên WARNING nhưng không hạ ERROR", () => {
    expect(
      resolveProfitVerificationVisualState({ ...okBase, faMatches: true, extraWarnings: 2 }),
    ).toBe("WARNING");
    expect(
      resolveProfitVerificationVisualState({ ...okBase, faMatches: false, extraWarnings: 2 }),
    ).toBe("ERROR");
  });

  it("nhãn chip nêu rõ phạm vi 'phần đã duyệt'", () => {
    expect(profitVerificationChipLabel("OK")).toContain("Khớp engine (phần đã duyệt)");
    expect(profitVerificationChipLabel("OK", "10:30")).toContain("10:30");
    expect(profitVerificationChipLabel("WARNING")).not.toContain("✓");
  });
});

describe("F34: ngoài-KQKD giữ số âm", () => {
  it("không cắt về 0", () => {
    expect(
      calculateNonKqkdAmounts(
        { cash_income: 100, cash_expense: 50 },
        { cash_income: 130, cash_expense: 20 },
      ),
    ).toEqual({ income: -30, expense: 30 });
  });
});

describe("F48: lọc loại phiếu chỉ so chiều đang xem", () => {
  const inv = {
    totalIncome: 1_000,
    totalExpense: 0,
    shownIncomeSum: 1_000,
    shownExpenseSum: 700,
    hiddenIncomeSum: 0,
    hiddenExpenseSum: 0,
  };

  it("chỉ khoản thu: chi không bị so", () => {
    expect(calculateProfitVerificationInvariant({ ...inv, voucherType: "INCOME" })).toMatchObject({
      expenseMatches: true,
      expenseDiff: 0,
      expenseCompared: false,
      incomeCompared: true,
    });
    // không lọc ⇒ vẫn báo lệch chi
    expect(calculateProfitVerificationInvariant(inv).expenseMatches).toBe(false);
  });

  it("tie-out engine bỏ chiều không xem", () => {
    const base = {
      totalIncome: 1_000,
      totalExpense: 0,
      pendingIncome: 100,
      pendingExpense: 0,
      fa: { income: 900, expense: 500 },
    };
    expect(calculateEngineTieOut(base).matches).toBe(false);
    expect(calculateEngineTieOut({ ...base, voucherType: "INCOME" })).toMatchObject({
      matches: true,
      expenseDiff: 0,
    });
    expect(calculateEngineTieOut({ ...base, voucherType: "EXPENSE" }).matches).toBe(false);
  });

  it("chưa có số engine ⇒ matches null", () => {
    expect(
      calculateEngineTieOut({
        totalIncome: 1,
        totalExpense: 1,
        pendingIncome: 0,
        pendingExpense: 0,
        fa: null,
      }).matches,
    ).toBeNull();
  });
});

describe("F35: lệch theo toà khoá bằng building_id", () => {
  const engine = new Map([
    ["b1", { name: "Toà A", income: 1_000, expense: 200 }],
    ["b2", { name: "Toà B", income: 500, expense: 100 }],
    ["b3", { name: "Toà C", income: 300, expense: 0 }],
  ]);
  const row = (
    buildingId: string | null,
    buildingName: string | null,
    income: number,
    expense: number,
    approvalStatus = "APPROVED",
  ) => ({ buildingId, buildingName, income, expense, approvalStatus });

  it("chỉ liệt kê toà lệch, bỏ phần chờ duyệt, gộp theo id dù trùng tên", () => {
    const diffs = calculateBuildingDiffs({
      engine,
      clientRows: [
        row("b1", "Toà A", 600, 200),
        row("b1", "Toà A", 400, 0),
        row("b2", "Trùng tên", 500, 100),
        row("b2", "Trùng tên", 999, 999, "UNAPPROVED"), // chờ duyệt: không tính
        row("b3", "Trùng tên", 250, 0),
      ],
    });
    expect(diffs).toEqual([
      { buildingId: "b3", name: "Trùng tên", incomeDiff: -50, expenseDiff: 0 },
    ]);
  });

  it("toà chỉ có phía client / chỉ có engine / không gắn toà đều lộ ra, sắp theo độ lớn", () => {
    const diffs = calculateBuildingDiffs({
      engine: new Map([["b1", { name: "Toà A", income: 100, expense: 0 }]]),
      clientRows: [row(null, null, 40, 0), row("b9", "Toà Z", 0, 700)],
    });
    expect(diffs.map((d) => d.buildingId)).toEqual(["b9", "b1", "__no_building__"]);
    expect(diffs[1]).toMatchObject({ incomeDiff: -100 });
    expect(diffs[2].name).toBe("Không rõ toà");
  });

  it("ngưỡng 2đ và lọc chiều", () => {
    expect(
      calculateBuildingDiffs({
        engine: new Map([["b1", { name: "A", income: 100, expense: 0 }]]),
        clientRows: [row("b1", "A", 101, 50)],
        voucherType: "INCOME",
      }),
    ).toEqual([]);
  });
});

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
