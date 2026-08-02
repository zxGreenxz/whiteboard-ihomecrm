-- =============================================================================
-- Network Center deployment readback: server-derived poll EXPECTATION.
--
-- 20260729136000 returns what the worker CLAIMED it polled (connectionCount /
-- successfulPollCount / failedPollCount). It returns nothing the deploy gate can
-- compare that claim against, so deploy-vultr.ps1 had to hard-code the only
-- expectation it could express without server help:
--
--     connectionCount >= 1 AND successfulPollCount = connectionCount
--                          AND failedPollCount = 0
--
-- On a green-field fleet - which is every fleet at its FIRST deploy - there are
-- zero rows in public.network_device_connections, so a healthy worker reports
-- connections=0 and that gate can never be satisfied. Promoting a worker then
-- requires a reachable router, and onboarding a router requires a promoted
-- worker: a deadlock that blocks the first production deploy outright.
--
-- The fix is NOT an operator switch that waives the poll evidence. A flag that
-- says "ignore the polls" gets left on, and then a fleet where every router is
-- unreachable promotes green. Instead the EXPECTATION itself becomes server
-- state: this migration adds `expectedConnectionCount`, the number of device
-- connections PostgreSQL would actually serve to this worker, computed here
-- under the same predicate as
-- public.network_center_worker_list_connections_v2 (20260729133000) so the
-- number the gate expects is the number the worker is given:
--
--   * the connection is enabled and its device is active;
--   * an assignment binds THIS worker to that exact organization/building/device
--     with can_poll, inside its active window;
--   * the worker registry row is ACTIVE or DRAINING and carries POLL;
--   * the building is not monitoring-disabled (NULL settings = monitoring on);
--   * the device is a MIKROTIK reached over ROUTEROS_SSH, which is the exact
--     subset the worker's polling cycle keeps (infra/network-center-worker/
--     src/polling.ts runCycle) - counting connections the worker filters out
--     would make a healthy cycle look short forever.
--
-- With that number the deploy gate becomes correct in every fleet state without
-- anyone choosing a mode:
--   expected = 0  -> require exactly 0 successful and 0 failed polls, on top of
--                    every other liveness signal. "Nothing to poll" is provable,
--                    not waived.
--   expected > 0  -> require successfulPollCount = expected and 0 failures, so a
--                    fleet whose connections are ALL failing still fails the
--                    gate. The hole a flag would have opened stays shut.
--
-- The count is DISTINCT over connection ids because overlapping assignment rows
-- for one device would otherwise multiply it, exactly as list_connections_v2
-- de-duplicates with DISTINCT ON (connection.id).
--
-- Deliberately NOT clamped to the worker's 500-row read limit: a fleet larger
-- than one worker can read back makes successfulPollCount = expected
-- unsatisfiable and the deploy fails closed and loudly, which is the correct
-- outcome for a worker that cannot see its whole assignment.
--
-- Additive: same signature, so grants and dependants are unchanged; this
-- migration owns the function body at the end of the release, which is what
-- makes the stage observable to the rollout tool.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729143000::bigint);

