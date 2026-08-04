#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runDisposableSupabaseMatrix } from "./network-center-disposable-db.mjs";

const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
const FORBIDDEN_PROD_ORG_ID = [
  "aaaa0000", "0000", "4000", "8000", "000000000001",
].join("-");
const MAX_RUNNER_OUTPUT_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024;

// The exact public worker v2 route/RPC-name/signature surface. This is the
// single source of truth for the preflight existence checks below and for
// the case catalog: every route gets an independent runtime (assigned worker
// succeeds) proof and control (unassigned/wrong-credential fail-closed) proof.
export const PUBLIC_WORKER_V2_RPC_MANIFEST = Object.freeze([
  Object.freeze({
    route: "heartbeat",
    rpcName: "network_center_worker_heartbeat_v2",
    signature: "network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)",
  }),
  Object.freeze({
    route: "connections",
    rpcName: "network_center_worker_list_connections_v2",
    signature: "network_center_worker_list_connections_v2(text,integer)",
  }),
  Object.freeze({
    route: "claim",
    rpcName: "network_center_worker_claim_v2",
    signature: "network_center_worker_claim_v2(text,integer,integer)",
  }),
  Object.freeze({
    route: "renew",
    rpcName: "network_center_worker_renew_v2",
    signature: "network_center_worker_renew_v2(text,uuid,uuid,bigint,integer)",
  }),
  Object.freeze({
    route: "ingest",
    rpcName: "network_center_worker_ingest_v2",
    signature: "network_center_worker_ingest_v2(text,jsonb)",
  }),
  Object.freeze({
    route: "inventory",
    rpcName: "network_center_worker_inventory_v2",
    signature: "network_center_worker_inventory_v2(text,jsonb)",
  }),
  Object.freeze({
    route: "stage",
    rpcName: "network_center_worker_command_event_v2",
    signature: "network_center_worker_command_event_v2(text,uuid,uuid,bigint,text,jsonb)",
  }),
  Object.freeze({
    route: "observe",
    rpcName: "network_center_worker_observe_v2",
    signature: "network_center_worker_observe_v2(text,uuid,uuid,bigint,bigint,uuid,text,timestamp with time zone,jsonb)",
  }),
  Object.freeze({
    route: "complete",
    rpcName: "network_center_worker_complete_v2",
    signature: "network_center_worker_complete_v2(text,uuid,uuid,bigint,bigint,text,jsonb,jsonb,integer)",
  }),
  Object.freeze({
    route: "incidents",
    rpcName: "network_center_worker_upsert_incident_v2",
    signature: "network_center_worker_upsert_incident_v2(text,jsonb)",
  }),
  Object.freeze({
    route: "snapshots",
    rpcName: "network_center_worker_snapshot_v2",
    signature: "network_center_worker_snapshot_v2(text,jsonb)",
  }),
  Object.freeze({
    route: "maintenance",
    rpcName: "network_center_worker_maintenance_v2",
    signature: "network_center_worker_maintenance_v2(text,timestamp with time zone)",
  }),
]);

export const WORKER_SCOPE_CASE_IDS = Object.freeze([
  // Heartbeat: worker-facing RPC boundary plus the RLS-scoped browser
  // projection it feeds (no worker identity/credential ever reaches it).
  "rpc.heartbeat.runtime",
  "rpc.heartbeat.control",
  "heartbeat.raw_anon_denied",
  "heartbeat.raw_authenticated_denied",
  "heartbeat.raw_service_role_denied",
  "heartbeat.projection_service_role_denied",
  "heartbeat.browser_projection_scoped",
  "heartbeat.projection_secret_free",
  "heartbeat.publication_scoped",
  // Every remaining public worker v2 RPC: an independent runtime proof (the
  // assigned worker succeeds) and control proof (an unassigned or
  // unauthenticated caller is denied) against live DEMO fixtures.
  "rpc.connections.runtime",
  "rpc.connections.control",
  "rpc.claim.runtime",
  "rpc.claim.control",
  "rpc.renew.runtime",
  "rpc.renew.control",
  "rpc.ingest.runtime",
  "rpc.ingest.control",
  "rpc.inventory.runtime",
  "rpc.inventory.control",
  "rpc.stage.runtime",
  "rpc.stage.control",
  "rpc.observe.runtime",
  "rpc.observe.control",
  "rpc.complete.runtime",
  "rpc.complete.control",
  "rpc.incidents.runtime",
  "rpc.incidents.control",
  "rpc.snapshots.runtime",
  "rpc.snapshots.control",
  "rpc.maintenance.runtime",
  "rpc.maintenance.control",
]);

