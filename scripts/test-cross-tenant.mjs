#!/usr/bin/env node
// Network Center AuthZ/RLS matrix. Every fixture write is limited to the
// canonical DEMO organization and the whole request ends with ROLLBACK.
// Production organization rows are read-only negative targets.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeManagementQuery,
  loadAdminConfig,
} from "./test-business-performance-authz.mjs";

export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
export const DEMO_OWNER_EMAIL = "demo.chunha@username.ihomecrm.local";
export const DEMO_VIEW_EMAIL = "demo.ketoan@username.ihomecrm.local";
export const DEMO_EXECUTE_EMAIL = "demo.quanly@username.ihomecrm.local";

const MIGRATION_PATHS = Object.freeze([
  "../supabase/migrations/20260729010000_network_center_permissions_inventory.sql",
  "../supabase/migrations/20260729020000_network_center_current_telemetry.sql",
  "../supabase/migrations/20260729030000_network_center_operations.sql",
  "../supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql",
]);

export const REQUIRED_CASE_IDS = Object.freeze([
  "owner.view",
  "owner.execute",
  "owner.organization_scope",
  "view_only.view",
  "view_only.execute_denied",
  "execute.view",
  "execute.enqueue",
  "scope.view_wrong_building_denied",
  "scope.execute_wrong_building_denied",
  "scope.wrong_organization_denied",
  "scope.production_absent_from_fleet",
  "browser.direct_commands_denied",
  "inventory.mapping",
  "inventory.aruba_above_ten",
  "inventory.aruba_display_only",
  "inventory.protected_preserved",
  "lifecycle.offboarded_view_denied",
  "lifecycle.offboarded_execute_denied",
  "anonymous.view_denied",
  "anonymous.execute_denied",
]);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function stripMigrationShell(sql) {
  return sql
    .replace(/^\uFEFF/, "")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "")
    .replace(/^\s*NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;\s*$/gim, "")
    .trim();
}

function replaceExactly(sql, pattern, replacement, expected, label) {
  const matches = sql.match(pattern) ?? [];
  if (matches.length !== expected) {
    throw new Error(
      `Shadow migration guard failed for ${label}: expected ${expected}, received ${matches.length}`,
    );
  }
  return sql.replace(pattern, replacement);
}

export function buildShadowMigrationSql(readFile = readFileSync) {
  const migrations = MIGRATION_PATHS.map((relativePath) =>
    stripMigrationShell(
      readFile(new URL(relativePath, import.meta.url), "utf8"),
    ),
  );

  migrations[0] = replaceExactly(
    migrations[0],
    /WHERE b\.organization_id IS NOT NULL\s+AND b\.is_virtual = false/g,
    `WHERE b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid\n  AND b.is_virtual = false`,
    2,
    "DEMO-only inventory/settings backfill",
  );
  migrations[3] = replaceExactly(
    migrations[3],
    /FROM public\.organizations organization\s+WHERE NOT EXISTS \(/g,
    `FROM public.organizations organization\nWHERE organization.id = ${sqlLiteral(DEMO_ORG_ID)}::uuid\n  AND NOT EXISTS (`,
    1,
    "DEMO-only organization scope seed",
  );
  migrations[3] = replaceExactly(
    migrations[3],
    /WHERE membership\.member_type = 'OWNER'/g,
    `WHERE membership.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid\n  AND membership.member_type = 'OWNER'`,
    1,
    "DEMO-only owner permission seed",
  );
  migrations[3] = replaceExactly(
    migrations[3],
    /WHERE override\.permission_key IN \('network_center\.view', 'network_center\.execute'\)/g,
    `WHERE override.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid\n  AND override.permission_key IN ('network_center.view', 'network_center.execute')`,
    1,
    "DEMO-only owner scope edges",
  );

  const shadowSql = migrations.join("\n\n");
  if (/session_replication_role\s*=\s*replica/i.test(shadowSql)) {
    throw new Error("Shadow migrations must use real triggers and constraints");
  }
  if (/^\s*(?:BEGIN|COMMIT)\s*;/im.test(shadowSql)) {
    throw new Error("Nested transaction shell remained in shadow migrations");
  }
  return shadowSql;
}

function requiredCaseValues() {
  return REQUIRED_CASE_IDS.map(
    (caseId, index) => `(${index + 1}, ${sqlLiteral(caseId)})`,
  ).join(",\n  ");
}

export function buildNetworkCenterMatrixSql({ shadowSql = "" } = {}) {
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET CONSTRAINTS ALL DEFERRED;

${shadowSql}

CREATE TEMP TABLE _nc_fixture ON COMMIT DROP AS
SELECT
  ${sqlLiteral(DEMO_ORG_ID)}::uuid AS demo_organization_id,
  ${sqlLiteral(PROD_ORG_ID)}::uuid AS prod_organization_id,
  (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlLiteral(DEMO_OWNER_EMAIL)}) LIMIT 1) AS owner_id,
  (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlLiteral(DEMO_VIEW_EMAIL)}) LIMIT 1) AS view_id,
  (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlLiteral(DEMO_EXECUTE_EMAIL)}) LIMIT 1) AS execute_id,
  (SELECT id FROM public.buildings
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND deleted_at IS NULL AND NOT is_virtual
    ORDER BY lower(name) COLLATE "C", id LIMIT 1) AS building_a_id,
  (SELECT id FROM public.buildings
    WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND deleted_at IS NULL AND NOT is_virtual
      AND id <> (SELECT id FROM public.buildings
        WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
          AND deleted_at IS NULL AND NOT is_virtual
        ORDER BY lower(name) COLLATE "C", id LIMIT 1)
    ORDER BY lower(name) COLLATE "C", id LIMIT 1) AS building_b_id,
  (SELECT id FROM public.buildings
    WHERE organization_id = ${sqlLiteral(PROD_ORG_ID)}::uuid
      AND deleted_at IS NULL AND NOT is_virtual
    ORDER BY lower(name) COLLATE "C", id LIMIT 1) AS prod_building_id;

