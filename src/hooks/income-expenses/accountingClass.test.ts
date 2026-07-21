import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  inFilter: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mocks.from },
}));

import { loadIncomeExpenseAccountingClassResolver } from "./accountingClass";

describe("income expense accounting class resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ in: mocks.inFilter });
  });

  it("snapshots deposit and P&L classes from the selected item types", async () => {
    mocks.inFilter.mockResolvedValue({
      data: [
        { id: "rent", is_deposit: false },
        { id: "deposit", is_deposit: true },
      ],
      error: null,
    });

    const resolveClass = await loadIncomeExpenseAccountingClassResolver([
      "rent",
      "deposit",
      "rent",
    ]);

    expect(mocks.from).toHaveBeenCalledWith("income_expense_types");
    expect(mocks.inFilter).toHaveBeenCalledWith("id", ["rent", "deposit"]);
    expect(resolveClass("rent")).toBe("PNL");
    expect(resolveClass("deposit")).toBe("DEPOSIT");
  });

  it("fails closed when an item type is not visible", async () => {
    mocks.inFilter.mockResolvedValue({ data: [], error: null });

    const resolveClass = await loadIncomeExpenseAccountingClassResolver([
      "missing",
    ]);

    expect(() => resolveClass("missing")).toThrow(
      "Không tìm thấy hạng mục thu/chi missing",
    );
  });
});
