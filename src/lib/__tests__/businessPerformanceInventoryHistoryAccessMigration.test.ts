import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260728040000_business_performance_inventory_history_safe_scope.sql";

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("business-performance inventory history safe-scope repair", () => {
  it("keeps inventory history on the analysis-only occupancy boundary", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.business_performance_inventory_history_v1",
    );
    expect(sql).toMatch(/p_require_restricted\s*=>\s*false/i);
    expect(sql).not.toMatch(/p_require_restricted\s*=>\s*true/i);
  });

  it("preserves definer hardening and the exact authenticated-only ACL", () => {
    const sql = migrationSql();

    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog, app_private, public");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM PUBLIC",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM anon",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM service_role",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) TO authenticated",
    );
  });
});