function workerScopeRpcPreflightCheck() {
  return PUBLIC_WORKER_V2_RPC_MANIFEST
    .map((entry) => `to_regprocedure('public.${entry.signature}') IS NULL`)
    .join("\n     OR ");
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function caseValues() {
  return WORKER_SCOPE_CASE_IDS.map(
    (caseId, index) => `(${index + 1}, ${sqlLiteral(caseId)})`,
  ).join(",\n  ");
}

export function buildNetworkCenterWorkerScopeSql() {
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE _ncws_fixture (
  organization_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  visible_building_id uuid NOT NULL,
  control_building_id uuid NOT NULL,
  visible_device_id uuid NOT NULL,
  control_device_id uuid NOT NULL,
  visible_scope_id uuid NOT NULL,
  view_override_id uuid NOT NULL,
  assigned_digest text NOT NULL,
  control_digest text NOT NULL
) ON COMMIT DROP;

INSERT INTO _ncws_fixture VALUES (
  ${sqlLiteral(DEMO_ORG_ID)}::uuid,
  '15150000-0000-4000-8000-000000000001'::uuid,
  '15150000-0000-4000-8000-000000000002'::uuid,
  '15150000-0000-4000-8000-000000000101'::uuid,
  '15150000-0000-4000-8000-000000000102'::uuid,
  '15150000-0000-4000-8000-000000000201'::uuid,
  '15150000-0000-4000-8000-000000000202'::uuid,
  '15150000-0000-4000-8000-000000000301'::uuid,
  '15150000-0000-4000-8000-000000000302'::uuid,
  repeat('a', 64),
  repeat('b', 64)
);

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations organization
    WHERE organization.id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND organization.is_demo
      AND organization.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Canonical DEMO organization is unavailable';
  END IF;
  IF ${workerScopeRpcPreflightCheck()} THEN
    RAISE EXCEPTION 'Network Center worker v2 RPCs are unavailable';
  END IF;
END
$preflight$;

INSERT INTO auth.users (
  id, aud, role, email, created_at, updated_at
)
SELECT owner_id, 'authenticated', 'authenticated',
  'worker-scope-owner@example.invalid', clock_timestamp(), clock_timestamp()
FROM _ncws_fixture;

INSERT INTO public.organization_memberships (
  id, organization_id, user_id, member_type, status,
  valid_from, activated_at
)
SELECT membership_id, organization_id, owner_id, 'OWNER', 'ACTIVE',
  clock_timestamp() - INTERVAL '1 minute', clock_timestamp()
FROM _ncws_fixture;

INSERT INTO public.buildings (
  id, user_id, organization_id, name, province, district, ward,
  total_floors, total_rooms
)
SELECT visible_building_id, owner_id, organization_id,
  'Worker scope visible building', 'DEMO', 'DEMO', 'DEMO', 1, 1
FROM _ncws_fixture
UNION ALL
SELECT control_building_id, owner_id, organization_id,
  'Worker scope control building', 'DEMO', 'DEMO', 'DEMO', 1, 1
FROM _ncws_fixture;

INSERT INTO public.network_devices (
  id, organization_id, building_id, device_kind, external_key,
  display_name, vendor, lifecycle_status, write_capability,
  is_active, credential_ref
)
SELECT visible_device_id, organization_id, visible_building_id,
  'MIKROTIK', 'worker-scope-visible-router',
  'Worker scope visible router', 'MikroTik', 'ONLINE', true, true,
  'runtime/worker-scope-visible'
FROM _ncws_fixture
UNION ALL
SELECT control_device_id, organization_id, control_building_id,
  'MIKROTIK', 'worker-scope-control-router',
  'Worker scope control router', 'MikroTik', 'ONLINE', true, true,
  'runtime/worker-scope-control'
FROM _ncws_fixture
UNION ALL
SELECT '15150000-0000-4000-8000-000000000203'::uuid, organization_id,
  visible_building_id, 'MIKROTIK', 'worker-scope-visible-router-2',
  'Worker scope visible router 2', 'MikroTik', 'ONLINE', true, true,
  'runtime/worker-scope-visible-2'
FROM _ncws_fixture;

INSERT INTO public.authorization_scopes (
  id, organization_id, scope_type, building_id
)
SELECT visible_scope_id, organization_id, 'BUILDING', visible_building_id
FROM _ncws_fixture;

INSERT INTO public.member_permission_overrides (
  id, organization_id, membership_id, permission_key, effect,
  reason, created_by, scope_mode
)
SELECT view_override_id, organization_id, membership_id,
  'network_center.view', 'ALLOW',
  'Rollback-only worker heartbeat projection proof', owner_id, 'SCOPED'
FROM _ncws_fixture;

INSERT INTO public.member_override_scopes (
  organization_id, override_id, scope_id
)
SELECT organization_id, view_override_id, visible_scope_id
FROM _ncws_fixture;

-- Both assignments grant every assignment-level capability flag so a single
-- pair of workers can prove the full public worker v2 RPC surface: heartbeat
-- and inventory only ever needed can_poll/can_inventory, but claim, renew,
-- stage, observe, complete, snapshot and maintenance additionally require
-- can_execute. The worker-level capabilities array already grants everything
-- unconditionally, so widening the assignment-level flags does not weaken
-- any existing runtime or control proof above.
SELECT public.network_center_admin_provision_worker_v1(
  'worker-scope-assigned',
  'Worker scope assigned worker',
  assigned_digest,
  'sha256:' || substr(assigned_digest, 1, 24),
  clock_timestamp() + INTERVAL '1 day',
  jsonb_build_array(
    jsonb_build_object(
      'organizationId', organization_id,
      'buildingId', visible_building_id,
      'deviceId', visible_device_id,
      'canPoll', true,
      'canInventory', true,
      'canExecute', true
    ),
    jsonb_build_object(
      'organizationId', organization_id,
      'buildingId', visible_building_id,
      'deviceId', '15150000-0000-4000-8000-000000000203'::uuid,
      'canPoll', true,
      'canInventory', true,
      'canExecute', true
    )
  )
)
FROM _ncws_fixture;

SELECT public.network_center_admin_provision_worker_v1(
  'worker-scope-control',
  'Worker scope control worker',
  control_digest,
  'sha256:' || substr(control_digest, 1, 24),
  clock_timestamp() + INTERVAL '1 day',
  jsonb_build_array(jsonb_build_object(
    'organizationId', organization_id,
    'buildingId', control_building_id,
    'deviceId', control_device_id,
    'canPoll', true,
    'canInventory', true,
    'canExecute', true
  ))
)
FROM _ncws_fixture;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- Fixture state for the stateful public worker v2 RPCs. The claim command
-- stays QUEUED on the worker's first device so rpc.claim.* can prove the
-- assignment boundary; the lease command is hand-set to the exact state a
-- successful claim would leave on the worker's second device (a distinct
-- device so claiming the first never collides with the device-lease
-- exclusivity check below), so rpc.renew/.stage/.observe/.complete can each
-- be proven independently without depending on claim's own admission rules.
INSERT INTO public.network_site_settings (
  organization_id, building_id, rollout_state
)
SELECT organization_id, visible_building_id, 'EXECUTE'
FROM _ncws_fixture;

INSERT INTO public.network_device_connections (
  organization_id, building_id, device_id, transport, management_ip,
  management_port, credential_ref, poll_interval_seconds,
  connect_timeout_ms, is_enabled
)
SELECT organization_id, visible_building_id, visible_device_id,
  'ROUTEROS_SSH', '192.0.2.10'::inet, 22,
  'runtime/worker-scope-connection', 60, 8000, true
FROM _ncws_fixture;

INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, status, managed_target, intent_type,
  expected_postcondition, observation_deadline, semantic_fingerprint
)
SELECT
  '15150000-0000-4000-8000-000000000801'::uuid,
  organization_id, visible_building_id, visible_device_id,
  'CAPTURE_SNAPSHOT', 'Rollback-only worker-scope claim runtime proof',
  '{}'::jsonb, '{}'::jsonb, owner_id, repeat('7', 64),
  'worker-scope-claim-fixture-001', 'QUEUED', '{}'::jsonb,
  'CAPTURE_SNAPSHOT', '{}'::jsonb, clock_timestamp() + INTERVAL '1 hour',
  repeat('8', 64)