CREATE OR REPLACE FUNCTION public.network_center_admin_worker_release_status_v1(
  p_worker_key text,
  p_worker_version text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_release_heartbeat jsonb;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_worker_key IS NULL
     OR p_worker_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
     OR p_worker_version IS NULL
     OR octet_length(p_worker_version) <> 40
     OR p_worker_version !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'Invalid worker release status request'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'workerKey', worker.worker_key,
    'displayName', worker.display_name,
    'workerVersion', heartbeat.worker_version,
    'status', heartbeat.status,
    'heartbeatAt', heartbeat.heartbeat_at,
    'startedAt', heartbeat.started_at,
    'assignedBuildingCount', heartbeat.assigned_building_count,
    'activeAssignedBuildingCount',
      assignment_evidence.active_assigned_building_count,
    'activeAssignmentCount', assignment_evidence.active_assignment_count,
    'activeAssignmentHash', assignment_evidence.active_assignment_hash,
    'expectedConnectionCount',
      connection_evidence.expected_connection_count,
    'connectionCount', heartbeat.connection_count,
    'successfulPollCount', heartbeat.successful_poll_count,
    'failedPollCount', heartbeat.failed_poll_count,
    'pollObservedAt', heartbeat.poll_observed_at
  )
  INTO v_release_heartbeat
  FROM app_private.network_worker_release_heartbeats heartbeat
  JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
  CROSS JOIN LATERAL (
    WITH effective_assignments AS MATERIALIZED (
      SELECT assignment.organization_id,
        assignment.building_id,
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
          coalesce(
            to_char(
              assignment.active_until AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ),
            '-'
          )
        ) AS canonical_row
      FROM public.network_worker_assignments assignment
      WHERE assignment.worker_id = worker.id
        AND worker.status IN ('ACTIVE', 'DRAINING')
        AND 'HEARTBEAT' = ANY(worker.capabilities)
        AND assignment.active_from <= v_now
        AND (
          assignment.active_until IS NULL
          OR assignment.active_until > v_now
        )
        AND (
          assignment.can_poll OR assignment.can_inventory
          OR assignment.can_execute
        )
    )
    SELECT count(DISTINCT (organization_id, building_id))::integer
        AS active_assigned_building_count,
      count(*)::integer AS active_assignment_count,
      encode(
        extensions.digest(
          convert_to(
            coalesce(string_agg(
              canonical_row,
              E'\n' ORDER BY canonical_row COLLATE "C"
            ), ''),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS active_assignment_hash
    FROM effective_assignments
  ) assignment_evidence
  CROSS JOIN LATERAL (
    -- Mirrors public.network_center_worker_list_connections_v2 row for row, then
    -- narrows to the MIKROTIK/ROUTEROS_SSH subset the worker's polling cycle
    -- actually attempts. Every predicate below is a server-side fact; nothing
    -- the deploying client sends can widen or narrow it, because the only
    -- parameters this function accepts are the worker key and the release SHA,
    -- both already validated above.
    SELECT count(*)::integer AS expected_connection_count
    FROM (
      SELECT DISTINCT connection.id
      FROM public.network_device_connections connection
      JOIN public.network_devices device
        ON device.organization_id = connection.organization_id
       AND device.building_id = connection.building_id
       AND device.id = connection.device_id
      JOIN public.network_worker_assignments assignment
        ON assignment.worker_id = worker.id
       AND assignment.organization_id = connection.organization_id
       AND assignment.building_id = connection.building_id
       AND assignment.device_id = connection.device_id
       AND assignment.can_poll
       AND assignment.active_from <= v_now
       AND (
         assignment.active_until IS NULL
         OR assignment.active_until > v_now
       )
      LEFT JOIN public.network_site_settings settings
        ON settings.organization_id = connection.organization_id
       AND settings.building_id = connection.building_id
      WHERE worker.status IN ('ACTIVE', 'DRAINING')
        AND 'POLL' = ANY(worker.capabilities)
        AND connection.is_enabled
        AND device.is_active
        AND device.device_kind = 'MIKROTIK'
        AND connection.transport = 'ROUTEROS_SSH'
        AND coalesce(settings.monitoring_enabled, true)
    ) pollable_connections
  ) connection_evidence
  WHERE worker.worker_key = p_worker_key
    AND heartbeat.worker_version = p_worker_version;

  RETURN v_release_heartbeat;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_worker_release_status_v1(
  text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_worker_release_status_v1(
  text, text
) TO service_role;

COMMENT ON FUNCTION public.network_center_admin_worker_release_status_v1(text, text) IS
  'Service-role-only exact worker and release readback with canonical active-assignment evidence and the server-derived expected pollable connection count the deployment gate compares the reported poll evidence against.';

COMMIT;

NOTIFY pgrst, 'reload schema';
