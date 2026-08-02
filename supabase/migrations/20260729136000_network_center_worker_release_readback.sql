-- =============================================================================
-- Network Center deployment readback: retain bounded, version-keyed heartbeats.
--
-- A blue/green canary and the active worker may temporarily share one principal.
-- Keeping one row per worker release prevents the old process from overwriting
-- proof that the reviewed candidate reached PostgreSQL. No credential digest or
-- caller metadata is retained.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729136000::bigint);

CREATE TABLE app_private.network_worker_release_heartbeats (
  worker_id uuid NOT NULL
    REFERENCES public.network_workers(id) ON DELETE CASCADE,
  worker_version text NOT NULL
    CHECK (octet_length(worker_version) = 40)
    CHECK (worker_version ~ '^[a-f0-9]{40}$'),
  status text NOT NULL
    CHECK (status IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')),
  heartbeat_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  assigned_building_count integer NOT NULL
    CHECK (assigned_building_count BETWEEN 1 AND 10000),
  connection_count integer
    CHECK (connection_count BETWEEN 0 AND 500),
  successful_poll_count integer
    CHECK (successful_poll_count BETWEEN 0 AND 500),
  failed_poll_count integer
    CHECK (failed_poll_count BETWEEN 0 AND 500),
  poll_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (worker_id, worker_version),
  CONSTRAINT network_worker_release_heartbeat_time_check
    CHECK (started_at <= heartbeat_at),
  CONSTRAINT network_worker_release_heartbeat_poll_metrics_check
    CHECK (
      (
        connection_count IS NULL
        AND successful_poll_count IS NULL
        AND failed_poll_count IS NULL
        AND poll_observed_at IS NULL
      ) OR (
        connection_count IS NOT NULL
        AND successful_poll_count IS NOT NULL
        AND failed_poll_count IS NOT NULL
        AND poll_observed_at IS NOT NULL
        AND successful_poll_count + failed_poll_count = connection_count
        AND poll_observed_at BETWEEN started_at AND heartbeat_at
      )
    )
);

CREATE INDEX network_worker_release_heartbeats_recent_idx
  ON app_private.network_worker_release_heartbeats (
    heartbeat_at DESC, worker_id, worker_version
  );

ALTER TABLE app_private.network_worker_release_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.network_worker_release_heartbeats FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.network_worker_release_heartbeats
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the fully reviewed heartbeat/assignment implementation as a private
-- core, then wrap it only to record bounded release evidence.
ALTER FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) SET SCHEMA app_private;
ALTER FUNCTION app_private.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) RENAME TO network_center_worker_heartbeat_impl_v2;

