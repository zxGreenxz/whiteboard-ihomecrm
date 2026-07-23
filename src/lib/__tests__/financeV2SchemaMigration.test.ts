import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Static migration tests for the Finance V2 (Thu Chi V2) stage manifest. These read the
// migration SQL and assert structural invariants (plan §16.1). They do NOT hit a database.
// This file grows one describe-block per stage as stages land.

function readMigration(basename: string): string {
  return readFileSync(
    resolve(process.cwd(), "supabase/migrations", basename),
    "utf8",
  );
}

describe("Finance V2 Stage 1 — semantics snapshot", () => {
  const sql = readMigration("20260723010000_finance_v2_semantics_snapshot.sql");

  it("is a single-transaction, forward-only, catalog-only migration", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    // NOTIFY only after COMMIT
    expect(sql.indexOf("NOTIFY pgrst")).toBeGreaterThan(sql.indexOf("COMMIT;"));
  });

  it("hard-asserts the reviewed Accounting/V5/RBAC foundation + reuse targets", () => {
    expect(sql).toContain("missing schema app_private");
    expect(sql).toContain("ie_canonical_writer");
    // Control-plane + lifecycle reuse targets (must EXTEND, never fork — §4.2/§6.1/§10.4)
    for (const rel of [
      "app_private.server_feature_flags",
      "app_private.server_feature_flag_canary_orgs",
      "app_private.canonical_write_operations",
      "app_private.income_expense_flow_ownership",
      "app_private.termination_forfeit_authorizations",
      "public.profit_payout_reservations",
      "public.approval_requests",
    ]) {
      expect(sql).toContain(rel);
    }
  });

  it("resolves the live divergence: possession bindings in PUBLIC, candidates in APP_PRIVATE", () => {
    expect(sql).toContain("public.cashbook_possession_bindings");
    expect(sql).toContain("app_private.cashbook_possession_candidates");
  });

  it("pins the exact reuse-target control-plane function signatures", () => {
    expect(sql).toContain("app_private.evaluate_feature_route(text,uuid)");
    expect(sql).toContain(
      "app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric)",
    );
    expect(sql).toContain("set_feature_route_v1");
    // Mirrors (does not reuse) the accounting activation guard
    expect(sql).toContain("assert_accounting_feature_activation_v1");
  });

  it("creates an append-only private baseline snapshot with no client access", () => {
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS app_private.finance_v2_semantics_snapshot",
    );
    expect(sql).toContain("baseline_fingerprint");
    expect(sql).toContain(
      "REVOKE ALL ON app_private.finance_v2_semantics_snapshot FROM PUBLIC",
    );
    expect(sql).toContain("a00_finance_v2_snapshot_immutable");
    expect(sql).toContain("append-only (no UPDATE/DELETE)");
  });

  it("captures the mutable pre-V2 baseline (default, constraint defs, counts, modes)", () => {
    expect(sql).toContain("income_expenses_approval_status_default");
    expect(sql).toContain("approval_requests_state_check");
    expect(sql).toContain("cashbook_possession_bindings_possession_kind_check");
    expect(sql).toContain("pending_kqkd_by_org");
    expect(sql).toContain("feature_flag_modes");
    expect(sql).toContain("finance_v2_objects_present");
    expect(sql).toContain("md5(v_baseline::text)");
  });

  it("does NOT change any feature mode or enroll an org (§13)", () => {
    // Stage 1 must not call the route CAS or insert canary enrollment.
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
    expect(sql).not.toMatch(
      /insert\s+into\s+app_private\.server_feature_flag_canary_orgs/i,
    );
  });
});

