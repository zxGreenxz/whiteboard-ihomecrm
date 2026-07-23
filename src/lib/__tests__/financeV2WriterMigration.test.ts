import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723050000_finance_v2_writers.sql"),
  "utf8",
);

describe("Finance V2 Stage 5 — writers-core (manual voucher lifecycle)", () => {
  it("is single-transaction and changes no feature mode", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
  });

  it("defines the private primitives (§7.1)", () => {
    for (const fn of [
      "app_private.resolve_finance_actor_v2",
      "app_private.assert_cashbook_access_v2",
      "app_private.assert_income_expense_flow_owner_v2",
      "app_private.resolve_business_result_v2",
      "app_private.assert_committed_birth_boundary_v2",
    ]) {
      expect(sql).toContain(fn);
    }
  });

  it("defines the 11 public lifecycle RPCs (§7.2)", () => {
    for (const rpc of [
      "public.create_income_expense_v2(",
      "public.approve_income_expense_v2(",
      "public.post_approved_income_expense_v2(",
      "public.approve_and_post_income_expense_v2(",
      "public.request_income_expense_changes_v2(",
      "public.reject_invalid_income_expense_v2(",
      "public.mark_income_expense_disputed_v2(",
      "public.withdraw_income_expense_v2(",
      "public.resubmit_income_expense_v2(",
      "public.cancel_unposted_income_expense_v2(",
      "public.reverse_posted_income_expense_v2(",
    ]) {
      expect(sql).toContain(rpc);
    }
  });

  it("enforces the committed-birth-boundary guard (create->approve/post in one txn fails)", () => {
    expect(sql).toContain("pg_current_xact_id()");
    expect(sql).toMatch(/birth[_ ]?txid|birth boundary/i);
  });

  it("locks in a fixed order and uses canonical_write_operations idempotency (no dual registry)", () => {
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain(
      "ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)",
    );
    expect(sql).toMatch(/different payload/i);
  });

  it("implements the §5.3 review state machine + maker withdraw", () => {
    expect(sql).toContain("'WITHDRAWN_BY_MAKER'");
    expect(sql).toContain("CHANGES_REQUESTED");
    expect(sql).toContain("'REVERSAL'"); // reverse creates a new event
    expect(sql).toContain("'VOUCHER_TOTAL'"); // manual MAIN line basis
  });

  it("is SECURITY DEFINER with pinned search_path and raises 42501 on access denial", () => {
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain("ERRCODE = '42501'");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.create_income_expense_v2(jsonb) TO authenticated");
  });
});
