#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION_PATH = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260729136000_network_center_worker_release_readback.sql",
);
const NATIVE_COMMAND_TIMEOUT_MS = 60_000;
const PG_CTL_TIMEOUT_MS = 30_000;
const POSTGRES_VERSION_PROBE_TIMEOUT_MS = 10_000;
const PG_CTL_STDIO = ["ignore", "ignore", "ignore"];
export const DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS =
  (3 * 4 * POSTGRES_VERSION_PROBE_TIMEOUT_MS)
  + (4 * NATIVE_COMMAND_TIMEOUT_MS)
  + (2 * PG_CTL_TIMEOUT_MS)
  + 10_000;

const BOOTSTRAP_SQL = String.raw`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA app_private;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO service_role;
CREATE TABLE public.network_workers (
  id uuid PRIMARY KEY,
  worker_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL,
  capabilities text[] NOT NULL
);
INSERT INTO public.network_workers VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'disposable-worker-01',
    'Disposable worker one',
    'ACTIVE',
    ARRAY['HEARTBEAT']::text[]
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'disposable-worker-02',
    'Disposable worker two',
    'ACTIVE',
    ARRAY['HEARTBEAT']::text[]
  );
CREATE TABLE public.network_worker_assignments (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES public.network_workers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_kind text NOT NULL,
  assignment_version bigint NOT NULL,
  can_poll boolean NOT NULL DEFAULT false,
  can_inventory boolean NOT NULL DEFAULT false,
  can_execute boolean NOT NULL DEFAULT false,
  active_from timestamptz NOT NULL,
  active_until timestamptz
);
INSERT INTO public.network_worker_assignments VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'MIKROTIK', 1,
    true, false, false, clock_timestamp() - interval '1 day', NULL
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    'MIKROTIK', 7,
    false, true, false, clock_timestamp() - interval '1 day', NULL
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000003',
    'MIKROTIK', 2,
    true, false, false,
    clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000004',
    'MIKROTIK', 1,
    true, false, false, clock_timestamp() - interval '1 day', NULL
  );
CREATE FUNCTION app_private.network_center_authenticate_worker_v2(p_digest text)
RETURNS TABLE(
  worker_id uuid,
  worker_key text,
  worker_status text,
  capabilities text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT worker.id, worker.worker_key, worker.status, worker.capabilities
  FROM public.network_workers worker
  WHERE worker.worker_key = CASE p_digest
    WHEN 'digest-worker-01' THEN 'disposable-worker-01'
    WHEN 'digest-worker-02' THEN 'disposable-worker-02'
  END
$fn$;
CREATE FUNCTION public.network_center_worker_heartbeat_v2(
  p_credential_digest text,
  p_worker_version text,
  p_capabilities text[],
  p_status text,
  p_queue_age_seconds integer,
  p_safe_metadata jsonb,
  p_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_assigned_building_count integer;
BEGIN
  IF p_started_at IS NULL OR p_started_at > clock_timestamp() THEN
    RAISE EXCEPTION 'invalid heartbeat' USING ERRCODE = '22023';
  END IF;
  SELECT authenticated.worker_id
  INTO v_worker_id
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  SELECT count(DISTINCT assignment.building_id)::integer
  INTO v_assigned_building_count
  FROM public.network_worker_assignments assignment
  WHERE assignment.worker_id = v_worker_id
    AND assignment.active_from <= clock_timestamp()
    AND (
      assignment.active_until IS NULL
      OR assignment.active_until > clock_timestamp()
    )
    AND (
      assignment.can_poll OR assignment.can_inventory OR assignment.can_execute
    );
  RETURN jsonb_build_object(
    'status', upper(p_status),
    'heartbeatAt', clock_timestamp(),
    'assignedBuildingCount', v_assigned_building_count
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;
`;

