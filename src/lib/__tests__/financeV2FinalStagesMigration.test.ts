import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const noModeChange = (sql: string) => {
  expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
  expect(sql).not.toMatch(/insert\s+into\s+app_private\.server_feature_flag_canary_orgs/i);
};

describe("Finance V2 Stage 7 — caller drain + ACL", () => {
  const sql = readMigration("20260723070000_finance_v2_caller_drain_acl.sql");

  it("revokes client DML on money tables and drops broad write policies", () => {
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.income_expenses, public.income_expense_items FROM authenticated",
    );
    for (const p of [
      "income_expenses_insert_rbac",
      "income_expenses_update_rbac",
      "income_expenses_delete_rbac",
      "income_expense_items_insert_rbac",
      "income_expense_items_update_rbac",
      "income_expense_items_delete_rbac",
    ]) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${p}`);
    }
    // SELECT stays (legacy read contract until Stage-11 boundary)
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS income_expenses_select_rbac\b/);
    noModeChange(sql);
  });

  it("asserts control tables expose nothing to clients (fail loud on grant drift)", () => {
    expect(sql).toContain("app_private.canonical_write_operations");
    expect(sql).toContain("unexpectedly has access");
  });
});

describe("Finance V2 Stage 8 — delta catch-up", () => {
  const sql = readMigration("20260723080000_finance_v2_delta_catchup.sql");

  it("attaches the a90 capture trigger and provides the idempotent replay engine", () => {
    expect(sql).toContain("a90_finance_v2_capture");
    expect(sql).toContain("finance_v2_capture_change");
    expect(sql).toContain("finance_v2_replay_change_log_v1");
    expect(sql).toContain("finance_v2_delta_lag_v1");
    noModeChange(sql);
  });

  it("appends reversal + replacement generations, never mutating posting events", () => {
    expect(sql).toContain("finance_v2_append_reversal_v1");
    expect(sql).toContain("finance_v2_append_legacy_posting_v1");
    expect(sql).toContain("LEGACY_DELTA_REPLACEMENT");
    // The engine must not UPDATE or DELETE posting event rows themselves.
    expect(sql).not.toMatch(/UPDATE\s+public\.income_expense_postings\s+SET/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.income_expense_postings/i);
  });
});

describe("Finance V2 Stage 9 (slot 105000) — shadow reconcile", () => {
  const sql = readMigration("20260723105000_finance_v2_shadow_reconcile.sql");

  it("creates owner-only parity views + shadow gate readout + bypass monitor", () => {
    expect(sql).toContain("finance_v2_balance_parity_v1");
    expect(sql).toContain("finance_v2_pnl_parity_v1");
    expect(sql).toContain("finance_v2_shadow_summary_v1");
    expect(sql).toContain("finance_v2_bypass_monitor_v1");
    expect(sql).toContain("accounts_with_balance_v2");
    noModeChange(sql);
  });
});

describe("Finance V2 Stage 11 — RLS-canary read boundary", () => {
  const sql = readMigration("20260723110000_finance_v2_rls_canary.sql");

  it("gates posting-ledger reads on CANONICAL route + open CUSTODIAN binding", () => {
    expect(sql).toContain("finance_v2_can_read_posting_v1");
    expect(sql).toContain("income_expense.read_semantics.v2");
    expect(sql).toContain("finance_v2_postings_select_custodian");
    expect(sql).toContain("finance_v2_posting_lines_select_custodian");
  });

  it("implements the §9.2 union predicate: CUSTODIAN all-legs, KNOWER own-created INCOME only", () => {
    expect(sql).toContain("finance_v2_visible_vouchers");
    expect(sql).toMatch(/change_account_id,\s*ie\.rounding_account_id/);
    expect(sql).toContain("ie.maker_user_id = auth.uid()");
    expect(sql).toMatch(/type\s*=\s*'INCOME'/);
  });

  it("provides intent selectors + admin/CAS access RPCs with cashbooks.share gate", () => {
    for (const fn of [
      "list_income_expenses_v2",
      "get_income_expense_stats_v2",
      "get_income_expense_detail_v2",
      "list_cashbooks_for_income_v2",
      "list_cashbooks_for_expense_v2",
      "list_cashbooks_with_balance_v2",
      "list_my_cashbook_access_v2",
      "get_cashbook_access_admin_v2",
      "set_cashbook_access_v2",
      "list_finance_execution_queue_v2",
    ]) {
      expect(sql).toContain(fn);
    }
    expect(sql).toContain("'cashbooks.share'");
    // authorize_tenant_action_v3 is set-returning: must be consumed via .allowed
    expect(sql).toMatch(/z\.allowed/);
  });

  it("enforces revision CAS, idempotency, and no self-role change", () => {
    expect(sql).toContain("Stale access revision");
    expect(sql).toContain("Idempotency key reused with a different payload");
    expect(sql).toContain("Self role change is not allowed");
    // bindings are closed (valid_to), never deleted
    expect(sql).toContain("SET valid_to = now()");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.cashbook_possession_bindings/i);
    noModeChange(sql);
  });
});

describe("Finance V2 Stage 12 — cutover readiness", () => {
  const sql = readMigration("20260723120000_finance_v2_cutover_readiness.sql");

  it("adds readiness report + readout without flipping any mode or default", () => {
    expect(sql).toContain("finance_v2_cutover_readiness_v1");
    expect(sql).toContain("finance_v2_cutover_readiness_report");
    expect(sql).toContain("VALIDATE CONSTRAINT");
    noModeChange(sql);
    // The approval_status default flip must remain a deliberate post-drain operator step:
    // no ACTIVE (uncommented) ALTER of the default in this stage.
    const active = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(active).not.toMatch(/ALTER\s+TABLE\s+public\.income_expenses\s+ALTER\s+COLUMN\s+approval_status\s+SET\s+DEFAULT/i);
  });
});
