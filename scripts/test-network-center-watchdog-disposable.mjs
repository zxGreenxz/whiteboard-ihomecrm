#!/usr/bin/env node
// Disposable PostgreSQL proof for supabase/migrations/20260729139000_network_center_watchdog.sql.
//
// Deliberately a SEPARATE runner from
// scripts/test-network-center-release-readback-disposable.mjs: that file is
// concurrently owned elsewhere, and its invariant count is asserted by its own
// test. This one owns only the watchdog migration.
//
// Every invariant runs against a real PostgreSQL cluster created in TEMP, bound
// to 127.0.0.1 on an ephemeral port, torn down in a finally block, and refused
// outright if its path is not a disposable TEMP directory. No production
// credential, no Docker, no remote host.
//
// The invariant count is COUNTED BY THE SQL ITSELF (one row per named assertion,
// primary-keyed so a copy-pasted name cannot inflate it) rather than hardcoded in
// two places that can drift apart.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const WATCHDOG_MIGRATION_PATH = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260729139000_network_center_watchdog.sql",
);

/** Raise together with the SQL whenever an invariant is added. */
export const WATCHDOG_PROOF_INVARIANTS = 42;

const NATIVE_COMMAND_TIMEOUT_MS = 60_000;
const PG_CTL_TIMEOUT_MS = 30_000;
const POSTGRES_VERSION_PROBE_TIMEOUT_MS = 10_000;
const LOCK_HOLDER_SETTLE_MS = 1_500;
const PG_CTL_STDIO = ["ignore", "ignore", "ignore"];

export const WATCHDOG_PROOF_PROCESS_TIMEOUT_MS =
  (3 * 4 * POSTGRES_VERSION_PROBE_TIMEOUT_MS)
  + (5 * NATIVE_COMMAND_TIMEOUT_MS)
  + (2 * PG_CTL_TIMEOUT_MS)
  + 15_000;

