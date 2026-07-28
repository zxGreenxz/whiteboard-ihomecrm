import { describe, expect, it, vi } from "vitest";

import {
  buildBusinessPerformanceAuthzSql,
  DEMO_ORG_ID,
  executeManagementQuery,
  EXPECTED_PROJECT_REF,
  loadAdminConfig,
  parseVerdictResponse,
  PROD_ORG_ID,
  REQUIRED_CASE_IDS,
} from "../test-business-performance-authz.mjs";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEMO_BUILDING_ID = "22222222-2222-4222-8222-222222222222";
const PROD_BUILDING_ID = "33333333-3333-4333-8333-333333333333";
const EXPECTED_CASE_IDS = [
  "harness.expected_42501_capture",
  "catalog.wrapper_acl_exact",
  "legacy.view_fallback_allow_provenance",
  "legacy.detail_true_beats_view_false",
  "legacy.detail_false_beats_view_true",
  "legacy.role_staff_snapshot_false_deny",
  "legacy.applicable_detail_deny_wins",
  "legacy.noncovering_deny_no_bleed",
  "legacy.cross_org_deny_no_bleed",
  "legacy.view_false_deny",
  "legacy.null_detail_deny",
  "legacy.nonboolean_detail_deny",
  "legacy.staff_snapshot_authoritative",
  "legacy.duplicate_scope_deny_wins",
  "canonical.analysis_deny_blocks_fallback",
  "permission_inactive.analysis_helper_denied",
  "permission_inactive.analysis_roster_empty",
  "permission_inactive.analysis_wrapper_denied",
  "permission_inactive.view_helper_denied",
  "permission_inactive.view_roster_empty",
  "permission_inactive.view_wrapper_denied",
  "no_action.empty_roster",
  "no_action.wrapper_denied",
  "analysis_only.occupancy_snapshot_allowed",
  "analysis_only.upcoming_allowed",
  "analysis_only.monthly_allowed",
  "analysis_only.inventory_history_allowed",
  "analysis_only.pnl_denied",
  "analysis_only.snapshot_denied",
  "restricted.pnl_allowed",
  "restricted.snapshot_allowed",
  "gated.inventory_history_allowed",
  "gated.reporting_roles_allowed",
  "gated.break_even_allowed",
  "gated.invoice_cohort_allowed",
  "gated.cash_received_allowed",
  "gated.category_breakdown_allowed",
  "gated.mapping_without_categories_edit_denied",
  "gated.mapping_with_categories_edit_allowed",
  "temporal.pnl_null_start_rejected",
  "temporal.pnl_null_end_rejected",
  "temporal.pnl_reversed_rejected",
  "temporal.pnl_excessive_rejected",
  "temporal.pnl_13_months_allowed",
  "temporal.occupancy_snapshot_null_as_of_rejected",
  "temporal.upcoming_null_as_of_rejected",
  "temporal.upcoming_null_window_rejected",
  "temporal.upcoming_negative_window_rejected",
  "temporal.upcoming_over_max_window_rejected",
  "temporal.monthly_null_start_rejected",
  "temporal.monthly_null_end_rejected",
  "temporal.monthly_reversed_rejected",
  "temporal.monthly_excessive_rejected",
  "lifecycle.membership_suspended.roster_empty",
  "lifecycle.membership_suspended.pnl_denied",
  "lifecycle.membership_suspended.snapshot_denied",
  "lifecycle.membership_suspended.occupancy_snapshot_denied",
  "lifecycle.membership_suspended.upcoming_denied",
  "lifecycle.membership_suspended.monthly_denied",
  "lifecycle.membership_expired.roster_empty",
  "lifecycle.membership_expired.pnl_denied",
  "lifecycle.membership_expired.snapshot_denied",
  "lifecycle.membership_expired.occupancy_snapshot_denied",
  "lifecycle.membership_expired.upcoming_denied",
  "lifecycle.membership_expired.monthly_denied",
  "lifecycle.organization_suspended.roster_empty",
  "lifecycle.organization_suspended.pnl_denied",
  "lifecycle.organization_suspended.snapshot_denied",
  "lifecycle.organization_suspended.occupancy_snapshot_denied",
  "lifecycle.organization_suspended.upcoming_denied",
  "lifecycle.organization_suspended.monthly_denied",
  "scope.cross_org.pnl_denied",
  "scope.cross_org.snapshot_denied",
  "scope.cross_org.occupancy_snapshot_denied",
  "scope.cross_org.upcoming_denied",
  "scope.cross_org.monthly_denied",
  "scope.cross_org.inventory_history_denied",
  "scope.cross_org.reporting_roles_denied",
  "scope.cross_org.break_even_denied",
  "scope.cross_org.invoice_cohort_denied",
  "scope.cross_org.cash_received_denied",
  "scope.cross_org.category_breakdown_denied",
  "scope.mixed.pnl_denied",
  "scope.mixed.snapshot_denied",
  "scope.mixed.occupancy_snapshot_denied",
  "scope.mixed.upcoming_denied",
  "scope.mixed.monthly_denied",
  "scope.null_org_denied",
  "scope.null_ids_denied",
  "scope.empty_ids_denied",
  "scope.null_element_denied",
  "scope.virtual_denied",
  "scope.deleted_denied",
  "scope.duplicate_normalized_success",
  "roster.exact_distinct_ids",
  "occupancy_snapshot.exact_set",
  "finance_snapshot.exact_set",
  "parity.pnl_accrual",
  "parity.pnl_voucher_date",
  "parity.finance_snapshot",
  "parity.occupancy_snapshot",
  "parity.upcoming_vacancy",
  "parity.occupancy_monthly",
];