ALTER TABLE _nc_fixture
  ADD COLUMN owner_membership_id uuid,
  ADD COLUMN view_membership_id uuid,
  ADD COLUMN execute_membership_id uuid,
  ADD COLUMN router_a_id uuid,
  ADD COLUMN router_b_id uuid;

UPDATE _nc_fixture fixture
SET owner_membership_id = (
      SELECT membership.id FROM public.organization_memberships membership
      WHERE membership.organization_id = fixture.demo_organization_id
        AND membership.user_id = fixture.owner_id
        AND membership.member_type = 'OWNER'
        AND membership.status = 'ACTIVE'
        AND coalesce(membership.valid_from, '-infinity'::timestamptz) <= statement_timestamp()
        AND (membership.valid_to IS NULL OR membership.valid_to > statement_timestamp())
      ORDER BY membership.id LIMIT 1
    ),
    view_membership_id = (
      SELECT membership.id FROM public.organization_memberships membership
      WHERE membership.organization_id = fixture.demo_organization_id
        AND membership.user_id = fixture.view_id
        AND membership.status = 'ACTIVE'
        AND coalesce(membership.valid_from, '-infinity'::timestamptz) <= statement_timestamp()
        AND (membership.valid_to IS NULL OR membership.valid_to > statement_timestamp())
      ORDER BY membership.id LIMIT 1
    ),
    execute_membership_id = (
      SELECT membership.id FROM public.organization_memberships membership
      WHERE membership.organization_id = fixture.demo_organization_id
        AND membership.user_id = fixture.execute_id
        AND membership.status = 'ACTIVE'
        AND coalesce(membership.valid_from, '-infinity'::timestamptz) <= statement_timestamp()
        AND (membership.valid_to IS NULL OR membership.valid_to > statement_timestamp())
      ORDER BY membership.id LIMIT 1
    ),
    router_a_id = (
      SELECT device.id FROM public.network_devices device
      WHERE device.organization_id = fixture.demo_organization_id
        AND device.building_id = fixture.building_a_id
        AND device.device_kind = 'MIKROTIK' AND device.is_active
      ORDER BY device.id LIMIT 1
    ),
    router_b_id = (
      SELECT device.id FROM public.network_devices device
      WHERE device.organization_id = fixture.demo_organization_id
        AND device.building_id = fixture.building_b_id
        AND device.device_kind = 'MIKROTIK' AND device.is_active
      ORDER BY device.id LIMIT 1
    );

