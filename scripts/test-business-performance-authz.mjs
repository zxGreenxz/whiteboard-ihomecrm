// Rollback-only authorization matrix for the business-performance RPC boundary.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PROJECT_REF = "tryymsxyyckgbrmmvozx";
export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
export const DEMO_OWNER_EMAIL = "demo.chunha@username.ihomecrm.local";
export const REQUIRED_CASE_IDS = Object.freeze([
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
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readOptionalFile(url, readFile) {
  try {
    return readFile(url, "utf8");
  } catch {
    return null;
  }
}

export function loadAdminConfig({
  env = process.env,
  readFile = readFileSync,
} = {}) {
  let pat = env.SUPABASE_PAT?.trim();
  if (!pat) {
    const local = readOptionalFile(
      new URL("../CLAUDE.local.md", import.meta.url),
      readFile,
    );
    pat = local?.match(/\bsbp_[A-Za-z0-9_-]+\b/)?.[0];
  }
  if (!pat) {
    throw new Error(
      "Missing Supabase PAT (set SUPABASE_PAT or configure CLAUDE.local.md)",
    );
  }

  let projectRef = env.SUPABASE_PROJECT_REF?.trim();
  if (!projectRef) {
    projectRef = readOptionalFile(
      new URL("../supabase/.temp/project-ref", import.meta.url),
      readFile,
    )?.trim();
  }
  if (!projectRef) {
    const linked = readOptionalFile(
      new URL("../supabase/.temp/linked-project.json", import.meta.url),
      readFile,
    );
    if (linked) {
      try {
        projectRef = JSON.parse(linked).ref?.trim();
      } catch {
        throw new Error("Invalid supabase/.temp/linked-project.json");
      }
    }
  }
  if (!projectRef) {
    const config = readOptionalFile(
      new URL("../supabase/config.toml", import.meta.url),
      readFile,
    );
    projectRef = config?.match(/project_id\s*=\s*"([a-z0-9]+)"/i)?.[1];
  }
  if (!projectRef || !/^[a-z0-9]+$/i.test(projectRef)) {
    throw new Error("Missing or invalid linked Supabase project reference");
  }
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `Expected linked project ${EXPECTED_PROJECT_REF}, received ${projectRef}`,
    );
  }

  return { pat, projectRef };
}

function redact(value, secret) {
  return secret
    ? String(value).replaceAll(secret, "[REDACTED]")
    : String(value);
}

export async function executeManagementQuery(
  query,
  { pat, projectRef },
  fetchImpl = fetch,
) {
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error(`Refusing Management API query for unexpected project ${projectRef}`);
  }

  let response;
  try {
    response = await fetchImpl(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pat}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Supabase Management SQL request failed: ${redact(message, pat)}`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Supabase Management SQL failed (${response.status}): ${redact(body, pat).slice(0, 4000)}`,
    );
  }
  return body;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function optionalUuidLiteral(value, fallbackSql) {
  if (value === undefined) return fallbackSql;
  if (!UUID_RE.test(value)) throw new Error(`Invalid UUID fixture override: ${value}`);
  return `${sqlLiteral(value)}::uuid`;
}

export function buildBusinessPerformanceAuthzSql({
  actorId,
  demoBuildingId,
  prodBuildingId,
} = {}) {
  const actorSql = optionalUuidLiteral(
    actorId,
    `(SELECT id FROM auth.users WHERE email = ${sqlLiteral(DEMO_OWNER_EMAIL)})`,
  );
  const demoBuildingSql = optionalUuidLiteral(
    demoBuildingId,
    `(SELECT id FROM public.buildings
       WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
         AND deleted_at IS NULL AND NOT is_virtual
       ORDER BY lower(name) COLLATE "C", id LIMIT 1)`,
  );
  const prodBuildingSql = optionalUuidLiteral(
    prodBuildingId,
    `(SELECT id FROM public.buildings
       WHERE organization_id = ${sqlLiteral(PROD_ORG_ID)}::uuid
         AND deleted_at IS NULL AND NOT is_virtual
       ORDER BY lower(name) COLLATE "C", id LIMIT 1)`,
  );
  const requiredCaseValues = REQUIRED_CASE_IDS.map(
    (caseId, index) => `(${index + 1}, ${sqlLiteral(caseId)})`,
  ).join(",\n  ");

  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE _bp_authz_fixture ON COMMIT DROP AS
SELECT
  ${sqlLiteral(DEMO_ORG_ID)}::uuid AS demo_organization_id,
  ${sqlLiteral(PROD_ORG_ID)}::uuid AS prod_organization_id,
  ${actorSql} AS actor_id,
  (SELECT id FROM public.organization_memberships
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND user_id = ${actorSql}
      AND status = 'ACTIVE'
      AND COALESCE(valid_from, '-infinity'::timestamptz) <= clock_timestamp()
      AND (valid_to IS NULL OR valid_to > clock_timestamp())
    ORDER BY id LIMIT 1) AS membership_id,
  (SELECT status FROM public.organization_memberships
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND user_id = ${actorSql}
      AND status = 'ACTIVE'
      AND COALESCE(valid_from, '-infinity'::timestamptz) <= clock_timestamp()
      AND (valid_to IS NULL OR valid_to > clock_timestamp())
    ORDER BY id LIMIT 1) AS original_membership_status,
  (SELECT valid_from FROM public.organization_memberships
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND user_id = ${actorSql}
      AND status = 'ACTIVE'
      AND COALESCE(valid_from, '-infinity'::timestamptz) <= clock_timestamp()
      AND (valid_to IS NULL OR valid_to > clock_timestamp())
    ORDER BY id LIMIT 1) AS original_membership_valid_from,
  (SELECT valid_to FROM public.organization_memberships
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND user_id = ${actorSql}
      AND status = 'ACTIVE'
      AND COALESCE(valid_from, '-infinity'::timestamptz) <= clock_timestamp()
      AND (valid_to IS NULL OR valid_to > clock_timestamp())
    ORDER BY id LIMIT 1) AS original_membership_valid_to,
  (SELECT status FROM public.organizations
    WHERE id = ${sqlLiteral(DEMO_ORG_ID)}::uuid) AS original_organization_status,
  ${demoBuildingSql} AS demo_building_id,
  (SELECT id FROM public.buildings
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND deleted_at IS NULL AND NOT is_virtual
      AND id <> ${demoBuildingSql}
    ORDER BY lower(name) COLLATE "C", id LIMIT 1) AS other_demo_building_id,
  ${prodBuildingSql} AS prod_building_id,
  (SELECT ab.area_id
    FROM public.area_buildings ab
    JOIN public.areas area
      ON area.id = ab.area_id
     AND area.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
     AND area.deleted_at IS NULL
    WHERE ab.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND ab.building_id = ${demoBuildingSql}
    ORDER BY ab.area_id LIMIT 1) AS demo_area_id,
  (SELECT user_id FROM public.buildings WHERE id = ${demoBuildingSql}) AS demo_owner_id,
  (SELECT type_row.id
     FROM public.income_expense_types type_row
    WHERE type_row.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND upper(type_row.type) IN ('INCOME', 'EXPENSE')
      AND NOT COALESCE(type_row.is_deposit, false)
    ORDER BY type_row.id
    LIMIT 1) AS demo_type_id;

DO $bp_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _bp_authz_fixture
    WHERE actor_id IS NULL
       OR membership_id IS NULL
       OR original_membership_status IS DISTINCT FROM 'ACTIVE'
       OR original_membership_valid_from IS NULL
       OR original_organization_status IS DISTINCT FROM 'ACTIVE'
       OR demo_building_id IS NULL
       OR other_demo_building_id IS NULL
       OR prod_building_id IS NULL
       OR demo_area_id IS NULL
       OR demo_owner_id IS NULL
       OR demo_type_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Business-performance authz fixture is incomplete';
  END IF;
  IF (to_regprocedure('app_private.business_performance_analysis_decision_v1(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.business_performance_organizations_v1()') IS NULL
     OR to_regprocedure('public.business_performance_pnl_v1(uuid,text,date,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_snapshot_v1(uuid,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_occupancy_snapshot_v1(uuid,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_upcoming_vacancy_v1(uuid,date,integer,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_occupancy_monthly_v1(uuid,date,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_inventory_history_v1(uuid,date,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_reporting_roles_v1(uuid,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_set_reporting_role_v1(uuid,uuid,text,date)') IS NULL
     OR to_regprocedure('public.business_performance_break_even_v1(uuid,text,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_invoice_cohort_v1(uuid,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_cash_received_v1(uuid,date,uuid[])') IS NULL
     OR to_regprocedure('public.business_performance_category_breakdown_v1(uuid,text,date,date,uuid[])') IS NULL
  ) THEN
    RAISE EXCEPTION 'Business-performance authz migration is not applied';
  END IF;
  IF (
    SELECT count(*) <> 2 OR NOT bool_and(definition.is_active)
    FROM public.permission_definitions definition
    WHERE definition.key IN ('reports_finance.analysis', 'reports_finance.view')
  ) THEN
    RAISE EXCEPTION 'Business-performance permission definitions must start active';
  END IF;
END
$bp_preflight$;

CREATE TEMP TABLE _bp_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _bp_required_cases(sequence, case_id) VALUES
  ${requiredCaseValues};

CREATE TEMP TABLE _bp_authz_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb
) ON COMMIT DROP;

