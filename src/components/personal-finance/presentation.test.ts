import {
  categoryFilterFor,
  categoryFilterValue,
  matchesCategoryFilter,
} from "./presentation";
import { selectMonth } from "@/lib/personalFinance/selectors";
import type { Snapshot } from "@/lib/personalFinance/contract";
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

it("keeps report bucket identity for category IDs, exact legacy names and null", () => {
  const base = {
    user_id: "owner",
    type: "EXPENSE" as const,
    version: 1,
    amount: 1,
    txn_date: "2026-10-01",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: null,
    description: null,
    wallet_id: "wallet",
    resolved_wallet_id: "wallet",
    category_id: null,
  };
  const rows = [
    { resolved_category_id: "id", category: "A" },
    { resolved_category_id: null, category: "id" },
    { resolved_category_id: null, category: "A" },
    { resolved_category_id: null, category: "B" },
    { resolved_category_id: null, category: null },
    { resolved_category_id: null, category: "" },
  ];
  const snapshot: Snapshot = {
    owner_id: "owner",
    schema_version: 1,
    wallets: [],
    transfers: [],
    goals: [],
    categories: [
      {
        id: "id",
        name: "A",
        user_id: "owner",
        version: 1,
        type: "EXPENSE",
        icon: "leaf",
        color: "#000000",
        hidden: false,
        seed_key: null,
        legacy_name: null,
      },
    ],
    budgets: [],
    transactions: rows.map((r, i) => ({ ...base, ...r, id: String(i) })),
  };
  const buckets = selectMonth(snapshot, "2026-10").categories;
  expect(buckets).toHaveLength(6);
  const filters = buckets.map((g) =>
    categoryFilterFor(g.categoryId, g.legacyName),
  );
  expect(new Set(filters.map(categoryFilterValue)).size).toBe(6);
  rows.forEach((row, i) =>
    expect(filters.map((filter) => matchesCategoryFilter(row, filter))).toEqual(
      rows.map((_r, j) => i === j),
    ),
  );
  expect(matchesCategoryFilter(rows[0], { kind: "all" })).toBe(true);
  expect(buckets.map((g) => [g.categoryId, g.legacyName])).toEqual([
    ["id", null],
    [null, "id"],
    [null, "A"],
    [null, "B"],
    [null, null],
    [null, ""],
  ]);
});