FROM _ncws_fixture;

INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, status, lease_token, lease_owner, lease_expires_at,
  attempt_count, managed_target, intent_type, expected_postcondition,
  observation_deadline, semantic_fingerprint
)
SELECT
  '15150000-0000-4000-8000-000000000802'::uuid,
  organization_id, visible_building_id,
  '15150000-0000-4000-8000-000000000203'::uuid,
  'CAPTURE_SNAPSHOT', 'Rollback-only worker-scope lease runtime proof',
  '{}'::jsonb, '{}'::jsonb, owner_id, repeat('9', 64),
  'worker-scope-lease-fixture-001', 'LEASED',
  '15150000-0000-4000-8000-000000000803'::uuid, 'worker-scope-assigned',
  clock_timestamp() + INTERVAL '90 seconds', 1,
  '{}'::jsonb, 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  clock_timestamp() + INTERVAL '1 hour', repeat('6', 64)
FROM _ncws_fixture;

INSERT INTO public.network_device_leases (
  device_id, organization_id, building_id, command_id, lease_token,
  lease_owner, acquired_at, heartbeat_at, expires_at, generation
)
SELECT
  '15150000-0000-4000-8000-000000000203'::uuid, organization_id,
  visible_building_id, '15150000-0000-4000-8000-000000000802'::uuid,
  '15150000-0000-4000-8000-000000000803'::uuid, 'worker-scope-assigned',
  clock_timestamp() - INTERVAL '5 seconds',
  clock_timestamp() - INTERVAL '5 seconds',
  clock_timestamp() + INTERVAL '90 seconds', 1
FROM _ncws_fixture;

INSERT INTO public.network_command_attempts (
  organization_id, building_id, command_id, device_id, attempt_no,
  worker_id, lease_token, outcome, started_at
)
SELECT organization_id, visible_building_id,
  '15150000-0000-4000-8000-000000000802'::uuid,
  '15150000-0000-4000-8000-000000000203'::uuid, 1,
  'worker-scope-assigned', '15150000-0000-4000-8000-000000000803'::uuid,
  'STARTED', clock_timestamp() - INTERVAL '5 seconds'
FROM _ncws_fixture;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE _ncws_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _ncws_required_cases(sequence, case_id) VALUES
  ${caseValues()};