REVOKE ALL ON FUNCTION app_private.network_center_worker_heartbeat_impl_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.network_center_worker_heartbeat_core_v2(
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
BEGIN
  IF p_worker_version IS NULL
     OR octet_length(p_worker_version) <> 40
     OR p_worker_version !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'Invalid worker heartbeat' USING ERRCODE = '22023';
  END IF;
  RETURN app_private.network_center_worker_heartbeat_impl_v2(
    p_credential_digest,
    p_worker_version,
    p_capabilities,
    p_status,
    p_queue_age_seconds,
    p_safe_metadata,
    p_started_at
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_worker_heartbeat_core_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.network_center_worker_heartbeat_v2(
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
  v_result jsonb;
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_registry_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_worker_version text := p_worker_version;
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_assigned_building_count integer;
  v_connection_count integer;
  v_successful_poll_count integer;
  v_failed_poll_count integer;
  v_poll_observed_at timestamptz;
BEGIN
  -- Validate the raw release identity before calling the mutation-capable core.
  -- Trimming or case-folding would let a different deploy artifact claim proof.
  IF p_worker_version IS NULL
     OR octet_length(p_worker_version) <> 40
     OR p_worker_version !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'Invalid worker release version' USING ERRCODE = '22023';
  END IF;

  -- The private core performs validation, authentication, assignment locking and
  -- the scoped building-status upsert. If it fails, no release row is written.
  v_result := app_private.network_center_worker_heartbeat_core_v2(
    p_credential_digest,
    p_worker_version,
    p_capabilities,
    p_status,
    p_queue_age_seconds,
    p_safe_metadata,
    p_started_at
  );

  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_registry_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;

  v_assigned_building_count := nullif(
    v_result->>'assignedBuildingCount', ''
  )::integer;
  IF v_assigned_building_count IS NULL
     OR v_assigned_building_count NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid worker release heartbeat result'
      USING ERRCODE = '22023';
  END IF;
  IF p_safe_metadata ?| ARRAY[
    'connections', 'successfulPolls', 'failedPolls'
  ] THEN
    IF NOT (p_safe_metadata ?& ARRAY[
      'connections', 'successfulPolls', 'failedPolls'
    ]) THEN
      RAISE EXCEPTION 'Incomplete worker poll evidence'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_connection_count := (p_safe_metadata->>'connections')::integer;
      v_successful_poll_count := (p_safe_metadata->>'successfulPolls')::integer;
      v_failed_poll_count := (p_safe_metadata->>'failedPolls')::integer;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Invalid worker poll evidence'
          USING ERRCODE = '22023';
    END;
    IF v_connection_count NOT BETWEEN 0 AND 500
       OR v_successful_poll_count NOT BETWEEN 0 AND 500
       OR v_failed_poll_count NOT BETWEEN 0 AND 500
       OR v_successful_poll_count + v_failed_poll_count <> v_connection_count THEN
      RAISE EXCEPTION 'Invalid worker poll evidence'
        USING ERRCODE = '22023';
    END IF;
    v_poll_observed_at := v_now;
  END IF;

  INSERT INTO app_private.network_worker_release_heartbeats (
    worker_id,
    worker_version,
    status,
    heartbeat_at,
    started_at,
    assigned_building_count,
    connection_count,
    successful_poll_count,
    failed_poll_count,
    poll_observed_at,
    updated_at
  ) VALUES (
    v_worker_id,
    v_worker_version,
    v_status,
    v_now,
    p_started_at,
    v_assigned_building_count,
    v_connection_count,
    v_successful_poll_count,
    v_failed_poll_count,
    v_poll_observed_at,
    v_now
  )
  ON CONFLICT (worker_id, worker_version) DO UPDATE SET
    status = EXCLUDED.status,
    heartbeat_at = EXCLUDED.heartbeat_at,
    started_at = LEAST(
      app_private.network_worker_release_heartbeats.started_at,
      EXCLUDED.started_at
    ),
    assigned_building_count = EXCLUDED.assigned_building_count,
    connection_count = coalesce(
      EXCLUDED.connection_count,
      app_private.network_worker_release_heartbeats.connection_count
    ),
    successful_poll_count = coalesce(
      EXCLUDED.successful_poll_count,
      app_private.network_worker_release_heartbeats.successful_poll_count
    ),
    failed_poll_count = coalesce(
      EXCLUDED.failed_poll_count,
      app_private.network_worker_release_heartbeats.failed_poll_count
    ),
    poll_observed_at = coalesce(
      EXCLUDED.poll_observed_at,
      app_private.network_worker_release_heartbeats.poll_observed_at
    ),
    updated_at = EXCLUDED.updated_at;

  DELETE FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.heartbeat_at < v_now - INTERVAL '30 days';

  DELETE FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.worker_id = v_worker_id
    AND (heartbeat.worker_id, heartbeat.worker_version) IN (
      SELECT ranked.worker_id, ranked.worker_version
      FROM app_private.network_worker_release_heartbeats ranked
      WHERE ranked.worker_id = v_worker_id
      ORDER BY ranked.heartbeat_at DESC, ranked.worker_version
      OFFSET 20
    );

  RETURN v_result || jsonb_build_object('workerVersion', v_worker_version);
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.network_center_admin_release_status_v1(
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_release_heartbeats jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Network Center release status limit must be between 1 and 200'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_release_heartbeats
  FROM (
    SELECT worker.worker_key AS "workerKey",
      worker.display_name AS "displayName",
      heartbeat.worker_version AS "workerVersion",
      heartbeat.status,
      heartbeat.heartbeat_at AS "heartbeatAt",
      heartbeat.started_at AS "startedAt",
      heartbeat.assigned_building_count AS "assignedBuildingCount",
      heartbeat.connection_count AS "connectionCount",
      heartbeat.successful_poll_count AS "successfulPollCount",
      heartbeat.failed_poll_count AS "failedPollCount",
      heartbeat.poll_observed_at AS "pollObservedAt"
    FROM app_private.network_worker_release_heartbeats heartbeat
    JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
    ORDER BY heartbeat.heartbeat_at DESC, worker.worker_key,
      heartbeat.worker_version
    LIMIT p_limit
  ) row_data;

  RETURN jsonb_build_object('releaseHeartbeats', v_release_heartbeats);
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_release_status_v1(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_release_status_v1(integer)
  TO service_role;

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

COMMENT ON TABLE app_private.network_worker_release_heartbeats IS
  'Private bounded release/version heartbeat evidence for blue-green deployment readback.';
COMMENT ON FUNCTION public.network_center_admin_release_status_v1(integer) IS
  'Service-role-only bounded release heartbeat readback; excludes credentials and caller metadata.';
COMMENT ON FUNCTION public.network_center_admin_worker_release_status_v1(text, text) IS
  'Service-role-only exact worker and release readback with canonical active-assignment evidence.';

COMMIT;

NOTIFY pgrst, 'reload schema';
