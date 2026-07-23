import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723030000_finance_v2_containment.sql"),
  "utf8",
);

describe("Finance V2 Stage 3 — containment (RLS/storage leak closure + approval-inbox compat)", () => {
  it("is a single-transaction, forward-only migration that changes no feature mode", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
    expect(sql).not.toMatch(/insert\s+into\s+app_private\.server_feature_flag_canary_orgs/i);
  });

  it("drops the co-staff + all-building leaks by exact live policy name", () => {
    expect(sql).toContain("DROP POLICY IF EXISTS accounts_select_staff ON public.accounts");
    for (const cmd of ["select", "insert", "update", "delete"]) {
      expect(sql).toContain(`income_expenses_${cmd}_all_buildings`);
      expect(sql).toContain(`income_expense_items_${cmd}_all_buildings`);
    }
    expect(sql).toContain("DROP POLICY IF EXISTS income_expenses_insert_shared ON public.income_expenses");
  });

  it("removes self-grant DML on account_shared_users", () => {
    expect(sql).toContain("DROP POLICY IF EXISTS account_shared_users_insert ON public.account_shared_users");
    expect(sql).toContain("DROP POLICY IF EXISTS account_shared_users_delete ON public.account_shared_users");
  });

  it("revokes REST reads on all 7 approval base tables + possession bindings", () => {
    for (const t of [
      "approval_requests_select_member",
      "approval_request_steps_select_member",
      "approval_request_step_candidates_select_member",
      "approval_decisions_select_member",
      "approval_rule_sets_select_member",
      "approval_step_approvers_select_member",
      "authorization_audit_events_select_member",
    ]) {
      expect(sql).toContain(t);
    }
    expect(sql).toContain("REVOKE SELECT ON public.cashbook_possession_bindings FROM authenticated");
  });

  it("does NOT over-close storage — receipt buckets already org-isolated by the RESTRICTIVE shield", () => {
    // VERIFIED LIVE: can_read_storage_object_v1 already org-scopes income-expense-attachments
    // + payment-receipts (PS03_storage_shield, post-plan). Dropping the PERMISSIVE grant would
    // break legit signed-URL reads with no leak benefit, so Stage-3 must NOT drop them.
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS ie_attachments_select_authenticated ON storage\.objects/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS payment_receipts_select_authenticated ON storage\.objects/);
    expect(sql).toContain("can_read_storage_object_v1");
    expect(sql).toContain("storage_object_links");
  });

  it("adds scoped approval-inbox compat RPCs granted only to authenticated", () => {
    expect(sql).toContain("app_private.resolve_approval_actor_v2()");
    expect(sql).toContain("public.list_my_pending_approvals_compat_v2()");
    expect(sql).toContain("public.get_approval_request_detail_compat_v2(");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.list_my_pending_approvals_compat_v2() TO authenticated");
    // compat RPCs must not expose the raw payload snapshot to REST
    expect(sql).toMatch(/SECURITY DEFINER/);
  });

  it("keeps LEGACY-compat policies (does not over-drop the building/owner/shared contract)", () => {
    // These must NOT be dropped in containment — they carry the LEGACY route.
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS income_expenses_select_rbac\b/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS accounts_select\b(?!_)/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS income_expenses_select_fund_member\b/);
  });
});