CREATE TEMP TABLE _bp_authz_ids ON COMMIT DROP AS
SELECT
  gen_random_uuid() AS role_full_id,
  gen_random_uuid() AS role_area_id,
  gen_random_uuid() AS role_building_id,
  gen_random_uuid() AS assignment_full_id,
  gen_random_uuid() AS assignment_area_id,
  gen_random_uuid() AS assignment_building_id;

CREATE OR REPLACE FUNCTION pg_temp._bp_clear_canonical()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $bp_clear_canonical$
BEGIN
  DELETE FROM public.member_override_scopes edge
  USING public.member_permission_overrides override_row, pg_temp._bp_authz_fixture fixture
  WHERE edge.organization_id = fixture.demo_organization_id
    AND edge.override_id = override_row.id
    AND override_row.organization_id = fixture.demo_organization_id
    AND override_row.membership_id = fixture.membership_id
    AND override_row.permission_key IN (
      'reports_finance.analysis',
      'reports_finance.view',
      'income_expenses.restricted_view',
      'categories.edit'
    );

  DELETE FROM public.member_permission_overrides override_row
  USING pg_temp._bp_authz_fixture fixture
  WHERE override_row.organization_id = fixture.demo_organization_id
    AND override_row.membership_id = fixture.membership_id
    AND override_row.permission_key IN (
      'reports_finance.analysis',
      'reports_finance.view',
      'income_expenses.restricted_view',
      'categories.edit'
    );

  DELETE FROM public.role_permissions permission
  USING public.role_bindings binding, pg_temp._bp_authz_fixture fixture
  WHERE binding.organization_id = fixture.demo_organization_id
    AND binding.membership_id = fixture.membership_id
    AND permission.organization_id = binding.organization_id
    AND permission.role_id = binding.role_id
    AND permission.permission_key IN (
      'reports_finance.analysis',
      'reports_finance.view',
      'income_expenses.restricted_view',
      'categories.edit'
    );

  DELETE FROM app_private.tenant_emergency_denies deny_row
  USING pg_temp._bp_authz_fixture fixture
  WHERE deny_row.organization_id = fixture.demo_organization_id
    AND (
      deny_row.permission_key IS NULL
      OR deny_row.permission_key IN (
        'reports_finance.analysis',
        'reports_finance.view',
        'income_expenses.restricted_view',
        'categories.edit'
      )
    );
END
$bp_clear_canonical$;