// ---------------------------------------------------------------------------
// Minimal replica of exactly the objects the watchdog migration touches. Real
// CHECK constraints, real composite foreign keys and the real one-active
// fingerprint partial unique index are copied verbatim from
// 20260729030000_network_center_operations.sql, because the whole point of a
// live proof is that a row the watchdog writes must actually satisfy them.
// ---------------------------------------------------------------------------
const BOOTSTRAP_SQL = String.raw`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA app_private;

CREATE TABLE public.buildings (
  organization_id uuid NOT NULL,
  id uuid NOT NULL PRIMARY KEY,
  UNIQUE (organization_id, id)
);

CREATE TABLE public.network_devices (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  id uuid NOT NULL PRIMARY KEY,
  device_kind text NOT NULL,
  UNIQUE (organization_id, building_id, id),
  UNIQUE (organization_id, building_id, id, device_kind),
  FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id)
);

CREATE TABLE public.network_interfaces (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  id uuid NOT NULL PRIMARY KEY,
  UNIQUE (organization_id, building_id, device_id, id)
);

CREATE TABLE public.network_workers (
  id uuid PRIMARY KEY,
  worker_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DRAINING', 'DISABLED')),
  capabilities text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.network_worker_assignments (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES public.network_workers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_kind text NOT NULL DEFAULT 'MIKROTIK',
  can_poll boolean NOT NULL DEFAULT false,
  can_inventory boolean NOT NULL DEFAULT false,
  can_execute boolean NOT NULL DEFAULT false,
  active_from timestamptz NOT NULL,
  active_until timestamptz,
  FOREIGN KEY (organization_id, building_id, device_id, device_kind)
    REFERENCES public.network_devices(organization_id, building_id, id, device_kind)
);

CREATE TABLE app_private.network_worker_release_heartbeats (
  worker_id uuid NOT NULL REFERENCES public.network_workers(id) ON DELETE CASCADE,
  worker_version text NOT NULL CHECK (worker_version ~ '^[a-f0-9]{40}$'),
  status text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  PRIMARY KEY (worker_id, worker_version)
);

CREATE TABLE public.network_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid,
  fingerprint text NOT NULL,
  incident_type text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  title text NOT NULL,
  summary text NOT NULL,
  availability_impact boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  recovered_at timestamptz,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  occurrence_count integer NOT NULL DEFAULT 1,
  observed_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_incidents_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id),
  CONSTRAINT network_incidents_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id),
  CONSTRAINT network_incidents_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id),
  CONSTRAINT network_incidents_fingerprint_check
    CHECK (char_length(btrim(fingerprint)) BETWEEN 8 AND 200),
  CONSTRAINT network_incidents_type_check
    CHECK (incident_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT network_incidents_severity_check
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT network_incidents_status_check
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RECOVERING', 'RESOLVED')),
  CONSTRAINT network_incidents_text_check
    CHECK (
      char_length(btrim(title)) BETWEEN 3 AND 200
      AND char_length(btrim(summary)) BETWEEN 3 AND 2000
    ),
  CONSTRAINT network_incidents_time_check
    CHECK (
      opened_at <= last_observed_at
      AND (recovered_at IS NULL OR recovered_at >= opened_at)
      AND (resolved_at IS NULL OR resolved_at >= opened_at)
      AND (acknowledged_at IS NULL OR acknowledged_at >= opened_at)
    ),
  CONSTRAINT network_incidents_resolution_check
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CONSTRAINT network_incidents_occurrence_check CHECK (occurrence_count > 0),
  CONSTRAINT network_incidents_values_check
    CHECK (jsonb_typeof(observed_values) = 'object'
      AND octet_length(observed_values::text) <= 16384),
  CONSTRAINT network_incidents_version_check CHECK (version > 0),
  UNIQUE (organization_id, building_id, id)
);

CREATE UNIQUE INDEX network_incidents_one_active_fingerprint_uidx
  ON public.network_incidents (organization_id, building_id, fingerprint)
  WHERE status <> 'RESOLVED';

CREATE TABLE public.network_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  event_seq bigint NOT NULL,
  event_kind text NOT NULL,
  severity text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  worker_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_event_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_incident_events_incident_fk
    FOREIGN KEY (organization_id, building_id, incident_id)
    REFERENCES public.network_incidents(organization_id, building_id, id),
  CONSTRAINT network_incident_events_seq_check CHECK (event_seq > 0),
  CONSTRAINT network_incident_events_kind_check
    CHECK (event_kind IN ('OPENED', 'OBSERVED', 'ESCALATED', 'ACKNOWLEDGED',
      'RECOVERED', 'RESOLVED')),
  CONSTRAINT network_incident_events_severity_check
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT network_incident_events_actor_check
    CHECK (actor_id IS NOT NULL OR worker_id IS NOT NULL),
  CONSTRAINT network_incident_events_worker_check
    CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_incident_events_details_check
    CHECK (jsonb_typeof(details) = 'object'
      AND octet_length(details::text) <= 65536),
  UNIQUE (incident_id, event_seq)
);

CREATE TABLE public.network_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  worker_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  target_display jsonb NOT NULL,
  reason text NOT NULL,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL,
  command_id uuid,
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_audit_events_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id),
  CONSTRAINT network_audit_events_actor_type_check
    CHECK (actor_type IN ('USER', 'WORKER', 'SYSTEM')),
  CONSTRAINT network_audit_events_actor_check
    CHECK (
      (actor_type = 'USER' AND actor_id IS NOT NULL AND worker_id IS NULL)
      OR (actor_type = 'WORKER' AND actor_id IS NULL AND worker_id IS NOT NULL)
      OR (actor_type = 'SYSTEM' AND actor_id IS NULL AND worker_id IS NULL)
    ),
  CONSTRAINT network_audit_events_action_check
    CHECK (action ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  CONSTRAINT network_audit_events_target_check
    CHECK (target_type ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  CONSTRAINT network_audit_events_target_display_check
    CHECK (jsonb_typeof(target_display) = 'object'
      AND octet_length(target_display::text) <= 16384),
  CONSTRAINT network_audit_events_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT network_audit_events_outcome_check
    CHECK (outcome IN ('ACCEPTED', 'REJECTED', 'SUCCEEDED', 'FAILED',
      'UNCERTAIN', 'OBSERVED'))
);

CREATE TABLE public.network_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_outbox_events_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id),
  CONSTRAINT network_outbox_events_type_check
    CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  CONSTRAINT network_outbox_events_aggregate_check
    CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  CONSTRAINT network_outbox_events_payload_check
    CHECK (jsonb_typeof(payload) = 'object'
      AND octet_length(payload::text) <= 65536)
);

CREATE TABLE public.network_client_current (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  client_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, building_id, device_id, client_key)
);

CREATE TABLE public.network_maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL
);

-- Fleet-global maintenance primitives. The real implementations live in
-- 20260729020000/030000/131000; here they only have to exist with the exact
-- signatures the watchdog calls, and to record that they were called with the
-- arguments they were called with.
CREATE TABLE app_private.watchdog_proof_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fn text NOT NULL,
  args text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION app_private.network_center_ensure_raw_partitions_v1(
  p_from date, p_through date
) RETURNS void LANGUAGE plpgsql AS $stub$
BEGIN
  INSERT INTO app_private.watchdog_proof_calls (fn, args)
  VALUES ('ensure_raw_partitions', p_from::text || '..' || p_through::text);
END;
$stub$;

CREATE FUNCTION app_private.network_center_rollup_hourly_v1(p_hour timestamptz)
RETURNS void LANGUAGE plpgsql AS $stub$
BEGIN
  INSERT INTO app_private.watchdog_proof_calls (fn, args)
  VALUES ('rollup_hourly', to_char(p_hour AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'));
END;
$stub$;

CREATE FUNCTION app_private.network_center_rollup_sla_daily_v1(p_day date)
RETURNS void LANGUAGE plpgsql AS $stub$
BEGIN
  INSERT INTO app_private.watchdog_proof_calls (fn, args)
  VALUES ('rollup_sla_daily', p_day::text);
END;
$stub$;

CREATE FUNCTION app_private.network_center_retention_v1(p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $stub$
BEGIN
  INSERT INTO app_private.watchdog_proof_calls (fn, args)
  VALUES ('retention', p_now::text);
  RETURN jsonb_build_object('raw_partitions_dropped', 0);
END;
$stub$;

CREATE FUNCTION app_private.network_center_reclaim_expired_commands_v1(p_now timestamptz)
RETURNS integer LANGUAGE plpgsql AS $stub$
BEGIN
  INSERT INTO app_private.watchdog_proof_calls (fn, args)
  VALUES ('reclaim_expired_commands', p_now::text);
  RETURN 4;
END;
$stub$;

-- Named-assertion ledger. The PRIMARY KEY is load-bearing: it makes a duplicated
-- assertion name a hard error instead of a silently inflated invariant count.
CREATE TABLE app_private.watchdog_proof_results (
  name text PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION app_private.watchdog_assert(
  p_name text, p_condition boolean, p_detail text DEFAULT ''
) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'WATCHDOG PROOF FAILED [%]: %', p_name, p_detail;
  END IF;
  INSERT INTO app_private.watchdog_proof_results (name) VALUES (p_name);
END;
$assert$;
`;