DO $nc_preflight$
DECLARE fixture _nc_fixture%ROWTYPE;
BEGIN
  SELECT * INTO fixture FROM _nc_fixture;
  IF fixture.owner_id IS NULL OR fixture.view_id IS NULL OR fixture.execute_id IS NULL THEN
    RAISE EXCEPTION 'Required DEMO auth users are missing';
  END IF;
  IF fixture.owner_membership_id IS NULL OR fixture.view_membership_id IS NULL
     OR fixture.execute_membership_id IS NULL THEN
    RAISE EXCEPTION 'Required DEMO memberships are missing or inactive';
  END IF;
  IF fixture.building_a_id IS NULL OR fixture.building_b_id IS NULL THEN
    RAISE EXCEPTION 'Network Center matrix requires two physical DEMO buildings';
  END IF;
  IF fixture.prod_building_id IS NULL THEN
    RAISE EXCEPTION 'Network Center matrix requires one read-only PROD building';
  END IF;
  IF fixture.router_a_id IS NULL OR fixture.router_b_id IS NULL THEN
    RAISE EXCEPTION 'Network Center MikroTik slots were not provisioned by the migration';
  END IF;
  IF to_regprocedure('public.network_center_list_fleet_v1()') IS NULL
     OR to_regprocedure('public.network_center_get_building_v1(uuid)') IS NULL
     OR to_regprocedure('public.network_center_execute_action_v1(uuid,text,text,jsonb,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Network Center RPC migration is unavailable';
  END IF;
END
$nc_preflight$;

CREATE TEMP TABLE _nc_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _nc_required_cases(sequence, case_id) VALUES
  ${requiredCaseValues()};

CREATE TEMP TABLE _nc_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp._nc_expect_true(p_case_id text, p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $nc_expect_true$
DECLARE value boolean;
BEGIN
  EXECUTE p_statement INTO value;
  INSERT INTO pg_temp._nc_results(case_id, passed, detail)
  VALUES (
    p_case_id,
    value IS TRUE,
    CASE WHEN value IS TRUE THEN NULL ELSE jsonb_build_object('observed', value) END
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO pg_temp._nc_results(case_id, passed, detail)
  VALUES (p_case_id, false, jsonb_build_object('unexpected_sqlstate', SQLSTATE, 'message', SQLERRM));
END
$nc_expect_true$;

CREATE OR REPLACE FUNCTION pg_temp._nc_expect_42501(p_case_id text, p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $nc_expect_42501$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._nc_results(case_id, passed, detail)
    VALUES (p_case_id, false, jsonb_build_object('expected_sqlstate', '42501'));
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      INSERT INTO pg_temp._nc_results(case_id, passed, detail)
      VALUES (p_case_id, true, jsonb_build_object('sqlstate', SQLSTATE));
    WHEN OTHERS THEN
      INSERT INTO pg_temp._nc_results(case_id, passed, detail)
      VALUES (p_case_id, false, jsonb_build_object('unexpected_sqlstate', SQLSTATE, 'message', SQLERRM));
  END;
END
$nc_expect_42501$;

CREATE OR REPLACE FUNCTION pg_temp._nc_add_override(
  p_membership_id uuid,
  p_permission_key text,
  p_scope_id uuid,
  p_scope_mode text,
  p_created_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $nc_add_override$
DECLARE override_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.member_permission_overrides (
    id, organization_id, membership_id, permission_key, effect,
    reason, created_by, scope_mode
  )
  SELECT override_id, fixture.demo_organization_id, p_membership_id,
         p_permission_key, 'ALLOW', 'Network Center rollback authz matrix',
         p_created_by, p_scope_mode
  FROM pg_temp._nc_fixture fixture;

  INSERT INTO public.member_override_scopes(organization_id, override_id, scope_id)
  SELECT fixture.demo_organization_id, override_id, p_scope_id
  FROM pg_temp._nc_fixture fixture;
END
$nc_add_override$;

-- Normalize only the selected DEMO users. No production membership, role, or
-- permission row is changed, even temporarily.
UPDATE public.member_permission_overrides override_row
SET revoked_at = clock_timestamp()
FROM _nc_fixture fixture
WHERE override_row.organization_id = fixture.demo_organization_id
  AND override_row.membership_id IN (
    fixture.owner_membership_id,
    fixture.view_membership_id,
    fixture.execute_membership_id
  )
  AND override_row.permission_key IN ('network_center.view', 'network_center.execute')
  AND override_row.revoked_at IS NULL;

DELETE FROM public.role_permissions permission
USING public.role_bindings binding, _nc_fixture fixture
WHERE permission.organization_id = fixture.demo_organization_id
  AND binding.organization_id = fixture.demo_organization_id
  AND binding.membership_id IN (fixture.view_membership_id, fixture.execute_membership_id)
  AND permission.role_id = binding.role_id
  AND permission.permission_key IN ('network_center.view', 'network_center.execute');

INSERT INTO public.authorization_scopes(organization_id, scope_type)
SELECT fixture.demo_organization_id, 'ORGANIZATION'
FROM _nc_fixture fixture
ON CONFLICT DO NOTHING;

INSERT INTO public.authorization_scopes(organization_id, scope_type, building_id)
SELECT fixture.demo_organization_id, 'BUILDING', building_id
FROM _nc_fixture fixture
CROSS JOIN LATERAL (VALUES (fixture.building_a_id), (fixture.building_b_id)) input(building_id)
ON CONFLICT DO NOTHING;

SELECT pg_temp._nc_add_override(
  fixture.owner_membership_id,
  permission_key,
  (SELECT scope.id FROM public.authorization_scopes scope
    WHERE scope.organization_id = fixture.demo_organization_id
      AND scope.scope_type = 'ORGANIZATION'),
  'ORGANIZATION',
  fixture.owner_id
)
FROM _nc_fixture fixture
CROSS JOIN (VALUES ('network_center.view'::text), ('network_center.execute'::text)) permission(permission_key);

SELECT pg_temp._nc_add_override(
  fixture.view_membership_id,
  'network_center.view',
  (SELECT scope.id FROM public.authorization_scopes scope
    WHERE scope.organization_id = fixture.demo_organization_id
      AND scope.scope_type = 'BUILDING' AND scope.building_id = fixture.building_a_id),
  'SCOPED',
  fixture.owner_id
)
FROM _nc_fixture fixture;

SELECT pg_temp._nc_add_override(
  fixture.execute_membership_id,
  permission_key,
  (SELECT scope.id FROM public.authorization_scopes scope
    WHERE scope.organization_id = fixture.demo_organization_id
      AND scope.scope_type = 'BUILDING' AND scope.building_id = fixture.building_a_id),
  'SCOPED',
  fixture.owner_id
)
FROM _nc_fixture fixture
CROSS JOIN (VALUES ('network_center.view'::text), ('network_center.execute'::text)) permission(permission_key);

UPDATE public.network_devices device
SET lifecycle_status = 'ONLINE', write_capability = true,
    display_name = CASE WHEN device.id = fixture.router_a_id
      THEN 'DEMO-NC-ROUTER-A' ELSE 'DEMO-NC-ROUTER-B' END
FROM _nc_fixture fixture
WHERE device.organization_id = fixture.demo_organization_id
  AND device.id IN (fixture.router_a_id, fixture.router_b_id);

UPDATE public.network_site_settings settings
SET changes_paused = false
FROM _nc_fixture fixture
WHERE settings.organization_id = fixture.demo_organization_id
  AND settings.building_id IN (fixture.building_a_id, fixture.building_b_id);

INSERT INTO public.network_device_connections (
  organization_id, building_id, device_id, transport, management_ip,
  management_port, credential_ref, host_key_fingerprint, is_enabled
)
SELECT fixture.demo_organization_id, input.building_id, input.device_id,
       'ROUTEROS_SSH', input.management_ip::inet, 22,
       'demo-network-center-harness',
       'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', true
FROM _nc_fixture fixture
CROSS JOIN LATERAL (
  VALUES
    (fixture.building_a_id, fixture.router_a_id, '192.0.2.10'),
    (fixture.building_b_id, fixture.router_b_id, '192.0.2.11')
) input(building_id, device_id, management_ip)
WHERE NOT EXISTS (
  SELECT 1 FROM public.network_device_connections existing
  WHERE existing.organization_id = fixture.demo_organization_id
    AND existing.building_id = input.building_id
    AND existing.device_id = input.device_id
    AND existing.is_enabled
);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

GRANT SELECT ON TABLE pg_temp._nc_fixture TO authenticated, anon;
GRANT INSERT, SELECT ON TABLE pg_temp._nc_results TO authenticated, anon;
GRANT EXECUTE ON FUNCTION pg_temp._nc_expect_true(text, text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION pg_temp._nc_expect_42501(text, text) TO authenticated, anon;

-- Exercise inventory discovery with more than the former ten-AP assumption.
-- The second interface upsert deliberately asks to lower protection; the
-- database must preserve the original protected state.
CREATE TEMP TABLE _nc_inventory_result ON COMMIT DROP AS
SELECT public.network_center_worker_inventory_v1(
  'demo.harness',
  jsonb_build_object(
    'routerDeviceId', fixture.router_a_id,
    'interfaces', jsonb_build_array(
      jsonb_build_object(
        'interfaceKey', 'ether1', 'displayName', 'ether1',
        'interfaceKind', 'ETHERNET', 'interfaceRole', 'WAN',
        'macAddress', '02:00:00:00:00:01', 'ifIndex', 1,
        'nominalSpeedBps', 1000000000, 'isProtected', false,
        'sortOrder', 1, 'isEnabled', true, 'metadata', '{}'::jsonb
      ),
      jsonb_build_object(
        'interfaceKey', 'ether2', 'displayName', 'ether2',
        'interfaceKind', 'ETHERNET', 'interfaceRole', 'ACCESS',
        'macAddress', '02:00:00:00:00:02', 'ifIndex', 2,
        'nominalSpeedBps', 1000000000, 'isProtected', true,
        'sortOrder', 2, 'isEnabled', true, 'metadata', '{}'::jsonb
      )
    ),
    'aruba', (
      SELECT jsonb_agg(jsonb_build_object(
        'externalKey', 'demo-harness-ap-' || lpad(series::text, 3, '0'),
        'displayName', 'DEMO Aruba ' || series::text,
        'model', 'AP-DEMO',
        'serialNumber', 'DEMO-' || lpad(series::text, 3, '0'),
        'uplinkInterfaceKey', 'ether2',
        'managementAddress', '192.0.2.' || (series + 20)::text,
        'sortOrder', series,
        'lifecycleStatus', 'ONLINE',
        'metadata', jsonb_build_object('source', 'rollback-harness')
      ) ORDER BY series)
      FROM generate_series(1, 12) series
    )
  )
) AS result
FROM _nc_fixture fixture;

SELECT public.network_center_worker_inventory_v1(
  'demo.harness',
  jsonb_build_object(
    'routerDeviceId', fixture.router_a_id,
    'interfaces', jsonb_build_array(jsonb_build_object(
      'interfaceKey', 'ether2', 'displayName', 'ether2',
      'interfaceKind', 'ETHERNET', 'interfaceRole', 'ACCESS',
      'macAddress', '02:00:00:00:00:02', 'ifIndex', 2,
      'nominalSpeedBps', 1000000000, 'isProtected', false,
      'sortOrder', 2, 'isEnabled', true, 'metadata', '{}'::jsonb
    )),
    'aruba', '[]'::jsonb
  )
)
FROM _nc_fixture fixture;

INSERT INTO _nc_results(case_id, passed, detail)
SELECT
  'inventory.mapping',
  jsonb_array_length(inventory.result->'interfaces') = 2
    AND jsonb_array_length(inventory.result->'aruba') = 12
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(inventory.result->'aruba') mapping
      LEFT JOIN public.network_devices device
        ON device.id = (mapping->>'id')::uuid
       AND device.external_key = mapping->>'externalKey'
       AND device.organization_id = fixture.demo_organization_id
       AND device.building_id = fixture.building_a_id
      WHERE device.id IS NULL
    ),
  NULL::jsonb
FROM _nc_inventory_result inventory
CROSS JOIN _nc_fixture fixture
UNION ALL
SELECT
  'inventory.aruba_above_ten',
  (SELECT count(*) = 12
   FROM public.network_devices device
   WHERE device.organization_id = fixture.demo_organization_id
     AND device.building_id = fixture.building_a_id
     AND device.device_kind = 'ARUBA'
     AND device.external_key LIKE 'demo-harness-ap-%'),
  NULL::jsonb
FROM _nc_fixture fixture
UNION ALL
SELECT
  'inventory.aruba_display_only',
  (SELECT count(*) = 12 AND bool_and(
     NOT device.write_capability
       AND device.credential_ref IS NULL
       AND device.inventory_metadata ? 'managementAddress'
   )
   FROM public.network_devices device
   WHERE device.organization_id = fixture.demo_organization_id
     AND device.building_id = fixture.building_a_id
     AND device.device_kind = 'ARUBA'
     AND device.external_key LIKE 'demo-harness-ap-%'),
  NULL::jsonb
FROM _nc_fixture fixture
UNION ALL
SELECT
  'inventory.protected_preserved',
  (SELECT count(*) = 2 AND bool_and(interface.is_protected)
   FROM public.network_interfaces interface
   WHERE interface.organization_id = fixture.demo_organization_id
     AND interface.building_id = fixture.building_a_id
     AND interface.device_id = fixture.router_a_id
     AND interface.interface_key IN ('ether1', 'ether2')),
  NULL::jsonb
FROM _nc_fixture fixture;

-- Owner: organization-scoped view and immediate execute.
SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', fixture.owner_id, 'role', 'authenticated'
)::text, true) FROM _nc_fixture fixture;
SET LOCAL ROLE authenticated;
SELECT pg_temp._nc_expect_true(
  'owner.view',
  format('SELECT public.network_center_get_building_v1(%L::uuid) IS NOT NULL', fixture.building_a_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_true(
  'owner.execute',
  format(
    'SELECT (public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())->>''status'') = ''QUEUED''',
    fixture.router_a_id, 'FLUSH_DNS_CACHE', 'DEMO owner harness action', '{}'
  )
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_true(
  'owner.organization_scope',
  format('SELECT public.network_center_get_building_v1(%L::uuid) IS NOT NULL', fixture.building_b_id)
) FROM _nc_fixture fixture;
RESET ROLE;

-- View-only staff: building A read succeeds, execute is rejected.
SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', fixture.view_id, 'role', 'authenticated'
)::text, true) FROM _nc_fixture fixture;
SET LOCAL ROLE authenticated;
SELECT pg_temp._nc_expect_true(
  'view_only.view',
  format('SELECT public.network_center_get_building_v1(%L::uuid) IS NOT NULL', fixture.building_a_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'view_only.execute_denied',
  format(
    'SELECT public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())',
    fixture.router_a_id, 'FLUSH_DNS_CACHE', 'DEMO view-only denied', '{}'
  )
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'scope.view_wrong_building_denied',
  format('SELECT public.network_center_get_building_v1(%L::uuid)', fixture.building_b_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'browser.direct_commands_denied',
  'SELECT count(*) FROM public.network_commands'
);
RESET ROLE;

-- Execute staff: view + immediate enqueue on building A, but no access to B or PROD.
SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', fixture.execute_id, 'role', 'authenticated'
)::text, true) FROM _nc_fixture fixture;
SET LOCAL ROLE authenticated;
SELECT pg_temp._nc_expect_true(
  'execute.view',
  format('SELECT public.network_center_get_building_v1(%L::uuid) IS NOT NULL', fixture.building_a_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_true(
  'execute.enqueue',
  format(
    'SELECT (public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())->>''status'') = ''QUEUED''',
    fixture.router_a_id, 'FLUSH_DNS_CACHE', 'DEMO execute harness action', '{}'
  )
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'scope.execute_wrong_building_denied',
  format(
    'SELECT public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())',
    fixture.router_b_id, 'FLUSH_DNS_CACHE', 'DEMO wrong building denied', '{}'
  )
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'scope.wrong_organization_denied',
  format('SELECT public.network_center_get_building_v1(%L::uuid)', fixture.prod_building_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_true(
  'scope.production_absent_from_fleet',
  format(
    'SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.network_center_list_fleet_v1()->''items'') item WHERE item->>''buildingId'' = %L)',
    fixture.prod_building_id::text
  )
) FROM _nc_fixture fixture;
RESET ROLE;

-- Offboarding is a real membership transition inside DEMO, then rolled back.
UPDATE public.organization_memberships membership
SET status = 'SUSPENDED', version = version + 1
FROM _nc_fixture fixture
WHERE membership.organization_id = fixture.demo_organization_id
  AND membership.id = fixture.execute_membership_id;

SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', fixture.execute_id, 'role', 'authenticated'
)::text, true) FROM _nc_fixture fixture;
SET LOCAL ROLE authenticated;
SELECT pg_temp._nc_expect_42501(
  'lifecycle.offboarded_view_denied',
  format('SELECT public.network_center_get_building_v1(%L::uuid)', fixture.building_a_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'lifecycle.offboarded_execute_denied',
  format(
    'SELECT public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())',
    fixture.router_a_id, 'FLUSH_DNS_CACHE', 'DEMO offboarded denied', '{}'
  )
) FROM _nc_fixture fixture;
RESET ROLE;

-- Anonymous callers have neither table nor RPC access.
SELECT set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
SET LOCAL ROLE anon;
SELECT pg_temp._nc_expect_42501(
  'anonymous.view_denied',
  format('SELECT public.network_center_get_building_v1(%L::uuid)', fixture.building_a_id)
) FROM _nc_fixture fixture;
SELECT pg_temp._nc_expect_42501(
  'anonymous.execute_denied',
  format(
    'SELECT public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())',
    fixture.router_a_id, 'FLUSH_DNS_CACHE', 'DEMO anonymous denied', '{}'
  )
) FROM _nc_fixture fixture;
RESET ROLE;

WITH evaluated AS (
  SELECT required.sequence, required.case_id,
         coalesce(result.passed, false) AS passed,
         CASE WHEN result.case_id IS NULL
           THEN jsonb_build_object('missing_result', true)
           ELSE result.detail END AS detail
  FROM _nc_required_cases required
  LEFT JOIN _nc_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;`;
}

export function parseNetworkCenterVerdict(body) {
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("Supabase Management SQL returned invalid JSON");
  }
  const verdict = Array.isArray(rows)
    ? rows.find((row) => row && typeof row === "object" && row.verdict)?.verdict
    : null;
  const assertions = verdict?.assertions;
  const assertionCount = Number(verdict?.assertion_count);
  const failedCount = Number(verdict?.failed_count);
  if (
    !verdict ||
    typeof verdict.passed !== "boolean" ||
    !Array.isArray(assertions) ||
    !Number.isInteger(assertionCount) ||
    assertionCount !== REQUIRED_CASE_IDS.length ||
    !Number.isInteger(failedCount)
  ) {
    throw new Error("Supabase Management SQL response has no valid Network Center verdict");
  }
  for (const [index, assertion] of assertions.entries()) {
    if (
      assertion?.case_id !== REQUIRED_CASE_IDS[index] ||
      typeof assertion?.passed !== "boolean"
    ) {
      throw new Error("Network Center verdict case manifest is inconsistent");
    }
  }
  const observedFailures = assertions.filter((assertion) => !assertion.passed).length;
  if (failedCount !== observedFailures || verdict.passed !== (failedCount === 0)) {
    throw new Error("Network Center verdict counts are inconsistent");
  }
  return verdict;
}

async function migrationApplied(config, fetchImpl) {
  const body = await executeManagementQuery(
    "SELECT to_regprocedure('public.network_center_list_fleet_v1()') IS NOT NULL AS applied;",
    config,
    fetchImpl,
  );
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("Unable to parse Network Center migration preflight");
  }
  if (!Array.isArray(rows) || typeof rows[0]?.applied !== "boolean") {
    throw new Error("Network Center migration preflight returned an invalid response");
  }
  return rows[0].applied;
}

export async function main(
  argv = process.argv.slice(2),
  { log = console.log, fetchImpl = fetch, loadConfig = loadAdminConfig } = {},
) {
  const unknown = argv.filter(
    (argument) => !["--dry-run", "--help", "-h"].includes(argument),
  );
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (argv.includes("--help") || argv.includes("-h")) {
    log("Usage: node scripts/test-cross-tenant.mjs [--dry-run]");
    log("  --dry-run  Build the rollback-only matrix without calling Supabase.");
    return;
  }

  const shadowSql = buildShadowMigrationSql();
  if (argv.includes("--dry-run")) {
    const sql = buildNetworkCenterMatrixSql({ shadowSql });
    if (!/\bROLLBACK\s*;/i.test(sql)) {
      throw new Error("Rollback terminator is missing");
    }
    log("Network Center dry run passed: DEMO-only rollback payload built.");
    log("No Management API request was executed.");
    return;
  }

  const config = loadConfig();
  const applied = await migrationApplied(config, fetchImpl);
  const sql = buildNetworkCenterMatrixSql({
    shadowSql: applied ? "" : shadowSql,
  });
  const body = await executeManagementQuery(sql, config, fetchImpl);
  const verdict = parseNetworkCenterVerdict(body);
  if (!verdict.passed) {
    const failures = verdict.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => assertion.case_id)
      .join(", ");
    throw new Error(
      `Network Center tenant matrix failed ${verdict.failed_count}/${verdict.assertion_count}: ${failures}`,
    );
  }
  log(
    `Network Center tenant matrix passed (${verdict.assertion_count} assertions, transaction rolled back).`,
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
