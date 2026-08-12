#!/usr/bin/env node
// Network Center AuthZ/RLS matrix. Every fixture write is limited to the
// canonical DEMO organization and the whole request ends with ROLLBACK.
// Production organization rows are read-only negative targets.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  runDisposableLocalClusterMatrix,
  runDisposableSupabaseMatrix,
} from "./network-center-disposable-db.mjs";

export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
export const DEMO_OWNER_EMAIL = "demo.chunha@username.ihomecrm.local";
export const DEMO_VIEW_EMAIL = "demo.ketoan@username.ihomecrm.local";
export const DEMO_EXECUTE_EMAIL = "demo.quanly@username.ihomecrm.local";

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
  "inventory.protection_role_widening",
  "lifecycle.offboarded_view_denied",
  "lifecycle.offboarded_execute_denied",
  "anonymous.view_denied",
  "anonymous.execute_denied",
]);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requiredCaseValues() {
  return REQUIRED_CASE_IDS.map(
    (caseId, index) => `(${index + 1}, ${sqlLiteral(caseId)})`,
  ).join(",\n  ");
}

function buildLocalProofSql(localProof) {
  if (!localProof) return "NULL::jsonb";
  const {
    proofNonce,
    migrationManifestSha256,
    migrationCount,
    networkCenterMigrationCount,
  } = localProof;
  if (
    !/^[a-f0-9]{32}$/.test(proofNonce) ||
    !/^[a-f0-9]{64}$/.test(migrationManifestSha256) ||
    !Number.isInteger(migrationCount) ||
    !Number.isInteger(networkCenterMigrationCount)
  ) {
    throw new Error("Network Center local proof request is invalid");
  }
  return `(SELECT jsonb_build_object(
    'proof_nonce', proof.proof_nonce,
    'migration_manifest_sha256', proof.migration_manifest_sha256,
    'migration_count', proof.migration_count,
    'network_center_migration_count', proof.network_center_migration_count
  )
  FROM app_private.network_center_disposable_proof proof
  WHERE proof.proof_nonce = ${sqlLiteral(proofNonce)}
    AND proof.migration_manifest_sha256 = ${sqlLiteral(migrationManifestSha256)}
    AND proof.migration_count = ${migrationCount}
    AND proof.network_center_migration_count = ${networkCenterMigrationCount})`;
}