const FIXTURE_SQL = String.raw`
INSERT INTO public.buildings (organization_id, id) VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000004'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000006');

INSERT INTO public.network_devices (organization_id, building_id, id, device_kind)
SELECT building.organization_id, building.id,
  ('50000000-0000-4000-8000-0000000000' || lpad(row_number() OVER (ORDER BY building.id)::text, 2, '0'))::uuid,
  'MIKROTIK'
FROM public.buildings building;

-- worker-01 serves two buildings in org 1; worker-02 one building in org 2.
INSERT INTO public.network_workers (id, worker_key, display_name, status, capabilities, created_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'watchdog-worker-01', 'Worker one', 'ACTIVE', ARRAY['HEARTBEAT'], clock_timestamp() - interval '30 days'),
  ('10000000-0000-4000-8000-000000000002', 'watchdog-worker-02', 'Worker two', 'ACTIVE', ARRAY['HEARTBEAT'], clock_timestamp() - interval '30 days'),
  ('10000000-0000-4000-8000-000000000003', 'watchdog-worker-03', 'Disabled worker', 'DISABLED', ARRAY['HEARTBEAT'], clock_timestamp() - interval '30 days'),
  ('10000000-0000-4000-8000-000000000004', 'watchdog-worker-04', 'Unassigned worker', 'ACTIVE', ARRAY['HEARTBEAT'], clock_timestamp() - interval '30 days'),
  ('10000000-0000-4000-8000-000000000005', 'watchdog-worker-05', 'Just provisioned', 'ACTIVE', ARRAY['HEARTBEAT'], clock_timestamp() - interval '2 minutes');

INSERT INTO public.network_worker_assignments (
  id, worker_id, organization_id, building_id, device_id, can_poll, active_from, active_until
)
SELECT ('30000000-0000-4000-8000-0000000000' || lpad(row_number() OVER (ORDER BY assignment.building_id)::text, 2, '0'))::uuid,
  assignment.worker_id, device.organization_id, device.building_id, device.id,
  true, clock_timestamp() - interval '10 days', assignment.active_until
FROM (VALUES
  ('20000000-0000-4000-8000-000000000001'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, NULL::timestamptz),
  ('20000000-0000-4000-8000-000000000002'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, NULL::timestamptz),
  ('20000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000002'::uuid, NULL::timestamptz),
  ('20000000-0000-4000-8000-000000000004'::uuid, '10000000-0000-4000-8000-000000000003'::uuid, NULL::timestamptz),
  ('20000000-0000-4000-8000-000000000005'::uuid, '10000000-0000-4000-8000-000000000004'::uuid, clock_timestamp() - interval '1 day'),
  ('20000000-0000-4000-8000-000000000006'::uuid, '10000000-0000-4000-8000-000000000005'::uuid, NULL::timestamptz)
) AS assignment(building_id, worker_id, active_until)
JOIN public.network_devices device ON device.building_id = assignment.building_id;

-- Both serving workers start healthy.
INSERT INTO app_private.network_worker_release_heartbeats (
  worker_id, worker_version, status, heartbeat_at, started_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', repeat('a', 40), 'ONLINE', clock_timestamp(), clock_timestamp() - interval '1 hour'),
  ('10000000-0000-4000-8000-000000000002', repeat('b', 40), 'ONLINE', clock_timestamp(), clock_timestamp() - interval '1 hour'),
  ('10000000-0000-4000-8000-000000000003', repeat('c', 40), 'ONLINE', clock_timestamp() - interval '3 days', clock_timestamp() - interval '4 days'),
  ('10000000-0000-4000-8000-000000000004', repeat('d', 40), 'ONLINE', clock_timestamp() - interval '3 days', clock_timestamp() - interval '4 days');
`;

