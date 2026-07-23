import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723100000_finance_v2_read_models.sql"),
  "utf8",
);

describe("Finance V2 Stage 10 — read-models v2 (posting-based, additive)", () => {
  it("is a single-transaction migration that changes no feature mode", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
  });

  it("creates accounts_with_balance_v2 from posting lines with security_invoker (§11.2)", () => {
    expect(sql).toContain("accounts_with_balance_v2");
    expect(sql).toContain("security_invoker");
    expect(sql).toContain("income_expense_posting_lines");
    expect(sql).toContain("NO approval_status filter");
    // The balance-view CREATE statement itself must not gate cash on approval_status.
    const view = sql.slice(
      sql.indexOf("VIEW public.accounts_with_balance_v2"),
      sql.indexOf("VIEW public.accounts_with_balance_v2") + 1500,
    );
    expect(view).not.toMatch(/approval_status\s*=\s*'APPROVED'/i);
    expect(view).toMatch(/signed_amount/i);
  });

  it("is additive — leaves the legacy accounts_with_balance untouched", () => {
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?view\s+public\.accounts_with_balance\b(?!_v2)/i);
  });

  it("provides the §11.3 effective-contribution resolver keyed off recognition, not posting", () => {
    expect(sql).toContain("effective_profit_contributions_v2");
    expect(sql).toContain("BASE_ALLOCATION");
    expect(sql).toContain("RECOGNITION_ADJUSTMENT");
    expect(sql).toContain("recognition_source_mode");
  });

  it("provides posting-based aggregate RPCs windowed by posted_on", () => {
    expect(sql).toContain("cashbook_period_totals_v2");
    expect(sql).toContain("cashbook_opening_balance_v2");
    expect(sql).toContain("cashflow_by_day_v2");
    expect(sql).toContain("posted_on");
  });

  it("provides the close-blocker helper (§11.4) reading the resolver", () => {
    expect(sql).toContain("finance_v2_pending_kqkd_blockers");
    expect(sql).toMatch(/pending_kqkd_count/);
    expect(sql).toMatch(/approved_unposted_count/);
  });
});