describe("Finance V2 Stage 2 — schema-inert + activation guards", () => {
  const sql = readMigration(
    "20260723020000_finance_v2_schema_inert_and_activation_guard.sql",
  );

  it("is a single-transaction, forward-only migration", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.indexOf("NOTIFY pgrst")).toBeGreaterThan(sql.indexOf("COMMIT;"));
  });

  it("creates the posting event ledger + signed lines with subject/generation guards (§6.2)", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.income_expense_postings");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.income_expense_posting_lines");
    expect(sql).toContain("posting_subject_kind IN ('VOUCHER','SALARY_TRANCHE')");
    expect(sql).toContain("amount_basis IN ('VOUCHER_TOTAL','EXTERNAL_TENDER_GROSS','SALARY_TRANCHE_CASH')");
    expect(sql).toContain("event_kind IN ('POSTING','REVERSAL')");
    // one active posting per subject/generation + org idempotency
    expect(sql).toMatch(/organization_id,\s*posting_subject_kind,\s*posting_subject_id,\s*posting_generation/);
    expect(sql).toMatch(/organization_id,\s*idempotency_key/);
    // append-only: reversal is a new event, not an UPDATE/DELETE
    expect(sql).toContain("a00_income_expense_postings_immutable");
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.income_expense_postings/);
  });

  it("creates the evidence registry with ORIGINAL-once and per-tender V5 uniqueness (§6.3)", () => {
    expect(sql).toContain("public.finance_evidence_objects");
    expect(sql).toContain("public.finance_evidence_system_sources");
    expect(sql).toContain("public.income_expense_posting_evidence");
    expect(sql).toContain("provenance_kind IN ('UPLOAD','SYSTEM_REFERENCE')");
    expect(sql).toContain("relation_kind IN ('ORIGINAL','INHERITED_LEGACY_DELTA')");
    expect(sql).toContain("INVOICE_COLLECTION_V5");
  });

  it("expands cashbook access with KNOWER across all three possession constraints (§6.4)", () => {
    // 1) bindings possession_kind, 2) candidates proposed_kind, 3) permission_definitions contract
    expect(sql).toContain("cashbook_possession_bindings_possession_kind_check");
    expect(sql).toContain("cashbook_possession_candidates_proposed_kind_check");
    expect(sql).toContain("permission_definitions_possession_contract_check");
    expect(sql).toContain(
      "accepted_possession_kinds <@ ARRAY['CUSTODIAN'::text, 'OPERATOR'::text, 'KNOWER'::text]",
    );
    // CAS + execution routing
    expect(sql).toContain("app_private.cashbook_access_states");
    expect(sql).toContain("app_private.cashbook_access_mutation_requests");
    expect(sql).toContain("app_private.finance_execution_scopes");
    expect(sql).toContain("app_private.finance_execution_cashbook_candidates");
  });

  it("adds inert header columns + expands idempotency and approval compat (§6.1/§7.4)", () => {
    for (const col of [
      "active_posting_id_v2",
      "recognition_source_mode",
      "review_state",
      "maker_membership_id",
      "birth_txid",
    ]) {
      expect(sql).toContain(col);
    }
    // canonical_write_operations expansion (idempotency authority — no dual registry)
    expect(sql).toContain("expected_posting_version");
    expect(sql).toContain("resulting_approval_version");
    // approval_requests state widened additively to the four new terminal states
    expect(sql).toContain("approval_requests_state_check");
    for (const st of ["APPROVED", "WITHDRAWN", "CHANGES_REQUESTED", "DISPUTED"]) {
      expect(sql).toContain(`'${st}'`);
    }
  });

  it("adds recognition adjustments (append-only) + profit reservation lifecycle (§6.6/§6.7)", () => {
    expect(sql).toContain("public.income_expense_recognition_adjustments");
    // adjustment_kind enum (agents may use IN (...) or = ANY (ARRAY[...]) form)
    expect(sql).toMatch(/adjustment_kind[\s\S]{0,120}LATE_RECOGNITION[\s\S]{0,40}CANCELLATION[\s\S]{0,40}CORRECTION/);
    expect(sql).toContain("reservation_state");
    expect(sql).toContain("reservation_state IN ('HELD','CONSUMED','RELEASED','REVERSED')");
    expect(sql).toContain("consumed_posting_id");
  });

  it("adds salary bundle/tranche/earning + termination move-out subjects (§6.9/§6.10/§6.11)", () => {
    expect(sql).toContain("public.salary_settlement_bundles");
    expect(sql).toContain("public.salary_cash_authorizations");
    expect(sql).toContain("public.salary_settlement_tranches");
    expect(sql).toContain("public.salary_earning_consumptions");
    expect(sql).toContain("consumption_state IN ('HELD','CONSUMED','RELEASED','CLAWED_BACK')");
    expect(sql).toContain("public.termination_move_out_authorizations");
    expect(sql).toContain("public.termination_move_out_settlement_lines");
    expect(sql).toContain("funding_kind IN ('DEPOSIT_OFFSET','CUSTOMER_CREDIT')");
  });

  it("seeds all 7 Finance feature keys as OFF and never flips a mode (§10.4)", () => {
    expect(sql).toContain("INSERT INTO app_private.server_feature_flags");
    for (const key of [
      "income_expense.workflow.v2",
      "income_expense.posting.v2",
      "cashbook.access.v2",
      "income_expense.profit_close.v2",
      "income_expense.read_semantics.v2",
      "contract.commission.settlement.v2",
      "salary.settlement.v2",
    ]) {
      expect(sql).toContain(key);
    }
    expect(sql).toContain("ON CONFLICT (feature_key) DO NOTHING");
    // must NOT transition any mode or enroll a canary org in the schema stage
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
    expect(sql).not.toMatch(/insert\s+into\s+app_private\.server_feature_flag_canary_orgs/i);
  });

  it("installs Finance-specific activation + enrollment guards (mirrors, not reuses, accounting)", () => {
    expect(sql).toContain("app_private.assert_finance_v2_feature_activation_v1");
    expect(sql).toContain("app_private.guard_finance_v2_feature_activation_v1");
    expect(sql).toContain("CREATE TRIGGER a11_finance_v2_activation");
    expect(sql).toContain("app_private.assert_finance_v2_canary_enrollment_v1");
    expect(sql).toContain("CREATE TRIGGER a11_finance_v2_canary_enrollment");
    // cohort CAS wrapper signature present (stubbed until a later stage)
    expect(sql).toContain("app_private.set_finance_feature_cohort_v2");
    // business-policy + attestation authorities present
    expect(sql).toContain("app_private.finance_business_policy_decisions");
  });

  it("installs backfill capture + semantic-event log but attaches no capture trigger yet (§10.0)", () => {
    expect(sql).toContain("app_private.finance_v2_backfill_runs");
    expect(sql).toContain("app_private.finance_v2_backfill_change_log");
    expect(sql).toContain("app_private.finance_v2_semantic_event_log");
    expect(sql).toContain("app_private.finance_v2_capture_change");
    // capture fn exists but is NOT attached to any source table in Stage 2
    expect(sql).not.toMatch(/CREATE TRIGGER\s+\w+\s+.*ON public\.income_expenses\b[\s\S]*?finance_v2_capture_change/i);
  });

  it("keeps new money/access tables client-DML-free and FKs to big tables NOT VALID", () => {
    expect(sql).toContain("REVOKE ALL ON public.income_expense_postings FROM PUBLIC");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("NOT VALID");
    // no client (authenticated/anon) gets DML on the canonical posting ledger
    expect(sql).not.toMatch(/GRANT[^;]*ON public\.income_expense_postings[^;]*TO\s+authenticated/i);
  });
});