describe("business-performance authz harness runner", () => {
  it("pins writes to DEMO and refuses a different linked Supabase project", () => {
    expect(DEMO_ORG_ID).toBe("dddd0000-0000-4000-8000-000000000001");
    expect(PROD_ORG_ID).toBe("aaaa0000-0000-4000-8000-000000000001");
    expect(EXPECTED_PROJECT_REF).toBe("tryymsxyyckgbrmmvozx");

    const readFile = vi.fn((url) => {
      const path = String(url).replaceAll("\\", "/");
      if (path.endsWith("CLAUDE.local.md")) return "SUPABASE_PAT=sbp_test_secret";
      if (path.endsWith("supabase/.temp/project-ref")) return `${EXPECTED_PROJECT_REF}\n`;
      throw new Error(`unexpected read: ${path}`);
    });

    expect(loadAdminConfig({ env: {}, readFile })).toEqual({
      pat: "sbp_test_secret",
      projectRef: EXPECTED_PROJECT_REF,
    });
    expect(() =>
      loadAdminConfig({
        env: {
          SUPABASE_PAT: "sbp_test_secret",
          SUPABASE_PROJECT_REF: "wrongproject",
        },
        readFile,
      }),
    ).toThrow(/expected linked project/i);
  });

  it("builds one rollback-only transaction with nested 42501 capture and one JSON verdict", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^ROLLBACK;$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/^COMMIT;$/gm);
    expect(sql).toContain("SET LOCAL statement_timeout");
    expect(sql).toContain("SET LOCAL ROLE authenticated");
    expect(sql).toContain("request.jwt.claims");
    expect(sql).toContain("CREATE TEMP TABLE _bp_authz_results");
    expect(sql).not.toContain("GENERATED ALWAYS AS IDENTITY");
    expect(sql).toContain("SQLSTATE '42501'");
    expect(sql).toContain("SQLERRM = 'Business performance access denied'");
    expect(sql).toContain("WHEN OTHERS THEN");
    expect(sql).toContain("RAISE;");
    expect(sql).toContain("jsonb_build_object(");
    expect(sql).toContain("AS verdict");
    expect(sql.indexOf("AS verdict")).toBeLessThan(sql.lastIndexOf("ROLLBACK;"));
  });

  it("wraps the migration preflight procedure checks in balanced IF parentheses", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql).toContain(
      "IF (to_regprocedure('app_private.business_performance_analysis_decision_v1(uuid,uuid,uuid)') IS NULL",
    );
    expect(sql).toContain(
      "OR to_regprocedure('public.business_performance_category_breakdown_v1(uuid,text,date,date,uuid[])') IS NULL\n  ) THEN",
    );
  });

  it("uses trigger-respecting DEMO fixture DML without superuser-only settings", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql).not.toContain("session_replication_role");
    expect(sql).toContain("DELETE FROM public.staff_assignments");
    expect(sql).toContain("INSERT INTO public.roles");
    expect(sql).toContain("INSERT INTO public.staff_assignments");
    expect(sql).toContain("UPDATE public.buildings");
  });

  it("contains the complete deny-wins, wrapper, invalid-scope, roster, and occupancy matrix", () => {
    expect(REQUIRED_CASE_IDS).toEqual(EXPECTED_CASE_IDS);

    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });
    for (const caseId of EXPECTED_CASE_IDS) {
      expect(sql).toContain(caseId);
      expect(
        sql.split(caseId).length - 1,
        `${caseId} must appear in both the manifest and an executable assertion`,
      ).toBeGreaterThanOrEqual(2);
    }
    for (const rpc of [
      "business_performance_organizations_v1",
      "business_performance_pnl_v1",
      "business_performance_snapshot_v1",
      "business_performance_occupancy_snapshot_v1",
      "business_performance_upcoming_vacancy_v1",
      "business_performance_occupancy_monthly_v1",
      "business_performance_inventory_history_v1",
      "business_performance_reporting_roles_v1",
      "business_performance_set_reporting_role_v1",
      "business_performance_break_even_v1",
      "business_performance_invoice_cohort_v1",
      "business_performance_cash_received_v1",
      "business_performance_category_breakdown_v1",
    ]) {
      expect(sql).toContain(`public.${rpc}(`);
    }
    for (const provenance of [
      "LEGACY_VIEW_ALLOW",
      "LEGACY_DETAIL_ALLOW",
      "LEGACY_DETAIL_DENY",
      "LEGACY_VIEW_DENY",
      "CANONICAL_DETAIL_DENY",
      "NO_DECISION",
      "DEFAULT_DENY",
      "MEMBER_DENY",
    ]) {
      expect(sql).toContain(provenance);
    }
    expect(sql).toContain("_bp_required_cases");
    expect(sql).toContain("authorized_physical_building_count");
    expect(sql).toContain("count(DISTINCT snapshot.building_id)");

    const duplicateScopeStart = sql.indexOf("WITH duplicate_snapshot AS MATERIALIZED");
    const duplicateScopeEnd = sql.indexOf("RESET ROLE;", duplicateScopeStart);
    const duplicateScope = sql.slice(duplicateScopeStart, duplicateScopeEnd);
    expect(duplicateScopeStart).toBeGreaterThanOrEqual(0);
    expect(duplicateScope).toContain("'scope.duplicate_normalized_success'");
    expect(duplicateScope).toContain(
      "ARRAY[(SELECT demo_building_id FROM _bp_authz_fixture), (SELECT demo_building_id FROM _bp_authz_fixture)]::uuid[]",
    );
    expect(duplicateScope).toContain("count(*) = 1");
    expect(duplicateScope).toContain(
      "count(DISTINCT duplicate_snapshot.building_id) = 1",
    );
    expect(duplicateScope).toContain(
      "bool_and(duplicate_snapshot.building_id = fixture.demo_building_id)",
    );
    expect(duplicateScope).toContain("'requested_count', 2");
    expect(duplicateScope).toContain("'requested_distinct_count', 1");
    expect(sql).not.toContain("scope.duplicate_denied");
  });

  it("deactivates each canonical finance permission and proves legacy true cannot reopen access", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    for (const permissionKey of [
      "reports_finance.analysis",
      "reports_finance.view",
    ]) {
      expect(sql).toContain(`WHERE key = '${permissionKey}';`);
    }
    for (const caseId of [
      "permission_inactive.analysis_helper_denied",
      "permission_inactive.analysis_roster_empty",
      "permission_inactive.analysis_wrapper_denied",
      "permission_inactive.view_helper_denied",
      "permission_inactive.view_roster_empty",
      "permission_inactive.view_wrapper_denied",
    ]) {
      expect(sql).toContain(`'${caseId}'`);
    }
    expect(sql).toContain("PERMISSION_INACTIVE_OR_MISSING");
    expect(sql).toContain("SET is_active = false");
    expect(sql).toContain("SET is_active = true");
  });

  it("captures every invalid temporal boundary as 22023 while retaining the 13-month UI range", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql).toContain("CREATE OR REPLACE FUNCTION pg_temp._bp_expect_22023");
    expect(sql).toContain("WHEN SQLSTATE '22023' THEN");
    for (const caseId of [
      "temporal.pnl_null_start_rejected",
      "temporal.pnl_null_end_rejected",
      "temporal.pnl_reversed_rejected",
      "temporal.pnl_excessive_rejected",
      "temporal.pnl_13_months_allowed",
      "temporal.occupancy_snapshot_null_as_of_rejected",
      "temporal.upcoming_null_as_of_rejected",
      "temporal.upcoming_null_window_rejected",
      "temporal.upcoming_negative_window_rejected",
      "temporal.upcoming_over_max_window_rejected",
      "temporal.monthly_null_start_rejected",
      "temporal.monthly_null_end_rejected",
      "temporal.monthly_reversed_rejected",
      "temporal.monthly_excessive_rejected",
    ]) {
      expect(sql).toContain(`'${caseId}'`);
    }
    expect(sql).toContain("'2025-02-01', '2026-02-28'");
    expect(sql).toContain("current_date, 367");
  });

  it("keeps grants in place while lifecycle suspension and expiry deny the roster and all metric wrappers", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql).toContain("SET CONSTRAINTS ALL DEFERRED");
    expect(sql).toContain("SET status = 'SUSPENDED'");
    expect(sql).toContain("SET valid_to = clock_timestamp() - interval '1 second'");
    for (const prefix of [
      "lifecycle.membership_suspended",
      "lifecycle.membership_expired",
      "lifecycle.organization_suspended",
    ]) {
      for (const suffix of [
        "roster_empty",
        "pnl_denied",
        "snapshot_denied",
        "occupancy_snapshot_denied",
        "upcoming_denied",
        "monthly_denied",
      ]) {
        expect(sql).toContain(`'${prefix}.${suffix}'`);
      }
    }

    const lifecycleStart = sql.indexOf(
      "-- Membership and organization lifecycle changes must override retained grants.",
    );
    const lifecycleEnd = sql.indexOf("WITH finance_snapshot AS MATERIALIZED", lifecycleStart);
    const lifecycleSql = sql.slice(lifecycleStart, lifecycleEnd);
    expect(lifecycleStart).toBeGreaterThanOrEqual(0);
    expect(lifecycleSql).not.toContain("_bp_clear_canonical");
    expect(lifecycleSql).not.toContain("DELETE FROM public.staff_assignments");
    expect(lifecycleSql).not.toContain("DELETE FROM public.member_permission_overrides");
  });

  it("gates the exact public wrapper catalog and keeps private helpers client-inexecutable", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql).toContain("'catalog.wrapper_acl_exact'");
    for (const signature of [
      "business_performance_organizations_v1()",
      "business_performance_pnl_v1(uuid, text, date, date, uuid[])",
      "business_performance_snapshot_v1(uuid, uuid[])",
      "business_performance_occupancy_snapshot_v1(uuid, date, uuid[])",
      "business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[])",
      "business_performance_occupancy_monthly_v1(uuid, date, date, uuid[])",
      "business_performance_inventory_history_v1(uuid, date, date, uuid[])",
      "business_performance_reporting_roles_v1(uuid, date, uuid[])",
      "business_performance_set_reporting_role_v1(uuid, uuid, text, date)",
      "business_performance_break_even_v1(uuid, text, date, uuid[])",
      "business_performance_invoice_cohort_v1(uuid, date, uuid[])",
      "business_performance_cash_received_v1(uuid, date, uuid[])",
      "business_performance_category_breakdown_v1(uuid, text, date, date, uuid[])",
    ]) {
      expect(sql).toContain(signature);
    }
    for (const signature of [
      "business_performance_analysis_decision_v1(uuid, uuid, uuid)",
      "business_performance_authorized_buildings_v1(uuid, boolean)",
      "business_performance_exact_scope_v1(uuid, uuid[], boolean)",
    ]) {
      expect(sql).toContain(signature);
    }
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain("search_path=pg_catalog, app_private, public");
    expect(sql).toContain("has_function_privilege('authenticated'");
    expect(sql).toContain("has_function_privilege('anon'");
    expect(sql).toContain("has_function_privilege('service_role'");
    expect(sql).toContain("acl.grantee = 0");
  });

  it("executes authorized and cross-organization probes for every gated data RPC", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    for (const caseId of [
      "gated.inventory_history_allowed",
      "gated.reporting_roles_allowed",
      "gated.break_even_allowed",
      "gated.invoice_cohort_allowed",
      "gated.cash_received_allowed",
      "gated.category_breakdown_allowed",
      "gated.mapping_without_categories_edit_denied",
      "gated.mapping_with_categories_edit_allowed",
      "scope.cross_org.inventory_history_denied",
      "scope.cross_org.reporting_roles_denied",
      "scope.cross_org.break_even_denied",
      "scope.cross_org.invoice_cohort_denied",
      "scope.cross_org.cash_received_denied",
      "scope.cross_org.category_breakdown_denied",
    ]) {
      expect(sql).toContain(`'${caseId}'`);
    }
    expect(sql).toContain("pg_temp._bp_add_org_override('categories.edit', 'ALLOW')");
    expect(sql).toContain("FROM public.income_expense_types type_row");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION pg_temp._bp_expect_mapping_42501");
    expect(sql).toContain("SQLERRM = 'Business performance mapping access denied'");
  });

  it("normalizes duplicate finance snapshot scope to one exact distinct row", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });
    const blockStart = sql.indexOf("WITH finance_snapshot AS MATERIALIZED");
    const blockEnd = sql.indexOf("SELECT pg_temp._bp_assert_parity", blockStart);
    const block = sql.slice(blockStart, blockEnd);

    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(block).toContain("'finance_snapshot.exact_set'");
    expect(block).toContain(
      "ARRAY[(SELECT demo_building_id FROM _bp_authz_fixture), (SELECT demo_building_id FROM _bp_authz_fixture)]::uuid[]",
    );
    expect(block).toContain("count(*) = 1");
    expect(block).toContain("count(DISTINCT finance_snapshot.building_id) = 1");
    expect(block).toContain(
      "bool_and(finance_snapshot.building_id = fixture.demo_building_id)",
    );
  });

  it("compares every wrapper and delegate with EXCEPT ALL in both directions", () => {
    const sql = buildBusinessPerformanceAuthzSql({
      actorId: ACTOR_ID,
      demoBuildingId: DEMO_BUILDING_ID,
      prodBuildingId: PROD_BUILDING_ID,
    });

    expect(sql).toContain("CREATE OR REPLACE FUNCTION pg_temp._bp_assert_parity");
    expect(sql).toContain(
      "SELECT * FROM wrapper_rows EXCEPT ALL SELECT * FROM delegate_rows",
    );
    expect(sql).toContain(
      "SELECT * FROM delegate_rows EXCEPT ALL SELECT * FROM wrapper_rows",
    );
    for (const [caseId, delegate] of [
      ["parity.pnl_accrual", "public.fa_monthly_pnl_accrual("],
      ["parity.pnl_voucher_date", "public.fa_monthly_pnl("],
      ["parity.finance_snapshot", "public.fa_snapshot_kpis("],
      ["parity.occupancy_snapshot", "public.occupancy_snapshot_v2("],
      ["parity.upcoming_vacancy", "public.occupancy_upcoming_vacancy_v2("],
      ["parity.occupancy_monthly", "public.fa_occupancy_monthly("],
    ]) {
      expect(sql).toContain(`'${caseId}'`);
      expect(sql).toContain(delegate);
    }
    expect(sql).toContain("p_require_nonempty");
    expect(sql).toContain("generated_at is intentionally excluded from parity");
  });

  it("sends exactly one Management API SQL request and redacts the PAT on failure", async () => {
    const pat = "sbp_do_not_log_me";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => `database rejected ${pat}`,
    }));

    let thrown;
    try {
      await executeManagementQuery(
        "BEGIN; SELECT 1; ROLLBACK;",
        { pat, projectRef: EXPECTED_PROJECT_REF },
        fetchImpl,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("[REDACTED]");
    expect(thrown.message).not.toContain(pat);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses the final JSON verdict and rejects malformed Management API responses", () => {
    const assertions = REQUIRED_CASE_IDS.map((caseId) => ({
      case_id: caseId,
      passed: true,
      detail: null,
    }));
    const verdict = {
      passed: true,
      assertion_count: assertions.length,
      failed_count: 0,
      assertions,
    };

    expect(parseVerdictResponse(JSON.stringify([{ verdict }]))).toEqual(verdict);
    for (const body of ["not-json", "[]", '[{"verdict":null}]']) {
      expect(() => parseVerdictResponse(body)).toThrow(/verdict|JSON/i);
    }
    for (const malformedVerdict of [
      { ...verdict, assertion_count: 3 },
      { ...verdict, failed_count: 1 },
      {
        ...verdict,
        assertions: [
          verdict.assertions[0],
          verdict.assertions[0],
          ...verdict.assertions.slice(2),
        ],
      },
      {
        ...verdict,
        assertions: [
          { ...verdict.assertions[0], passed: "yes" },
          ...verdict.assertions.slice(1),
        ],
      },
      {
        ...verdict,
        assertions: [
          { ...verdict.assertions[0], case_id: "not.required" },
          ...verdict.assertions.slice(1),
        ],
      },
    ]) {
      expect(() =>
        parseVerdictResponse(JSON.stringify([{ verdict: malformedVerdict }])),
      ).toThrow(/verdict/i);
    }
  });
});