const ASSERTION_SQL = String.raw`
SET TIME ZONE 'UTC';

-- ==== structure and ACL ====================================================
DO $structure$
DECLARE
  v_liveness text;
  v_maintenance text;
BEGIN
  v_liveness := pg_catalog.pg_get_functiondef(
    'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)'::regprocedure
  );
  v_maintenance := pg_catalog.pg_get_functiondef(
    'public.network_center_watchdog_maintenance_v1(timestamptz)'::regprocedure
  );

  -- Guard against the vacuity mode this branch has already hit repeatedly: a
  -- source-text check that silently extracted nothing passes every LIKE below.
  PERFORM app_private.watchdog_assert(
    'function-definitions-were-actually-read',
    length(coalesce(v_liveness, '')) > 2000
      AND length(coalesce(v_maintenance, '')) > 1000,
    'pg_get_functiondef returned too little to assert on'
  );
  PERFORM app_private.watchdog_assert(
    'liveness-is-security-definer-with-pinned-search-path',
    v_liveness LIKE '%SECURITY DEFINER%'
      AND v_liveness LIKE '%SET search_path TO ''pg_catalog'', ''public'', ''app_private''%',
    'liveness search_path or SECURITY DEFINER is wrong'
  );
  PERFORM app_private.watchdog_assert(
    'maintenance-is-security-definer-with-pinned-search-path',
    v_maintenance LIKE '%SECURITY DEFINER%'
      AND v_maintenance LIKE '%SET search_path TO ''pg_catalog'', ''public'', ''app_private''%',
    'maintenance search_path or SECURITY DEFINER is wrong'
  );
  PERFORM app_private.watchdog_assert(
    'watchdog-never-reads-a-worker-credential',
    v_liveness NOT LIKE '%network_worker_credentials%'
      AND v_liveness NOT LIKE '%credential%'
      AND v_maintenance NOT LIKE '%credential%',
    'a watchdog entry point references worker credential material'
  );
  PERFORM app_private.watchdog_assert(
    'public-entrypoints-execute-service-role-only',
    has_function_privilege('service_role',
      'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.network_center_watchdog_maintenance_v1(timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.network_center_watchdog_maintenance_v1(timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'public.network_center_watchdog_maintenance_v1(timestamptz)', 'EXECUTE'),
    'watchdog entry point ACL is not service-role-only'
  );
  PERFORM app_private.watchdog_assert(
    'private-watchdog-objects-unreachable-by-api-roles',
    NOT has_table_privilege('service_role',
      'app_private.network_center_watchdog_state', 'SELECT')
    AND NOT has_table_privilege('authenticated',
      'app_private.network_center_watchdog_runs', 'SELECT')
    AND NOT has_function_privilege('service_role',
      'app_private.network_center_watchdog_liveness_scan_v1(timestamptz,integer,integer)',
      'EXECUTE')
    AND NOT has_function_privilege('service_role',
      'app_private.network_center_watchdog_record_run_v1(text,timestamptz,integer,jsonb)',
      'EXECUTE'),
    'a private watchdog object is reachable from an API role'
  );
END;
$structure$;

DO $reject$
BEGIN
  PERFORM public.network_center_watchdog_liveness_v1(29);
  RAISE EXCEPTION
    'WATCHDOG PROOF FAILED [liveness-rejects-an-out-of-range-threshold]: accepted 29 seconds';
EXCEPTION WHEN invalid_parameter_value THEN
  PERFORM app_private.watchdog_assert(
    'liveness-rejects-an-out-of-range-threshold', true, ''
  );
END;
$reject$;

-- ==== liveness =============================================================
DO $liveness$
DECLARE
  c_b1 constant uuid := '20000000-0000-4000-8000-000000000001';
  c_b2 constant uuid := '20000000-0000-4000-8000-000000000002';
  c_b3 constant uuid := '20000000-0000-4000-8000-000000000003';
  c_b6 constant uuid := '20000000-0000-4000-8000-000000000006';
  c_worker1 constant uuid := '10000000-0000-4000-8000-000000000001';
  c_worker2 constant uuid := '10000000-0000-4000-8000-000000000002';
  c_fingerprint constant text := 'network-center:worker-heartbeat-stale';
  v_report jsonb;
  v_incident uuid;
  v_events integer;
  v_leak integer;
BEGIN
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'fresh-fleet-opens-no-incident',
    (v_report->>'staleWorkers')::integer = 0
      AND (v_report->>'incidentsOpened')::integer = 0
      AND (v_report->>'monitoredBuildings')::integer = 4
      AND (SELECT count(*) FROM public.network_incidents) = 0,
    v_report::text
  );

  -- worker-05 was registered two minutes ago and has never reported. Inside the
  -- registration grace that is provisioning, not an outage.
  PERFORM app_private.watchdog_assert(
    'never-heartbeated-worker-is-live-inside-registration-grace',
    NOT EXISTS (
      SELECT 1 FROM app_private.network_center_watchdog_liveness_scan_v1(
        clock_timestamp(), 300, 900
      ) scan WHERE scan.building_id = c_b6 AND scan.stale
    ),
    'a worker inside its registration grace was reported stale'
  );
  -- Past the grace, the same silence is an alert: NULL is never health.
  PERFORM app_private.watchdog_assert(
    'never-heartbeated-worker-is-stale-past-registration-grace',
    EXISTS (
      SELECT 1 FROM app_private.network_center_watchdog_liveness_scan_v1(
        clock_timestamp(), 300, 60
      ) scan WHERE scan.building_id = c_b6 AND scan.stale
        AND scan.last_heartbeat_at IS NULL
    ),
    'silence from a registered worker past its grace was treated as health'
  );
  PERFORM app_private.watchdog_assert(
    'disabled-worker-is-not-monitored',
    NOT EXISTS (
      SELECT 1 FROM app_private.network_center_watchdog_liveness_scan_v1(
        clock_timestamp(), 300, 900
      ) scan WHERE scan.worker_key = 'watchdog-worker-03'
    ),
    'a DISABLED worker is still being watched'
  );
  PERFORM app_private.watchdog_assert(
    'expired-assignment-is-not-monitored',
    NOT EXISTS (
      SELECT 1 FROM app_private.network_center_watchdog_liveness_scan_v1(
        clock_timestamp(), 300, 900
      ) scan WHERE scan.worker_key = 'watchdog-worker-04'
    ),
    'an expired assignment is still being watched'
  );

  -- ---- worker-01 stops reporting ----------------------------------------
  UPDATE app_private.network_worker_release_heartbeats
  SET heartbeat_at = clock_timestamp() - interval '20 minutes'
  WHERE worker_id = c_worker1;

  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'stale-worker-opens-one-critical-incident-per-building',
    (v_report->>'staleWorkers')::integer = 1
      AND (v_report->>'staleBuildings')::integer = 2
      AND (v_report->>'incidentsOpened')::integer = 2
      AND (SELECT count(*) FROM public.network_incidents
           WHERE severity = 'CRITICAL' AND status = 'OPEN'
             AND incident_type = 'WORKER_HEARTBEAT_STALE'
             AND availability_impact) = 2,
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'stale-incident-uses-the-shared-fingerprint',
    (SELECT count(DISTINCT fingerprint) FROM public.network_incidents) = 1
      AND (SELECT min(fingerprint) FROM public.network_incidents) = c_fingerprint
      AND (SELECT count(*) FROM public.network_incidents
           WHERE building_id IN (c_b1, c_b2)) = 2,
    'the incident fingerprint is not the shared constant'
  );
  PERFORM app_private.watchdog_assert(
    'operator-payload-names-the-stale-worker',
    v_report->'staleWorkerDetail' @> '[{"workerKey": "watchdog-worker-01"}]'::jsonb
      AND jsonb_array_length(v_report->'staleWorkerDetail') = 1,
    v_report->>'staleWorkerDetail'
  );

  -- ---- repeat sweeps must not storm -------------------------------------
  SELECT id INTO v_incident FROM public.network_incidents WHERE building_id = c_b1;
  SELECT count(*)::integer INTO v_events FROM public.network_incident_events;

  v_report := public.network_center_watchdog_liveness_v1(300);
  v_report := public.network_center_watchdog_liveness_v1(300);
  v_report := public.network_center_watchdog_liveness_v1(300);

  PERFORM app_private.watchdog_assert(
    'repeat-sweep-opens-no-second-incident',
    (SELECT count(*) FROM public.network_incidents) = 2
      AND (v_report->>'incidentsOpened')::integer = 0,
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'repeat-sweep-appends-no-incident-event',
    (SELECT count(*) FROM public.network_incident_events) = v_events
      AND v_events = 2,
    'incident events grew on a repeat sweep, or the baseline was empty'
  );
  PERFORM app_private.watchdog_assert(
    'repeat-sweep-does-not-touch-the-incident-row',
    (SELECT version FROM public.network_incidents WHERE id = v_incident) = 1
      AND (SELECT occurrence_count FROM public.network_incidents
           WHERE id = v_incident) = 1,
    'an unchanged incident was rewritten, which would churn the Realtime publication'
  );
  PERFORM app_private.watchdog_assert(
    'repeat-sweep-appends-no-audit-or-outbox-row',
    (SELECT count(*) FROM public.network_audit_events) = 2
      AND (SELECT count(*) FROM public.network_outbox_events) = 2,
    'audit or outbox rows grew on a repeat sweep'
  );

  UPDATE public.network_incidents
  SET last_observed_at = last_observed_at - interval '10 minutes',
      opened_at = opened_at - interval '10 minutes';
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'stale-incident-refreshes-without-a-new-event',
    (v_report->>'incidentsRefreshed')::integer = 2
      AND (v_report->>'incidentsOpened')::integer = 0
      AND (SELECT count(*) FROM public.network_incident_events) = 2
      AND (SELECT occurrence_count FROM public.network_incidents
           WHERE id = v_incident) = 2,
    v_report::text
  );

  -- ---- nothing tenant-visible carries worker identity --------------------
  SELECT count(*)::integer INTO v_leak
  FROM public.network_workers worker
  WHERE EXISTS (
    SELECT 1 FROM public.network_incidents incident
    WHERE incident.title || ' ' || incident.summary || ' ' || incident.fingerprint
      || ' ' || incident.observed_values::text LIKE '%' || worker.worker_key || '%'
  ) OR EXISTS (
    SELECT 1 FROM public.network_audit_events audit
    WHERE audit.reason || ' ' || audit.target_display::text || ' '
      || audit.validation::text || ' ' || audit.result::text
      LIKE '%' || worker.worker_key || '%'
  ) OR EXISTS (
    SELECT 1 FROM public.network_incident_events event
    WHERE coalesce(event.worker_id, '') || ' ' || event.details::text
      LIKE '%' || worker.worker_key || '%'
  ) OR EXISTS (
    SELECT 1 FROM public.network_outbox_events outbox
    WHERE outbox.payload::text LIKE '%' || worker.worker_key || '%'
  );
  PERFORM app_private.watchdog_assert(
    'tenant-rows-carry-no-worker-identity',
    v_leak = 0
      AND (SELECT count(*) FROM public.network_incidents) > 0
      AND (SELECT count(*) FROM public.network_audit_events) > 0
      AND (SELECT count(*) FROM public.network_outbox_events) > 0
      AND (SELECT count(*) FROM public.network_workers) > 0,
    'a worker key reached a tenant-readable row (or there were no rows to check)'
  );
  PERFORM app_private.watchdog_assert(
    'incident-events-are-attributed-to-the-watchdog-not-a-worker',
    (SELECT count(DISTINCT worker_id) FROM public.network_incident_events) = 1
      AND (SELECT min(worker_id) FROM public.network_incident_events)
        = 'network-center-watchdog',
    'incident events are not attributed to the watchdog'
  );
  PERFORM app_private.watchdog_assert(
    'run-log-stores-no-worker-detail',
    (SELECT count(*) FROM app_private.network_center_watchdog_runs
     WHERE job = 'LIVENESS') > 0
    AND NOT EXISTS (
      SELECT 1 FROM app_private.network_center_watchdog_runs
      WHERE report ? 'staleWorkerDetail'
        OR report::text LIKE '%watchdog-worker-%'
    ),
    'the run log retained operator-only worker detail'
  );
  PERFORM app_private.watchdog_assert(
    'liveness-state-records-the-last-assessment',
    (SELECT stale_building_count
     FROM app_private.network_center_watchdog_state) = 2
      AND (SELECT stale_worker_count
           FROM app_private.network_center_watchdog_state) = 1
      AND (SELECT monitored_building_count
           FROM app_private.network_center_watchdog_state) = 4
      AND (SELECT liveness_threshold_seconds
           FROM app_private.network_center_watchdog_state) = 300,
    (SELECT to_jsonb(state)::text
     FROM app_private.network_center_watchdog_state state)
  );

  -- ---- a newer release heartbeat means the worker is alive ---------------
  INSERT INTO app_private.network_worker_release_heartbeats (
    worker_id, worker_version, status, heartbeat_at, started_at
  ) VALUES (
    c_worker1, repeat('e', 40), 'ONLINE', clock_timestamp(),
    clock_timestamp() - interval '1 minute'
  );
  PERFORM app_private.watchdog_assert(
    'liveness-uses-the-newest-release-heartbeat',
    NOT EXISTS (
      SELECT 1 FROM app_private.network_center_watchdog_liveness_scan_v1(
        clock_timestamp(), 300, 900
      ) scan WHERE scan.worker_key = 'watchdog-worker-01' AND scan.stale
    ),
    'a freshly promoted release was reported stale because an older release row is old'
  );

  -- ---- recovery ---------------------------------------------------------
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'recovery-resolves-the-incident',
    (v_report->>'incidentsResolved')::integer = 2
      AND (SELECT count(*) FROM public.network_incidents
           WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL
             AND recovered_at IS NOT NULL) = 2
      AND (SELECT count(*) FROM public.network_incidents
           WHERE status <> 'RESOLVED') = 0,
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'recovery-appends-exactly-one-resolved-event-per-incident',
    (SELECT count(*) FROM public.network_incident_events
     WHERE event_kind = 'RESOLVED' AND severity = 'INFO') = 2
      AND (SELECT count(*) FROM public.network_incident_events) = 4,
    'the recovery event count is wrong'
  );
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'recovery-is-idempotent',
    (v_report->>'incidentsResolved')::integer = 0
      AND (SELECT count(*) FROM public.network_incident_events) = 4,
    v_report::text
  );

  -- A resolved incident must not block the next outage: the partial unique
  -- index covers only non-RESOLVED rows.
  UPDATE app_private.network_worker_release_heartbeats
  SET heartbeat_at = clock_timestamp() - interval '20 minutes'
  WHERE worker_id = c_worker1;
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'a-second-outage-opens-a-second-incident',
    (v_report->>'incidentsOpened')::integer = 2
      AND (SELECT count(*) FROM public.network_incidents) = 4
      AND (SELECT count(*) FROM public.network_incident_events) = 6,
    v_report::text
  );

  -- ---- a building that stops being monitored keeps its alert -------------
  UPDATE app_private.network_worker_release_heartbeats
  SET heartbeat_at = clock_timestamp() - interval '20 minutes'
  WHERE worker_id = c_worker2;
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'a-second-tenant-alerts-independently',
    (SELECT count(*) FROM public.network_incidents
     WHERE building_id = c_b3 AND status <> 'RESOLVED') = 1
      AND (v_report->>'staleWorkers')::integer = 2,
    v_report::text
  );
  UPDATE public.network_worker_assignments
  SET active_until = clock_timestamp() - interval '1 minute'
  WHERE worker_id = c_worker2;
  UPDATE app_private.network_worker_release_heartbeats
  SET heartbeat_at = clock_timestamp()
  WHERE worker_id = c_worker2;
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'unmonitored-building-keeps-its-open-incident',
    (SELECT count(*) FROM public.network_incidents
     WHERE building_id = c_b3 AND status <> 'RESOLVED') = 1
      AND (v_report->>'monitoredBuildings')::integer = 3,
    'an alert was cleared merely because the thing being watched disappeared'
  );
END;
$liveness$;

-- ==== maintenance ==========================================================
DO $maintenance$
DECLARE
  v_report jsonb;
  v_today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  c_org2 constant uuid := '40000000-0000-4000-8000-000000000002';
  c_b4 constant uuid := '20000000-0000-4000-8000-000000000004';
BEGIN
  INSERT INTO public.network_client_current (
    organization_id, building_id, device_id, client_key, expires_at
  )
  SELECT device.organization_id, device.building_id, device.id, 'expired',
    clock_timestamp() - interval '1 hour'
  FROM public.network_devices device WHERE device.building_id = c_b4;
  INSERT INTO public.network_client_current (
    organization_id, building_id, device_id, client_key, expires_at
  )
  SELECT device.organization_id, device.building_id, device.id, 'live',
    clock_timestamp() + interval '1 hour'
  FROM public.network_devices device WHERE device.building_id = c_b4;

  INSERT INTO public.network_maintenance_windows (
    organization_id, building_id, status, starts_at, ends_at
  ) VALUES
    (c_org2, c_b4, 'SCHEDULED', clock_timestamp() - interval '10 minutes',
      clock_timestamp() + interval '1 hour'),
    (c_org2, c_b4, 'ACTIVE', clock_timestamp() - interval '3 hours',
      clock_timestamp() - interval '1 hour'),
    (c_org2, c_b4, 'SCHEDULED', clock_timestamp() + interval '5 hours',
      clock_timestamp() + interval '6 hours');

  v_report := public.network_center_watchdog_maintenance_v1();

  PERFORM app_private.watchdog_assert(
    'maintenance-precreates-raw-partitions-31-days-ahead',
    EXISTS (
      SELECT 1 FROM app_private.watchdog_proof_calls
      WHERE fn = 'ensure_raw_partitions'
        AND args = (v_today - 1)::text || '..' || (v_today + 31)::text
    ),
    coalesce((SELECT string_agg(fn || '=' || args, '; ')
      FROM app_private.watchdog_proof_calls), 'no maintenance primitive was called')
  );
  PERFORM app_private.watchdog_assert(
    'maintenance-rolls-up-the-previous-hour',
    EXISTS (
      SELECT 1 FROM app_private.watchdog_proof_calls
      WHERE fn = 'rollup_hourly'
        AND args = to_char(
          date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC')
            - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS')
    ),
    coalesce((SELECT string_agg(args, '; ')
      FROM app_private.watchdog_proof_calls WHERE fn = 'rollup_hourly'),
      'rollup_hourly was never called')
  );
  PERFORM app_private.watchdog_assert(
    'maintenance-reclaims-expired-command-leases',
    (v_report->>'reclaimedCommands')::integer = 4
      AND EXISTS (SELECT 1 FROM app_private.watchdog_proof_calls
                  WHERE fn = 'reclaim_expired_commands'),
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'maintenance-purges-only-expired-client-rows',
    (v_report->>'expiredClients')::integer = 1
      AND (SELECT count(*) FROM public.network_client_current) = 1
      AND (SELECT min(client_key) FROM public.network_client_current) = 'live',
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'maintenance-transitions-maintenance-windows',
    (SELECT count(*) FROM public.network_maintenance_windows
     WHERE status = 'ACTIVE') = 1
      AND (SELECT count(*) FROM public.network_maintenance_windows
           WHERE status = 'COMPLETED') = 1
      AND (SELECT count(*) FROM public.network_maintenance_windows
           WHERE status = 'SCHEDULED') = 1
      AND (v_report->>'maintenanceWindowsUpdated')::integer = 2,
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'first-maintenance-of-the-day-runs-retention-and-sla',
    (v_report->>'dailyMaintenanceRan')::boolean
      AND (SELECT count(*) FROM app_private.watchdog_proof_calls
           WHERE fn = 'retention') = 1
      AND (SELECT count(*) FROM app_private.watchdog_proof_calls
           WHERE fn = 'rollup_sla_daily') = 1
      AND jsonb_typeof(v_report->'retention') = 'object',
    v_report::text
  );

  v_report := public.network_center_watchdog_maintenance_v1();
  PERFORM app_private.watchdog_assert(
    'second-maintenance-of-the-day-skips-retention-and-sla',
    NOT (v_report->>'dailyMaintenanceRan')::boolean
      AND (SELECT count(*) FROM app_private.watchdog_proof_calls
           WHERE fn = 'retention') = 1
      AND (SELECT count(*) FROM app_private.watchdog_proof_calls
           WHERE fn = 'rollup_sla_daily') = 1
      AND (SELECT count(*) FROM app_private.watchdog_proof_calls
           WHERE fn = 'ensure_raw_partitions') = 2
      AND jsonb_typeof(v_report->'retention') = 'null',
    v_report::text
  );

  UPDATE app_private.network_center_watchdog_state
  SET daily_maintenance_day = v_today - 1;
  v_report := public.network_center_watchdog_maintenance_v1();
  PERFORM app_private.watchdog_assert(
    'a-new-utc-day-runs-retention-and-sla-again',
    (v_report->>'dailyMaintenanceRan')::boolean
      AND (SELECT count(*) FROM app_private.watchdog_proof_calls
           WHERE fn = 'retention') = 2
      AND (SELECT daily_maintenance_day
           FROM app_private.network_center_watchdog_state) = v_today,
    v_report::text
  );
  PERFORM app_private.watchdog_assert(
    'maintenance-run-log-is-written',
    (SELECT count(*) FROM app_private.network_center_watchdog_runs
     WHERE job = 'MAINTENANCE') = 3
      AND NOT EXISTS (
        SELECT 1 FROM app_private.network_center_watchdog_runs
        WHERE job = 'MAINTENANCE' AND report->>'job' <> 'MAINTENANCE'
      ),
    'the maintenance run log is wrong'
  );
END;
$maintenance$;

DO $skew$
BEGIN
  PERFORM public.network_center_watchdog_maintenance_v1(
    clock_timestamp() + interval '4 hours'
  );
  RAISE EXCEPTION
    'WATCHDOG PROOF FAILED [maintenance-rejects-a-clock-skewed-timestamp]: accepted +4h';
EXCEPTION WHEN invalid_parameter_value THEN
  PERFORM app_private.watchdog_assert(
    'maintenance-rejects-a-clock-skewed-timestamp', true, ''
  );
END;
$skew$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM app_private.watchdog_proof_results),
  'names', (SELECT jsonb_agg(name ORDER BY name)
            FROM app_private.watchdog_proof_results)
) AS disposable_watchdog_proof;
`;