const ASSERTION_SQL = String.raw`
SET ROLE service_role;
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object(
    'connections', 2,
    'successfulPolls', 2,
    'failedPolls', 0
  ),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('b', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object(
    'connections', 2,
    'successfulPolls', 1,
    'failedPolls', 1
  ),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object('source', 'periodic'),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-02', repeat('a', 40), ARRAY['polling'], 'ONLINE', 0,
  jsonb_build_object(
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_admin_release_status_v1(100);
RESET ROLE;
DO $keyed_readback$
DECLARE
  v_release_a jsonb;
  v_release_b jsonb;
  v_missing_release_status jsonb;
  v_other_worker_release_status jsonb;
  v_expected_assignment_hash text;
  v_previous_assignment_hash text;
  v_mutated_release_status jsonb;
BEGIN
  v_release_a := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  v_release_b := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('b', 40)
  );
  v_missing_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('f', 40)
  );
  v_other_worker_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-02', repeat('a', 40)
  );
  SELECT encode(extensions.digest(convert_to(string_agg(
    concat_ws(
      '|',
      'network-worker-assignment-v1',
      assignment.id::text,
      assignment.worker_id::text,
      assignment.organization_id::text,
      assignment.building_id::text,
      assignment.device_id::text,
      assignment.device_kind,
      assignment.assignment_version::text,
      CASE WHEN assignment.can_poll THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_inventory THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_execute THEN '1' ELSE '0' END,
      to_char(
        assignment.active_from AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      coalesce(to_char(
        assignment.active_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ), '-')
    ),
    E'\n' ORDER BY concat_ws(
      '|',
      'network-worker-assignment-v1',
      assignment.id::text,
      assignment.worker_id::text,
      assignment.organization_id::text,
      assignment.building_id::text,
      assignment.device_id::text,
      assignment.device_kind,
      assignment.assignment_version::text,
      CASE WHEN assignment.can_poll THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_inventory THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_execute THEN '1' ELSE '0' END,
      to_char(
        assignment.active_from AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      coalesce(to_char(
        assignment.active_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ), '-')
    ) COLLATE "C"
  ), 'UTF8'), 'sha256'), 'hex')
  INTO v_expected_assignment_hash
  FROM public.network_worker_assignments assignment
  WHERE assignment.worker_id = '10000000-0000-4000-8000-000000000001'
    AND assignment.active_from <= statement_timestamp()
    AND (assignment.active_until IS NULL OR assignment.active_until > statement_timestamp())
    AND (assignment.can_poll OR assignment.can_inventory OR assignment.can_execute);
  IF v_release_a IS NULL
     OR (v_release_a->>'schemaVersion')::integer <> 1
     OR v_release_a->>'workerKey' <> 'disposable-worker-01'
     OR v_release_a->>'workerVersion' <> repeat('a', 40) THEN
    RAISE EXCEPTION 'exact keyed release positive readback failed';
  END IF;
  IF (v_release_a->>'assignedBuildingCount')::integer <> 1
     OR (v_release_a->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_release_a->>'activeAssignmentCount')::integer <> 2
     OR v_release_a->>'activeAssignmentHash' <> v_expected_assignment_hash THEN
    RAISE EXCEPTION 'two active assignment rows for one building were not preserved';
  END IF;

  v_previous_assignment_hash := v_release_a->>'activeAssignmentHash';

  -- A same-building device swap changes the full-row digest, not either count.
  UPDATE public.network_worker_assignments assignment
  SET device_id = '50000000-0000-4000-8000-000000000005'
  WHERE assignment.id = '30000000-0000-4000-8000-000000000001';
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  IF (v_mutated_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_mutated_release_status->>'activeAssignmentCount')::integer <> 2
     OR v_mutated_release_status->>'activeAssignmentHash' = v_previous_assignment_hash THEN
    RAISE EXCEPTION 'same-building device swap was not detected';
  END IF;
  v_previous_assignment_hash := v_mutated_release_status->>'activeAssignmentHash';

  -- A capability change is part of canonical assignment identity.
  UPDATE public.network_worker_assignments assignment
  SET can_inventory = false,
      can_execute = true
  WHERE assignment.id = '30000000-0000-4000-8000-000000000002';
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  IF (v_mutated_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_mutated_release_status->>'activeAssignmentCount')::integer <> 2
     OR v_mutated_release_status->>'activeAssignmentHash' = v_previous_assignment_hash THEN
    RAISE EXCEPTION 'capability change was not detected';
  END IF;
  v_previous_assignment_hash := v_mutated_release_status->>'activeAssignmentHash';

  -- An assignment ID/version/window change is also digest-visible while active.
  UPDATE public.network_worker_assignments assignment
  SET id = '30000000-0000-4000-8000-000000000005',
      assignment_version = assignment.assignment_version + 1,
      active_from = clock_timestamp() - interval '2 hours',
      active_until = clock_timestamp() + interval '1 day'
  WHERE assignment.id = '30000000-0000-4000-8000-000000000002';
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  IF (v_mutated_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_mutated_release_status->>'activeAssignmentCount')::integer <> 2
     OR v_mutated_release_status->>'activeAssignmentHash' = v_previous_assignment_hash THEN
    RAISE EXCEPTION 'assignment ID/version/window change was not detected';
  END IF;
  IF (v_release_a->>'successfulPollCount')::integer <> 2
     OR (v_release_b->>'successfulPollCount')::integer <> 1
     OR (v_release_b->>'failedPollCount')::integer <> 1 THEN
    RAISE EXCEPTION 'exact release-version isolation failed';
  END IF;
  IF v_other_worker_release_status->>'workerKey' <> 'disposable-worker-02'
     OR (v_other_worker_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_other_worker_release_status->>'activeAssignmentCount')::integer <> 1
     OR v_other_worker_release_status->>'activeAssignmentHash' = v_expected_assignment_hash THEN
    RAISE EXCEPTION 'exact worker isolation failed';
  END IF;
  IF v_missing_release_status IS NOT NULL THEN
    RAISE EXCEPTION 'missing exact release did not return SQL NULL';
  END IF;
END
$keyed_readback$;
SET ROLE service_role;
DO $deny$
DECLARE
  v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM count(*)
    FROM app_private.network_worker_release_heartbeats;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'direct private-table read was allowed';
  END IF;
END
$deny$;
RESET ROLE;
DO $assertions$
DECLARE
  v_status jsonb;
BEGIN
  IF (SELECT count(*) FROM app_private.network_worker_release_heartbeats) <> 3 THEN
    RAISE EXCEPTION 'version-keyed rows missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_version = repeat('a', 40)
      AND heartbeat.connection_count = 2
      AND heartbeat.successful_poll_count = 2
      AND heartbeat.failed_poll_count = 0
      AND heartbeat.poll_observed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'periodic heartbeat erased successful poll evidence';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_version = repeat('b', 40)
      AND heartbeat.connection_count = 2
      AND heartbeat.successful_poll_count = 1
      AND heartbeat.failed_poll_count = 1
  ) THEN
    RAISE EXCEPTION 'failed poll evidence missing';
  END IF;
  v_status := public.network_center_admin_release_status_v1(100);
  IF jsonb_array_length(v_status->'releaseHeartbeats') <> 3 THEN
    RAISE EXCEPTION 'release status row count mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_status->'releaseHeartbeats') item
    WHERE NOT (item ?& ARRAY[
      'workerKey', 'workerVersion', 'status', 'connectionCount',
      'successfulPollCount', 'failedPollCount', 'pollObservedAt'
    ])
      OR item ?| ARRAY['credentialDigest', 'safeMetadata', 'secretDigest']
  ) THEN
    RAISE EXCEPTION 'release status shape is unsafe';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.network_center_admin_release_status_v1(integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.network_center_admin_release_status_v1(integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.network_center_admin_release_status_v1(integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'release status ACL mismatch';
  END IF;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('c', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object('connections', 1, 'successfulPolls', 1),
      clock_timestamp() - interval '1 minute'
    );
    RAISE EXCEPTION 'partial poll evidence was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$assertions$;
DO $null_poll_evidence$
DECLARE
  v_worker_id uuid := '10000000-0000-4000-8000-000000000001';
  v_before_poll_observed_at timestamptz;
  v_after_poll_observed_at timestamptz;
  v_rejected boolean;
BEGIN
  SELECT heartbeat.poll_observed_at
  INTO v_before_poll_observed_at
  FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.worker_id = v_worker_id
    AND heartbeat.worker_version = repeat('a', 40);
  IF v_before_poll_observed_at IS NULL THEN
    RAISE EXCEPTION 'null poll evidence proof needs a genuine poll baseline';
  END IF;

  -- JSON null satisfies both ?| and ?&, casts to SQL NULL without raising, and
  -- makes the range guard evaluate to NULL instead of TRUE, so poll_observed_at
  -- is stamped as if fresh evidence had been supplied. Unguarded, only the
  -- all-or-nothing storage CHECK stops the write, and it raises an opaque 23514
  -- from inside the INSERT instead of the documented 22023. Require the guard
  -- itself to fail closed.
  v_rejected := false;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object(
        'connections', NULL, 'successfulPolls', NULL, 'failedPolls', NULL
      ),
      clock_timestamp() - interval '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'JSON null poll evidence was accepted on an existing release';
  END IF;

  SELECT heartbeat.poll_observed_at
  INTO v_after_poll_observed_at
  FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.worker_id = v_worker_id
    AND heartbeat.worker_version = repeat('a', 40)
    AND heartbeat.connection_count = 2
    AND heartbeat.successful_poll_count = 2
    AND heartbeat.failed_poll_count = 0;
  IF v_after_poll_observed_at IS DISTINCT FROM v_before_poll_observed_at THEN
    RAISE EXCEPTION 'rejected null poll heartbeat refreshed poll freshness';
  END IF;

  -- On a first-seen release the all-or-nothing table CHECK would raise 23514,
  -- which is neither the documented error nor a guarantee once any column
  -- default changes. Require the explicit fail-closed 22023 and no row.
  v_rejected := false;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('d', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object(
        'connections', NULL, 'successfulPolls', NULL, 'failedPolls', NULL
      ),
      clock_timestamp() - interval '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'JSON null poll evidence was accepted on a fresh release';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = v_worker_id
      AND heartbeat.worker_version = repeat('d', 40)
  ) THEN
    RAISE EXCEPTION 'a rejected null poll heartbeat still wrote a release row';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object(
        'connections', 2, 'successfulPolls', NULL, 'failedPolls', 0
      ),
      clock_timestamp() - interval '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'a single JSON null poll count was accepted';
  END IF;
END
$null_poll_evidence$;
-- Release 'b' was superseded by 'a', so its heartbeat_at froze at the promotion
-- instant. The host still holds its image and still names it as previous;
-- rollback-vultr.ps1 reads it back by sha (Get-ReleaseStatus, no missing-row
-- tolerance) and refuses the rollback when the row is gone.
UPDATE app_private.network_worker_release_heartbeats heartbeat
SET started_at = statement_timestamp() - interval '46 days',
    heartbeat_at = statement_timestamp() - interval '45 days',
    poll_observed_at = statement_timestamp() - interval '45 days',
    updated_at = statement_timestamp() - interval '45 days'
WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
  AND heartbeat.worker_version = repeat('b', 40);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object('connections', 2, 'successfulPolls', 2, 'failedPolls', 0),
  clock_timestamp() - interval '1 minute'
);
DO $reachable_rollback_target_retained$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
      AND heartbeat.worker_version = repeat('b', 40)
  ) THEN
    RAISE EXCEPTION 'retention expired a still-reachable rollback target';
  END IF;
END
$reachable_rollback_target_retained$;
-- Displace 'b' beyond the reachable rollback depth with five newer-but-also-
-- expired releases so age-based collection still has something to reclaim.
INSERT INTO app_private.network_worker_release_heartbeats (
  worker_id, worker_version, status, heartbeat_at, started_at,
  assigned_building_count, updated_at
)
SELECT '10000000-0000-4000-8000-000000000001',
  repeat(filler.version_digit, 40),
  'PAUSED',
  clock_timestamp() - interval '31 days'
    - (filler.ordinal * interval '1 minute'),
  clock_timestamp() - interval '40 days',
  1,
  clock_timestamp() - interval '31 days'
FROM (VALUES ('0', 0), ('1', 1), ('2', 2), ('3', 3), ('4', 4))
  AS filler(version_digit, ordinal);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object('connections', 2, 'successfulPolls', 2, 'failedPolls', 0),
  clock_timestamp() - interval '1 minute'
);
DO $displaced_release_collected$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
      AND heartbeat.worker_version IN (repeat('b', 40), repeat('4', 40))
  ) THEN
    RAISE EXCEPTION 'expired releases beyond the reachable depth were not collected';
  END IF;
  IF (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
  ) <> 5 THEN
    RAISE EXCEPTION 'reachable rollback window is not exactly bounded';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000002'
      AND heartbeat.worker_version = repeat('a', 40)
  ) THEN
    RAISE EXCEPTION 'age-based collection deleted another worker''s release row';
  END IF;
END
$displaced_release_collected$;
-- Fresh releases never age out, so the per-worker hard cap is their only bound.
INSERT INTO app_private.network_worker_release_heartbeats (
  worker_id, worker_version, status, heartbeat_at, started_at,
  assigned_building_count, updated_at
)
SELECT '10000000-0000-4000-8000-000000000002',
  lpad(to_hex(4096 + series.ordinal), 40, '0'),
  'PAUSED',
  clock_timestamp() - (series.ordinal * interval '1 minute'),
  clock_timestamp() - interval '2 hours',
  1,
  clock_timestamp()
FROM generate_series(1, 24) AS series(ordinal);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-02', repeat('a', 40), ARRAY['polling'], 'ONLINE', 0,
  jsonb_build_object('connections', 1, 'successfulPolls', 1, 'failedPolls', 0),
  clock_timestamp() - interval '1 minute'
);
DO $fresh_release_growth_bounded$
BEGIN
  IF (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000002'
  ) <> 20 THEN
    RAISE EXCEPTION 'fresh release growth is not bounded by the per-worker cap';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000002'
      AND heartbeat.worker_version = repeat('a', 40)
  ) THEN
    RAISE EXCEPTION 'the live release was evicted by the per-worker cap';
  END IF;
  IF (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
  ) <> 5 THEN
    RAISE EXCEPTION 'another worker''s cap eviction changed the reachable window';
  END IF;
END
$fresh_release_growth_bounded$;
SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', 22
) AS disposable_release_proof;
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
  throw new Error(`${name} is unavailable; set POSTGRES_BIN to a PostgreSQL 16+ bin directory`);
}

function runNative(
  file,
  args,
  {
    input,
    quiet = false,
    stdio,
    timeoutMs = NATIVE_COMMAND_TIMEOUT_MS,
  } = {},
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
    throw new Error(`${basename(file)} ${outcome}: ${detail}`, {
      cause: result.error,
    });
  }
  if (!quiet && result.stderr?.trim()) process.stderr.write(result.stderr);
  return result.stdout ?? "";
}

export function assertDisposableClusterPath(cluster, tempDirectory = tmpdir()) {
  const resolvedTempDirectory = resolve(tempDirectory);
  const resolvedCluster = resolve(cluster);
  if (
    dirname(resolvedCluster) !== resolvedTempDirectory
    || !/^network-center-pg-[A-Za-z0-9_-]+$/u.test(basename(resolvedCluster))
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
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  if (!Number.isSafeInteger(port)) throw new Error("Could not reserve a loopback port");
  return port;
}

export async function runDisposableReleaseProof({ environment = process.env } = {}) {
  const binaries = Object.fromEntries(
    ["initdb", "pg_ctl", "psql"].map((name) => [name, resolveBinary(name, environment)]),
  );
  const port = await reserveLoopbackPort();
  const cluster = assertDisposableClusterPath(
    await mkdtemp(join(tmpdir(), "network-center-pg-")),
  );
  const logPath = join(cluster, "postgres.log");
  let proofError = null;
  let startAttempted = false;
  let started = false;
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
    ], {
      quiet: true,
      stdio: PG_CTL_STDIO,
      timeoutMs: PG_CTL_TIMEOUT_MS,
    });
    started = true;
    runNative(binaries.psql, connectionArgs, { input: BOOTSTRAP_SQL, quiet: true });
    runNative(binaries.psql, [...connectionArgs, "-f", MIGRATION_PATH], { quiet: true });
    const output = runNative(
      binaries.psql,
      ["-q", "-t", "-A", ...connectionArgs],
      { input: ASSERTION_SQL, quiet: true },
    );
    const verdictLine = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{') && line.includes('"status"'));
    const verdict = verdictLine ? JSON.parse(verdictLine) : null;
    if (verdict?.status !== "PASS" || verdict?.invariants !== 22) {
      throw new Error("Disposable release proof did not return the expected PASS verdict");
    }
    return verdict;
  } catch (error) {
    proofError = error;
    throw error;
  } finally {
    let cleanupError = null;
    let safeToRemove = !startAttempted;
    if (startAttempted) {
      try {
        assertDisposableClusterPath(cluster);
        runNative(binaries.pg_ctl, ["-D", cluster, "-m", "fast", "-w", "stop"], {
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
      const cleanupMessage = `Disposable PostgreSQL cleanup failed: ${cleanupError.message}`;
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
    throw new Error("Usage: node scripts/test-network-center-release-readback-disposable.mjs [--dry-run]");
  }
  if (args[0] === "--dry-run") {
    await readFile(MIGRATION_PATH, "utf8");
    process.stdout.write(
      "Disposable release proof dry-run passed; no PostgreSQL process was started.\n",
    );
    return;
  }
  const verdict = await runDisposableReleaseProof();
  process.stdout.write(
    `Disposable PostgreSQL release migration proof PASS: ${verdict.invariants}/22 invariants.\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