export function buildNetworkCenterMatrixSql({ localProof } = {}) {
  const localProofSql = buildLocalProofSql(localProof);
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET CONSTRAINTS ALL DEFERRED;

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

-- rollout_state defaults to 'OFF', and network_center_execute_action_v1 refuses
-- anything that is not 'EXECUTE' with NETWORK_CENTER_OFF. Leaving it at the
-- default would make every execute case fail for the same uninteresting reason
-- and, worse, make the DENIED cases pass without proving anything: a matrix
-- where the door is shut for everyone cannot show that it opens for the right
-- person and stays shut for the wrong one. The fixture therefore opens the door
-- and lets the RPCs decide who walks through.
--
-- This only ever exists inside this transaction, which ends in ROLLBACK, so the
-- real DEMO buildings stay 'OFF'.
UPDATE public.network_site_settings settings
SET changes_paused = false,
    rollout_state = 'EXECUTE'
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

-- Worker fixture for the v2 inventory path.
--
-- WHY THIS EXISTS AT ALL. This harness used to reach inventory through
-- public.network_center_worker_inventory_v1, which ignores its worker argument
-- and resolves the caller through app_private.network_center_compatibility_worker_v1
-- -- the legacy compatibility snapshot. That snapshot is deliberately one-way:
-- the trigger network_worker_compatibility_one_way rejects any UPDATE that grows
-- expires_at, so the window can narrow and finalize but never reopen. It lapsed
-- on 2026-08-09 11:48 UTC and the v1 entry point has raised 42501 for every
-- caller since. The matrix was therefore not merely failing, it was not running:
-- it aborted in setup, before a single isolation case was evaluated. A silent
-- non-running security matrix is worse than a red one, which is why the fix is
-- to move to the supported path rather than to widen the expired one. Widening
-- would mean dropping the guard trigger, i.e. dismantling a control this repo
-- built on purpose in order to make its own test pass.
--
-- WHY A LOCAL FIXTURE AND NOT A REAL CREDENTIAL. v2 authenticates by digest
-- only: app_private.network_center_authenticate_worker_v2 accepts any 64-char
-- lowercase hex that matches a live row in network_worker_credentials. Since
-- this transaction inserts the credential AND makes the call, the digest can be
-- derived on the spot with sha256() over a fixed label. No secret material is
-- involved, nothing needs to reach CI as an environment variable, and there is
-- nothing here that could leak if the file is read: the "secret" is a public
-- string whose digest is only ever valid inside a transaction that ends in
-- ROLLBACK.
--
-- The fixture worker is scoped to the two DEMO routers and to can_inventory
-- alone. It deliberately does NOT get can_execute: the negative cases further
-- down assert that a worker cannot act outside its assignment, and granting the
-- fixture more than it needs would blunt them.
INSERT INTO public.network_workers (worker_key, display_name, status, capabilities)
VALUES ('demo.harness.v2', 'DEMO cross-tenant harness', 'ACTIVE',
        ARRAY['POLL', 'INVENTORY']::text[])
ON CONFLICT (worker_key) DO UPDATE
  SET status = 'ACTIVE',
      capabilities = ARRAY['POLL', 'INVENTORY']::text[];

INSERT INTO public.network_worker_credentials (
  worker_id, secret_digest, fingerprint, not_before, expires_at
)
SELECT worker.id,
       encode(sha256('demo.harness.v2.cross-tenant-matrix'::bytea), 'hex')::character(64),
       -- The fingerprint has its own CHECK (^sha256:[a-f0-9]{12,64}$); it is a
       -- human-facing label for the credential, not a second secret, so it is
       -- derived from the same public string.
       'sha256:' || left(encode(sha256('demo.harness.v2.cross-tenant-matrix'::bytea), 'hex'), 16),
       clock_timestamp() - INTERVAL '1 minute',
       clock_timestamp() + INTERVAL '1 hour'
FROM public.network_workers worker
WHERE worker.worker_key = 'demo.harness.v2';

INSERT INTO public.network_worker_assignments (
  worker_id, organization_id, building_id, device_id, device_kind,
  can_poll, can_inventory, can_execute, active_from
)
SELECT worker.id, fixture.demo_organization_id, input.building_id,
       input.device_id, 'MIKROTIK', true, true, false,
       clock_timestamp() - INTERVAL '1 minute'
FROM _nc_fixture fixture
CROSS JOIN public.network_workers worker
CROSS JOIN LATERAL (
  VALUES
    (fixture.building_a_id, fixture.router_a_id),
    (fixture.building_b_id, fixture.router_b_id)
) input(building_id, device_id)
WHERE worker.worker_key = 'demo.harness.v2';

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- The v2 path must actually be reachable before the cases below lean on it.
-- Without this the first symptom of a broken fixture would be an isolation case
-- reporting "denied" -- which is what a PASS looks like for half this matrix.
-- A setup fault that disguises itself as a pass is exactly the failure mode this
-- file exists to prevent, so it is asserted here rather than inferred later.
DO $nc_worker_fixture$
DECLARE v_ok boolean;
BEGIN
  SELECT app_private.network_center_worker_can_access_device_v2(
    worker.id, fixture.demo_organization_id, fixture.building_a_id,
    fixture.router_a_id, 'INVENTORY'
  ) INTO v_ok
  FROM _nc_fixture fixture
  CROSS JOIN public.network_workers worker
  WHERE worker.worker_key = 'demo.harness.v2';
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'Harness worker fixture cannot inventory DEMO router A -- the v2 assignment did not take'
      USING ERRCODE = 'P0001';
  END IF;
END
$nc_worker_fixture$;

GRANT SELECT ON TABLE pg_temp._nc_fixture TO authenticated, anon;
GRANT INSERT, SELECT ON TABLE pg_temp._nc_results TO authenticated, anon;
GRANT EXECUTE ON FUNCTION pg_temp._nc_expect_true(text, text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION pg_temp._nc_expect_42501(text, text) TO authenticated, anon;

-- Exercise inventory discovery with more than the former ten-AP assumption.
-- The second interface upsert deliberately asks to lower protection; the
-- database must preserve the original protected state.
CREATE TEMP TABLE _nc_inventory_result ON COMMIT DROP AS
SELECT public.network_center_worker_inventory_v2(
  encode(sha256('demo.harness.v2.cross-tenant-matrix'::bytea), 'hex'),
  jsonb_build_object(
    'routerDeviceId', fixture.router_a_id,
    -- Batched-discovery envelope. The impl validates these before it looks at
    -- anything else (discoveryRunId must be an RFC-4122 UUID, batchIndex in
    -- [0, batchCount), batchCount in [1, 4096]), and a run's batch_count is
    -- immutable once recorded. This submission is a complete one-batch run.
    --
    -- The two submissions below deliberately carry DIFFERENT run ids: batches
    -- are deduplicated on (discovery_run_id, batch_index), so reusing one id
    -- would turn the second call into a silent no-op and quietly retire the
    -- protection-downgrade case it exists to prove.
    'discoveryRunId', gen_random_uuid(),
    'observedAt', clock_timestamp(),
    'batchIndex', 0,
    'batchCount', 1,
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
    -- Aruba items follow the stable-identity contract the ingest now enforces.
    --
    -- Each item must declare where its identity comes from and carry that
    -- identity verbatim; externalKey is not free text but a derived value the
    -- ingest recomputes ('serial:' || stableIdentity for SERIAL, 'mac:' ||
    -- lower(...) for HARDWARE_MAC) and compares. displayOnly must be true --
    -- discovered APs are observations, never write targets. Anything that does
    -- not satisfy all of it is quarantined as ARUBA_ITEM_INVALID rather than
    -- rejected loudly, so a stale payload shape shows up as a silently empty
    -- inventory, which is exactly how this block was failing: all 12 items
    -- quarantined, arubaCount 0, inventoryStatus DEGRADED.
    --
    -- serialNumber is deliberately NOT sent: for identitySource = 'SERIAL' the
    -- ingest derives it from stableIdentity and ignores any value supplied
    -- here. Sending one would suggest it is load-bearing when it is not.
    'aruba', (
      SELECT jsonb_agg(jsonb_build_object(
        'identitySource', 'SERIAL',
        'stableIdentity', 'DEMO-HARNESS-AP-' || lpad(series::text, 3, '0'),
        'externalKey',
          'serial:DEMO-HARNESS-AP-' || lpad(series::text, 3, '0'),
        'displayOnly', true,
        'displayName', 'DEMO Aruba ' || series::text,
        'model', 'AP-DEMO',
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

SELECT public.network_center_worker_inventory_v2(
  encode(sha256('demo.harness.v2.cross-tenant-matrix'::bytea), 'hex'),
  jsonb_build_object(
    'routerDeviceId', fixture.router_a_id,
    'discoveryRunId', gen_random_uuid(),
    'observedAt', clock_timestamp(),
    'batchIndex', 0,
    'batchCount', 1,
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
     -- Selector follows the derived externalKey the ingest recomputes from
     -- stableIdentity; it is how these fixture APs are told apart from real
     -- inventory, not part of the invariant being asserted.
     AND device.external_key LIKE 'serial:DEMO-HARNESS-AP-%'),
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
     -- Selector follows the derived externalKey the ingest recomputes from
     -- stableIdentity; it is how these fixture APs are told apart from real
     -- inventory, not part of the invariant being asserted.
     AND device.external_key LIKE 'serial:DEMO-HARNESS-AP-%'),
  NULL::jsonb
FROM _nc_fixture fixture
UNION ALL
-- Protection is decided by ROLE plus the router's FRESH report -- not by the
-- previously stored value.
--
-- This case used to assert the opposite: that a second cycle reporting a lower
-- protection must not lower it, i.e. is_protected = stored OR observed. That
-- rule was removed on purpose by 20260729148000, and the reasoning is worth
-- keeping in view because it is not obvious. Carrying protection forward fed
-- the bind trigger its own previous output: the trigger forces is_protected
-- true for any DISCOVERED managed resource, so from cycle two onward the stored
-- value was true regardless of what the router said, metadata.eligibleAccess
-- went false and stayed false, and the precondition for enrolling an access
-- port was destroyed by the act of discovering it. Measured in production on
-- 2026-08-03: eligibleAccess false on all five managed resources of the demo
-- router, refreshed every 60 seconds, and the enrollment door with zero callers
-- for its whole lifetime.
--
-- What still holds, and what this case now pins, is the part that actually
-- carries the security weight:
--   ether1 is WAN. It was reported isProtected = false and is protected anyway,
--   because role-based widening (WAN, UPLINK, MANAGEMENT) is applied on every
--   cycle and a worker cannot talk a WAN port out of protection.
--   ether2 is ACCESS. It was reported protected, then reported unprotected by
--   the second submission, and it follows the fresh report -- which is the whole
--   point of the change.
-- Asserting both together is strictly stronger than the old single-sided check:
-- re-introducing the OR flips ether2, dropping role widening flips ether1, and
-- either regression fails here.
SELECT
  'inventory.protection_role_widening',
  (SELECT count(*) = 2
     AND bool_and(interface.is_protected)
       FILTER (WHERE interface.interface_key = 'ether1')
     AND bool_and(NOT interface.is_protected)
       FILTER (WHERE interface.interface_key = 'ether2')
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
  -- A DIFFERENT action from owner.execute on purpose. Commands are deduplicated
  -- by semantic_fingerprint inside a cooldown window, and that fingerprint does
  -- not include who asked or why -- so a second FLUSH_DNS_CACHE on the same
  -- router is refused as an equivalent intent no matter which role sends it.
  -- Reusing the action here would make this case fail for a reason that has
  -- nothing to do with permissions, which is what it is here to measure: a
  -- staff member holding network_center.execute on building A can queue work on
  -- router A. Same router, same role, same building -- only the verb differs.
  format(
    'SELECT (public.network_center_execute_action_v1(%L::uuid, %L, %L, %L::jsonb, NULL, gen_random_uuid())->>''status'') = ''QUEUED''',
    fixture.router_a_id, 'RENEW_DHCP_LEASE', 'DEMO execute harness action', '{}'
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
  'local_proof', ${localProofSql},
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;`;
}

export function parseNetworkCenterVerdict(body, { expectedLocalProof } = {}) {
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
  if (expectedLocalProof) {
    const observedProof = verdict.local_proof;
    const expectedProof = {
      proof_nonce: expectedLocalProof.proofNonce,
      migration_manifest_sha256: expectedLocalProof.migrationManifestSha256,
      migration_count: expectedLocalProof.migrationCount,
      network_center_migration_count: expectedLocalProof.networkCenterMigrationCount,
    };
    if (
      !observedProof ||
      observedProof.proof_nonce !== expectedProof.proof_nonce ||
      observedProof.migration_manifest_sha256 !== expectedProof.migration_manifest_sha256 ||
      Number(observedProof.migration_count) !== expectedProof.migration_count ||
      Number(observedProof.network_center_migration_count) !==
        expectedProof.network_center_migration_count
    ) {
      throw new Error(
        "Network Center verdict has no authentic local proof; refusing a fabricated pass",
      );
    }
  }
  return verdict;
}

// psql prints a single jsonb column as a bare object per line, while the
// Supabase CLI wraps rows in a JSON array. Normalise the cluster output into the
// CLI shape so exactly one validator governs both paths - a second hand-written
// validator is how two paths quietly drift apart.
export function parseNetworkCenterClusterVerdict(output, options = {}) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Disposable cluster returned no Network Center verdict");
  }
  const candidates = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        Array.isArray(entry.assertions),
    );
  if (candidates.length !== 1) {
    throw new Error(
      `Disposable cluster returned ${candidates.length} Network Center verdicts; expected exactly one`,
    );
  }
  return parseNetworkCenterVerdict(
    JSON.stringify([{ verdict: candidates[0] }]),
    options,
  );
}

async function migrationApplied(config, fetchImpl, executeQuery) {
  const body = await executeQuery(
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
  {
    log = console.log,
    fetchImpl: injectedFetch,
    loadConfig: injectedLoadConfig,
    executeQuery: injectedExecuteQuery,
    runLocalDisposable = runDisposableSupabaseMatrix,
    runLocalCluster = runDisposableLocalClusterMatrix,
    disposableOptions = {},
  } = {},
) {
  const modes = ["--dry-run", "--local-disposable", "--local-cluster"];
  const unknown = argv.filter(
    (argument) => ![...modes, "--help", "-h"].includes(argument),
  );
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (argv.filter((argument) => modes.includes(argument)).length > 1) {
    throw new Error(
      "Choose exactly one of --dry-run, --local-disposable or --local-cluster",
    );
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    log("Usage: node scripts/test-cross-tenant.mjs [--dry-run | --local-cluster | --local-disposable]");
    log("  --dry-run  Build the rollback-only matrix without calling Supabase.");
    log("  --local-cluster  Build a disposable local PostgreSQL database from the declared platform");
    log("                   bootstrap plus the real Network Center migrations, run the matrix, then");
    log("                   destroy the cluster and verify the port is closed. Needs no Docker.");
    log("  --local-disposable  Apply all migrations to an isolated local Supabase stack (Docker), run");
    log("                      the matrix, then remove it. See network-center-disposable-db.mjs for why");
    log("                      the full historical replay this uses cannot succeed from a blank database.");
    return;
  }

  if (argv.includes("--local-cluster")) {
    const verdict = await runLocalCluster({
      ...disposableOptions,
      buildSql: buildNetworkCenterMatrixSql,
      parseVerdict: parseNetworkCenterClusterVerdict,
    });
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
      `Network Center local cluster matrix passed (${verdict.assertion_count} assertions, transaction rolled back and cluster destroyed).`,
    );
    return;
  }

  if (argv.includes("--dry-run")) {
    const sql = buildNetworkCenterMatrixSql();
    if (!/\bROLLBACK\s*;/i.test(sql)) {
      throw new Error("Rollback terminator is missing");
    }
    log("Network Center dry run passed: applied-schema rollback payload built.");
    log("No Management API request was executed.");
    return;
  }

  if (argv.includes("--local-disposable")) {
    const verdict = await runLocalDisposable({
      ...disposableOptions,
      buildSql: buildNetworkCenterMatrixSql,
      parseVerdict: parseNetworkCenterVerdict,
    });
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
      `Network Center local disposable matrix passed (${verdict.assertion_count} assertions, transaction rolled back and stack removed).`,
    );
    return;
  }

  const productionHarness = await import("./test-business-performance-authz.mjs");
  const fetchImpl = injectedFetch ?? fetch;
  const loadConfig = injectedLoadConfig ?? productionHarness.loadAdminConfig;
  const executeQuery =
    injectedExecuteQuery ?? productionHarness.executeManagementQuery;
  const config = loadConfig();
  const applied = await migrationApplied(config, fetchImpl, executeQuery);
  if (!applied) {
    throw new Error(
      "Network Center migration is not applied; refusing shadow DDL on the configured project",
    );
  }
  const sql = buildNetworkCenterMatrixSql();
  const body = await executeQuery(sql, config, fetchImpl);
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