// Run in a SECOND connection while a THIRD holds the liveness advisory lock.
// Advisory locks are re-entrant per session, so contention cannot be faked from
// one backend - a same-session attempt would acquire the lock and prove nothing.
const CONCURRENCY_ASSERTION_SQL = String.raw`
SET TIME ZONE 'UTC';
DO $contended$
DECLARE
  v_report jsonb;
BEGIN
  v_report := public.network_center_watchdog_liveness_v1(300);
  PERFORM app_private.watchdog_assert(
    'contended-liveness-reports-the-last-assessment-not-health',
    (v_report->>'skipped')::boolean
      AND v_report->>'skipReason' = 'CONCURRENT_RUN'
      AND (v_report->>'staleBuildings')::integer
        = (SELECT stale_building_count
           FROM app_private.network_center_watchdog_state)
      AND (v_report->>'staleBuildings')::integer > 0
      AND (v_report->>'assessedAt') IS NOT NULL,
    v_report::text
  );
END;
$contended$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM app_private.watchdog_proof_results),
  'names', (SELECT jsonb_agg(name ORDER BY name)
            FROM app_private.watchdog_proof_results)
) AS disposable_watchdog_proof;
`;

const LOCK_HOLDER_SQL = `
BEGIN;
SELECT pg_advisory_xact_lock(20260729139001::bigint);
SELECT pg_sleep(20);
COMMIT;
`;

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function candidatePostgresBins(environment = process.env) {
  const configured = environment.POSTGRES_BIN?.trim();
  return [
    configured || null,
    process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\17\\bin" : null,
    process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\16\\bin" : null,
  ].filter(Boolean);
}