CREATE TEMP TABLE _ncws_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.ncws_expect_true(
  p_case_id text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $fn$
DECLARE
  v_value boolean;
BEGIN
  EXECUTE p_statement INTO v_value;
  INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
  VALUES (
    p_case_id,
    v_value IS TRUE,
    CASE WHEN v_value IS TRUE THEN NULL
      ELSE jsonb_build_object('observed', v_value) END
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
  VALUES (
    p_case_id,
    false,
    jsonb_build_object('unexpected_sqlstate', SQLSTATE, 'message', SQLERRM)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.ncws_expect_42501(
  p_case_id text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $fn$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
    VALUES (
      p_case_id, false,
      jsonb_build_object('expected_sqlstate', '42501')
    );
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
      VALUES (
        p_case_id, true,
        jsonb_build_object('sqlstate', SQLSTATE)
      );
    WHEN OTHERS THEN
      INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
      VALUES (
        p_case_id, false,
        jsonb_build_object(
          'unexpected_sqlstate', SQLSTATE,
          'message', SQLERRM
        )
      );
  END;
END;
$fn$;

-- Generalized fail-closed proof: several public worker v2 RPCs deny an
-- out-of-scope caller with a SQLSTATE other than 42501 (an unauthenticated
-- credential digest is '28000'; a fenced lease held by a different worker is
-- '55000'), so this accepts the exact expected SQLSTATE instead of hardcoding
-- one, without touching the existing, already-passing ncws_expect_42501.
CREATE OR REPLACE FUNCTION pg_temp.ncws_expect_sqlstate(
  p_case_id text,
  p_statement text,
  p_expected_sqlstate text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $fn$
BEGIN
  BEGIN
    EXECUTE p_statement;
    INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
    VALUES (
      p_case_id, false,
      jsonb_build_object('expected_sqlstate', p_expected_sqlstate)
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
    VALUES (
      p_case_id,
      SQLSTATE = p_expected_sqlstate,
      jsonb_build_object(
        'sqlstate', SQLSTATE,
        'expected_sqlstate', p_expected_sqlstate,
        'message', CASE WHEN SQLSTATE = p_expected_sqlstate
          THEN NULL ELSE SQLERRM END
      )
    );
  END;
END;
$fn$;

GRANT SELECT ON TABLE pg_temp._ncws_fixture
  TO anon, authenticated, service_role;
GRANT INSERT, SELECT ON TABLE pg_temp._ncws_results
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.ncws_expect_true(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.ncws_expect_42501(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.ncws_expect_sqlstate(text, text, text)
  TO anon, authenticated, service_role;

SET LOCAL ROLE service_role;

-- A valid but differently assigned worker must be blocked from the target.
SELECT pg_temp.ncws_expect_42501(
  'rpc.inventory.control',
  format(
    'SELECT public.network_center_worker_inventory_v2(%L, %L::jsonb)',
    fixture.control_digest,
    jsonb_build_object(
      'routerDeviceId', fixture.visible_device_id,
      'discoveryRunId', '15150000-0000-4000-8000-000000000601'::uuid,
      'observedAt', clock_timestamp(),
      'batchIndex', 0,
      'batchCount', 1,
      'interfaces', '[]'::jsonb,
      'aruba', '[]'::jsonb,
      'quarantine', '[]'::jsonb
    )::text
  )
)
FROM pg_temp._ncws_fixture fixture;

-- The assigned worker is the legitimate control for the same v2 RPC target.
SELECT pg_temp.ncws_expect_true(
  'rpc.inventory.runtime',
  format(
    $statement$
      SELECT (
        public.network_center_worker_inventory_v2(%L, %L::jsonb)
          ->> 'interfaceCount'
      )::integer = 0
    $statement$,
    fixture.assigned_digest,
    jsonb_build_object(
      'routerDeviceId', fixture.visible_device_id,
      'discoveryRunId', '15150000-0000-4000-8000-000000000602'::uuid,
      'observedAt', clock_timestamp(),
      'batchIndex', 0,
      'batchCount', 1,
      'interfaces', '[]'::jsonb,
      'aruba', '[]'::jsonb,
      'quarantine', '[]'::jsonb
    )::text
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.heartbeat.runtime',
  format(
    $statement$
      SELECT (
        public.network_center_worker_heartbeat_v2(
          %L,
          repeat('1', 40),
          ARRAY['routeros-ssh', 'polling'],
          'ONLINE',
          2,
          jsonb_build_object(
            'source', 'worker-scope-runtime',
            'connections', 1,
            'successfulPolls', 1,
            'failedPolls', 0
          ),
          clock_timestamp() - INTERVAL '1 minute'
        ) ->> 'assignedBuildingCount'
      )::integer = 1
    $statement$,
    fixture.assigned_digest
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT public.network_center_worker_heartbeat_v2(
  control_digest,
  repeat('2', 40),
  ARRAY['routeros-ssh', 'polling'],
  'DEGRADED',
  3,
  jsonb_build_object(
    'source', 'worker-scope-control',
    'connections', 1,
    'successfulPolls', 0,
    'failedPolls', 1
  ),
  clock_timestamp() - INTERVAL '1 minute'
)
FROM pg_temp._ncws_fixture;

SELECT pg_temp.ncws_expect_42501(
  'heartbeat.raw_service_role_denied',
  'SELECT count(*) FROM public.network_worker_heartbeats'
);
SELECT pg_temp.ncws_expect_42501(
  'heartbeat.projection_service_role_denied',
  'SELECT count(*) FROM public.network_worker_building_status'
);

-- Heartbeat has no per-call target (it updates every building the caller is
-- currently assigned to), so its only fail-closed boundary is authentication
-- itself: an unregistered credential digest must be denied before any write.
SELECT pg_temp.ncws_expect_sqlstate(
  'rpc.heartbeat.control',
  format(
    $statement$
      SELECT public.network_center_worker_heartbeat_v2(
        %L, repeat('3', 40), ARRAY['routeros-ssh', 'polling'], 'ONLINE', 1,
        jsonb_build_object('source', 'worker-scope-heartbeat-control'),
        clock_timestamp() - INTERVAL '1 minute'
      )
    $statement$,
    repeat('f', 64)
  ),
  '28000'
);

-- rpc.connections: the browser-facing device connection roster is scoped by
-- the SAME worker/device assignment as every other v2 RPC.
SELECT pg_temp.ncws_expect_true(
  'rpc.connections.control',
  format(
    $statement$
      SELECT jsonb_array_length(
        public.network_center_worker_list_connections_v2(%L, 10) -> 'items'
      ) = 0
    $statement$,
    fixture.control_digest
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.connections.runtime',
  format(
    $statement$
      SELECT jsonb_array_length(result -> 'items') = 1
        AND result -> 'items' -> 0 ->> 'deviceId' = %L
      FROM (
        SELECT public.network_center_worker_list_connections_v2(%L, 10)
          AS result
      ) subquery
    $statement$,
    fixture.visible_device_id::text,
    fixture.assigned_digest
  )
)
FROM pg_temp._ncws_fixture fixture;

-- rpc.claim: a QUEUED command on the worker's own device is claimable only
-- by the worker actually assigned to that device.
SELECT pg_temp.ncws_expect_true(
  'rpc.claim.control',
  format(
    $statement$
      SELECT jsonb_array_length(
        public.network_center_worker_claim_v2(%L, 5, 90) -> 'items'
      ) = 0
    $statement$,
    fixture.control_digest
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.claim.runtime',
  format(
    $statement$
      SELECT jsonb_array_length(result -> 'items') = 1
        AND result -> 'items' -> 0 ->> 'commandId' = %L
      FROM (
        SELECT public.network_center_worker_claim_v2(%L, 5, 90) AS result
      ) subquery
    $statement$,
    '15150000-0000-4000-8000-000000000801',
    fixture.assigned_digest
  )
)
FROM pg_temp._ncws_fixture fixture;

-- rpc.renew / rpc.stage / rpc.observe / rpc.complete: exercised against the
-- hand-leased command above (fixed lease token, fencing generation 1). Each
-- control proof reuses the SAME lease the assigned worker actually holds, so
-- it proves ownership is enforced rather than merely "no lease exists".
SELECT pg_temp.ncws_expect_sqlstate(
  'rpc.renew.control',
  format(
    $statement$
      SELECT public.network_center_worker_renew_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 90
      )
    $statement$,
    fixture.control_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803'
  ),
  '55000'
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.renew.runtime',
  format(
    $statement$
      SELECT public.network_center_worker_renew_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 90
      ) ->> 'commandId' = %L
    $statement$,
    fixture.assigned_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803',
    '15150000-0000-4000-8000-000000000802'
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_sqlstate(
  'rpc.stage.control',
  format(
    $statement$
      SELECT public.network_center_worker_command_event_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 'VALIDATED', '{}'::jsonb
      )
    $statement$,
    fixture.control_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803'
  ),
  '55000'
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.stage.runtime',
  format(
    $statement$
      SELECT public.network_center_worker_command_event_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 'VALIDATED', '{}'::jsonb
      ) ->> 'eventKind' = 'VALIDATED'
    $statement$,
    fixture.assigned_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803'
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_sqlstate(
  'rpc.observe.control',
  format(
    $statement$
      SELECT public.network_center_worker_observe_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 1::bigint,
        gen_random_uuid(), 'PRE_ACTION', clock_timestamp(), '{}'::jsonb
      )
    $statement$,
    fixture.control_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803'
  ),
  '55000'
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.observe.runtime',
  format(
    $statement$
      SELECT public.network_center_worker_observe_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 1::bigint,
        gen_random_uuid(), 'PRE_ACTION', clock_timestamp(), '{}'::jsonb
      ) ->> 'accepted' = 'true'
    $statement$,
    fixture.assigned_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803'
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_sqlstate(
  'rpc.complete.control',
  format(
    $statement$
      SELECT public.network_center_worker_complete_v2(
        %L, %L::uuid, %L::uuid, 1::bigint, 1::bigint,
        'FAILED', '{}'::jsonb, NULL, 30
      )
    $statement$,
    fixture.control_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803'
  ),
  '55000'
)
FROM pg_temp._ncws_fixture fixture;

-- complete is the terminal step for this command, so its transition_version
-- is looked up live rather than assumed, to stay correct regardless of how
-- many prior observe/stage calls already advanced it.
SELECT pg_temp.ncws_expect_true(
  'rpc.complete.runtime',
  format(
    $statement$
      SELECT public.network_center_worker_complete_v2(
        %L, %L::uuid, %L::uuid, 1::bigint,
        (SELECT command.transition_version FROM public.network_commands command
          WHERE command.id = %L::uuid),
        'FAILED', '{}'::jsonb, NULL, 30
      ) ->> 'status' = 'FAILED'
    $statement$,
    fixture.assigned_digest,
    '15150000-0000-4000-8000-000000000802',
    '15150000-0000-4000-8000-000000000803',
    '15150000-0000-4000-8000-000000000802'
  )
)
FROM pg_temp._ncws_fixture fixture;

-- rpc.ingest: a mixed telemetry payload is rejected as a whole batch when
-- any target device is outside the caller's assignment.
SELECT pg_temp.ncws_expect_42501(
  'rpc.ingest.control',
  format(
    $statement$
      SELECT public.network_center_worker_ingest_v2(
        %L,
        jsonb_build_object(
          'observedAt', clock_timestamp(),
          'devices', jsonb_build_array(jsonb_build_object('deviceId', %L)),
          'interfaces', '[]'::jsonb,
          'clients', '[]'::jsonb
        )
      )
    $statement$,
    fixture.control_digest,
    fixture.visible_device_id
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.ingest.runtime',
  format(
    $statement$
      SELECT (
        public.network_center_worker_ingest_v2(
          %L,
          jsonb_build_object(
            'observedAt', clock_timestamp(),
            'devices', jsonb_build_array(jsonb_build_object('deviceId', %L)),
            'interfaces', '[]'::jsonb,
            'clients', '[]'::jsonb
          )
        ) ->> 'devices'
      )::integer = 1
    $statement$,
    fixture.assigned_digest,
    fixture.visible_device_id
  )
)
FROM pg_temp._ncws_fixture fixture;

-- rpc.incidents: opening an incident requires INCIDENT access to the
-- device's own MikroTik router.
SELECT pg_temp.ncws_expect_42501(
  'rpc.incidents.control',
  format(
    $statement$
      SELECT public.network_center_worker_upsert_incident_v2(
        %L,
        jsonb_build_object(
          'deviceId', %L,
          'eventKey', 'worker-scope-incident-control-evt',
          'fingerprint', 'worker-scope-incident-control-fp',
          'incidentType', 'LINK_DOWN',
          'severity', 'WARNING',
          'title', 'Worker scope control incident proof',
          'summary', 'Rollback-only worker-scope control incident proof',
          'observedAt', clock_timestamp(),
          'observedValues', '{}'::jsonb
        )
      )
    $statement$,
    fixture.control_digest,
    fixture.visible_device_id
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.incidents.runtime',
  format(
    $statement$
      SELECT public.network_center_worker_upsert_incident_v2(
        %L,
        jsonb_build_object(
          'deviceId', %L,
          'eventKey', 'worker-scope-incident-runtime-evt',
          'fingerprint', 'worker-scope-incident-runtime-fp',
          'incidentType', 'LINK_DOWN',
          'severity', 'WARNING',
          'title', 'Worker scope runtime incident proof',
          'summary', 'Rollback-only worker-scope runtime incident proof',
          'observedAt', clock_timestamp(),
          'observedValues', '{}'::jsonb
        )
      ) ->> 'status' = 'OPEN'
    $statement$,
    fixture.assigned_digest,
    fixture.visible_device_id
  )
)
FROM pg_temp._ncws_fixture fixture;

-- rpc.snapshots: a redacted config snapshot may only be recorded against a
-- device the caller has SNAPSHOT (can_execute) access to.
SELECT pg_temp.ncws_expect_42501(
  'rpc.snapshots.control',
  format(
    $statement$
      SELECT public.network_center_worker_snapshot_v2(
        %L,
        jsonb_build_object(
          'snapshotId', gen_random_uuid(),
          'deviceId', %L,
          'source', 'MANUAL',
          'normalizedContent', '{}'::jsonb,
          'redactedLines', '[]'::jsonb,
          'contentHash', repeat('5', 64)
        )
      )
    $statement$,
    fixture.control_digest,
    fixture.visible_device_id
  )
)
FROM pg_temp._ncws_fixture fixture;

SELECT pg_temp.ncws_expect_true(
  'rpc.snapshots.runtime',
  format(
    $statement$
      SELECT public.network_center_worker_snapshot_v2(
        %L,
        jsonb_build_object(
          'snapshotId', %L,
          'deviceId', %L,
          'source', 'MANUAL',
          'normalizedContent', '{}'::jsonb,
          'redactedLines', '[]'::jsonb,
          'contentHash', repeat('5', 64)
        )
      ) ->> 'contentHash' = repeat('5', 64)
    $statement$,
    fixture.assigned_digest,
    '15150000-0000-4000-8000-000000000805',
    fixture.visible_device_id
  )
)
FROM pg_temp._ncws_fixture fixture;

-- rpc.maintenance: like heartbeat, maintenance has no per-call target, so
-- its fail-closed boundary is authentication rather than a device mismatch.
SELECT pg_temp.ncws_expect_sqlstate(
  'rpc.maintenance.control',
  format(
    'SELECT public.network_center_worker_maintenance_v2(%L, clock_timestamp())',
    repeat('f', 64)
  ),
  '28000'
);

SELECT pg_temp.ncws_expect_true(
  'rpc.maintenance.runtime',
  format(
    $statement$
      SELECT (
        public.network_center_worker_maintenance_v2(%L, clock_timestamp())
          ->> 'assignedBuildings'
      )::integer >= 1
    $statement$,
    fixture.assigned_digest
  )
)
FROM pg_temp._ncws_fixture fixture;

RESET ROLE;

UPDATE pg_temp._ncws_results result
SET passed = result.passed AND projection.valid,
    detail = CASE WHEN result.passed AND projection.valid THEN result.detail
      ELSE jsonb_build_object('projectionRowsValid', projection.valid) END
FROM (
  SELECT count(*) = 2
    AND count(*) FILTER (
      WHERE heartbeat.status = 'ONLINE'
        AND heartbeat.building_id = fixture.visible_building_id
    ) = 1
    AND count(*) FILTER (
      WHERE heartbeat.status = 'DEGRADED'
        AND heartbeat.building_id = fixture.control_building_id
    ) = 1 AS valid
  FROM public.network_worker_building_status heartbeat
  CROSS JOIN pg_temp._ncws_fixture fixture
  WHERE heartbeat.organization_id = fixture.organization_id
    AND heartbeat.building_id IN (
      fixture.visible_building_id,
      fixture.control_building_id
    )
) projection
WHERE result.case_id = 'rpc.heartbeat.runtime';

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', fixture.owner_id,
    'role', 'authenticated'
  )::text,
  true
)
FROM pg_temp._ncws_fixture fixture;

SET LOCAL ROLE authenticated;

SELECT pg_temp.ncws_expect_42501(
  'heartbeat.raw_authenticated_denied',
  'SELECT count(*) FROM public.network_worker_heartbeats'
);
-- The browser projection must expose only the explicitly granted building.
SELECT pg_temp.ncws_expect_true(
  'heartbeat.browser_projection_scoped',
  format(
    $statement$
      SELECT count(*) = 1
        AND bool_and(organization_id = %L::uuid)
        AND bool_and(building_id = %L::uuid)
        AND bool_and(status = 'ONLINE')
      FROM public.network_worker_building_status
    $statement$,
    fixture.organization_id,
    fixture.visible_building_id
  )
)
FROM pg_temp._ncws_fixture fixture;

RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'anon')::text,
  true
);
SET LOCAL ROLE anon;
SELECT pg_temp.ncws_expect_42501(
  'heartbeat.raw_anon_denied',
  'SELECT count(*) FROM public.network_worker_heartbeats'
);
RESET ROLE;

INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
SELECT
  'heartbeat.projection_secret_free',
  array_agg(column_name ORDER BY ordinal_position) = ARRAY[
    'organization_id', 'building_id', 'status', 'heartbeat_at',
    'queue_age_seconds', 'started_at', 'updated_at'
  ]::text[]
  AND count(*) FILTER (
    WHERE column_name ~* '(secret|credential|token|fingerprint|metadata|worker_id|worker_key)'
  ) = 0,
  jsonb_build_object(
    'columns', array_agg(column_name ORDER BY ordinal_position)
  )
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'network_worker_building_status';

INSERT INTO pg_temp._ncws_results(case_id, passed, detail)
SELECT
  'heartbeat.publication_scoped',
  count(*) FILTER (
    WHERE schemaname = 'public'
      AND tablename = 'network_worker_building_status'
  ) = 1
  AND count(*) FILTER (
    WHERE schemaname = 'public'
      AND tablename = 'network_worker_heartbeats'
  ) = 0,
  jsonb_build_object(
    'publishedTables', coalesce(
      jsonb_agg(jsonb_build_object(
        'schema', schemaname,
        'table', tablename
      ) ORDER BY schemaname, tablename),
      '[]'::jsonb
    )
  )
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename IN (
    'network_worker_building_status',
    'network_worker_heartbeats'
  );

WITH evaluated AS (
  SELECT required.sequence, required.case_id,
    coalesce(result.passed, false) AS passed,
    CASE WHEN result.case_id IS NULL
      THEN jsonb_build_object('missing_result', true)
      ELSE result.detail END AS detail
  FROM pg_temp._ncws_required_cases required
  LEFT JOIN pg_temp._ncws_results result USING (case_id)
)
SELECT jsonb_build_object(
  'status', CASE WHEN bool_and(evaluated.passed) THEN 'PASS' ELSE 'FAIL' END,
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

export const buildWorkerScopeSql = buildNetworkCenterWorkerScopeSql;

function validateVerdict(verdict) {
  if (
    !verdict
    || typeof verdict !== "object"
    || !["PASS", "FAIL"].includes(verdict.status)
    || typeof verdict.passed !== "boolean"
    || !Number.isInteger(verdict.assertion_count)
    || !Number.isInteger(verdict.failed_count)
    || !Array.isArray(verdict.assertions)
    || verdict.assertion_count !== WORKER_SCOPE_CASE_IDS.length
    || verdict.assertions.length !== WORKER_SCOPE_CASE_IDS.length
  ) {
    throw new Error("Supabase output has no valid worker-scope verdict");
  }

  const seen = new Set();
  for (const [index, assertion] of verdict.assertions.entries()) {
    if (
      assertion?.case_id !== WORKER_SCOPE_CASE_IDS[index]
      || typeof assertion?.passed !== "boolean"
      || seen.has(assertion.case_id)
    ) {
      throw new Error("Worker-scope verdict case manifest is inconsistent");
    }
    seen.add(assertion.case_id);
  }

  const observedFailures = verdict.assertions.filter(
    (assertion) => !assertion.passed,
  ).length;
  if (
    verdict.failed_count !== observedFailures
    || verdict.passed !== (observedFailures === 0)
    || verdict.status !== (verdict.passed ? "PASS" : "FAIL")
  ) {
    throw new Error("Worker-scope verdict counts are inconsistent");
  }
  return verdict;
}

export function parseNetworkCenterWorkerScopeVerdict(body) {
  const text = String(body ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_RUNNER_OUTPUT_BYTES) {
    throw new Error("Disposable runner output exceeds the worker-scope limit");
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error("Disposable runner returned invalid JSON");
  }
  if (!Array.isArray(rows)) {
    throw new Error("Supabase output has no valid worker-scope verdict");
  }
  const verdicts = rows
    .filter((row) => row && typeof row === "object" && row.verdict)
    .map((row) => row.verdict);
  if (verdicts.length !== 1) {
    if (verdicts.length > 1) {
      throw new Error("Expected exactly one worker-scope verdict");
    }
    throw new Error("Supabase output has no valid worker-scope verdict");
  }
  return validateVerdict(verdicts[0]);
}

export const parseWorkerScopeVerdict = parseNetworkCenterWorkerScopeVerdict;

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new Error("Verifier arguments must be an array");
  const allowed = new Set(["--dry-run", "--local-disposable"]);
  const unknown = argv.find((argument) => !allowed.has(argument));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (argv.length !== 1 || new Set(argv).size !== argv.length) {
    throw new Error(
      "Usage: node scripts/verify-network-center-worker-scope.mjs (--dry-run | --local-disposable)",
    );
  }
  return {
    mode: argv[0] === "--dry-run" ? "dry-run" : "local-disposable",
  };
}

function assertRollbackOnlySql(sql) {
  const beginCount = (sql.match(/\bBEGIN\s*;/giu) ?? []).length;
  const rollbackCount = (sql.match(/\bROLLBACK\s*;/giu) ?? []).length;
  if (
    beginCount !== 1
    || rollbackCount !== 1
    || /\bCOMMIT\s*;/iu.test(sql)
    || !/ROLLBACK;\s*$/iu.test(sql)
    || !sql.includes(DEMO_ORG_ID)
    || sql.includes(FORBIDDEN_PROD_ORG_ID)
  ) {
    throw new Error("Worker-scope SQL is not DEMO-only and rollback-only");
  }
}

function sanitize(value, key = "", depth = 0) {
  if (/(?:secret|password|credential|token|authorization|api[_-]?key)/iu.test(key)) {
    return "[REDACTED]";
  }
  if (depth >= 5) return "[TRUNCATED]";
  if (typeof value === "string") {
    const redacted = value.replace(
      /\b(?:secret|password|credential|token|authorization|api[_-]?key)(?:[-_][a-z0-9]+)*\s*[=:]\s*[^\s,;]+/giu,
      "[REDACTED]",
    );
    return redacted.length <= 512
      ? redacted
      : `${redacted.slice(0, 509)}...`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitize(entryValue, entryKey, depth + 1),
        ]),
    );
  }
  return value;
}

export function formatWorkerScopeEvidence(value) {
  let output = JSON.stringify(sanitize(value));
  if (Buffer.byteLength(output, "utf8") <= MAX_EVIDENCE_BYTES) return output;
  output = JSON.stringify({
    status: value?.status === "PASS" ? "PASS" : "FAIL",
    ok: value?.ok === true,
    mode: value?.mode,
    summary: sanitize(value?.summary ?? {}),
    failures: sanitize(Array.isArray(value?.failures) ? value.failures.slice(0, 4) : []),
    truncated: true,
  });
  return Buffer.byteLength(output, "utf8") <= MAX_EVIDENCE_BYTES
    ? output
    : JSON.stringify({ status: "FAIL", ok: false, truncated: true });
}

function failureCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Docker is required/iu.test(message)) return "DOCKER_UNAVAILABLE";
  if (/argument|Usage:/iu.test(message)) return "ARGUMENTS_INVALID";
  if (/failed \d+\/\d+/iu.test(message)) return "WORKER_SCOPE_ASSERTIONS_FAILED";
  return "VERIFIER_EXECUTION_FAILED";
}

export async function main(
  argv = process.argv.slice(2),
  options = {},
) {
  const log = options.log ?? console.log;
  const disposableOptions = options.disposableOptions ?? {};
  const runLocalDisposable = options.runDisposableSupabaseMatrix
    ?? options.runLocalDisposable
    ?? runDisposableSupabaseMatrix;
  let mode = "invalid";
  try {
    ({ mode } = parseArguments(argv));
    const sql = buildNetworkCenterWorkerScopeSql();
    assertRollbackOnlySql(sql);

    if (mode === "dry-run") {
      const evidence = {
        status: "PASS",
        ok: true,
        mode,
        summary: {
          assertions: WORKER_SCOPE_CASE_IDS.length,
          demoOnly: true,
          rollbackOnly: true,
          databaseStarted: false,
        },
      };
      log(formatWorkerScopeEvidence(evidence));
      return { exitCode: 0, evidence };
    }

    const verdict = validateVerdict(await runLocalDisposable({
      ...disposableOptions,
      buildSql: buildNetworkCenterWorkerScopeSql,
      parseVerdict: parseNetworkCenterWorkerScopeVerdict,
    }));
    if (!verdict.passed) {
      const failedCases = verdict.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.case_id);
      throw new Error(
        `Worker-scope runtime failed ${verdict.failed_count}/${verdict.assertion_count}: ${failedCases.join(", ")}`,
      );
    }
    const evidence = {
      status: "PASS",
      ok: true,
      mode,
      summary: {
        assertions: verdict.assertion_count,
        failed: verdict.failed_count,
        demoOnly: true,
        rollbackOnly: true,
      },
    };
    log(formatWorkerScopeEvidence(evidence));
    return { exitCode: 0, evidence };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evidence = {
      status: "FAIL",
      ok: false,
      mode,
      failures: [{ code: failureCode(error), message }],
    };
    log(formatWorkerScopeEvidence(evidence));
    return { exitCode: 1, evidence };
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const result = await main();
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
