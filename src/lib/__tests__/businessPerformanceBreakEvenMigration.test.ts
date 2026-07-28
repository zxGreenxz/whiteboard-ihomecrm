import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260728020000_business_performance_finance_roles_and_break_even.sql";

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("business-performance finance-role and break-even migration", () => {
  it("creates an effective-dated, confirmed and tenant-bound role ledger", () => {
    const sql = migrationSql();

    expect(sql).toContain("CREATE TABLE public.finance_reporting_role_assignments");
    expect(sql).toMatch(/organization_id\s+uuid\s+NOT NULL/i);
    expect(sql).toMatch(/income_expense_type_id\s+uuid\s+NOT NULL/i);
    expect(sql).toMatch(/effective_from\s+date\s+NOT NULL/i);
    expect(sql).toMatch(/effective_to\s+date/i);
    expect(sql).toMatch(/confirmed_at\s+timestamptz\s+NOT NULL/i);
    expect(sql).toMatch(/confirmed_by\s+uuid\s+NOT NULL/i);
    expect(sql).toContain("finance_reporting_role_assignments_role_check");
    expect(sql).toContain("ROOM_RENT_REVENUE");
    expect(sql).toContain("LANDLORD_RENT_FIXED");
    expect(sql).toContain("PASS_THROUGH_EXPENSE");
    expect(sql).toContain("OUTSIDE_BREAK_EVEN_MODEL");
    expect(sql).toContain("finance_reporting_role_assignments_no_overlap");
    expect(sql).toContain("finance_reporting_role_assignments_lookup_idx");
  });

  it("keeps the mapping ledger behind RLS and least-privilege RPCs", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "ALTER TABLE public.finance_reporting_role_assignments ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.finance_reporting_role_assignments FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "business_performance_reporting_roles_v1(uuid, date, uuid[])",
    );
    expect(sql).toContain(
      "business_performance_set_reporting_role_v1(uuid, uuid, text, date)",
    );
    expect(sql).toMatch(
      /business_performance_set_reporting_role_v1[\s\S]*authorize_tenant_action_v3[\s\S]*'categories\.edit'/,
    );
    expect(sql).toMatch(
      /business_performance_reporting_roles_v1[\s\S]*business_performance_exact_scope_v1[\s\S]*p_require_restricted\s*=>\s*true/,
    );
  });

  it("publishes one server-side break-even contract with month and three-month windows", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.business_performance_break_even_v1",
    );
    expect(sql).toContain(
      "business_performance_break_even_v1(uuid, text, date, uuid[])",
    );
    expect(sql).toMatch(/p_basis\s+text/i);
    expect(sql).toMatch(/p_month\s+date/i);
    expect(sql).toContain("business_performance_exact_scope_v1");
    expect(sql).toMatch(/p_require_restricted\s*=>\s*true/);
    expect(sql).toContain("R_room");
    expect(sql).toContain("R_other");
    expect(sql).toContain("R_pass");
    expect(sql).toContain("F_landlord");
    expect(sql).toContain("F_other");
    expect(sql).toContain("V_room");
    expect(sql).toContain("V_other");
    expect(sql).toContain("E_pass");
    expect(sql).toContain("mapping_coverage_pct");
    expect(sql).toContain("missing_landlord_months");
    expect(sql).toContain("outside_model_amount");
    expect(sql).toContain("unmapped_amount");
    expect(sql).toContain("SELECTED_MONTH");
    expect(sql).toContain("THREE_MONTH_AVERAGE");
  });

  it("implements fail-closed formulas and capacity disclosure", () => {
    const sql = migrationSql();

    expect(sql).toContain("CMR_core");
    expect(sql).toContain("CMR_room");
    expect(sql).toContain("R_core_BE");
    expect(sql).toContain("R_room_BE");
    expect(sql).toContain("capacity_current");
    expect(sql).toContain("capacity_blocked");
    expect(sql).toContain("capacity_theory");
    expect(sql).toContain("invalid_rent_room_count");
    expect(sql).toContain("break_even_revenue_available");
    expect(sql).toContain("break_even_occupancy_available");
    expect(sql).toMatch(/CMR_core\s*<=\s*0/i);
    expect(sql).toMatch(/CMR_room\s*<=\s*0/i);
    expect(sql).toMatch(/outside_model_amount\s*>\s*0/i);
    expect(sql).toMatch(/unmapped_amount\s*>\s*0/i);
  });

  it("grants only authenticated execution on the three public entry points", () => {
    const sql = migrationSql();
    const signatures = [
      "public.business_performance_reporting_roles_v1(uuid, date, uuid[])",
      "public.business_performance_set_reporting_role_v1(uuid, uuid, text, date)",
      "public.business_performance_break_even_v1(uuid, text, date, uuid[])",
    ];

    for (const signature of signatures) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM service_role`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    }
  });
});