export function assertSupportedPostgresVersion(name, versionOutput) {
  const match = String(versionOutput).match(/\bPostgreSQL\)?\s+(\d+)(?:\.\d+)?/u);
  if (!match) {
    throw new Error(
      `${name} did not report a valid PostgreSQL version; PostgreSQL 16+ is required`,
    );
  }
  const major = Number.parseInt(match[1], 10);
  if (major < 16) {
    throw new Error(`${name} requires PostgreSQL 16+ (reported major ${major})`);
  }
  return major;
}

function probePostgresBinary(name, binary) {
  const probe = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: POSTGRES_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (probe.status !== 0) return false;
  assertSupportedPostgresVersion(name, probe.stdout || probe.stderr);
  return true;
}

function resolveBinary(name, environment = process.env) {
  for (const directory of candidatePostgresBins(environment)) {
    const candidate = join(directory, executableName(name));
    if (existsSync(candidate) && probePostgresBinary(name, candidate)) return candidate;
  }
  const command = executableName(name);
  if (probePostgresBinary(name, command)) return command;
  throw new Error(
    `${name} is unavailable; set POSTGRES_BIN to a PostgreSQL 16+ bin directory`,
  );
}

function runNative(
  file,
  args,
  { input, quiet = false, stdio, timeoutMs = NATIVE_COMMAND_TIMEOUT_MS } = {},
) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  };
  if (input !== undefined) options.input = input;
  if (stdio !== undefined) options.stdio = stdio;
  const result = spawnSync(file, args, options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "native command failed")
      .trim()
      .slice(-4_000);
    const outcome = result.error?.code === "ETIMEDOUT"
      ? `timed out after ${timeoutMs}ms`
      : `failed (${result.status ?? result.error?.code ?? "unknown"})`;
    throw new Error(`${basename(file)} ${outcome}: ${detail}`, { cause: result.error });
  }
  if (!quiet && result.stderr?.trim()) process.stderr.write(result.stderr);
  return result.stdout ?? "";
}