CREATE OR REPLACE FUNCTION pg_temp._bp_set_legacy(
  p_full_role jsonb,
  p_full_staff jsonb,
  p_area_role jsonb,
  p_area_staff jsonb,
  p_building_role jsonb,
  p_building_staff jsonb,
  p_building_scope uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $bp_set_legacy$
BEGIN
  UPDATE public.roles role
  SET permissions = CASE role.id
    WHEN ids.role_full_id THEN p_full_role
    WHEN ids.role_area_id THEN p_area_role
    WHEN ids.role_building_id THEN p_building_role
  END
  FROM pg_temp._bp_authz_ids ids
  WHERE role.id IN (ids.role_full_id, ids.role_area_id, ids.role_building_id);

  UPDATE public.staff_assignments assignment
  SET permissions = CASE assignment.id
        WHEN ids.assignment_full_id THEN p_full_staff
        WHEN ids.assignment_area_id THEN p_area_staff
        WHEN ids.assignment_building_id THEN p_building_staff
      END,
      building_id = CASE
        WHEN assignment.id = ids.assignment_building_id THEN p_building_scope
        ELSE assignment.building_id
      END
  FROM pg_temp._bp_authz_ids ids
  WHERE assignment.id IN (
    ids.assignment_full_id,
    ids.assignment_area_id,
    ids.assignment_building_id
  );
END
$bp_set_legacy$;

CREATE OR REPLACE FUNCTION pg_temp._bp_add_override(
  p_permission_key text,
  p_effect text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $bp_add_override$
DECLARE
  v_override_id uuid := gen_random_uuid();
  v_scope_id uuid;
BEGIN
  SELECT scope.id
    INTO v_scope_id
  FROM public.authorization_scopes scope
  CROSS JOIN pg_temp._bp_authz_fixture fixture
  WHERE scope.organization_id = fixture.demo_organization_id
    AND scope.scope_type = 'BUILDING'
    AND scope.building_id = fixture.demo_building_id;

  IF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'Missing DEMO building authorization scope';
  END IF;

  INSERT INTO public.member_permission_overrides (
    id, organization_id, membership_id, permission_key, effect,
    reason, created_by, scope_mode
  )
  SELECT
    v_override_id, fixture.demo_organization_id, fixture.membership_id,
    p_permission_key, p_effect, 'business-performance rollback authz test',
    fixture.actor_id, 'SCOPED'
  FROM pg_temp._bp_authz_fixture fixture;

  INSERT INTO public.member_override_scopes(organization_id, override_id, scope_id)
  SELECT fixture.demo_organization_id, v_override_id, v_scope_id
  FROM pg_temp._bp_authz_fixture fixture;
END
$bp_add_override$;

CREATE OR REPLACE FUNCTION pg_temp._bp_add_org_override(
  p_permission_key text,
  p_effect text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $bp_add_org_override$
DECLARE
  v_override_id uuid := gen_random_uuid();
  v_scope_id uuid;
BEGIN
  SELECT scope.id
    INTO v_scope_id
  FROM public.authorization_scopes scope
  CROSS JOIN pg_temp._bp_authz_fixture fixture
  WHERE scope.organization_id = fixture.demo_organization_id
    AND scope.scope_type = 'ORGANIZATION';

  IF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'Missing DEMO organization authorization scope';
  END IF;

  INSERT INTO public.member_permission_overrides (
    id, organization_id, membership_id, permission_key, effect,
    reason, created_by, scope_mode
  )
  SELECT
    v_override_id, fixture.demo_organization_id, fixture.membership_id,
    p_permission_key, p_effect, 'business-performance rollback authz test',
    fixture.actor_id, 'ORGANIZATION'
  FROM pg_temp._bp_authz_fixture fixture;

  INSERT INTO public.member_override_scopes(organization_id, override_id, scope_id)
  SELECT fixture.demo_organization_id, v_override_id, v_scope_id
  FROM pg_temp._bp_authz_fixture fixture;
END
$bp_add_org_override$;

CREATE OR REPLACE FUNCTION pg_temp._bp_assert_decision(
  p_case_id text,
  p_expected_allowed boolean,
  p_expected_provenance jsonb,
  p_organization_id uuid,
  p_building_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $bp_assert_decision$
DECLARE
  v_allowed boolean;
  v_version bigint;
  v_provenance jsonb;
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT decision.allowed, decision.authorization_version, decision.analysis_provenance
    INTO v_allowed, v_version, v_provenance
  FROM app_private.business_performance_analysis_decision_v1(
    p_organization_id => p_organization_id,
    p_actor => (SELECT actor_id FROM pg_temp._bp_authz_fixture),
    p_building_id => p_building_id
  ) AS decision;

  INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
  VALUES (
    p_case_id,
    v_allowed IS NOT DISTINCT FROM p_expected_allowed
      AND COALESCE(v_provenance @> p_expected_provenance, false),
    jsonb_build_object(
      'allowed', v_allowed,
      'authorization_version', v_version,
      'provenance', v_provenance,
      'expected_allowed', p_expected_allowed,
      'expected_provenance', p_expected_provenance
    )
  );
END
$bp_assert_decision$;

CREATE OR REPLACE FUNCTION pg_temp._bp_assert_cross_org_no_bleed(p_case_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $bp_assert_cross_org_no_bleed$
DECLARE
  v_prod_allowed boolean;
  v_prod_provenance jsonb;
  v_demo_allowed boolean;
  v_demo_provenance jsonb;
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(
    (SELECT prod_organization_id FROM pg_temp._bp_authz_fixture)
  );
  SELECT decision.allowed, decision.analysis_provenance
    INTO v_prod_allowed, v_prod_provenance
  FROM pg_temp._bp_authz_fixture fixture
  CROSS JOIN LATERAL app_private.business_performance_analysis_decision_v1(
    fixture.actor_id,
    fixture.prod_organization_id,
    fixture.prod_building_id
  ) AS decision;

  PERFORM app_private.lock_org_for_decision_v1(
    (SELECT demo_organization_id FROM pg_temp._bp_authz_fixture)
  );
  SELECT decision.allowed, decision.analysis_provenance
    INTO v_demo_allowed, v_demo_provenance
  FROM pg_temp._bp_authz_fixture fixture
  CROSS JOIN LATERAL app_private.business_performance_analysis_decision_v1(
    fixture.actor_id,
    fixture.demo_organization_id,
    fixture.demo_building_id
  ) AS decision;

  INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
  VALUES (
    p_case_id,
    v_prod_allowed IS FALSE
      AND COALESCE(v_prod_provenance @> '{"decision_reason":"CANONICAL_DETAIL_DENY","canonical_decision_reason":"MEMBERSHIP_INACTIVE_OR_MISSING","fallback_used":false}'::jsonb, false)
      AND v_demo_allowed IS TRUE
      AND COALESCE(v_demo_provenance @> '{"decision_reason":"LEGACY_DETAIL_ALLOW","canonical_decision_reason":"DEFAULT_DENY","fallback_used":false}'::jsonb, false),
    jsonb_build_object(
      'prod_allowed', v_prod_allowed,
      'prod_provenance', v_prod_provenance,
      'demo_allowed', v_demo_allowed,
      'demo_provenance', v_demo_provenance
    )
  );
END
$bp_assert_cross_org_no_bleed$;

CREATE OR REPLACE FUNCTION pg_temp._bp_expect_42501(
  p_case_id text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $bp_expect_42501$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
    VALUES (p_case_id, false, jsonb_build_object('expected_sqlstate', '42501'));
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      IF SQLERRM = 'Business performance access denied' THEN
        INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
        VALUES (p_case_id, true, jsonb_build_object('sqlstate', SQLSTATE));
      ELSE
        RAISE;
      END IF;
    WHEN OTHERS THEN
      RAISE;
  END;
END
$bp_expect_42501$;

CREATE OR REPLACE FUNCTION pg_temp._bp_expect_mapping_42501(
  p_case_id text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $bp_expect_mapping_42501$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
    VALUES (p_case_id, false, jsonb_build_object('expected_sqlstate', '42501'));
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      IF SQLERRM = 'Business performance mapping access denied' THEN
        INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
        VALUES (p_case_id, true, jsonb_build_object('sqlstate', SQLSTATE));
      ELSE
        RAISE;
      END IF;
    WHEN OTHERS THEN
      RAISE;
  END;
END
$bp_expect_mapping_42501$;

CREATE OR REPLACE FUNCTION pg_temp._bp_expect_success(
  p_case_id text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $bp_expect_success$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
    VALUES (p_case_id, true, NULL);
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
      VALUES (p_case_id, false, jsonb_build_object('unexpected_sqlstate', SQLSTATE));
    WHEN OTHERS THEN
      RAISE;
  END;
END
$bp_expect_success$;

CREATE OR REPLACE FUNCTION pg_temp._bp_expect_22023(
  p_case_id text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $bp_expect_22023$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
    VALUES (p_case_id, false, jsonb_build_object('expected_sqlstate', '22023'));
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
      VALUES (p_case_id, true, jsonb_build_object('sqlstate', SQLSTATE));
    WHEN OTHERS THEN
      RAISE;
  END;
END
$bp_expect_22023$;

CREATE OR REPLACE FUNCTION pg_temp._bp_assert_parity(
  p_case_id text,
  p_wrapper_sql text,
  p_delegate_sql text,
  p_require_nonempty boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $bp_assert_parity$
DECLARE
  v_passed boolean;
  v_wrapper_count bigint;
  v_delegate_count bigint;
  v_wrapper_only_count bigint;
  v_delegate_only_count bigint;
BEGIN
  BEGIN
    EXECUTE format(
      $bp_parity_query$
      WITH wrapper_rows AS MATERIALIZED (
        %s
      ), delegate_rows AS MATERIALIZED (
        %s
      ), wrapper_minus_delegate AS MATERIALIZED (
        SELECT * FROM wrapper_rows EXCEPT ALL SELECT * FROM delegate_rows
      ), delegate_minus_wrapper AS MATERIALIZED (
        SELECT * FROM delegate_rows EXCEPT ALL SELECT * FROM wrapper_rows
      )
      SELECT
        NOT EXISTS (SELECT 1 FROM wrapper_minus_delegate)
          AND NOT EXISTS (SELECT 1 FROM delegate_minus_wrapper)
          AND (NOT $1 OR EXISTS (SELECT 1 FROM wrapper_rows)),
        (SELECT count(*) FROM wrapper_rows),
        (SELECT count(*) FROM delegate_rows),
        (SELECT count(*) FROM wrapper_minus_delegate),
        (SELECT count(*) FROM delegate_minus_wrapper)
      $bp_parity_query$,
      p_wrapper_sql,
      p_delegate_sql
    )
    USING COALESCE(p_require_nonempty, false)
    INTO
      v_passed,
      v_wrapper_count,
      v_delegate_count,
      v_wrapper_only_count,
      v_delegate_only_count;

    INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
    VALUES (
      p_case_id,
      COALESCE(v_passed, false),
      jsonb_build_object(
        'wrapper_count', v_wrapper_count,
        'delegate_count', v_delegate_count,
        'wrapper_only_count', v_wrapper_only_count,
        'delegate_only_count', v_delegate_only_count,
        'required_nonempty', COALESCE(p_require_nonempty, false)
      )
    );
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      IF SQLERRM <> 'Business performance access denied' THEN
        RAISE;
      END IF;
      INSERT INTO pg_temp._bp_authz_results(case_id, passed, detail)
      VALUES (
        p_case_id,
        false,
        jsonb_build_object('unexpected_sqlstate', SQLSTATE)
      );
    WHEN OTHERS THEN
      RAISE;
  END;
END
$bp_assert_parity$;

WITH expected_public(signature) AS (
  VALUES
    ('business_performance_organizations_v1()'),
    ('business_performance_pnl_v1(uuid, text, date, date, uuid[])'),
    ('business_performance_snapshot_v1(uuid, uuid[])'),
    ('business_performance_occupancy_snapshot_v1(uuid, date, uuid[])'),
    ('business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[])'),
    ('business_performance_occupancy_monthly_v1(uuid, date, date, uuid[])'),
    ('business_performance_inventory_history_v1(uuid, date, date, uuid[])'),
    ('business_performance_reporting_roles_v1(uuid, date, uuid[])'),
    ('business_performance_set_reporting_role_v1(uuid, uuid, text, date)'),
    ('business_performance_break_even_v1(uuid, text, date, uuid[])'),
    ('business_performance_invoice_cohort_v1(uuid, date, uuid[])'),
    ('business_performance_cash_received_v1(uuid, date, uuid[])'),
    ('business_performance_category_breakdown_v1(uuid, text, date, date, uuid[])')
), actual_public AS MATERIALIZED (
  SELECT
    p.oid,
    format('%s(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
    p.prosecdef,
    COALESCE(
      'search_path=pg_catalog, app_private, public' = ANY(p.proconfig),
      false
    ) AS fixed_search_path,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute,
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) AS public_execute_revoked
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = p.pronamespace
  WHERE namespace.nspname = 'public'
    AND p.prokind = 'f'
    AND p.proname ~ '^business_performance_.*_v1$'
), expected_private(signature) AS (
  VALUES
    ('business_performance_analysis_decision_v1(uuid, uuid, uuid)'),
    ('business_performance_authorized_buildings_v1(uuid, boolean)'),
    ('business_performance_exact_scope_v1(uuid, uuid[], boolean)')
), actual_private AS MATERIALIZED (
  SELECT
    p.oid,
    format('%s(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute,
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) AS public_execute_revoked
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = p.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND p.prokind = 'f'
    AND p.proname IN (
      'business_performance_analysis_decision_v1',
      'business_performance_authorized_buildings_v1',
      'business_performance_exact_scope_v1'
    )
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'catalog.wrapper_acl_exact',
  (SELECT count(*) FROM actual_public) = 13
    AND NOT EXISTS (
      SELECT signature FROM expected_public
      EXCEPT
      SELECT signature FROM actual_public
    )
    AND NOT EXISTS (
      SELECT signature FROM actual_public
      EXCEPT
      SELECT signature FROM expected_public
    )
    AND COALESCE((
      SELECT bool_and(
        prosecdef
          AND fixed_search_path
          AND authenticated_execute
          AND NOT anon_execute
          AND NOT service_role_execute
          AND public_execute_revoked
      )
      FROM actual_public
    ), false)
    AND (SELECT count(*) FROM actual_private) = 3
    AND NOT EXISTS (
      SELECT signature FROM expected_private
      EXCEPT
      SELECT signature FROM actual_private
    )
    AND NOT EXISTS (
      SELECT signature FROM actual_private
      EXCEPT
      SELECT signature FROM expected_private
    )
    AND COALESCE((
      SELECT bool_and(
        NOT authenticated_execute
          AND NOT anon_execute
          AND NOT service_role_execute
          AND public_execute_revoked
      )
      FROM actual_private
    ), false),
  jsonb_build_object(
    'public_wrappers', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'signature', signature,
          'security_definer', prosecdef,
          'fixed_search_path', fixed_search_path,
          'authenticated_execute', authenticated_execute,
          'anon_execute', anon_execute,
          'service_role_execute', service_role_execute,
          'public_execute_revoked', public_execute_revoked
        ) ORDER BY signature
      )
      FROM actual_public
    ),
    'private_helpers', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'signature', signature,
          'authenticated_execute', authenticated_execute,
          'anon_execute', anon_execute,
          'service_role_execute', service_role_execute,
          'public_execute_revoked', public_execute_revoked
        ) ORDER BY signature
      )
      FROM actual_private
    )
  );

SELECT set_config('request.jwt.claims', json_build_object(
  'sub', (SELECT actor_id FROM _bp_authz_fixture),
  'role', 'authenticated'
)::text, true);

-- Use ordinary DEMO DML so current integrity and RBAC synchronization triggers run.
DELETE FROM public.staff_assignments assignment
USING _bp_authz_fixture fixture
WHERE assignment.organization_id = fixture.demo_organization_id
  AND assignment.staff_id = fixture.actor_id;

INSERT INTO public.roles(id, user_id, name, permissions, is_system, organization_id)
SELECT ids.role_full_id, fixture.demo_owner_id,
       'BP-AUTHZ-FULL-' || txid_current()::text, '{}'::jsonb, false,
       fixture.demo_organization_id
FROM _bp_authz_ids ids CROSS JOIN _bp_authz_fixture fixture
UNION ALL
SELECT ids.role_area_id, fixture.demo_owner_id,
       'BP-AUTHZ-AREA-' || txid_current()::text, '{}'::jsonb, false,
       fixture.demo_organization_id
FROM _bp_authz_ids ids CROSS JOIN _bp_authz_fixture fixture
UNION ALL
SELECT ids.role_building_id, fixture.demo_owner_id,
       'BP-AUTHZ-BUILDING-' || txid_current()::text, '{}'::jsonb, false,
       fixture.demo_organization_id
FROM _bp_authz_ids ids CROSS JOIN _bp_authz_fixture fixture;

INSERT INTO public.staff_assignments(
  id, staff_id, role_id, building_id, area_id, user_id, permissions, organization_id
)
SELECT ids.assignment_full_id, fixture.actor_id, ids.role_full_id,
       NULL::uuid, NULL::uuid, fixture.demo_owner_id, NULL::jsonb,
       fixture.demo_organization_id
FROM _bp_authz_ids ids CROSS JOIN _bp_authz_fixture fixture
UNION ALL
SELECT ids.assignment_area_id, fixture.actor_id, ids.role_area_id,
       NULL::uuid, fixture.demo_area_id, fixture.demo_owner_id, NULL::jsonb,
       fixture.demo_organization_id
FROM _bp_authz_ids ids CROSS JOIN _bp_authz_fixture fixture
UNION ALL
SELECT ids.assignment_building_id, fixture.actor_id, ids.role_building_id,
       fixture.demo_building_id, NULL::uuid, fixture.demo_owner_id, NULL::jsonb,
       fixture.demo_organization_id
FROM _bp_authz_ids ids CROSS JOIN _bp_authz_fixture fixture;

INSERT INTO public.authorization_scopes(organization_id, scope_type, building_id)
SELECT fixture.demo_organization_id, 'BUILDING', fixture.demo_building_id
FROM _bp_authz_fixture fixture
ON CONFLICT DO NOTHING;

SELECT pg_temp._bp_clear_canonical();

GRANT SELECT ON TABLE pg_temp._bp_authz_fixture TO authenticated;
GRANT INSERT, SELECT ON TABLE pg_temp._bp_authz_results TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp._bp_expect_42501(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp._bp_expect_mapping_42501(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp._bp_expect_success(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp._bp_expect_22023(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp._bp_assert_parity(text, text, text, boolean) TO authenticated;

-- The sentinel verifies assertion failures are captured without aborting rollback.
DO $bp_expected_42501_sentinel$
BEGIN
  BEGIN
    RAISE EXCEPTION 'expected authz sentinel' USING ERRCODE = '42501';
    INSERT INTO _bp_authz_results(case_id, passed, detail)
    VALUES ('harness.expected_42501_capture', false, NULL);
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      INSERT INTO _bp_authz_results(case_id, passed, detail)
      VALUES ('harness.expected_42501_capture', true, NULL);
    WHEN OTHERS THEN
      RAISE;
  END;
END
$bp_expected_42501_sentinel$;

-- Presence-aware legacy resolver and provenance.
SELECT pg_temp._bp_set_legacy(
  '{"reports_finance":{"view":true}}'::jsonb, NULL,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.view_fallback_allow_provenance', true,
  '{"permission_key":"reports_finance.view","decision_reason":"LEGACY_VIEW_ALLOW","canonical_decision_reason":"DEFAULT_DENY","fallback_used":true,"primary_decision_reason":"DEFAULT_DENY"}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  '{}'::jsonb, '{"reports_finance":{"analysis":true,"view":false}}'::jsonb,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.detail_true_beats_view_false', true,
  '{"permission_key":"reports_finance.analysis","decision_reason":"LEGACY_DETAIL_ALLOW","canonical_decision_reason":"DEFAULT_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  '{}'::jsonb, '{"reports_finance":{"analysis":false,"view":true}}'::jsonb,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.detail_false_beats_view_true', false,
  '{"permission_key":"reports_finance.analysis","decision_reason":"LEGACY_DETAIL_DENY","canonical_decision_reason":"DEFAULT_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{"reports_finance":{"analysis":true,"view":true}}'::jsonb,
  '{"reports_finance":{"analysis":false,"view":true}}'::jsonb,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.role_staff_snapshot_false_deny', false,
  '{"decision_reason":"LEGACY_DETAIL_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, '{"reports_finance":{"analysis":true}}'::jsonb,
  '{}'::jsonb, NULL,
  '{}'::jsonb, '{"reports_finance":{"analysis":false}}'::jsonb,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.applicable_detail_deny_wins', false,
  '{"decision_reason":"LEGACY_DETAIL_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, '{"reports_finance":{"analysis":true}}'::jsonb,
  '{}'::jsonb, NULL,
  '{}'::jsonb, '{"reports_finance":{"analysis":false}}'::jsonb,
  fixture.other_demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.noncovering_deny_no_bleed', true,
  '{"decision_reason":"LEGACY_DETAIL_ALLOW","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_assert_cross_org_no_bleed('legacy.cross_org_deny_no_bleed');

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, '{"reports_finance":{"view":false}}'::jsonb,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.view_false_deny', false,
  '{"permission_key":"reports_finance.view","decision_reason":"LEGACY_VIEW_DENY","canonical_decision_reason":"DEFAULT_DENY","fallback_used":true}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, '{"reports_finance":{"analysis":null}}'::jsonb,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.null_detail_deny', false,
  '{"decision_reason":"LEGACY_DETAIL_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, '{"reports_finance":{"analysis":"true"}}'::jsonb,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.nonboolean_detail_deny', false,
  '{"decision_reason":"LEGACY_DETAIL_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{"reports_finance":{"analysis":true,"view":true}}'::jsonb,
  '{"unrelated":{"flag":true}}'::jsonb,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.staff_snapshot_authoritative', false,
  '{"permission_key":"reports_finance.view","decision_reason":"NO_DECISION","canonical_decision_reason":"DEFAULT_DENY","fallback_used":true,"primary_decision_reason":"DEFAULT_DENY"}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, '{"reports_finance":{"analysis":true}}'::jsonb,
  '{}'::jsonb, '{"reports_finance":{"analysis":true}}'::jsonb,
  '{}'::jsonb, '{"reports_finance":{"analysis":false}}'::jsonb,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_assert_decision(
  'legacy.duplicate_scope_deny_wins', false,
  '{"decision_reason":"LEGACY_DETAIL_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_clear_canonical();
SELECT pg_temp._bp_set_legacy(
  '{"reports_finance":{"view":true}}'::jsonb, NULL,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_add_override('reports_finance.analysis', 'DENY');
SELECT pg_temp._bp_assert_decision(
  'canonical.analysis_deny_blocks_fallback', false,
  '{"permission_key":"reports_finance.analysis","decision_reason":"CANONICAL_DETAIL_DENY","canonical_decision_reason":"MEMBER_DENY","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

-- Inactive canonical definitions are hard denials, never legacy rollout gaps.
SELECT pg_temp._bp_clear_canonical();
SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  '{}'::jsonb, '{"reports_finance":{"analysis":true,"view":true}}'::jsonb,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
UPDATE public.permission_definitions
SET is_active = false
WHERE key = 'reports_finance.analysis';
SELECT pg_temp._bp_assert_decision(
  'permission_inactive.analysis_helper_denied', false,
  '{"permission_key":"reports_finance.analysis","decision_reason":"CANONICAL_DETAIL_DENY","canonical_decision_reason":"PERMISSION_INACTIVE_OR_MISSING","fallback_used":false}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SET LOCAL ROLE authenticated;
WITH visible AS MATERIALIZED (
  SELECT * FROM public.business_performance_organizations_v1()
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'permission_inactive.analysis_roster_empty',
  count(*) FILTER (WHERE organization_id = fixture.demo_organization_id) = 0,
  jsonb_build_object('demo_rows', count(*) FILTER (
    WHERE organization_id = fixture.demo_organization_id
  ))
FROM visible CROSS JOIN _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'permission_inactive.analysis_wrapper_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.permission_definitions
SET is_active = true
WHERE key = 'reports_finance.analysis';

SELECT pg_temp._bp_set_legacy(
  '{"reports_finance":{"view":true}}'::jsonb, NULL,
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
UPDATE public.permission_definitions
SET is_active = false
WHERE key = 'reports_finance.view';
SELECT pg_temp._bp_assert_decision(
  'permission_inactive.view_helper_denied', false,
  '{"permission_key":"reports_finance.view","decision_reason":"CANONICAL_VIEW_DENY","canonical_decision_reason":"PERMISSION_INACTIVE_OR_MISSING","fallback_used":true,"primary_decision_reason":"DEFAULT_DENY"}'::jsonb,
  fixture.demo_organization_id, fixture.demo_building_id
) FROM _bp_authz_fixture fixture;
SET LOCAL ROLE authenticated;
WITH visible AS MATERIALIZED (
  SELECT * FROM public.business_performance_organizations_v1()
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'permission_inactive.view_roster_empty',
  count(*) FILTER (WHERE organization_id = fixture.demo_organization_id) = 0,
  jsonb_build_object('demo_rows', count(*) FILTER (
    WHERE organization_id = fixture.demo_organization_id
  ))
FROM visible CROSS JOIN _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'permission_inactive.view_wrapper_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.permission_definitions
SET is_active = true
WHERE key = 'reports_finance.view';

-- No-action persona: empty roster and a scoped data wrapper fails closed.
SELECT pg_temp._bp_clear_canonical();
SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, NULL, '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SET LOCAL ROLE authenticated;
WITH visible AS MATERIALIZED (
  SELECT * FROM public.business_performance_organizations_v1()
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'no_action.empty_roster',
  count(*) FILTER (WHERE organization_id = fixture.demo_organization_id) = 0,
  jsonb_build_object('demo_rows', count(*) FILTER (
    WHERE organization_id = fixture.demo_organization_id
  ))
FROM visible CROSS JOIN _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'no_action.wrapper_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;

-- Analysis-only scope exposes all occupancy wrappers but not restricted finance.
SELECT pg_temp._bp_set_legacy(
  '{}'::jsonb, NULL, '{}'::jsonb, NULL,
  '{}'::jsonb, '{"reports_finance":{"analysis":true}}'::jsonb,
  fixture.demo_building_id
) FROM _bp_authz_fixture fixture;

SET LOCAL ROLE authenticated;
WITH roster AS MATERIALIZED (
  SELECT *
  FROM public.business_performance_organizations_v1()
  WHERE organization_id = (SELECT demo_organization_id FROM _bp_authz_fixture)
), roster_buildings AS MATERIALIZED (
  SELECT
    (building.value ->> 'id')::uuid AS building_id,
    COALESCE((building.value ->> 'restricted_allowed')::boolean, false) AS restricted_allowed,
    building.value -> 'analysis_provenance' AS analysis_provenance
  FROM roster
  CROSS JOIN LATERAL jsonb_array_elements(roster.authorized_buildings) building(value)
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'roster.exact_distinct_ids',
  (SELECT count(*) FROM roster) = 1
    AND COALESCE((SELECT max(authorized_physical_building_count) = 1 FROM roster), false)
    AND (SELECT count(*) FROM roster_buildings) = 1
    AND (SELECT count(DISTINCT building_id) FROM roster_buildings) = 1
    AND COALESCE((SELECT bool_and(building_id = fixture.demo_building_id) FROM roster_buildings), false)
    AND COALESCE((SELECT bool_and(NOT restricted_allowed) FROM roster_buildings), false)
    AND COALESCE((SELECT bool_and(
      analysis_provenance @> '{"decision_reason":"LEGACY_DETAIL_ALLOW","fallback_used":false}'::jsonb
    ) FROM roster_buildings), false),
  jsonb_build_object(
    'roster_rows', (SELECT count(*) FROM roster),
    'building_ids', (SELECT jsonb_agg(building_id ORDER BY building_id) FROM roster_buildings),
    'expected_building_id', fixture.demo_building_id
  )
FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_expect_success(
  'analysis_only.occupancy_snapshot_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'analysis_only.upcoming_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'analysis_only.monthly_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'analysis_only.inventory_history_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_inventory_history_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'analysis_only.pnl_denied',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'analysis_only.snapshot_denied',
  format(
    'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;

WITH snapshot AS MATERIALIZED (
  SELECT *
  FROM public.business_performance_occupancy_snapshot_v1(
    (SELECT demo_organization_id FROM _bp_authz_fixture),
    current_date,
    ARRAY[(SELECT demo_building_id FROM _bp_authz_fixture)]::uuid[]
  )
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'occupancy_snapshot.exact_set',
  count(*) = 1
    AND count(DISTINCT snapshot.building_id) = 1
    AND bool_and(snapshot.building_id = fixture.demo_building_id),
  jsonb_build_object(
    'count', count(*),
    'distinct_count', count(DISTINCT snapshot.building_id),
    'building_ids', jsonb_agg(snapshot.building_id ORDER BY snapshot.building_id),
    'expected_building_id', fixture.demo_building_id
  )
FROM snapshot CROSS JOIN _bp_authz_fixture fixture
GROUP BY fixture.demo_building_id;
RESET ROLE;

-- Restricted allow is required only by P&L and finance snapshot.
SELECT pg_temp._bp_add_override('income_expenses.restricted_view', 'ALLOW');
SET LOCAL ROLE authenticated;
SELECT pg_temp._bp_expect_success(
  'restricted.pnl_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'restricted.snapshot_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;

-- Every gated-data RPC must execute for the authorized DEMO scope. Mapping
-- remains separately protected by categories.edit and is exercised in rollback.
SELECT pg_temp._bp_expect_success(
  'gated.inventory_history_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_inventory_history_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'gated.reporting_roles_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_reporting_roles_v1(%L::uuid, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'gated.break_even_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_break_even_v1(%L::uuid, ''ACCRUAL'', %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'gated.invoice_cohort_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_invoice_cohort_v1(%L::uuid, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'gated.cash_received_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_cash_received_v1(%L::uuid, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'gated.category_breakdown_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_category_breakdown_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_mapping_42501(
  'gated.mapping_without_categories_edit_denied',
  format(
    'SELECT count(*) FROM public.business_performance_set_reporting_role_v1(%L::uuid, %L::uuid, ''OUTSIDE_BREAK_EVEN_MODEL'', %L::date)',
    fixture.demo_organization_id, fixture.demo_type_id, '2099-01-01'
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;
SELECT pg_temp._bp_add_org_override('categories.edit', 'ALLOW');
SET LOCAL ROLE authenticated;
SELECT pg_temp._bp_expect_success(
  'gated.mapping_with_categories_edit_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_set_reporting_role_v1(%L::uuid, %L::uuid, ''OUTSIDE_BREAK_EVEN_MODEL'', %L::date)',
    fixture.demo_organization_id, fixture.demo_type_id, '2099-01-01'
  )
) FROM _bp_authz_fixture fixture;

-- Temporal arguments are bounded at the public wrapper boundary with 22023.
SELECT pg_temp._bp_expect_22023(
  'temporal.pnl_null_start_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', NULL::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.pnl_null_end_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, NULL::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.pnl_reversed_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-02-01', '2026-01-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.pnl_excessive_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2025-01-01', '2026-02-06', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_success(
  'temporal.pnl_13_months_allowed',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2025-02-01', '2026-02-28', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.occupancy_snapshot_null_as_of_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, NULL::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.upcoming_null_as_of_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, NULL::date, 60, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.upcoming_null_window_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, NULL::integer, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.upcoming_negative_window_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, -1, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.upcoming_over_max_window_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 367, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.monthly_null_start_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, NULL::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.monthly_null_end_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, NULL::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.monthly_reversed_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-02-01', '2026-01-31', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_22023(
  'temporal.monthly_excessive_rejected',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2025-01-01', '2026-02-06', fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;

-- Membership and organization lifecycle changes must override retained grants.
UPDATE public.organization_memberships membership
SET status = 'SUSPENDED'
FROM _bp_authz_fixture fixture
WHERE membership.id = fixture.membership_id
  AND membership.organization_id = fixture.demo_organization_id;
SET LOCAL ROLE authenticated;
WITH visible AS MATERIALIZED (
  SELECT * FROM public.business_performance_organizations_v1()
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'lifecycle.membership_suspended.roster_empty',
  count(*) FILTER (WHERE organization_id = fixture.demo_organization_id) = 0,
  jsonb_build_object('demo_rows', count(*) FILTER (
    WHERE organization_id = fixture.demo_organization_id
  ))
FROM visible CROSS JOIN _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_suspended.pnl_denied', format(
  'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_suspended.snapshot_denied', format(
  'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_suspended.occupancy_snapshot_denied', format(
  'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_suspended.upcoming_denied', format(
  'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_suspended.monthly_denied', format(
  'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.organization_memberships membership
SET status = fixture.original_membership_status
FROM _bp_authz_fixture fixture
WHERE membership.id = fixture.membership_id
  AND membership.organization_id = fixture.demo_organization_id;

UPDATE public.organization_memberships membership
SET valid_to = clock_timestamp() - interval '1 second'
FROM _bp_authz_fixture fixture
WHERE membership.id = fixture.membership_id
  AND membership.organization_id = fixture.demo_organization_id;
SET LOCAL ROLE authenticated;
WITH visible AS MATERIALIZED (
  SELECT * FROM public.business_performance_organizations_v1()
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'lifecycle.membership_expired.roster_empty',
  count(*) FILTER (WHERE organization_id = fixture.demo_organization_id) = 0,
  jsonb_build_object('demo_rows', count(*) FILTER (
    WHERE organization_id = fixture.demo_organization_id
  ))
FROM visible CROSS JOIN _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_expired.pnl_denied', format(
  'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_expired.snapshot_denied', format(
  'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_expired.occupancy_snapshot_denied', format(
  'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_expired.upcoming_denied', format(
  'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.membership_expired.monthly_denied', format(
  'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.organization_memberships membership
SET valid_to = fixture.original_membership_valid_to
FROM _bp_authz_fixture fixture
WHERE membership.id = fixture.membership_id
  AND membership.organization_id = fixture.demo_organization_id;

UPDATE public.organizations organization
SET status = 'SUSPENDED'
FROM _bp_authz_fixture fixture
WHERE organization.id = fixture.demo_organization_id;
SET LOCAL ROLE authenticated;
WITH visible AS MATERIALIZED (
  SELECT * FROM public.business_performance_organizations_v1()
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'lifecycle.organization_suspended.roster_empty',
  count(*) FILTER (WHERE organization_id = fixture.demo_organization_id) = 0,
  jsonb_build_object('demo_rows', count(*) FILTER (
    WHERE organization_id = fixture.demo_organization_id
  ))
FROM visible CROSS JOIN _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.organization_suspended.pnl_denied', format(
  'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.organization_suspended.snapshot_denied', format(
  'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.organization_suspended.occupancy_snapshot_denied', format(
  'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.organization_suspended.upcoming_denied', format(
  'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501('lifecycle.organization_suspended.monthly_denied', format(
  'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
  fixture.demo_organization_id, '2026-01-01', '2026-01-31', fixture.demo_building_id
)) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.organizations organization
SET status = fixture.original_organization_status
FROM _bp_authz_fixture fixture
WHERE organization.id = fixture.demo_organization_id;
SET LOCAL ROLE authenticated;

WITH finance_snapshot AS MATERIALIZED (
  SELECT *
  FROM public.business_performance_snapshot_v1(
    (SELECT demo_organization_id FROM _bp_authz_fixture),
    ARRAY[(SELECT demo_building_id FROM _bp_authz_fixture), (SELECT demo_building_id FROM _bp_authz_fixture)]::uuid[]
  )
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'finance_snapshot.exact_set',
  count(*) = 1
    AND count(DISTINCT finance_snapshot.building_id) = 1
    AND bool_and(finance_snapshot.building_id = fixture.demo_building_id),
  jsonb_build_object(
    'requested_count', 2,
    'requested_distinct_count', 1,
    'result_count', count(*),
    'result_distinct_count', count(DISTINCT finance_snapshot.building_id),
    'building_ids', jsonb_agg(finance_snapshot.building_id ORDER BY finance_snapshot.building_id),
    'expected_building_id', fixture.demo_building_id
  )
FROM finance_snapshot CROSS JOIN _bp_authz_fixture fixture
GROUP BY fixture.demo_building_id;

SELECT pg_temp._bp_assert_parity(
  'parity.pnl_accrual',
  format(
    'SELECT * FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31', fixture.demo_building_id
  ),
  format(
    'SELECT * FROM public.fa_monthly_pnl_accrual(%L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    '2026-01-01', '2026-03-31', fixture.demo_building_id
  ),
  false
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_assert_parity(
  'parity.pnl_voucher_date',
  format(
    'SELECT * FROM public.business_performance_pnl_v1(%L::uuid, ''VOUCHER_DATE'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31', fixture.demo_building_id
  ),
  format(
    'SELECT * FROM public.fa_monthly_pnl(%L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    '2026-01-01', '2026-03-31', fixture.demo_building_id
  ),
  false
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_assert_parity(
  'parity.finance_snapshot',
  format(
    'SELECT * FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  ),
  format(
    'SELECT * FROM public.fa_snapshot_kpis(ARRAY[%L::uuid]::uuid[])',
    fixture.demo_building_id
  ),
  true
) FROM _bp_authz_fixture fixture;

-- generated_at is intentionally excluded from parity because each call samples now().
SELECT pg_temp._bp_assert_parity(
  'parity.occupancy_snapshot',
  format(
    'SELECT building_id, building_name, total, occupied, reserved, maintenance, unavailable, available, occupancy_pct, committed_pct, missed_revenue FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  ),
  format(
    'SELECT building_id, building_name, total, occupied, reserved, maintenance, unavailable, available, occupancy_pct, committed_pct, missed_revenue FROM public.occupancy_snapshot_v2(current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_building_id
  ),
  true
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_assert_parity(
  'parity.upcoming_vacancy',
  format(
    'SELECT * FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  ),
  format(
    'SELECT * FROM public.occupancy_upcoming_vacancy_v2(current_date, 60, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_building_id
  ),
  false
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_assert_parity(
  'parity.occupancy_monthly',
  format(
    'SELECT * FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31', fixture.demo_building_id
  ),
  format(
    'SELECT * FROM public.fa_occupancy_monthly(%L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    '2026-01-01', '2026-03-31', fixture.demo_building_id
  ),
  true
) FROM _bp_authz_fixture fixture;

-- Cross-org and mixed-id requests reject through every scoped data wrapper.
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.pnl_denied',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', '2026-03-31', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.snapshot_denied',
  format(
    'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.occupancy_snapshot_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.upcoming_denied',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.monthly_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', '2026-03-31', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.inventory_history_denied',
  format(
    'SELECT count(*) FROM public.business_performance_inventory_history_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', '2026-03-01', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.reporting_roles_denied',
  format(
    'SELECT count(*) FROM public.business_performance_reporting_roles_v1(%L::uuid, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.break_even_denied',
  format(
    'SELECT count(*) FROM public.business_performance_break_even_v1(%L::uuid, ''ACCRUAL'', %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.invoice_cohort_denied',
  format(
    'SELECT count(*) FROM public.business_performance_invoice_cohort_v1(%L::uuid, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.cash_received_denied',
  format(
    'SELECT count(*) FROM public.business_performance_cash_received_v1(%L::uuid, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.cross_org.category_breakdown_denied',
  format(
    'SELECT count(*) FROM public.business_performance_category_breakdown_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid]::uuid[])',
    fixture.prod_organization_id, '2026-01-01', '2026-01-31', fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_expect_42501(
  'scope.mixed.pnl_denied',
  format(
    'SELECT count(*) FROM public.business_performance_pnl_v1(%L::uuid, ''ACCRUAL'', %L::date, %L::date, ARRAY[%L::uuid,%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31',
    fixture.demo_building_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.mixed.snapshot_denied',
  format(
    'SELECT count(*) FROM public.business_performance_snapshot_v1(%L::uuid, ARRAY[%L::uuid,%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.mixed.occupancy_snapshot_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid,%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.mixed.upcoming_denied',
  format(
    'SELECT count(*) FROM public.business_performance_upcoming_vacancy_v1(%L::uuid, current_date, 60, ARRAY[%L::uuid,%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.mixed.monthly_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_monthly_v1(%L::uuid, %L::date, %L::date, ARRAY[%L::uuid,%L::uuid]::uuid[])',
    fixture.demo_organization_id, '2026-01-01', '2026-03-31',
    fixture.demo_building_id, fixture.prod_building_id
  )
) FROM _bp_authz_fixture fixture;

SELECT pg_temp._bp_expect_42501(
  'scope.null_org_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(NULL::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.null_ids_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, NULL::uuid[])',
    fixture.demo_organization_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.empty_ids_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[]::uuid[])',
    fixture.demo_organization_id
  )
) FROM _bp_authz_fixture fixture;
SELECT pg_temp._bp_expect_42501(
  'scope.null_element_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid,NULL::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
WITH duplicate_snapshot AS MATERIALIZED (
  SELECT *
  FROM public.business_performance_occupancy_snapshot_v1(
    (SELECT demo_organization_id FROM _bp_authz_fixture),
    current_date,
    ARRAY[(SELECT demo_building_id FROM _bp_authz_fixture), (SELECT demo_building_id FROM _bp_authz_fixture)]::uuid[]
  )
)
INSERT INTO _bp_authz_results(case_id, passed, detail)
SELECT
  'scope.duplicate_normalized_success',
  count(*) = 1
    AND count(DISTINCT duplicate_snapshot.building_id) = 1
    AND bool_and(duplicate_snapshot.building_id = fixture.demo_building_id),
  jsonb_build_object(
    'requested_count', 2,
    'requested_distinct_count', 1,
    'result_count', count(*),
    'result_distinct_count', count(DISTINCT duplicate_snapshot.building_id),
    'building_ids', jsonb_agg(duplicate_snapshot.building_id ORDER BY duplicate_snapshot.building_id),
    'expected_building_id', fixture.demo_building_id
  )
FROM duplicate_snapshot CROSS JOIN _bp_authz_fixture fixture
GROUP BY fixture.demo_building_id;
RESET ROLE;

UPDATE public.buildings building
SET is_virtual = true
FROM _bp_authz_fixture fixture
WHERE building.id = fixture.demo_building_id
  AND building.organization_id = fixture.demo_organization_id;
SET LOCAL ROLE authenticated;
SELECT pg_temp._bp_expect_42501(
  'scope.virtual_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.buildings building
SET is_virtual = false
FROM _bp_authz_fixture fixture
WHERE building.id = fixture.demo_building_id
  AND building.organization_id = fixture.demo_organization_id;

UPDATE public.buildings building
SET deleted_at = clock_timestamp()
FROM _bp_authz_fixture fixture
WHERE building.id = fixture.demo_building_id
  AND building.organization_id = fixture.demo_organization_id;
SET LOCAL ROLE authenticated;
SELECT pg_temp._bp_expect_42501(
  'scope.deleted_denied',
  format(
    'SELECT count(*) FROM public.business_performance_occupancy_snapshot_v1(%L::uuid, current_date, ARRAY[%L::uuid]::uuid[])',
    fixture.demo_organization_id, fixture.demo_building_id
  )
) FROM _bp_authz_fixture fixture;
RESET ROLE;
UPDATE public.buildings building
SET deleted_at = NULL
FROM _bp_authz_fixture fixture
WHERE building.id = fixture.demo_building_id
  AND building.organization_id = fixture.demo_organization_id;

WITH evaluated AS (
  SELECT
    required.sequence,
    required.case_id,
    COALESCE(result.passed, false) AS passed,
    CASE
      WHEN result.case_id IS NULL THEN jsonb_build_object('missing_result', true)
      ELSE result.detail
    END AS detail
  FROM _bp_required_cases required
  LEFT JOIN _bp_authz_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(
    jsonb_build_object(
      'case_id', evaluated.case_id,
      'passed', evaluated.passed,
      'detail', evaluated.detail
    ) ORDER BY evaluated.sequence
  )
) AS verdict
FROM evaluated;
ROLLBACK;`;
}

export function parseVerdictResponse(body) {
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("Supabase Management SQL returned invalid JSON");
  }
  if (!Array.isArray(rows)) {
    throw new Error("Supabase Management SQL verdict response must be an array");
  }

  const verdict = rows.find(
    (row) => row && typeof row === "object" && row.verdict,
  )?.verdict;
  const assertionCount = Number(verdict?.assertion_count);
  const failedCount = Number(verdict?.failed_count);
  const assertions = verdict?.assertions;
  if (
    !verdict ||
    typeof verdict !== "object" ||
    typeof verdict.passed !== "boolean" ||
    !Number.isInteger(assertionCount) ||
    assertionCount < 0 ||
    !Number.isInteger(failedCount) ||
    failedCount < 0 ||
    !Array.isArray(assertions) ||
    assertions.length !== assertionCount
  ) {
    throw new Error("Supabase Management SQL response has no valid verdict");
  }

  const caseIds = new Set();
  let observedFailedCount = 0;
  for (const assertion of assertions) {
    if (
      !assertion ||
      typeof assertion !== "object" ||
      typeof assertion.case_id !== "string" ||
      assertion.case_id.length === 0 ||
      typeof assertion.passed !== "boolean" ||
      caseIds.has(assertion.case_id)
    ) {
      throw new Error("Supabase Management SQL response has an invalid verdict assertion");
    }
    caseIds.add(assertion.case_id);
    if (!assertion.passed) observedFailedCount += 1;
  }
  if (
    failedCount !== observedFailedCount ||
    verdict.passed !== (failedCount === 0)
  ) {
    throw new Error("Supabase Management SQL verdict counts are inconsistent");
  }
  if (
    assertionCount !== REQUIRED_CASE_IDS.length ||
    assertions.some(
      (assertion, index) => assertion.case_id !== REQUIRED_CASE_IDS[index],
    )
  ) {
    throw new Error(
      "Supabase Management SQL verdict case manifest is inconsistent",
    );
  }
  return verdict;
}

function printUsage(log) {
  log("Usage: node scripts/test-business-performance-authz.mjs [--dry-run]");
  log("  --dry-run  Build the one-request rollback payload without calling Supabase.");
}

export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    fetchImpl = fetch,
    loadConfig = loadAdminConfig,
  } = {},
) {
  const unknown = argv.filter(
    (arg) => arg !== "--dry-run" && arg !== "--help" && arg !== "-h",
  );
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage(log);
    return;
  }

  const sql = buildBusinessPerformanceAuthzSql();
  if (argv.includes("--dry-run")) {
    log("Static dry run passed: one rollback-only SQL payload was built.");
    log("No Management API request was executed.");
    return;
  }

  const config = loadConfig();
  const body = await executeManagementQuery(sql, config, fetchImpl);
  const verdict = parseVerdictResponse(body);
  if (!verdict.passed || Number(verdict.failed_count) > 0) {
    const failed = verdict.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => assertion.case_id)
      .join(", ");
    throw new Error(
      `Business-performance authz matrix failed ${verdict.failed_count}/${verdict.assertion_count}: ${failed}`,
    );
  }
  log(
    `Business-performance authz matrix passed (${verdict.assertion_count} assertions, transaction rolled back).`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
