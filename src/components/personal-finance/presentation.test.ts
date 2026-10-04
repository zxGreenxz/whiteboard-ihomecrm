import { describe, expect, it } from "vitest";
import { money, changedFields, deleteReason, shiftMonth } from "./presentation";
describe("personal finance presentation boundaries", () => {
  it("preserves legacy fractions and unchanged historical fields", () => {
    expect(money(12.125)).toContain("12,125");
    expect(
      changedFields(
        { name: "\t", amount: 12.125 },
        { name: "\t", amount: 12.125, icon: "leaf" },
      ),
    ).toEqual({ icon: "leaf" });
  });
  it("moves months across years", () =>
    expect(shiftMonth("2026-01", -1)).toBe("2025-12"));
  it("explains protected default wallet deletion", () =>
    expect(
      deleteReason("wallet", { is_default: true }, {
        transactions: [],
        transfers: [],
        goals: [],
        categories: [],
        budgets: [],
        wallets: [],
      } as never),
    ).toContain("mặc định"));
});