export function assertDisposableClusterPath(cluster, tempDirectory = tmpdir()) {
  const resolvedTempDirectory = resolve(tempDirectory);
  const resolvedCluster = resolve(cluster);
  if (
    dirname(resolvedCluster) !== resolvedTempDirectory
    || !/^network-center-watchdog-pg-[A-Za-z0-9_-]+$/u.test(basename(resolvedCluster))
  ) {
    throw new Error(
      `Refusing destructive cleanup outside a disposable TEMP cluster: ${resolvedCluster}`,
    );
  }
  return resolvedCluster;
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  if (!Number.isSafeInteger(port)) throw new Error("Could not reserve a loopback port");
  return port;
}

export function parseProofVerdict(output) {
  const verdicts = String(output)
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
    .filter((entry) =>
      entry !== null && typeof entry === "object" && Object.hasOwn(entry, "invariants")
    );
  return verdicts.at(-1) ?? null;
}

export async function runDisposableWatchdogProof({ environment = process.env } = {}) {
  const binaries = Object.fromEntries(
    ["initdb", "pg_ctl", "psql"].map((name) => [name, resolveBinary(name, environment)]),
  );
  const port = await reserveLoopbackPort();
  const cluster = assertDisposableClusterPath(
    await mkdtemp(join(tmpdir(), "network-center-watchdog-pg-")),
  );
  const logPath = join(cluster, "postgres.log");
  let proofError = null;
  let startAttempted = false;
  let started = false;
  let lockHolder = null;
  const connectionArgs = [
    "-X", "-v", "ON_ERROR_STOP=1",
    "-h", "127.0.0.1", "-p", String(port),
    "-U", "postgres", "-d", "postgres",
  ];
  try {
    runNative(binaries.initdb, [
      "-D", cluster,
      "--auth=trust",
      "--username=postgres",
      "--encoding=UTF8",
      "--no-locale",
    ], { quiet: true });
    startAttempted = true;
    runNative(binaries.pg_ctl, [
      "-D", cluster,
      "-l", logPath,
      "-o", `-p ${port} -h 127.0.0.1`,
      "-w", "start",
    ], { quiet: true, stdio: PG_CTL_STDIO, timeoutMs: PG_CTL_TIMEOUT_MS });
    started = true;

    runNative(binaries.psql, connectionArgs, { input: BOOTSTRAP_SQL, quiet: true });
    runNative(binaries.psql, connectionArgs, {
      input: await readFile(WATCHDOG_MIGRATION_PATH, "utf8"),
      quiet: true,
    });
    runNative(binaries.psql, connectionArgs, { input: FIXTURE_SQL, quiet: true });

    runNative(binaries.psql, ["-q", "-t", "-A", ...connectionArgs], {
      input: ASSERTION_SQL,
      quiet: true,
    });

    // Genuine contention: a separate backend holds the liveness advisory lock in
    // an open transaction while the sweep runs in this one. There is no way to
    // fake this from a single session - advisory locks are re-entrant per
    // session, so a same-session attempt would succeed and prove nothing.
    lockHolder = spawn(binaries.psql, connectionArgs, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    lockHolder.stdin.end(LOCK_HOLDER_SQL);
    await new Promise((settle) => setTimeout(settle, LOCK_HOLDER_SETTLE_MS));

    const output = runNative(binaries.psql, ["-q", "-t", "-A", ...connectionArgs], {
      input: CONCURRENCY_ASSERTION_SQL,
      quiet: true,
    });

    const verdict = parseProofVerdict(output);
    if (
      verdict?.status !== "PASS"
      || verdict?.invariants !== WATCHDOG_PROOF_INVARIANTS
    ) {
      throw new Error(
        "Disposable watchdog proof did not return the expected PASS verdict: "
          + JSON.stringify(verdict),
      );
    }
    return verdict;
  } catch (error) {
    proofError = error;
    throw error;
  } finally {
    if (lockHolder && lockHolder.exitCode === null) {
      try {
        lockHolder.kill();
      } catch {
        /* the holder is a child of this process and dies with the cluster anyway */
      }
    }
    let cleanupError = null;
    let safeToRemove = !startAttempted;
    if (startAttempted) {
      try {
        assertDisposableClusterPath(cluster);
        runNative(binaries.pg_ctl, ["-D", cluster, "-m", "immediate", "-w", "stop"], {
          quiet: true,
          stdio: PG_CTL_STDIO,
          timeoutMs: PG_CTL_TIMEOUT_MS,
        });
        safeToRemove = true;
      } catch (error) {
        safeToRemove = !existsSync(join(cluster, "postmaster.pid"));
        if (!safeToRemove || started) cleanupError = error;
      }
    }
    if (safeToRemove) {
      try {
        await rm(assertDisposableClusterPath(cluster), { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      const cleanupMessage =
        `Disposable PostgreSQL cleanup failed: ${cleanupError.message}`;
      if (proofError) {
        throw new Error(`${proofError.message}; ${cleanupMessage}`, {
          cause: new AggregateError([proofError, cleanupError]),
        });
      }
      throw new Error(cleanupMessage, { cause: cleanupError });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error(
      "Usage: node scripts/test-network-center-watchdog-disposable.mjs [--dry-run]",
    );
  }
  if (args[0] === "--dry-run") {
    await readFile(WATCHDOG_MIGRATION_PATH, "utf8");
    process.stdout.write(
      "Disposable watchdog proof dry-run passed; no PostgreSQL process was started.\n",
    );
    return;
  }
  const verdict = await runDisposableWatchdogProof();
  process.stdout.write(
    `Disposable PostgreSQL watchdog migration proof PASS: `
      + `${verdict.invariants}/${WATCHDOG_PROOF_INVARIANTS} invariants.\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
