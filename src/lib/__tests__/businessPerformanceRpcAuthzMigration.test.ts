import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260725001000_business_performance_rpc_authz.sql",
);
const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const hardeningMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260725051000_business_performance_fail_closed_bounds.sql",
);
const hardeningSql = existsSync(hardeningMigrationPath)
  ? readFileSync(hardeningMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

function functionBlock(functionName: string): string {
  const marker = new RegExp(
    `CREATE OR REPLACE FUNCTION ${functionName.replace(/\./g, "\\.")}\\(`,
  );
  const match = marker.exec(sql);
  expect(match, `${functionName} must be defined`).not.toBeNull();

  const start = match?.index ?? 0;
  const next = sql.indexOf("\nCREATE OR REPLACE FUNCTION ", start + 1);
  return sql.slice(start, next >= 0 ? next : sql.length);
}

function hardeningFunctionBlock(functionName: string): string {
  const marker = new RegExp(
    `CREATE OR REPLACE FUNCTION ${functionName.replace(/\./g, "\\.")}\\(`,
  );
  const match = marker.exec(hardeningSql);
  expect(match, `${functionName} must be hardened`).not.toBeNull();

  const start = match?.index ?? 0;
  const next = hardeningSql.indexOf("\nCREATE OR REPLACE FUNCTION ", start + 1);
  return hardeningSql.slice(start, next >= 0 ? next : hardeningSql.length);
}

const publicRpcs = [
  "business_performance_organizations_v1()",
  "business_performance_pnl_v1(uuid, text, date, date, uuid[])",
  "business_performance_snapshot_v1(uuid, uuid[])",
  "business_performance_occupancy_snapshot_v1(uuid, date, uuid[])",
  "business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[])",
  "business_performance_occupancy_monthly_v1(uuid, date, date, uuid[])",
] as const;

const privateHelpers = [
  "app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid)",
  "app_private.business_performance_authorized_buildings_v1(uuid, boolean)",
  "app_private.business_performance_exact_scope_v1(uuid, uuid[], boolean)",
] as const;

const stalePrivateRosterDrop =
  "DROP FUNCTION IF EXISTS app_private.business_performance_authorized_buildings_v1(uuid);";

function definedPublicRpcSignatures(): string[] {
  return Array.from(
    sql.matchAll(
      /CREATE OR REPLACE FUNCTION public\.(business_performance_[a-z0-9_]+)\s*\(([\s\S]*?)\)\s*\nRETURNS TABLE/g,
    ),
    ([, name, parameters]) => {
      const parameterTypes = parameters.trim()
        ? parameters
            .split(",")
            .map((parameter) => parameter.trim().replace(/\s+/g, " "))
            .map((parameter) => parameter.split(" ").slice(1).join(" "))
        : [];
      return `${name}(${parameterTypes.join(", ")})`;
    },
  );
}

describe("business performance RPC authorization migration", () => {
  it("remains one collision-safe forward migration", () => {
    expect(existsSync(migrationPath), `Missing migration: ${migrationPath}`).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });

  it("makes analysis and its legacy view fallback building-scope aware", () => {
    expect(sql).toContain("key IN ('reports_finance.analysis', 'reports_finance.view')");
    expect(sql).toContain(
      "scope_kinds = ARRAY['ORGANIZATION', 'AREA', 'BUILDING']::text[]",
    );
    expect(sql).not.toMatch(/SET required_dimensions\s*=/);
    expect(sql).not.toMatch(
      /key = 'income_expenses\.restricted_view'[\s\S]*?SET[\s\S]*?scope_kinds/,
    );
  });

  it("ships fail-closed permission and temporal bounds as a later forward migration", () => {
    expect(
      existsSync(hardeningMigrationPath),
      `Missing migration: ${hardeningMigrationPath}`,
    ).toBe(true);
    expect(hardeningMigrationPath).toMatch(/20260725051000_/);
    expect(hardeningSql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(hardeningSql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(hardeningSql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    expect(hardeningSql.match(/^DROP FUNCTION IF EXISTS .+;$/gm)).toEqual([
      stalePrivateRosterDrop,
    ]);
    expect(hardeningSql.match(/SECURITY DEFINER/g)).toHaveLength(5);
    expect(
      hardeningSql.match(/SET search_path = pg_catalog, app_private, public/g),
    ).toHaveLength(5);
    expect(
      Array.from(
        hardeningSql.matchAll(
          /CREATE OR REPLACE FUNCTION (?:app_private|public)\.(business_performance_[a-z0-9_]+)\s*\(/g,
        ),
        ([, name]) => name,
      ),
    ).toEqual([
      "business_performance_analysis_decision_v1",
      "business_performance_pnl_v1",
      "business_performance_occupancy_snapshot_v1",
      "business_performance_upcoming_vacancy_v1",
      "business_performance_occupancy_monthly_v1",
    ]);

    for (const signature of [
      "app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid)",
      "public.business_performance_pnl_v1(uuid, text, date, date, uuid[])",
      "public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[])",
      "public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[])",
      "public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[])",
    ]) {
      expect(hardeningSql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      expect(hardeningSql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
      expect(hardeningSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM service_role`,
      );
      expect(hardeningSql).toContain(`COMMENT ON FUNCTION ${signature}`);
    }
    for (const signature of [
      "public.business_performance_pnl_v1(uuid, text, date, date, uuid[])",
      "public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[])",
      "public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[])",
      "public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[])",
    ]) {
      expect(hardeningSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`,
      );
    }
    for (const delegate of [
      "fa_monthly_pnl",
      "fa_monthly_pnl_accrual",
      "fa_snapshot_kpis",
      "occupancy_snapshot_v2",
      "occupancy_upcoming_vacancy_v2",
      "fa_occupancy_monthly",
    ]) {
      expect(hardeningSql).not.toMatch(
        new RegExp(
          `(?:CREATE|DROP)\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${delegate}\\s*\\(`,
          "i",
        ),
      );
      expect(hardeningSql).not.toMatch(
        new RegExp(`(?:REVOKE|GRANT)[^;]+ON FUNCTION public\\.${delegate}\\s*\\(`, "i"),
      );
    }
  });

  it("resolves applicable legacy whole snapshots with presence-aware deny-wins", () => {
    const decision = functionBlock(
      "app_private.business_performance_analysis_decision_v1",
    );

    expect(decision).toContain(
      "COALESCE(sa.permissions, r.permissions) AS permissions",
    );
    expect(decision).not.toMatch(/COALESCE\(\s*sa\.permissions\s*->/);
    expect(decision).toMatch(/sa\.staff_id = p_actor/);
    expect(decision).toMatch(/sa\.organization_id = p_organization_id/);
    expect(decision).toMatch(/r\.organization_id = p_organization_id/);
    expect(decision).toMatch(/sa\.building_id = p_building_id/);
    expect(decision).toMatch(
      /ab\.organization_id = p_organization_id[\s\S]*?ab\.area_id = sa\.area_id[\s\S]*?ab\.building_id = p_building_id/,
    );
    expect(decision).toMatch(
      /sa\.building_id IS NULL[\s\S]*?sa\.area_id IS NULL/,
    );

    for (const action of ["analysis", "view"]) {
      expect(decision).toContain(
        `(permissions -> 'reports_finance') ? '${action}'`,
      );
      expect(decision).toContain(
        `permissions -> 'reports_finance' -> '${action}' IS DISTINCT FROM 'true'::jsonb`,
      );
      expect(decision).toContain(
        `permissions -> 'reports_finance' -> '${action}' = 'true'::jsonb`,
      );
    }
    expect(decision.match(/bool_or\(/g)).toHaveLength(4);
  });

  it("uses legacy detail and view fallback only for canonical DEFAULT_DENY", () => {
    const decision = hardeningFunctionBlock(
      "app_private.business_performance_analysis_decision_v1",
    );

    expect(decision).toContain("app_private.authorize_tenant_action_v3(");
    expect(decision).toContain("'reports_finance.analysis'");
    expect(decision).toContain("'reports_finance.view'");
    expect(decision).toMatch(
      /v_primary_reason\s+IS DISTINCT FROM\s+'DEFAULT_DENY'/,
    );
    expect(decision).toMatch(
      /v_fallback_reason\s+IS DISTINCT FROM\s+'DEFAULT_DENY'/,
    );
    expect(decision).not.toMatch(/NOT IN\s*\([^)]*PERMISSION_INACTIVE_OR_MISSING/);

    const provenance = [
      "CANONICAL_DETAIL_DENY",
      "LEGACY_DETAIL_DENY",
      "CANONICAL_DETAIL_ALLOW",
      "LEGACY_DETAIL_ALLOW",
      "CANONICAL_VIEW_DENY",
      "LEGACY_VIEW_DENY",
      "CANONICAL_VIEW_ALLOW",
      "LEGACY_VIEW_ALLOW",
      "NO_DECISION",
    ];
    for (const reason of provenance) {
      expect(decision).toContain(`'${reason}'`);
    }

    const fallbackCall = decision.indexOf(
      "p_permission_key => 'reports_finance.view'",
    );
    expect(fallbackCall).toBeGreaterThan(-1);
    for (const detailReason of provenance.slice(0, 4)) {
      expect(decision.indexOf(`'${detailReason}'`)).toBeLessThan(fallbackCall);
    }
    expect(decision.indexOf("'LEGACY_DETAIL_DENY'")).toBeLessThan(
      decision.indexOf("'LEGACY_DETAIL_ALLOW'"),
    );
    expect(decision.indexOf("'LEGACY_VIEW_DENY'")).toBeLessThan(
      decision.indexOf("'LEGACY_VIEW_ALLOW'"),
    );
    expect(decision).toMatch(
      /IF NOT COALESCE\(v_primary_allowed, false\)\s+AND v_primary_reason IS DISTINCT FROM 'DEFAULT_DENY' THEN/,
    );
    expect(decision).toMatch(
      /IF NOT COALESCE\(v_fallback_allowed, false\)\s+AND v_fallback_reason IS DISTINCT FROM 'DEFAULT_DENY' THEN/,
    );
    expect(decision).toContain("analysis_provenance jsonb");
  });

  it("applies legacy denials before either canonical allow return", () => {
    const decision = hardeningFunctionBlock(
      "app_private.business_performance_analysis_decision_v1",
    );

    expect(decision.indexOf("IF v_legacy_detail_deny THEN")).toBeLessThan(
      decision.indexOf("'decision_reason', 'CANONICAL_DETAIL_ALLOW'"),
    );
    expect(decision.indexOf("IF v_legacy_view_deny THEN")).toBeLessThan(
      decision.indexOf("'decision_reason', 'CANONICAL_VIEW_ALLOW'"),
    );
  });

  it("builds one authoritative physical-building roster with restricted capability", () => {
    const roster = functionBlock(
      "app_private.business_performance_authorized_buildings_v1",
    );
    const organizations = functionBlock(
      "public.business_performance_organizations_v1",
    );

    expect(roster).toContain("app_private.lock_org_for_decision_v1(");
    expect(roster).toContain("app_private.resolve_finance_actor_v2(");
    expect(roster).toContain(
      "app_private.business_performance_analysis_decision_v1(",
    );
    expect(roster).toContain("public.can_access_building(b.id)");
    expect(roster).toContain("'income_expenses.restricted_view'");
    expect(roster).toContain("p_include_restricted boolean");
    expect(roster).toContain("IF COALESCE(p_include_restricted, false) THEN");
    expect(roster).not.toContain("FROM public.organization_memberships");
    expect(roster).toMatch(/b\.organization_id = p_organization_id/);
    expect(roster).toMatch(/b\.is_virtual = false/);
    expect(roster).toMatch(/b\.deleted_at IS NULL/i);

    expect(organizations).toContain(
      "RETURNS TABLE(organization_id uuid, organization_name text, authorized_buildings jsonb, authorized_physical_building_count bigint, authorization_version bigint)",
    );
    for (const key of [
      "'id'",
      "'name'",
      "'restricted_allowed'",
      "'analysis_provenance'",
    ]) {
      expect(organizations).toContain(key);
    }
    expect(organizations).toContain("jsonb_agg(");
    expect(organizations).toContain("count(*) = count(DISTINCT roster.building_id)");
    expect(organizations).toContain("count(*) > 0");
    expect(organizations).toMatch(
      /ORDER BY[\s\S]*organization_name[\s\S]*organization_id/,
    );
    expect(organizations).not.toMatch(/o\.id::text|building_id::text AS name/i);
  });

  it("defers removal of only the stale private one-argument building-roster overload", () => {
    expect(sql).not.toMatch(/^DROP FUNCTION IF EXISTS .+;$/gm);
    expect(hardeningSql).toContain(`BEGIN;\n\n${stalePrivateRosterDrop}\n\n`);
    expect(hardeningSql.match(/^DROP FUNCTION IF EXISTS .+;$/gm)).toEqual([
      stalePrivateRosterDrop,
    ]);
    expect(sql).not.toMatch(/^DROP FUNCTION IF EXISTS public\./gm);
    expect(hardeningSql).not.toMatch(/^DROP FUNCTION IF EXISTS public\./gm);
  });

  it("normalizes duplicate IDs and rejects every invalid requested scope against the same roster", () => {
    const exactScope = functionBlock(
      "app_private.business_performance_exact_scope_v1",
    );

    expect(exactScope).toContain(
      "app_private.business_performance_authorized_buildings_v1(",
    );
    expect(exactScope).toContain("COALESCE(p_require_restricted, false)");
    expect(exactScope).toContain("p_organization_id IS NULL");
    expect(exactScope).toContain("p_building_ids IS NULL");
    expect(exactScope).toContain("cardinality(p_building_ids) = 0");
    expect(exactScope).toContain("array_position(p_building_ids, NULL::uuid) IS NOT NULL");
    expect(exactScope).toContain(
      "array_agg(DISTINCT requested.building_id ORDER BY requested.building_id)",
    );
    expect(exactScope).not.toContain(
      "cardinality(v_building_ids) <> cardinality(p_building_ids)",
    );
    expect(exactScope).toContain("v_roster_count <> v_distinct_roster_count");
    expect(exactScope).toContain("roster.restricted_allowed");
    expect(exactScope).toContain("Business performance access denied");
    expect(exactScope).toContain("ERRCODE = '42501'");
    expect(exactScope).not.toMatch(/ERRCODE = '22023'/);
  });

  it("keeps exactly the six authenticated-only public SECURITY DEFINER names", () => {
    expect(definedPublicRpcSignatures()).toEqual([...publicRpcs]);

    for (const signature of publicRpcs) {
      expect(sql).toContain(`public.${signature}`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon`);
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${signature} FROM service_role`,
      );
      expect(sql).toContain(
        `GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated`,
      );
      expect(sql).toContain(`COMMENT ON FUNCTION public.${signature}`);
      expect(
        functionBlock(`public.${signature.slice(0, signature.indexOf("("))}`),
      ).toContain("SECURITY DEFINER");
    }

    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.business_performance_/g)).toHaveLength(6);
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(9);
    expect(
      sql.match(/SET search_path = pg_catalog, app_private, public/g),
    ).toHaveLength(9);
    expect(sql).not.toMatch(/is_super_admin|is_superadmin|super_admin/i);

    for (const signature of privateHelpers) {
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM ${role}`);
      }
      expect(sql).toContain(`COMMENT ON FUNCTION ${signature}`);
    }
  });

  it("requires restricted roster access only for P&L and finance snapshot", () => {
    const pnl = functionBlock("public.business_performance_pnl_v1");
    const snapshot = functionBlock("public.business_performance_snapshot_v1");
    const occupancySnapshot = functionBlock(
      "public.business_performance_occupancy_snapshot_v1",
    );
    const upcoming = functionBlock(
      "public.business_performance_upcoming_vacancy_v1",
    );
    const monthly = functionBlock(
      "public.business_performance_occupancy_monthly_v1",
    );

    expect(pnl).toContain("p_require_restricted => true");
    expect(pnl).toMatch(
      /IF p_basis = 'ACCRUAL' THEN[\s\S]*?public\.fa_monthly_pnl_accrual\([\s\S]*?ELSE[\s\S]*?public\.fa_monthly_pnl\(/,
    );
    expect(pnl).not.toMatch(/UNION ALL/);
    expect(snapshot).toContain("p_require_restricted => true");
    for (const occupancy of [occupancySnapshot, upcoming, monthly]) {
      expect(occupancy).toContain("p_require_restricted => false");
    }
  });

  it("rejects invalid temporal inputs with bounded 22023 validation before delegates", () => {
    const pnl = hardeningFunctionBlock("public.business_performance_pnl_v1");
    const occupancySnapshot = hardeningFunctionBlock(
      "public.business_performance_occupancy_snapshot_v1",
    );
    const upcoming = hardeningFunctionBlock(
      "public.business_performance_upcoming_vacancy_v1",
    );
    const monthly = hardeningFunctionBlock(
      "public.business_performance_occupancy_monthly_v1",
    );

    for (const dateRangeWrapper of [pnl, monthly]) {
      expect(dateRangeWrapper).toContain(
        "v_max_date_span_days CONSTANT integer := 400",
      );
      expect(dateRangeWrapper).toMatch(/p_start_date IS NULL/);
      expect(dateRangeWrapper).toMatch(/p_end_date IS NULL/);
      expect(dateRangeWrapper).toMatch(/p_end_date < p_start_date/);
      expect(dateRangeWrapper).toMatch(
        /\(p_end_date - p_start_date\) > v_max_date_span_days/,
      );
      expect(dateRangeWrapper).toContain("ERRCODE = '22023'");
    }

    expect(occupancySnapshot).toMatch(/IF p_as_of_date IS NULL THEN/);
    expect(occupancySnapshot).toContain("ERRCODE = '22023'");

    expect(upcoming).toContain("v_max_window_days CONSTANT integer := 366");
    expect(upcoming).toMatch(/IF p_as_of_date IS NULL THEN/);
    expect(upcoming).toMatch(/p_window_days IS NULL/);
    expect(upcoming).toMatch(/p_window_days < 0/);
    expect(upcoming).toMatch(/p_window_days > v_max_window_days/);
    expect(upcoming).toContain("ERRCODE = '22023'");
    expect(upcoming).toContain("BETWEEN 0 AND p_window_days");
    expect(upcoming).not.toContain("GREATEST(p_window_days, 0)");

    expect(pnl.indexOf("p_start_date IS NULL")).toBeLessThan(
      pnl.indexOf("public.fa_monthly_pnl_accrual("),
    );
    expect(monthly.indexOf("p_start_date IS NULL")).toBeLessThan(
      monthly.indexOf("public.fa_occupancy_monthly("),
    );
  });

  it("fails closed when remaining delegates return rows outside scope", () => {
    for (const functionName of [
      "public.business_performance_pnl_v1",
      "public.business_performance_snapshot_v1",
      "public.business_performance_occupancy_monthly_v1",
    ]) {
      const body = functionBlock(functionName);
      expect(body).toContain("v_row.building_id IS NULL");
      expect(body).toContain("v_row.building_id = ANY(v_building_ids)");
      expect(body).toContain("Business performance access denied");
      expect(body).toContain("ERRCODE = '42501'");
    }

    const snapshot = functionBlock("public.business_performance_snapshot_v1");
    expect(snapshot).toContain("v_seen_building_ids");
    expect(snapshot).toContain("v_row.building_id = ANY(v_seen_building_ids)");
    expect(snapshot).toContain(
      "cardinality(v_seen_building_ids) <> cardinality(v_building_ids)",
    );
  });

  it("inlines an organization-anchored occupancy snapshot without legacy visibility helpers", () => {
    const occupancySnapshot = functionBlock(
      "public.business_performance_occupancy_snapshot_v1",
    );

    expect(occupancySnapshot).not.toContain("public.occupancy_snapshot_v2(");
    expect(occupancySnapshot).not.toContain("can_access_building");
    expect(occupancySnapshot).toContain("WITH allowed AS (");
    expect(occupancySnapshot).toMatch(/b\.organization_id = p_organization_id/);
    expect(occupancySnapshot).toMatch(/b\.id = ANY\(v_building_ids\)/);
    expect(occupancySnapshot).toMatch(/r\.organization_id = p_organization_id/);
    expect(occupancySnapshot).toMatch(/c\.organization_id = p_organization_id/);
    expect(occupancySnapshot).toContain("c.actual_end_date IS NULL");
    expect(occupancySnapshot).toContain("WHEN r.status = 'RESERVED'");
    expect(occupancySnapshot).toContain("WHEN r.status = 'MAINTENANCE'");
    expect(occupancySnapshot).toContain("WHEN r.status = 'AVAILABLE'");
    expect(occupancySnapshot).toContain("GREATEST(rent_price, 0)");
    expect(occupancySnapshot).toContain("v_seen_building_ids");
    expect(occupancySnapshot).toContain(
      "cardinality(v_seen_building_ids) <> cardinality(v_building_ids)",
    );
  });

  it("inlines upcoming vacancy from allowed buildings through org-bound rooms and contracts", () => {
    const upcoming = functionBlock(
      "public.business_performance_upcoming_vacancy_v1",
    );

    expect(upcoming).not.toContain("public.occupancy_upcoming_vacancy_v2(");
    expect(upcoming).toContain("WITH allowed AS (");
    expect(upcoming).toContain("allowed_rooms AS (");
    expect(upcoming.indexOf("WITH allowed AS (")).toBeLessThan(
      upcoming.indexOf("allowed_rooms AS ("),
    );
    expect(upcoming.indexOf("allowed_rooms AS (")).toBeLessThan(
      upcoming.indexOf("eff AS ("),
    );
    expect(upcoming).toMatch(/b\.organization_id = p_organization_id/);
    expect(upcoming).toMatch(/r\.organization_id = p_organization_id/);
    expect(upcoming).toMatch(/c\.organization_id = p_organization_id/);
    expect(upcoming).toMatch(/ce\.organization_id = p_organization_id/g);
    expect(upcoming).toContain("GREATEST(");
    expect(upcoming).toContain("ce.status IN ('APPROVED', 'COMPLETED')");
    expect(upcoming).toContain("SELECT DISTINCT ON (e.room_id)");
    expect(upcoming).toContain("BETWEEN 0 AND GREATEST(p_window_days, 0)");
  });

  it("preserves delegate row types and never redefines or revokes legacy RPCs", () => {
    for (const resultContract of [
      "RETURNS TABLE(month date, building_id uuid, building_name text, is_virtual boolean, revenue numeric, expense numeric, net numeric)",
      "RETURNS TABLE(building_id uuid, building_name text, total_rooms integer, rooms_available integer, rooms_occupied integer, rooms_reserved integer, rooms_maintenance integer, rooms_unavailable integer, vacancy_loss_month numeric, active_contracts bigint, avg_rent numeric, deposit_held numeric, receivable_total numeric, aging_not_due numeric, aging_1_30 numeric, aging_31_60 numeric, aging_61_90 numeric, aging_over_90 numeric)",
      "RETURNS TABLE(building_id uuid, building_name text, total integer, occupied integer, reserved integer, maintenance integer, unavailable integer, available integer, occupancy_pct numeric, committed_pct numeric, missed_revenue numeric, generated_at timestamp with time zone)",
      "RETURNS TABLE(contract_id uuid, contract_number text, building_id uuid, building_name text, room_id uuid, room_name text, effective_end_date date, days_remaining integer, rent_price numeric, extension_applied boolean)",
      "RETURNS TABLE(month date, building_id uuid, building_name text, total_rooms integer, occupied_rooms integer, occupancy_pct numeric)",
    ]) {
      expect(sql).toContain(resultContract);
    }

    for (const delegate of [
      "fa_monthly_pnl",
      "fa_monthly_pnl_accrual",
      "fa_snapshot_kpis",
      "occupancy_snapshot_v2",
      "occupancy_upcoming_vacancy_v2",
      "fa_occupancy_monthly",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(
          `(?:CREATE|DROP)\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${delegate}\\s*\\(`,
          "i",
        ),
      );
      expect(sql).not.toMatch(
        new RegExp(
          `(?:REVOKE|GRANT)[^;]+ON FUNCTION public\\.${delegate}\\s*\\(`,
          "i",
        ),
      );
      expect(sql).not.toMatch(
        new RegExp(`COMMENT\\s+ON FUNCTION public\\.${delegate}\\s*\\(`, "i"),
      );
    }

    for (const delegate of [
      "fa_monthly_pnl",
      "fa_monthly_pnl_accrual",
      "fa_snapshot_kpis",
      "fa_occupancy_monthly",
    ]) {
      expect(sql).toContain(`public.${delegate}(`);
    }
    expect(sql).not.toContain("public.occupancy_snapshot_v2(");
    expect(sql).not.toContain("public.occupancy_upcoming_vacancy_v2(");
  });
});
