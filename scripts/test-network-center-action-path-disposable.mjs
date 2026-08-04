#!/usr/bin/env node
/**
 * Disposable-PostgreSQL proof that the disruptive-action path is REACHABLE.
 *
 * Two structural gates made every disruptive action refuse for every router in
 * the fleet, forever:
 *
 *   BLOCKER A  network_devices.lifecycle_status never left 'UNPROVISIONED' for
 *              a MikroTik, and both public.network_center_execute_action_v1 and
 *              public.network_center_request_snapshot_v1 admit a device only
 *              when it is IN ('ONLINE','OFFLINE').
 *   BLOCKER B  every access port was latched is_protected, and the only unlatch
 *              had its own precondition (metadata.eligibleAccess) destroyed by
 *              the trigger that discovers the port.
 *
 * This proof builds a real PostgreSQL 17 cluster from the declared platform
 * bootstrap plus EVERY real Network Center migration, discovered BY GLOB
 * (network-center-disposable-db.mjs `loadNetworkCenterMigrations` readdir's
 * supabase/migrations). Nothing here names 20260729148000: delete that file and
 * the harness simply replays 22 migrations instead of 23, the two blockers come
 * back, and this proof goes red. That is the non-vacuity guarantee.
 *
 * Everything runs inside one transaction that ends in ROLLBACK, on a cluster
 * that is then torn down and asserted gone. No production database, no router,
 * no network. The one command this proof enqueues is a row in a throwaway
 * cluster that is rolled back before the cluster is destroyed; no worker exists
 * to claim it and no hardware is reachable from it.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";

// Raised by hand alongside the SQL. A proof whose expected count moves on its
// own is a proof that stopped counting.
const ACTION_PATH_PROOF_INVARIANTS = 51;

const DEMO_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const BUILDING_A_ID = "dddd1000-0000-4000-8000-000000000001";
const BUILDING_B_ID = "dddd1000-0000-4000-8000-000000000002";
const DEMO_OWNER_ID = "de6f33f3-349f-4bec-bd3d-106192f6715e";
const PROOF_WORKER_KEY = "disposable-action-path-worker";

function buildActionPathProofSql({ localProof }) {
  const nonce = localProof.proofNonce;
  return String.raw`
BEGIN;

SET LOCAL client_min_messages = warning;

-- Refuse to run anywhere but the cluster this run built. The nonce is written
-- by the harness after the last migration; a database that does not carry it is
-- not ours and this script must not touch it.
DO $bind$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ) THEN
    RAISE EXCEPTION
      'ACTION PATH PROOF REFUSED: this database is not the disposable cluster this run created';
  END IF;
END;
$bind$;

CREATE TEMP TABLE nap_results (name text PRIMARY KEY) ON COMMIT DROP;

-- A VOLATILE call and a STABLE read of what it changed must not share a
-- statement: inside one statement the STABLE function keeps the snapshot taken
-- before the mutation, so the assertion would read the OLD row and fail for a
-- reason that has nothing to do with the code under test. Reports land here
-- first and are read back by the next statement.
CREATE TEMP TABLE nap_scratch (key text PRIMARY KEY, value jsonb NOT NULL)
  ON COMMIT DROP;

-- PRIMARY KEY is load-bearing: a copy-pasted assertion name is a hard error
-- rather than an inflated invariant count.
CREATE FUNCTION pg_temp.nap_assert(
  p_name text, p_condition boolean, p_detail text DEFAULT ''
) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'ACTION PATH PROOF FAILED [%]: %', p_name, p_detail;
  END IF;
  INSERT INTO pg_temp.nap_results (name) VALUES (p_name);
END;
$assert$;

-- The exact admission predicate of public.network_center_execute_action_v1's
-- second SELECT, evaluated as data. This is the same clause-by-clause
-- differential that isolated the blocker in production.
CREATE FUNCTION pg_temp.nap_gate_admits(p_device_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $gate$
  SELECT EXISTS (
    SELECT 1
    FROM public.network_devices device
    WHERE device.id = p_device_id
      AND device.organization_id = '${DEMO_ORGANIZATION_ID}'::uuid
      AND device.device_kind = 'MIKROTIK'
      AND device.is_active
      AND device.write_capability
      AND device.lifecycle_status IN ('ONLINE', 'OFFLINE')
      AND EXISTS (
        SELECT 1
        FROM public.network_device_connections connection
        WHERE connection.organization_id = device.organization_id
          AND connection.building_id = device.building_id
          AND connection.device_id = device.id
          AND connection.is_enabled
      )
  );
$gate$;

-- The same predicate MINUS the lifecycle clause: the positive control that
-- makes a false gate mean "exactly this clause" rather than "something broke".
CREATE FUNCTION pg_temp.nap_gate_admits_without_lifecycle(p_device_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $gate$
  SELECT EXISTS (
    SELECT 1
    FROM public.network_devices device
    WHERE device.id = p_device_id
      AND device.organization_id = '${DEMO_ORGANIZATION_ID}'::uuid
      AND device.device_kind = 'MIKROTIK'
      AND device.is_active
      AND device.write_capability
      AND EXISTS (
        SELECT 1
        FROM public.network_device_connections connection
        WHERE connection.organization_id = device.organization_id
          AND connection.building_id = device.building_id
          AND connection.device_id = device.id
          AND connection.is_enabled
      )
  );
$gate$;

CREATE TEMP TABLE nap_fixture ON COMMIT DROP AS
SELECT
  device.id AS router_a_id,
  '${BUILDING_A_ID}'::uuid AS building_a_id,
  '${BUILDING_B_ID}'::uuid AS building_b_id,
  '${DEMO_ORGANIZATION_ID}'::uuid AS organization_id,
  '${DEMO_OWNER_ID}'::uuid AS owner_id
FROM public.network_devices device
WHERE device.organization_id = '${DEMO_ORGANIZATION_ID}'::uuid
  AND device.building_id = '${BUILDING_A_ID}'::uuid
  AND device.device_kind = 'MIKROTIK';

DO $preflight$
DECLARE
  v_count integer;
  v_lifecycle text;
BEGIN
  SELECT count(*) INTO v_count FROM pg_temp.nap_fixture;
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'ACTION PATH PROOF REFUSED: expected exactly one seeded DEMO MikroTik, found %',
      v_count;
  END IF;
  SELECT device.lifecycle_status INTO v_lifecycle
  FROM public.network_devices device
  JOIN pg_temp.nap_fixture fixture ON fixture.router_a_id = device.id;
  IF v_lifecycle <> 'UNPROVISIONED' THEN
    RAISE EXCEPTION
      'ACTION PATH PROOF REFUSED: the seeded router is % and not UNPROVISIONED; the premise of this proof is gone',
      v_lifecycle;
  END IF;
END;
$preflight$;

-- The second DEMO router (building B) is never polled by this proof. It is the
-- control for "silence does not un-observe history".
CREATE TEMP TABLE nap_router_b ON COMMIT DROP AS
SELECT device.id AS router_b_id
FROM public.network_devices device
WHERE device.organization_id = '${DEMO_ORGANIZATION_ID}'::uuid
  AND device.building_id = '${BUILDING_B_ID}'::uuid
  AND device.device_kind = 'MIKROTIK';

-- ---------------------------------------------------------------------------
-- Fixtures: a pinned connection, and the platform reference row the
-- authorization chain needs. Neither is a Network Center gate input.
-- ---------------------------------------------------------------------------
INSERT INTO public.network_device_connections (
  organization_id, building_id, device_id, transport, management_ip,
  management_port, credential_ref, host_key_fingerprint, poll_interval_seconds,
  connect_timeout_ms, is_enabled
)
SELECT fixture.organization_id, fixture.building_a_id, fixture.router_a_id,
  'ROUTEROS_SSH', '10.99.0.1'::inet, 22, 'router/disposable-action-path',
  'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60, 8000, true
FROM pg_temp.nap_fixture fixture;

INSERT INTO public.permission_definitions (key, resource, action, sensitivity)
VALUES
  ('network_center.view', 'network_center', 'view', 'VIEW'),
  ('network_center.execute', 'network_center', 'execute', 'ELEVATED')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.member_permission_overrides (
  organization_id, membership_id, permission_key, effect, scope_mode,
  reason, created_by
)
SELECT fixture.organization_id, membership.id, permission.key, 'ALLOW',
  'ORGANIZATION', 'disposable action-path proof', fixture.owner_id
FROM pg_temp.nap_fixture fixture
JOIN public.organization_memberships membership
  ON membership.organization_id = fixture.organization_id
 AND membership.user_id = fixture.owner_id
CROSS JOIN (
  VALUES ('network_center.view'), ('network_center.execute')
) AS permission(key)
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- BLOCKER A -- baseline. Reproduce the production differential exactly.
-- ===========================================================================
SELECT pg_temp.nap_assert(
  'a01-baseline-router-is-unprovisioned',
  (SELECT device.lifecycle_status FROM public.network_devices device
    JOIN pg_temp.nap_fixture fixture ON fixture.router_a_id = device.id)
    = 'UNPROVISIONED',
  'the seeded router did not start UNPROVISIONED'
);

SELECT pg_temp.nap_assert(
  'a02-baseline-gate-refuses',
  NOT pg_temp.nap_gate_admits(fixture.router_a_id),
  'the action gate admitted an UNPROVISIONED router'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a03-baseline-positive-control-only-lifecycle-fails',
  pg_temp.nap_gate_admits_without_lifecycle(fixture.router_a_id),
  'the same predicate minus the lifecycle clause also refused, so a02 does not isolate anything'
) FROM pg_temp.nap_fixture fixture;

-- ===========================================================================
-- BLOCKER A -- promotion from a real accepted telemetry row.
-- ===========================================================================
CREATE FUNCTION pg_temp.nap_ingest(
  p_device_id uuid, p_reachable boolean, p_observed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql AS $ingest$
BEGIN
  RETURN app_private.network_center_worker_ingest_legacy_impl_v1(
    '${PROOF_WORKER_KEY}',
    jsonb_build_object(
      'observedAt', p_observed_at,
      'devices', jsonb_build_array(jsonb_build_object(
        'deviceId', p_device_id,
        'reachable', p_reachable,
        'healthStatus', CASE WHEN p_reachable THEN 'HEALTHY' ELSE 'OFFLINE' END,
        'identity', 'DISPOSABLE-ROUTER-A',
        'routerosVersion', '7.20.8',
        'uptimeSeconds', 924006,
        'connectionCount', 4
      ))
    )
  );
END;
$ingest$;

CREATE FUNCTION pg_temp.nap_lifecycle(p_device_id uuid) RETURNS text
LANGUAGE sql STABLE AS $lifecycle$
  SELECT device.lifecycle_status FROM public.network_devices device
  WHERE device.id = p_device_id;
$lifecycle$;

SELECT pg_temp.nap_ingest(fixture.router_a_id, true, clock_timestamp())
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a04-first-successful-poll-promotes-to-online',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'ONLINE',
  'lifecycle after a reachable poll: ' || pg_temp.nap_lifecycle(fixture.router_a_id)
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a05-gate-now-admits-the-router',
  pg_temp.nap_gate_admits(fixture.router_a_id),
  'the action gate still refuses an ONLINE router'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_ingest(
  fixture.router_a_id, false, clock_timestamp() + INTERVAL '1 second'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a06-failed-poll-demotes-to-offline',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'OFFLINE',
  'lifecycle after an unreachable poll: ' || pg_temp.nap_lifecycle(fixture.router_a_id)
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a07-offline-is-still-admitted-by-the-gate',
  pg_temp.nap_gate_admits(fixture.router_a_id),
  'the gate admits ONLINE and OFFLINE by design; OFFLINE was refused'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_ingest(
  fixture.router_a_id, true, clock_timestamp() + INTERVAL '2 seconds'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a08-recovery-repromotes-to-online',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'ONLINE',
  'ONLINE -> OFFLINE -> ONLINE is not a latch in either direction'
) FROM pg_temp.nap_fixture fixture;

-- A stale observation must move nothing: the _current upsert carries
-- WHERE EXCLUDED.observed_at >= current, so it returns no row and the lifecycle
-- write is scoped to the rows that upsert accepted.
SELECT pg_temp.nap_ingest(
  fixture.router_a_id, false, clock_timestamp() - INTERVAL '4 minutes'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a09-stale-observation-moves-nothing',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'ONLINE',
  'a late payload demoted the router: ' || pg_temp.nap_lifecycle(fixture.router_a_id)
) FROM pg_temp.nap_fixture fixture;

-- DISABLED is the operator's. Telemetry does not resurrect it.
UPDATE public.network_devices device SET lifecycle_status = 'DISABLED'
FROM pg_temp.nap_fixture fixture WHERE device.id = fixture.router_a_id;

SELECT pg_temp.nap_ingest(
  fixture.router_a_id, true, clock_timestamp() + INTERVAL '3 seconds'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a10-telemetry-does-not-resurrect-a-disabled-device',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'DISABLED',
  'a DISABLED router was promoted by telemetry: '
    || pg_temp.nap_lifecycle(fixture.router_a_id)
) FROM pg_temp.nap_fixture fixture;

UPDATE public.network_devices device SET lifecycle_status = 'ONLINE'
FROM pg_temp.nap_fixture fixture WHERE device.id = fixture.router_a_id;

-- ===========================================================================
-- BLOCKER A -- demotion when evidence STOPS arriving.
-- ===========================================================================
SELECT pg_temp.nap_assert(
  'a11-router-b-is-still-unprovisioned',
  pg_temp.nap_lifecycle(router_b.router_b_id) = 'UNPROVISIONED',
  'the never-polled control router moved on its own'
) FROM pg_temp.nap_router_b router_b;

-- Fresh evidence: the sweep must NOT demote. This is the positive control that
-- makes the demotion below mean "staleness" and not "the sweep demotes
-- everything".
SELECT pg_temp.nap_ingest(
  fixture.router_a_id, true, clock_timestamp() + INTERVAL '4 seconds'
) FROM pg_temp.nap_fixture fixture;

SELECT app_private.network_center_reconcile_device_lifecycle_v1(clock_timestamp());

SELECT pg_temp.nap_assert(
  'a12-fresh-evidence-is-not-demoted',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'ONLINE',
  'the sweep demoted a router that reported seconds ago'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a13-sweep-does-not-touch-unprovisioned',
  pg_temp.nap_lifecycle(router_b.router_b_id) = 'UNPROVISIONED',
  'the sweep moved a router that was never observed'
) FROM pg_temp.nap_router_b router_b;

-- Now age the evidence past three poll intervals (60s connection -> 300s floor).
-- last_seen_at moves with observed_at: network_device_current_time_check
-- requires last_seen_at <= observed_at, so backdating only one of them would
-- fail the fixture rather than the assertion.
UPDATE public.network_device_current current_state
-- now() and not clock_timestamp(): the latter advances between the two
-- assignments in the same statement, leaving last_seen_at a microsecond after
-- observed_at and failing the check on the fixture instead of the assertion.
SET observed_at = now() - INTERVAL '31 minutes',
    last_seen_at = now() - INTERVAL '31 minutes'
FROM pg_temp.nap_fixture fixture
WHERE current_state.device_id = fixture.router_a_id;

INSERT INTO pg_temp.nap_scratch (key, value)
VALUES ('a14', app_private.network_center_reconcile_device_lifecycle_v1(clock_timestamp()));

SELECT pg_temp.nap_assert(
  'a14-stale-evidence-demotes-online-to-offline',
  (
    SELECT (scratch.value->>'demotedToOffline')::integer
    FROM pg_temp.nap_scratch scratch WHERE scratch.key = 'a14'
  ) = 1 AND pg_temp.nap_lifecycle(fixture.router_a_id) = 'OFFLINE',
  'ONLINE never fell when telemetry stopped: '
    || pg_temp.nap_lifecycle(fixture.router_a_id)
) FROM pg_temp.nap_fixture fixture;

-- Tolerance follows the device's own poll interval rather than a fleet
-- constant. At a 3600s interval the same 31-minute-old evidence is fresh.
UPDATE public.network_devices device SET lifecycle_status = 'ONLINE'
FROM pg_temp.nap_fixture fixture WHERE device.id = fixture.router_a_id;
UPDATE public.network_device_connections connection
SET poll_interval_seconds = 3600
FROM pg_temp.nap_fixture fixture
WHERE connection.device_id = fixture.router_a_id;

INSERT INTO pg_temp.nap_scratch (key, value)
VALUES ('a15', app_private.network_center_reconcile_device_lifecycle_v1(clock_timestamp()));

SELECT pg_temp.nap_assert(
  'a15-tolerance-follows-the-devices-own-poll-interval',
  (
    SELECT (scratch.value->>'demotedToOffline')::integer
    FROM pg_temp.nap_scratch scratch WHERE scratch.key = 'a15'
  ) = 0 AND pg_temp.nap_lifecycle(fixture.router_a_id) = 'ONLINE',
  'a slow poller was demoted inside its own interval'
) FROM pg_temp.nap_fixture fixture;

UPDATE public.network_device_connections connection
SET poll_interval_seconds = 60
FROM pg_temp.nap_fixture fixture
WHERE connection.device_id = fixture.router_a_id;

-- The wiring: the two-minute watchdog sweep must actually call the reconciler.
UPDATE public.network_devices device SET lifecycle_status = 'ONLINE'
FROM pg_temp.nap_fixture fixture WHERE device.id = fixture.router_a_id;

SELECT public.network_center_watchdog_liveness_v1(300, clock_timestamp(), 900);

SELECT pg_temp.nap_assert(
  'a16-watchdog-liveness-sweep-runs-the-reconciler',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'OFFLINE',
  'the out-of-band sweep did not demote a stale router, so nothing schedules the demotion'
) FROM pg_temp.nap_fixture fixture;

-- Put the router back into a truthful, freshly-observed ONLINE for the rest.
SELECT pg_temp.nap_ingest(
  fixture.router_a_id, true, clock_timestamp() + INTERVAL '5 seconds'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'a17-a-returning-router-is-repromoted-by-its-own-poll',
  pg_temp.nap_lifecycle(fixture.router_a_id) = 'ONLINE',
  'a router that came back stayed OFFLINE'
) FROM pg_temp.nap_fixture fixture;

-- ===========================================================================
-- BLOCKER B -- the inventory cycle, run for real, more than once.
-- ===========================================================================
CREATE FUNCTION pg_temp.nap_inventory(
  p_device_id uuid, p_ether3_role text, p_ether4_protected boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql AS $inventory$
DECLARE
  v_run uuid := gen_random_uuid();
BEGIN
  RETURN app_private.network_center_worker_inventory_legacy_impl_v1(
    '${PROOF_WORKER_KEY}',
    jsonb_build_object(
      'routerDeviceId', p_device_id,
      'discoveryRunId', v_run,
      'observedAt', clock_timestamp(),
      'batchIndex', '0',
      'batchCount', '1',
      'interfaces', jsonb_build_array(
        -- The worker's real classification: ether1 is WAN and protected, the
        -- bridge is LAN, the WireGuard tunnel is MANAGEMENT and protected, and
        -- the physical access ports are sent with isProtected FALSE.
        jsonb_build_object(
          'interfaceKey', 'ether1', 'displayName', 'ether1',
          'interfaceKind', 'ETHERNET', 'interfaceRole', 'WAN',
          'isProtected', true, 'isEnabled', true, 'sortOrder', 0,
          'metadata', jsonb_build_object('immutableKey', 'ether1')
        ),
        jsonb_build_object(
          'interfaceKey', 'ether3', 'displayName', 'ether3',
          'interfaceKind', 'ETHERNET', 'interfaceRole', p_ether3_role,
          'isProtected', p_ether3_role IN ('WAN', 'UPLINK', 'MANAGEMENT'),
          'isEnabled', true, 'sortOrder', 2,
          'metadata', jsonb_build_object('immutableKey', 'ether3')
        ),
        jsonb_build_object(
          'interfaceKey', 'ether4', 'displayName', 'ether4',
          'interfaceKind', 'ETHERNET', 'interfaceRole', 'ACCESS',
          'isProtected', p_ether4_protected, 'isEnabled', true, 'sortOrder', 3,
          'metadata', jsonb_build_object('immutableKey', 'ether4')
        ),
        jsonb_build_object(
          'interfaceKey', 'ether5', 'displayName', 'ether5',
          'interfaceKind', 'ETHERNET', 'interfaceRole', 'ACCESS',
          'isProtected', false, 'isEnabled', true, 'sortOrder', 4,
          'metadata', jsonb_build_object('immutableKey', 'ether5')
        ),
        jsonb_build_object(
          'interfaceKey', 'bridge', 'displayName', 'bridge',
          'interfaceKind', 'BRIDGE', 'interfaceRole', 'LAN',
          'isProtected', false, 'isEnabled', true, 'sortOrder', 5,
          'metadata', jsonb_build_object()
        ),
        jsonb_build_object(
          'interfaceKey', 'wg-ihome-mgmt', 'displayName', 'wg-ihome-mgmt',
          'interfaceKind', 'WIREGUARD', 'interfaceRole', 'MANAGEMENT',
          'isProtected', true, 'isEnabled', true, 'sortOrder', 6,
          'metadata', jsonb_build_object()
        )
      )
    )
  );
END;
$inventory$;

CREATE FUNCTION pg_temp.nap_port(p_device_id uuid, p_key text)
RETURNS TABLE (
  interface_id uuid, resource_id uuid, interface_protected boolean,
  resource_protected boolean, enrollment_state text, eligible_access text,
  interface_role text, is_managed boolean
) LANGUAGE sql STABLE AS $port$
  SELECT interface.id, resource.id, interface.is_protected, resource.protected,
    resource.enrollment_state, resource.metadata->>'eligibleAccess',
    interface.interface_role, interface.is_managed
  FROM public.network_interfaces interface
  LEFT JOIN public.network_managed_resources resource
    ON resource.id = interface.managed_resource_id
  WHERE interface.device_id = p_device_id
    AND interface.interface_key = p_key;
$port$;

SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS')
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b01-first-cycle-discovers-an-eligible-but-protected-access-port',
  port.eligible_access = 'true' AND port.interface_protected
    AND port.resource_protected AND port.enrollment_state = 'DISCOVERED',
  format('ether4 after cycle 1: eligible=%s ifProtected=%s resProtected=%s state=%s',
    port.eligible_access, port.interface_protected, port.resource_protected,
    port.enrollment_state)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

-- THE REGRESSION. Before the fix, eligibleAccess computed itself out of
-- existence on the second poll -- measured in production as 'false' on all five
-- managed resources -- which is why the enrollment door could never be opened.
SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS')
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b02-eligibility-survives-the-second-poll-cycle',
  port.eligible_access = 'true',
  format('eligibleAccess=%s ifProtected=%s resProtected=%s role=%s kind=%s',
    port.eligible_access, port.interface_protected, port.resource_protected,
    port.interface_role, (SELECT interface.interface_kind FROM public.network_interfaces interface WHERE interface.id = port.interface_id))
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS')
FROM pg_temp.nap_fixture fixture, generate_series(1, 8);

SELECT pg_temp.nap_assert(
  'b03-eligibility-survives-ten-poll-cycles',
  port.eligible_access = 'true' AND port.interface_protected,
  'eligibleAccess after ten cycles: ' || coalesce(port.eligible_access, '<null>')
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

SELECT pg_temp.nap_assert(
  'b04-discovery-alone-never-unprotects-a-port',
  port.interface_protected AND port.resource_protected
    AND port.enrollment_state = 'DISCOVERED',
  'a port became cyclable without anybody enrolling it'
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

-- What stays protected, checked one by one rather than asserted in prose.
SELECT pg_temp.nap_assert(
  'b05-ether1-is-forced-wan-and-protected',
  port.interface_role = 'WAN' AND port.interface_protected
    AND port.resource_protected AND port.eligible_access = 'false',
  format('ether1: role=%s ifProtected=%s eligible=%s',
    port.interface_role, port.interface_protected, port.eligible_access)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether1') port;

SELECT pg_temp.nap_assert(
  'b06-the-bridge-is-unmanaged-and-not-an-access-port',
  NOT port.is_managed AND port.resource_id IS NULL
    AND port.interface_role = 'LAN',
  format('bridge: managed=%s role=%s', port.is_managed, port.interface_role)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'bridge') port;

SELECT pg_temp.nap_assert(
  'b07-the-management-tunnel-stays-protected',
  port.interface_protected AND port.interface_role = 'MANAGEMENT',
  format('wg-ihome-mgmt: protected=%s role=%s',
    port.interface_protected, port.interface_role)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'wg-ihome-mgmt') port;

-- ===========================================================================
-- BLOCKER B -- the door, and who may open it.
-- ===========================================================================
SELECT pg_temp.nap_assert(
  'b08-list-names-the-enrollable-port',
  (
    SELECT count(*) FROM jsonb_array_elements(
      public.network_center_admin_list_access_ports_v1(fixture.building_a_id)->'ports'
    ) port
    WHERE port->>'immutableKey' = 'ether4'
      AND (port->>'enrollable')::boolean
      AND jsonb_array_length(port->'blockedBy') = 0
  ) = 1,
  'the admin listing does not report ether4 as enrollable'
) FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b09-list-explains-why-ether1-is-not-enrollable',
  (
    SELECT bool_and(NOT (port->>'enrollable')::boolean
      AND jsonb_array_length(port->'blockedBy') > 0)
    FROM jsonb_array_elements(
      public.network_center_admin_list_access_ports_v1(fixture.building_a_id)->'ports'
    ) port
    WHERE port->>'immutableKey' = 'ether1'
  ),
  'ether1 was reported enrollable, or reported blocked with no reason'
) FROM pg_temp.nap_fixture fixture;

DO $reject_confirmation$
DECLARE
  v_interface uuid;
BEGIN
  SELECT port.interface_id INTO v_interface
  FROM pg_temp.nap_fixture fixture,
    LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;
  BEGIN
    PERFORM public.network_center_admin_enroll_access_port_v1(
      v_interface, 'ether5', 'proof: mistyped confirmation must refuse'
    );
    PERFORM pg_temp.nap_assert(
      'b10-enroll-refuses-a-mistyped-confirmation', false,
      'enrollment accepted a confirmation naming a different port'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    PERFORM pg_temp.nap_assert(
      'b10-enroll-refuses-a-mistyped-confirmation', true, ''
    );
  END;
END;
$reject_confirmation$;

DO $reject_ether1$
DECLARE
  v_interface uuid;
BEGIN
  SELECT port.interface_id INTO v_interface
  FROM pg_temp.nap_fixture fixture,
    LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether1') port;
  BEGIN
    PERFORM public.network_center_admin_enroll_access_port_v1(
      v_interface, 'ether1', 'proof: the WAN port must never be enrollable'
    );
    PERFORM pg_temp.nap_assert(
      'b11-enroll-refuses-the-wan-port', false,
      'the WAN port was enrolled'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    PERFORM pg_temp.nap_assert('b11-enroll-refuses-the-wan-port', true, '');
  END;
END;
$reject_ether1$;

DO $reject_short_reason$
DECLARE
  v_interface uuid;
BEGIN
  SELECT port.interface_id INTO v_interface
  FROM pg_temp.nap_fixture fixture,
    LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;
  BEGIN
    PERFORM public.network_center_admin_enroll_access_port_v1(
      v_interface, 'ether4', 'short'
    );
    PERFORM pg_temp.nap_assert(
      'b12-enroll-requires-a-reason', false, 'enrollment accepted a 5-character reason'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    PERFORM pg_temp.nap_assert('b12-enroll-requires-a-reason', true, '');
  END;
END;
$reject_short_reason$;

SELECT pg_temp.nap_assert(
  'b13-enrollment-opens-exactly-one-port',
  (
    SELECT (result->>'changed')::boolean
      AND result->>'enrollmentState' = 'ENROLLED'
      AND NOT (result->>'resourceProtected')::boolean
      AND NOT (result->>'interfaceProtected')::boolean
      AND result->>'immutableKey' = 'ether4'
    FROM (
      SELECT public.network_center_admin_enroll_access_port_v1(
        port.interface_id, 'ether4',
        'proof: deliberate enrollment of one physical access port'
      ) AS result
      FROM pg_temp.nap_fixture fixture,
        LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port
    ) enrolled
  ),
  'enrollment did not open the port'
);

SELECT pg_temp.nap_assert(
  'b14-the-enrolled-port-is-now-cyclable-in-the-database',
  NOT port.interface_protected AND NOT port.resource_protected
    AND port.enrollment_state = 'ENROLLED',
  format('ether4 after enrollment: ifProtected=%s resProtected=%s state=%s',
    port.interface_protected, port.resource_protected, port.enrollment_state)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

SELECT pg_temp.nap_assert(
  'b15-the-sibling-port-is-untouched',
  port.interface_protected AND port.resource_protected
    AND port.enrollment_state = 'DISCOVERED',
  'enrolling ether4 changed ether5'
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether5') port;

SELECT pg_temp.nap_assert(
  'b16-enrollment-writes-an-audit-event',
  (
    SELECT count(*) FROM public.network_audit_events event
    WHERE event.action = 'admin.enroll_access_port'
      AND event.actor_type = 'SYSTEM'
      AND event.target_type = 'interface'
      AND event.outcome = 'SUCCEEDED'
      AND event.target_display->>'immutableKey' = 'ether4'
  ) = 1,
  'no audit row, or more than one, for a single enrollment'
);

SELECT pg_temp.nap_assert(
  'b17-enrollment-is-idempotent',
  (
    SELECT NOT (result->>'changed')::boolean
      AND result->>'enrollmentState' = 'ENROLLED'
    FROM (
      SELECT public.network_center_admin_enroll_access_port_v1(
        port.interface_id, 'ether4', 'proof: a retried enrollment is a no-op'
      ) AS result
      FROM pg_temp.nap_fixture fixture,
        LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port
    ) again
  ),
  'a repeated enrollment was not reported as a no-op'
);

-- THE OTHER HALF OF THE REGRESSION: the poll that follows enrollment must not
-- silently re-protect the port, or enrollment would survive for one cycle in
-- the same way eligibility used to.
SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS')
FROM pg_temp.nap_fixture fixture, generate_series(1, 3);

SELECT pg_temp.nap_assert(
  'b18-enrollment-survives-later-poll-cycles',
  NOT port.interface_protected AND NOT port.resource_protected
    AND port.enrollment_state = 'ENROLLED' AND port.eligible_access = 'true',
  format('ether4 after three more cycles: ifProtected=%s resProtected=%s',
    port.interface_protected, port.resource_protected)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

-- ===========================================================================
-- BLOCKER B -- the command-target guard, which is the real lock.
-- ===========================================================================
CREATE FUNCTION pg_temp.nap_try_command(p_device_id uuid, p_key text)
RETURNS text LANGUAGE plpgsql AS $cmd$
DECLARE
  v_interface uuid;
  v_building uuid;
  v_org uuid;
BEGIN
  SELECT interface.id, interface.building_id, interface.organization_id
  INTO v_interface, v_building, v_org
  FROM public.network_interfaces interface
  WHERE interface.device_id = p_device_id AND interface.interface_key = p_key;
  -- Through the real enqueue function, not a hand-built INSERT: it owns
  -- semantic_fingerprint and the rest of the row shape, and the BEFORE INSERT
  -- guard app_private.network_center_guard_managed_command_target_v1 -- the
  -- actual ether2..N/ENROLLED lock -- fires either way.
  BEGIN
    PERFORM app_private.network_center_enqueue_command_v1(
      v_org, v_building, p_device_id, v_interface, 'CYCLE_ACCESS_PORT',
      'proof: managed target guard',
      jsonb_build_object('durationSeconds', 10),
      jsonb_build_object('interfaceName', p_key),
      (SELECT owner_id FROM pg_temp.nap_fixture),
      encode(extensions.digest(convert_to(p_key || ':proof', 'UTF8'), 'sha256'), 'hex'),
      gen_random_uuid()::text,
      clock_timestamp()
    );
    RETURN 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE || ' ' || SQLERRM;
  END;
END;
$cmd$;

-- Each of these calls nap_try_command EXACTLY once: SQL evaluates every
-- argument eagerly, so naming it in both the condition and the detail string
-- would attempt the enqueue twice.
--
-- The refusal arrives as 22023 rather than the managed-target guard's 42501
-- because the enqueue function has its own NOT is_protected check, which runs
-- first. That is the correct outcome and worth pinning: with the managed
-- resource as the single authority for protection, the two gates can no longer
-- disagree, so the 42501 path is unreachable defence in depth rather than the
-- first line.
SELECT pg_temp.nap_assert(
  'b19-command-guard-refuses-an-unenrolled-port',
  attempt.outcome = '22023 Access-port target is invalid or protected',
  'a CYCLE_ACCESS_PORT command for a port nobody enrolled returned: '
    || attempt.outcome
) FROM pg_temp.nap_fixture fixture,
  LATERAL (SELECT pg_temp.nap_try_command(fixture.router_a_id, 'ether5') AS outcome) attempt;

SELECT pg_temp.nap_assert(
  'b20-command-guard-refuses-the-wan-port',
  attempt.outcome = '22023 Access-port target is invalid or protected',
  'a CYCLE_ACCESS_PORT command for the WAN port returned: ' || attempt.outcome
) FROM pg_temp.nap_fixture fixture,
  LATERAL (SELECT pg_temp.nap_try_command(fixture.router_a_id, 'ether1') AS outcome) attempt;

-- There is deliberately no "the guard ACCEPTS the enrolled port" case here.
-- The accepting case is proven end to end in d03 through the real user-facing
-- RPC, which is a strict superset of this path: it runs the same enqueue
-- function and the same BEFORE INSERT guard, plus the permission, rollout,
-- pause and typed-identity checks. Enqueuing the same intent twice would also
-- collide on the semantic fingerprint and turn d03's genuine result into
-- "Equivalent command intent already exists".

-- Role drift must re-protect an ENROLLED port, permanently, without a human.
SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS')
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b22-ether3-tracks-its-observed-role',
  port.interface_role = 'ACCESS' AND port.eligible_access = 'true',
  'ether3 baseline before the drift test'
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether3') port;

SELECT pg_temp.nap_inventory(fixture.router_a_id, 'UPLINK')
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b23-role-drift-marks-a-port-ineligible-and-protected',
  port.eligible_access = 'false' AND port.interface_protected
    AND port.resource_protected,
  format('ether3 after drifting to UPLINK: eligible=%s ifProtected=%s resProtected=%s',
    port.eligible_access, port.interface_protected, port.resource_protected)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether3') port;

-- ===========================================================================
-- THE CAS REFUSAL: deterministic, and therefore not a serialization failure.
-- ===========================================================================
DO $cas$
DECLARE
  v_state text;
  v_sqlstate text;
  v_detail text;
  v_version bigint;
BEGIN
  SELECT settings.version INTO v_version
  FROM public.network_site_settings settings
  WHERE settings.building_id = '${BUILDING_A_ID}'::uuid;

  BEGIN
    PERFORM public.network_center_admin_set_rollout_v1(
      '${BUILDING_A_ID}'::uuid, 'READ_ONLY', v_version + 41,
      'proof: a stale expected version must refuse'
    );
    PERFORM pg_temp.nap_assert(
      'c01-stale-cas-is-refused', false, 'a stale expected version was accepted'
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE,
      v_detail = PG_EXCEPTION_DETAIL;
    PERFORM pg_temp.nap_assert(
      'c01-stale-cas-is-refused', v_sqlstate IS NOT NULL, ''
    );
    PERFORM pg_temp.nap_assert(
      'c02-cas-refusal-is-not-a-serialization-failure',
      v_sqlstate = '55000',
      'CAS refusal SQLSTATE is ' || v_sqlstate
        || '; 40001 invites the layer in front of PostgREST to retry it'
    );
    PERFORM pg_temp.nap_assert(
      'c03-cas-refusal-names-the-version-to-use',
      v_detail LIKE '%actualVersion=' || v_version || '%'
        AND v_detail LIKE '%expectedVersion=' || (v_version + 41) || '%',
      'CAS DETAIL was: ' || coalesce(v_detail, '<null>')
    );
  END;

  -- Positive control: the same procedure still commits on a correct version, so
  -- c02 is about the refusal path and not about the procedure being broken.
  PERFORM public.network_center_admin_set_rollout_v1(
    '${BUILDING_A_ID}'::uuid, 'READ_ONLY', v_version,
    'proof: the correct version still commits'
  );
  SELECT settings.rollout_state INTO v_state
  FROM public.network_site_settings settings
  WHERE settings.building_id = '${BUILDING_A_ID}'::uuid;
  PERFORM pg_temp.nap_assert(
    'c04-a-correct-version-still-commits', v_state = 'READ_ONLY',
    'rollout_state after a valid CAS: ' || v_state
  );

  PERFORM public.network_center_admin_set_rollout_v1(
    '${BUILDING_A_ID}'::uuid, 'EXECUTE', v_version + 1,
    'proof: staged path to EXECUTE for the end-to-end enqueue'
  );
END;
$cas$;

-- ===========================================================================
-- END TO END: the real user-facing RPC, as a real signed-in principal.
-- ===========================================================================
-- The disposable bootstrap's auth.uid() reads request.jwt.claim.sub (the
-- dotted per-claim GUC), not the request.jwt.claims JSON blob; setting the
-- wrong one yields a NULL subject and a 42501 that looks like a permission bug.
SELECT set_config('request.jwt.claim.sub', fixture.owner_id::text, true)
FROM pg_temp.nap_fixture fixture;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

-- The interface ids are resolved BEFORE the role switch, because
-- public.network_interfaces is REVOKEd from the authenticated role by design,
-- and the pg_temp helpers belong to the session superuser. Outcomes come back
-- through transaction-local GUCs so nothing in the signed-in section needs a
-- grant a browser session would not have.
SELECT set_config('nap.ether4', port.interface_id::text, true)
FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;
SELECT set_config('nap.ether5', port.interface_id::text, true)
FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether5') port;
SELECT set_config('nap.router', fixture.router_a_id::text, true)
FROM pg_temp.nap_fixture fixture;
SELECT set_config('nap.building', fixture.building_a_id::text, true)
FROM pg_temp.nap_fixture fixture;

-- The per-device pending-command budget is 2 (20260729131000). It is a real
-- pre-existing guard, so the proof works within it rather than around it: the
-- disruptive action is enqueued first, asserted, and the queue is drained by
-- the superuser between the two signed-in blocks.
SET LOCAL ROLE authenticated;

DO $signed_in_cycle$
DECLARE
  v_router uuid := current_setting('nap.router')::uuid;
  v_ether4 uuid := current_setting('nap.ether4')::uuid;
  v_ether5 uuid := current_setting('nap.ether5')::uuid;
  v_building uuid := current_setting('nap.building')::uuid;
BEGIN
  -- Positive control for the identity half of the gate, so a refusal below is
  -- attributable to the lifecycle/protection gates and not to the fixture.
  PERFORM set_config('nap.uid',
    coalesce((SELECT auth.uid())::text, '<null>'), true);
  PERFORM set_config('nap.can', public.can_do_on_building(
    'network_center', 'execute', v_building
  )::text, true);

  BEGIN
    PERFORM set_config('nap.d03', public.network_center_execute_action_v1(
      v_router, 'CYCLE_ACCESS_PORT',
      'proof: the enrolled access port is reachable',
      jsonb_build_object('interfaceId', v_ether4, 'durationSeconds', 10),
      'DISPOSABLE-ROUTER-A', gen_random_uuid()
    )->>'status', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('nap.d03', SQLSTATE || ' ' || SQLERRM, true);
  END;

  BEGIN
    PERFORM public.network_center_execute_action_v1(
      v_router, 'CYCLE_ACCESS_PORT',
      'proof: an unenrolled sibling must still refuse',
      jsonb_build_object('interfaceId', v_ether5, 'durationSeconds', 10),
      'DISPOSABLE-ROUTER-A', gen_random_uuid()
    );
    PERFORM set_config('nap.d04', 'ACCEPTED', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('nap.d04', SQLSTATE || ' ' || SQLERRM, true);
  END;
END;
$signed_in_cycle$;

RESET ROLE;

SELECT pg_temp.nap_assert(
  'd00-the-signed-in-principal-really-holds-execute',
  current_setting('nap.uid', true) IS NOT NULL
    AND current_setting('nap.uid', true) <> '<null>'
    AND current_setting('nap.can', true) = 'true',
  'identity control: uid=' || coalesce(current_setting('nap.uid', true), '?')
    || ' can_do_on_building=' || coalesce(current_setting('nap.can', true), '?')
);

SELECT pg_temp.nap_assert(
  'd03-cycle-access-port-is-enqueued-for-the-enrolled-port',
  current_setting('nap.d03', true) = 'QUEUED',
  'CYCLE_ACCESS_PORT on the enrolled port returned: '
    || coalesce(current_setting('nap.d03', true), '<null>')
);

SELECT pg_temp.nap_assert(
  'd04-cycle-refuses-an-unenrolled-sibling',
  current_setting('nap.d04', true) = '22023 Access port is invalid or protected',
  'CYCLE_ACCESS_PORT on an unenrolled sibling returned: '
    || coalesce(current_setting('nap.d04', true), '<null>')
);

SELECT pg_temp.nap_assert(
  'd05-the-enqueued-cycle-carries-the-enrolled-port-as-its-managed-target',
  (
    SELECT count(*) FROM public.network_commands command
    WHERE command.action_type = 'CYCLE_ACCESS_PORT'
      AND command.managed_target->>'immutableKey' = 'ether4'
      AND command.managed_target->>'interfaceId' = current_setting('nap.ether4', true)
      AND command.status = 'QUEUED'
  ) = 1,
  'the enqueued cycle does not carry the enrolled interface as its managed target'
);

-- The queue budget counts NON-TERMINAL commands, and command events are
-- append-only by trigger, so the honest way to free the budget is to retire the
-- proof's commands rather than delete them: identity fields stay byte-identical
-- and app_private.network_center_guard_command_immutable_v1 still passes.
UPDATE public.network_commands
SET status = 'FAILED',
    started_at = coalesce(started_at, created_at),
    finished_at = clock_timestamp()
WHERE reason LIKE 'proof: %' AND status = 'QUEUED';

SET LOCAL ROLE authenticated;

DO $signed_in_rest$
DECLARE
  v_router uuid := current_setting('nap.router')::uuid;
BEGIN
  BEGIN
    PERFORM set_config('nap.d01', public.network_center_execute_action_v1(
      v_router, 'FLUSH_DNS_CACHE',
      'proof: the least disruptive action, end to end', '{}'::jsonb,
      NULL, gen_random_uuid()
    )->>'status', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('nap.d01', SQLSTATE || ' ' || SQLERRM, true);
  END;

  BEGIN
    PERFORM set_config('nap.d02', public.network_center_request_snapshot_v1(
      v_router, 'proof snapshot label', gen_random_uuid()
    )->>'status', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('nap.d02', SQLSTATE || ' ' || SQLERRM, true);
  END;
END;
$signed_in_rest$;

RESET ROLE;

SELECT pg_temp.nap_assert(
  'd01-flush-dns-cache-is-enqueued',
  current_setting('nap.d01', true) = 'QUEUED',
  'FLUSH_DNS_CACHE returned: ' || coalesce(current_setting('nap.d01', true), '<null>')
);

SELECT pg_temp.nap_assert(
  'd02-capture-snapshot-is-enqueued',
  current_setting('nap.d02', true) = 'QUEUED',
  'CAPTURE_SNAPSHOT returned: ' || coalesce(current_setting('nap.d02', true), '<null>')
);

-- Deliberately LAST: this re-protects the very port d03 cycled, which is the
-- point. A protection flag from the worker RE-PROTECTS an enrolled port, and the
-- re-protection is deliberately sticky. The worker marks a port protected when
-- an owned :lan-recovery firewall rule names it, and a port that has become a
-- recovery path must stop being cyclable immediately. Because
-- app_private.network_center_guard_managed_resource_v1 permits a protection
-- downgrade only on DISCOVERED -> ENROLLED, that re-protection then needs a
-- deliberate human act to undo -- which is the fail-closed direction.
SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS', true)
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b24-a-worker-protection-flag-reprotects-an-enrolled-port',
  port.interface_protected AND port.resource_protected
    AND port.eligible_access = 'false',
  format('ether4 while the worker reports it protected: ifProtected=%s resProtected=%s eligible=%s',
    port.interface_protected, port.resource_protected, port.eligible_access)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;

SELECT pg_temp.nap_inventory(fixture.router_a_id, 'ACCESS', false)
FROM pg_temp.nap_fixture fixture;

SELECT pg_temp.nap_assert(
  'b25-the-reprotection-does-not-quietly-undo-itself',
  port.interface_protected AND port.resource_protected,
  format('ether4 after the flag cleared: ifProtected=%s resProtected=%s',
    port.interface_protected, port.resource_protected)
) FROM pg_temp.nap_fixture fixture,
  LATERAL pg_temp.nap_port(fixture.router_a_id, 'ether4') port;


SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM pg_temp.nap_results),
  'proofNonce', (
    SELECT proof_nonce FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ),
  'names', (SELECT jsonb_agg(name ORDER BY name) FROM pg_temp.nap_results)
) AS disposable_action_path_proof;

ROLLBACK;
`;
}

function parseProofVerdict(output) {
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
    .filter((entry) => entry && typeof entry === "object" && "invariants" in entry);
  return candidates.at(-1) ?? null;
}

function parseActionPathProofVerdict(output, { expectedLocalProof }) {
  const verdict = parseProofVerdict(output);
  if (!verdict) {
    throw new Error(
      `Disposable action-path proof produced no verdict line.\n${output.slice(-4_000)}`,
    );
  }
  if (verdict.status !== "PASS") {
    throw new Error(`Disposable action-path proof status: ${verdict.status}`);
  }
  if (verdict.proofNonce !== expectedLocalProof.proofNonce) {
    throw new Error(
      "Disposable action-path proof ran against a database this run did not create",
    );
  }
  if (verdict.invariants !== ACTION_PATH_PROOF_INVARIANTS) {
    throw new Error(
      `Disposable action-path proof asserted ${verdict.invariants} invariants, expected ${ACTION_PATH_PROOF_INVARIANTS}`,
    );
  }
  if (
    !Array.isArray(verdict.names) ||
    new Set(verdict.names).size !== ACTION_PATH_PROOF_INVARIANTS
  ) {
    throw new Error(
      "Disposable action-path proof reported duplicate or missing invariant names",
    );
  }
  return verdict;
}

export async function runActionPathProof({ environment = process.env } = {}) {
  return runDisposableLocalClusterMatrix({
    buildSql: buildActionPathProofSql,
    parseVerdict: parseActionPathProofVerdict,
    environment,
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error(
      "Usage: node scripts/test-network-center-action-path-disposable.mjs [--dry-run]",
    );
  }
  if (args[0] === "--dry-run") {
    buildActionPathProofSql({ localProof: { proofNonce: "0".repeat(32) } });
    process.stdout.write(
      "Disposable action-path proof dry-run passed; no PostgreSQL process was started.\n",
    );
    return;
  }
  const verdict = await runActionPathProof();
  process.stdout.write(
    "Disposable PostgreSQL action-path proof PASS: "
      + `${verdict.invariants}/${ACTION_PATH_PROOF_INVARIANTS} invariants.\n`,
  );
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

export {
  ACTION_PATH_PROOF_INVARIANTS,
  buildActionPathProofSql,
  parseActionPathProofVerdict,
};
