-- =============================================================================
-- Network Center out-of-band watchdog.
--
-- Everything periodic in this subsystem used to be initiated by the Vultr
-- worker itself, so the worker was both the thing being watched and the only
-- thing doing the watching. Two consequences, both verified against this tree
-- rather than assumed:
--
--  1. Nothing outside the worker can tell that the worker stopped. The browser
--     keeps rendering the last known device state, `network_worker_building_status`
--     keeps its last heartbeat row, and no incident is ever opened. Task 16's
--     rollout evidence ("observe seven cycles", "observe 24 hours") therefore
--     cannot distinguish a healthy canary from one that stopped reporting.
--
--  2. `network_center_worker_maintenance_v2` (20260729133000) deliberately
--     dropped the fleet-global half of maintenance - its own comment says
--     "Fleet-global partition, retention, rollup and command reclamation remain
--     a separate trusted scheduler responsibility; worker auth never invokes
--     them." That scheduler was never built. So today
--     `network_center_ensure_raw_partitions_v1`, `..._rollup_hourly_v1`,
--     `..._rollup_sla_daily_v1` and `..._retention_v1` have NO live caller at
--     all: the only remaining caller is `network_center_worker_maintenance_v1`,
--     whose service_role grant `network_center_admin_finalize_worker_compatibility_v1`
--     revokes at cutover. Raw partitions were pre-created 31 days ahead when
--     20260729020000 was applied and nothing has extended them since, so raw
--     telemetry ingest fails on a missing partition roughly one month after that
--     migration - with no alert, because of consequence 1.
--
-- This migration adds the missing scheduler and the missing detector. Both are
-- service-role-only entry points meant to be driven from OUTSIDE the worker:
-- pg_cron inside PostgreSQL (the pattern already used by
-- 20260603000011_recurring_vouchers_cron.sql and
-- 20260728010000_business_performance_month_snapshots.sql), and/or the
-- `network-watchdog` Edge function over HTTP for an external uptime monitor.
-- Neither is scheduled here on purpose: enabling them is an explicit operator
-- deployment step, because `network_center_watchdog_maintenance_v1` performs
-- retention. The exact statements are in the COMMENT block at the end of this
-- file.
--
-- Design constraints honoured throughout:
--  * No worker credential is read, held, returned or logged. The watchdog never
--    touches network_worker_credentials and takes no credential parameter.
--  * Nothing tenant-visible carries worker identity. `network_worker_building_status`
--    is documented as containing "no worker identity, credential material,
--    metadata, or cross-building join key", and incidents/audit rows written
--    here obey the same rule: the incident fingerprint is constant, and worker
--    keys appear only in the service-role return value.
--  * Deduped by the existing one-active-fingerprint partial unique index, and
--    incident EVENTS are appended only on a genuine open/close transition, so a
--    two-minute schedule during a multi-day outage cannot storm either
--    network_incident_events or the Realtime publication.
--  * Idempotent and concurrency-safe: each job takes a transaction-scoped
--    advisory lock and reports the last completed assessment instead of doing
--    the work twice.
--  * Fail closed: an indeterminate liveness verdict is reported as an alert
--    condition, never as silence.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729139000::bigint);

-- -----------------------------------------------------------------------------
-- 1. Watchdog state and a bounded run log.
--
-- The run log exists because Task 16 asks an operator to "observe seven cycles"
-- and "observe 24 hours". Without a record written by something other than the
-- worker there is nothing to observe those cycles IN. It is private to
-- service_role and holds no tenant rows, only counts.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_private.network_center_watchdog_state (
  singleton boolean PRIMARY KEY DEFAULT true
    CONSTRAINT network_center_watchdog_state_singleton_check CHECK (singleton),
  liveness_assessed_at timestamptz,
  liveness_threshold_seconds integer
    CHECK (liveness_threshold_seconds IS NULL
      OR liveness_threshold_seconds BETWEEN 30 AND 86400),
  monitored_worker_count integer NOT NULL DEFAULT 0
    CHECK (monitored_worker_count >= 0),
  monitored_building_count integer NOT NULL DEFAULT 0
    CHECK (monitored_building_count >= 0),
  stale_worker_count integer NOT NULL DEFAULT 0
    CHECK (stale_worker_count >= 0),
  stale_building_count integer NOT NULL DEFAULT 0
    CHECK (stale_building_count >= 0),
  maintenance_ran_at timestamptz,
  daily_maintenance_day date,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO app_private.network_center_watchdog_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_private.network_center_watchdog_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL
    CHECK (job IN ('LIVENESS', 'MAINTENANCE')),
  ran_at timestamptz NOT NULL,
  duration_ms integer NOT NULL
    CHECK (duration_ms BETWEEN 0 AND 86400000),
  report jsonb NOT NULL
    CHECK (jsonb_typeof(report) = 'object'
      AND octet_length(report::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS network_center_watchdog_runs_job_recent_idx
  ON app_private.network_center_watchdog_runs (job, ran_at DESC, id DESC);

ALTER TABLE app_private.network_center_watchdog_state
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.network_center_watchdog_state
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.network_center_watchdog_runs
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.network_center_watchdog_runs
  FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app_private.network_center_watchdog_state
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.network_center_watchdog_runs
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Bounded run-log writer.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_watchdog_record_run_v1(
  p_job text,
  p_ran_at timestamptz,
  p_duration_ms integer,
  p_report jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  c_run_log_limit constant integer := 10000;
  c_run_log_max_age constant interval := INTERVAL '14 days';
BEGIN
  IF p_job NOT IN ('LIVENESS', 'MAINTENANCE')
     OR p_ran_at IS NULL
     OR p_duration_ms IS NULL
     OR p_duration_ms < 0
     OR jsonb_typeof(coalesce(p_report, 'null'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Invalid Network Center watchdog run record'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.network_center_watchdog_runs (
    job, ran_at, duration_ms, report
  ) VALUES (
    p_job, p_ran_at, least(p_duration_ms, 86400000), p_report
  );

  DELETE FROM app_private.network_center_watchdog_runs run
  WHERE run.job = p_job
    AND run.ran_at < p_ran_at - c_run_log_max_age;

  DELETE FROM app_private.network_center_watchdog_runs run
  WHERE run.job = p_job
    AND run.id IN (
      SELECT ranked.id
      FROM app_private.network_center_watchdog_runs ranked
      WHERE ranked.job = p_job
      ORDER BY ranked.ran_at DESC, ranked.id DESC
      OFFSET c_run_log_limit
    );
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_watchdog_record_run_v1(
  text, timestamptz, integer, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Liveness, read from the authoritative source.
--
-- `app_private.network_worker_release_heartbeats` (20260729136000) is the table
-- `network_center_admin_worker_release_status_v1` reads, and the only place a
-- worker's own heartbeat lands after `network_center_worker_heartbeat_v2`
-- authenticates it. That admin RPC answers for ONE (worker_key, release sha)
-- pair, which the rollback runbook knows and a watchdog does not, so the sweep
-- reads the same table directly and takes `max(heartbeat_at)` ACROSS releases:
-- during a blue/green promotion the old and new release share one principal, and
-- ranking by release rather than recency would report a freshly promoted worker
-- as stale.
--
-- A monitored worker is one an operator has actually put in service: registered
-- ACTIVE or DRAINING, carrying the HEARTBEAT capability, and holding at least one
-- currently-effective polling assignment. DISABLED workers are excluded because
-- a human disabled them on purpose; DRAINING ones are not, because a draining
-- worker is still running and still expected to report.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_watchdog_liveness_scan_v1(
  p_now timestamptz,
  p_stale_after_seconds integer,
  p_registration_grace_seconds integer
)
RETURNS TABLE (
  worker_id uuid,
  worker_key text,
  organization_id uuid,
  building_id uuid,
  device_id uuid,
  last_heartbeat_at timestamptz,
  stale boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  WITH monitored AS (
    SELECT worker.id AS worker_id,
      worker.worker_key AS worker_key,
      worker.created_at AS registered_at,
      assignment.organization_id AS organization_id,
      assignment.building_id AS building_id,
      -- PostgreSQL has no min(uuid); array_agg with an explicit ORDER BY is
      -- the deterministic equivalent, so the incident always names the same
      -- device for a building no matter how the planner orders the scan.
      (array_agg(assignment.device_id ORDER BY assignment.device_id))[1]
        AS device_id
    FROM public.network_workers worker
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = worker.id
    WHERE worker.status IN ('ACTIVE', 'DRAINING')
      AND 'HEARTBEAT' = ANY(worker.capabilities)
      AND assignment.can_poll
      AND assignment.active_from <= p_now
      AND (
        assignment.active_until IS NULL
        OR assignment.active_until > p_now
      )
    GROUP BY worker.id, worker.worker_key, worker.created_at,
      assignment.organization_id, assignment.building_id
  )
  SELECT monitored.worker_id,
    monitored.worker_key,
    monitored.organization_id,
    monitored.building_id,
    monitored.device_id,
    liveness.last_heartbeat_at,
    -- Fail closed on the NULL: a worker that has never reported once is not
    -- "unknown, assume fine", it is exactly the shape of a deploy that never
    -- came up. The registration grace only keeps the minute between provisioning
    -- a principal and the first heartbeat from paging anyone.
    CASE
      WHEN liveness.last_heartbeat_at IS NULL
        THEN monitored.registered_at
          <= p_now - make_interval(secs => p_registration_grace_seconds)
      ELSE liveness.last_heartbeat_at
        < p_now - make_interval(secs => p_stale_after_seconds)
    END AS stale
  FROM monitored
  CROSS JOIN LATERAL (
    SELECT max(heartbeat.heartbeat_at) AS last_heartbeat_at
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = monitored.worker_id
  ) liveness;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_watchdog_liveness_scan_v1(
  timestamptz, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. The sweep.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.network_center_watchdog_liveness_v1(
  p_stale_after_seconds integer DEFAULT 300,
  p_now timestamptz DEFAULT clock_timestamp(),
  p_registration_grace_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  -- One fingerprint for the whole subsystem, deliberately carrying no worker
  -- key. `network_incidents_one_active_fingerprint_uidx` is
  -- (organization_id, building_id, fingerprint) WHERE status <> 'RESOLVED', so
  -- this yields exactly one active incident per building no matter how often the
  -- sweep runs or how many workers serve that building - and it leaks no worker
  -- identity into a tenant-readable row.
  c_fingerprint constant text := 'network-center:worker-heartbeat-stale';
  c_incident_type constant text := 'WORKER_HEARTBEAT_STALE';
  c_actor constant text := 'network-center-watchdog';
  -- How stale an already-open incident may get before it is touched again. Keeps
  -- a two-minute schedule from writing to a Realtime-published table 720 times a
  -- day for one unresolved outage.
  c_refresh_interval constant interval := INTERVAL '5 minutes';
  v_started timestamptz := clock_timestamp();
  v_now timestamptz := p_now;
  v_report jsonb;
  v_state app_private.network_center_watchdog_state;
  v_monitored_workers integer := 0;
  v_monitored_buildings integer := 0;
  v_stale_workers integer := 0;
  v_stale_buildings integer := 0;
  v_opened integer := 0;
  v_refreshed integer := 0;
  v_resolved integer := 0;
  v_stale_worker_detail jsonb := '[]'::jsonb;
BEGIN
  IF p_stale_after_seconds IS NULL
     OR p_stale_after_seconds NOT BETWEEN 30 AND 86400
     OR p_registration_grace_seconds IS NULL
     OR p_registration_grace_seconds NOT BETWEEN 0 AND 86400
     OR v_now IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - v_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid Network Center watchdog request'
      USING ERRCODE = '22023';
  END IF;

  -- Concurrency safety. Two schedulers (pg_cron and an external HTTP cron) may
  -- legitimately be enabled at once, and a slow run may still be in flight when
  -- the next tick arrives. The loser must not double-write incidents, and must
  -- not report "healthy" either - it reports the last COMPLETED assessment, so a
  -- caller that maps the payload to an alert cannot be silenced by contention.
  IF NOT pg_try_advisory_xact_lock(20260729139001::bigint) THEN
    SELECT state.* INTO v_state
    FROM app_private.network_center_watchdog_state state
    WHERE state.singleton;
    RETURN jsonb_build_object(
      'schemaVersion', 1,
      'job', 'LIVENESS',
      'at', v_now,
      'skipped', true,
      'skipReason', 'CONCURRENT_RUN',
      'thresholdSeconds', coalesce(
        v_state.liveness_threshold_seconds, p_stale_after_seconds
      ),
      'assessedAt', v_state.liveness_assessed_at,
      'monitoredWorkers', coalesce(v_state.monitored_worker_count, 0),
      'monitoredBuildings', coalesce(v_state.monitored_building_count, 0),
      'staleWorkers', coalesce(v_state.stale_worker_count, 0),
      'staleBuildings', coalesce(v_state.stale_building_count, 0),
      'incidentsOpened', 0,
      'incidentsRefreshed', 0,
      'incidentsResolved', 0,
      'staleWorkerDetail', '[]'::jsonb
    );
  END IF;

  -- The scan is re-evaluated per statement rather than materialized into a temp
  -- table: `CREATE TEMPORARY TABLE` would make a second call inside the same
  -- transaction fail with 42P07, and a scheduler that batches both watchdog jobs
  -- into one transaction is a perfectly reasonable thing for an operator to
  -- write. The function is STABLE over tables this sweep never writes, so every
  -- re-evaluation inside one transaction sees the same rows.
  SELECT count(DISTINCT scan.worker_id),
    count(DISTINCT (scan.organization_id, scan.building_id)),
    count(DISTINCT scan.worker_id) FILTER (WHERE scan.stale),
    count(DISTINCT (scan.organization_id, scan.building_id))
      FILTER (WHERE scan.stale)
  INTO v_monitored_workers, v_monitored_buildings, v_stale_workers,
    v_stale_buildings
  FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan;

  -- Operator-facing only: this value is returned to the service-role caller and
  -- never written to a tenant-readable row. Bounded so a large fleet cannot make
  -- the payload unbounded.
  SELECT coalesce(jsonb_agg(to_jsonb(detail) ORDER BY detail."workerKey"), '[]'::jsonb)
  INTO v_stale_worker_detail
  FROM (
    SELECT scan.worker_key AS "workerKey",
      max(scan.last_heartbeat_at) AS "lastHeartbeatAt",
      count(DISTINCT (scan.organization_id, scan.building_id))::integer
        AS "buildingCount"
    FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan
    WHERE scan.stale
    GROUP BY scan.worker_key
    ORDER BY scan.worker_key
    LIMIT 20
  ) detail;

  -- Open or refresh one incident per building that has lost every one of its
  -- pollers. `xmax = 0` distinguishes a genuine INSERT from a conflict update,
  -- and the DO UPDATE WHERE means an unchanged, already-open incident yields no
  -- row at all - so an outage lasting days appends exactly one incident event.
  WITH stale_building AS (
    SELECT scan.organization_id,
      scan.building_id,
      (array_agg(scan.device_id ORDER BY scan.device_id))[1] AS device_id,
      max(scan.last_heartbeat_at) AS last_heartbeat_at
    FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan
    WHERE scan.stale
    GROUP BY scan.organization_id, scan.building_id
  ), upserted AS (
    INSERT INTO public.network_incidents (
      organization_id, building_id, device_id, interface_id, fingerprint,
      incident_type, severity, status, title, summary, availability_impact,
      opened_at, last_observed_at, occurrence_count, observed_values
    )
    SELECT stale_building.organization_id,
      stale_building.building_id,
      stale_building.device_id,
      NULL::uuid,
      c_fingerprint,
      c_incident_type,
      'CRITICAL',
      'OPEN',
      'Hệ thống giám sát mạng ngừng báo cáo',
      'Không nhận được nhịp tim từ tiến trình thu thập dữ liệu mạng của tòa nhà'
        || ' trong hơn ' || p_stale_after_seconds::text || ' giây.'
        || ' Số liệu đang hiển thị có thể đã cũ và các lệnh mới sẽ không được'
        || ' thực thi cho tới khi tiến trình hoạt động trở lại.',
      true,
      v_now,
      v_now,
      1,
      jsonb_build_object(
        'thresholdSeconds', p_stale_after_seconds,
        'lastHeartbeatAt', stale_building.last_heartbeat_at,
        'detectedBy', 'watchdog'
      )
    FROM stale_building
    ON CONFLICT (organization_id, building_id, fingerprint)
      WHERE status <> 'RESOLVED'
    DO UPDATE SET
      severity = 'CRITICAL',
      last_observed_at = greatest(
        public.network_incidents.last_observed_at, EXCLUDED.last_observed_at
      ),
      occurrence_count = public.network_incidents.occurrence_count + 1,
      observed_values = EXCLUDED.observed_values,
      version = public.network_incidents.version + 1
    WHERE public.network_incidents.last_observed_at
      < EXCLUDED.last_observed_at - c_refresh_interval
    RETURNING id, organization_id, building_id, device_id, opened_at,
      (xmax = 0) AS newly_opened
  ), opened_event AS (
    INSERT INTO public.network_incident_events (
      organization_id, building_id, incident_id, event_seq, event_kind,
      severity, occurred_at, worker_id, details
    )
    SELECT upserted.organization_id, upserted.building_id, upserted.id,
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_incident_events event
        WHERE event.incident_id = upserted.id
      ), 1),
      'OPENED', 'CRITICAL', v_now, c_actor,
      jsonb_build_object(
        'thresholdSeconds', p_stale_after_seconds,
        'detectedBy', 'watchdog'
      )
    FROM upserted
    WHERE upserted.newly_opened
    RETURNING incident_id
  ), opened_audit AS (
    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type, target_id,
      target_display, reason, validation, result, outcome, occurred_at
    )
    SELECT upserted.organization_id, upserted.building_id, 'SYSTEM',
      'system.watchdog_worker_stale', 'building', upserted.building_id,
      jsonb_build_object('deviceId', upserted.device_id),
      'Watchdog ngoài luồng phát hiện tiến trình giám sát ngừng báo cáo',
      jsonb_build_object('thresholdSeconds', p_stale_after_seconds),
      jsonb_build_object('incidentId', upserted.id),
      'OBSERVED', v_now
    FROM upserted
    WHERE upserted.newly_opened
    RETURNING id
  ), opened_outbox AS (
    INSERT INTO public.network_outbox_events (
      organization_id, building_id, event_type, aggregate_type, aggregate_id,
      payload, occurred_at
    )
    SELECT upserted.organization_id, upserted.building_id,
      'network.worker.heartbeat_stale', 'building', upserted.building_id,
      jsonb_build_object(
        'incidentId', upserted.id,
        'incidentType', c_incident_type,
        'thresholdSeconds', p_stale_after_seconds
      ),
      v_now
    FROM upserted
    WHERE upserted.newly_opened
    RETURNING id
  )
  SELECT (count(*) FILTER (WHERE upserted.newly_opened))::integer,
    (count(*) FILTER (WHERE NOT upserted.newly_opened))::integer
  INTO v_opened, v_refreshed
  FROM upserted;

  -- Clear down. Only for buildings this sweep still monitors and now finds
  -- healthy: a building whose assignment was removed entirely keeps its open
  -- incident, because "the thing I was watching disappeared" must not read as
  -- "the thing I was watching recovered".
  WITH healthy_building AS (
    SELECT scan.organization_id, scan.building_id
    FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan
    GROUP BY scan.organization_id, scan.building_id
    HAVING bool_and(NOT scan.stale)
  ), cleared AS (
    UPDATE public.network_incidents incident
    SET status = 'RESOLVED',
      resolved_at = v_now,
      recovered_at = coalesce(incident.recovered_at, v_now),
      last_observed_at = greatest(incident.last_observed_at, v_now),
      version = incident.version + 1
    FROM healthy_building
    WHERE incident.organization_id = healthy_building.organization_id
      AND incident.building_id = healthy_building.building_id
      AND incident.fingerprint = c_fingerprint
      AND incident.status <> 'RESOLVED'
    RETURNING incident.id, incident.organization_id, incident.building_id,
      incident.device_id
  ), cleared_event AS (
    INSERT INTO public.network_incident_events (
      organization_id, building_id, incident_id, event_seq, event_kind,
      severity, occurred_at, worker_id, details
    )
    SELECT cleared.organization_id, cleared.building_id, cleared.id,
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_incident_events event
        WHERE event.incident_id = cleared.id
      ), 1),
      'RESOLVED', 'INFO', v_now, c_actor,
      jsonb_build_object('detectedBy', 'watchdog')
    FROM cleared
    RETURNING incident_id
  ), cleared_audit AS (
    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type, target_id,
      target_display, reason, validation, result, outcome, occurred_at
    )
    SELECT cleared.organization_id, cleared.building_id, 'SYSTEM',
      'system.watchdog_worker_recovered', 'building', cleared.building_id,
      jsonb_build_object('deviceId', cleared.device_id),
      'Watchdog ngoài luồng ghi nhận tiến trình giám sát đã báo cáo trở lại',
      jsonb_build_object('thresholdSeconds', p_stale_after_seconds),
      jsonb_build_object('incidentId', cleared.id),
      'OBSERVED', v_now
    FROM cleared
    RETURNING id
  ), cleared_outbox AS (
    INSERT INTO public.network_outbox_events (
      organization_id, building_id, event_type, aggregate_type, aggregate_id,
      payload, occurred_at
    )
    SELECT cleared.organization_id, cleared.building_id,
      'network.worker.heartbeat_recovered', 'building', cleared.building_id,
      jsonb_build_object(
        'incidentId', cleared.id,
        'incidentType', c_incident_type
      ),
      v_now
    FROM cleared
    RETURNING id
  )
  SELECT count(*)::integer INTO v_resolved FROM cleared;

  UPDATE app_private.network_center_watchdog_state state
  SET liveness_assessed_at = v_now,
    liveness_threshold_seconds = p_stale_after_seconds,
    monitored_worker_count = v_monitored_workers,
    monitored_building_count = v_monitored_buildings,
    stale_worker_count = v_stale_workers,
    stale_building_count = v_stale_buildings,
    updated_at = clock_timestamp()
  WHERE state.singleton;

  v_report := jsonb_build_object(
    'schemaVersion', 1,
    'job', 'LIVENESS',
    'at', v_now,
    'skipped', false,
    'skipReason', NULL,
    'thresholdSeconds', p_stale_after_seconds,
    'assessedAt', v_now,
    'monitoredWorkers', v_monitored_workers,
    'monitoredBuildings', v_monitored_buildings,
    'staleWorkers', v_stale_workers,
    'staleBuildings', v_stale_buildings,
    'incidentsOpened', v_opened,
    'incidentsRefreshed', v_refreshed,
    'incidentsResolved', v_resolved,
    'staleWorkerDetail', v_stale_worker_detail
  );

  PERFORM app_private.network_center_watchdog_record_run_v1(
    'LIVENESS',
    v_now,
    (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::integer,
    v_report - 'staleWorkerDetail'
  );

  RETURN v_report;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_watchdog_liveness_v1(
  integer, timestamptz, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_watchdog_liveness_v1(
  integer, timestamptz, integer
) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. The fleet-global maintenance the worker no longer performs.
--
-- Every step here is already documented repeat-safe by the migration that
-- defines it, and every step is called with an absolute argument derived from
-- p_now rather than from "time since the last run", so a missed hour, a double
-- run and a concurrent run all converge on the same state.
--
-- Retention and the daily SLA rollup are gated to once per UTC day because
-- retention DROPs raw partitions; the rest is cheap enough to repeat hourly and
-- includes the partition pre-creation whose absence is the one failure with a
-- calendar fuse on it.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.network_center_watchdog_maintenance_v1(
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_now timestamptz := p_now;
  v_day date;
  v_daily_done boolean := false;
  v_reclaimed integer := 0;
  v_expired_clients bigint := 0;
  v_windows_updated bigint := 0;
  v_retention jsonb := NULL;
  v_report jsonb;
BEGIN
  IF v_now IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - v_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid Network Center watchdog maintenance request'
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(20260729139002::bigint) THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1,
      'job', 'MAINTENANCE',
      'at', v_now,
      'skipped', true,
      'skipReason', 'CONCURRENT_RUN'
    );
  END IF;

  v_day := (v_now AT TIME ZONE 'UTC')::date;

  -- The 31-day horizon matches both the bootstrap in 20260729020000 and the
  -- re-creation inside network_center_retention_v1, so ingest keeps a month of
  -- head-room even if this job stops.
  PERFORM app_private.network_center_ensure_raw_partitions_v1(
    v_day - 1, v_day + 31
  );

  PERFORM app_private.network_center_rollup_hourly_v1(
    date_trunc('hour', v_now) - INTERVAL '1 hour'
  );

  v_reclaimed := app_private.network_center_reclaim_expired_commands_v1(v_now);

  DELETE FROM public.network_client_current client
  WHERE client.expires_at <= v_now;
  GET DIAGNOSTICS v_expired_clients = ROW_COUNT;

  UPDATE public.network_maintenance_windows maintenance
  SET status = CASE
    WHEN maintenance.ends_at <= v_now THEN 'COMPLETED' ELSE 'ACTIVE'
  END
  WHERE maintenance.status IN ('SCHEDULED', 'ACTIVE')
    AND (
      maintenance.starts_at <= v_now OR maintenance.ends_at <= v_now
    );
  GET DIAGNOSTICS v_windows_updated = ROW_COUNT;

  -- Once per UTC day, taken under the same advisory lock, so a second caller in
  -- the same day observes the committed marker and does nothing.
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_center_watchdog_state state
    WHERE state.singleton
      AND state.daily_maintenance_day = v_day
  ) THEN
    PERFORM app_private.network_center_rollup_sla_daily_v1(
      (v_now - INTERVAL '1 day')::date
    );
    v_retention := app_private.network_center_retention_v1(v_now);
    v_daily_done := true;
  END IF;

  UPDATE app_private.network_center_watchdog_state state
  SET maintenance_ran_at = v_now,
    daily_maintenance_day = CASE
      WHEN v_daily_done THEN v_day ELSE state.daily_maintenance_day
    END,
    updated_at = clock_timestamp()
  WHERE state.singleton;

  v_report := jsonb_build_object(
    'schemaVersion', 1,
    'job', 'MAINTENANCE',
    'at', v_now,
    'skipped', false,
    'skipReason', NULL,
    'partitionHorizonThrough', v_day + 31,
    'reclaimedCommands', v_reclaimed,
    'expiredClients', v_expired_clients,
    'maintenanceWindowsUpdated', v_windows_updated,
    'dailyMaintenanceRan', v_daily_done,
    'retention', v_retention
  );

  PERFORM app_private.network_center_watchdog_record_run_v1(
    'MAINTENANCE',
    v_now,
    (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::integer,
    v_report
  );

  RETURN v_report;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_watchdog_maintenance_v1(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_watchdog_maintenance_v1(timestamptz)
  TO service_role;

COMMENT ON TABLE app_private.network_center_watchdog_state IS
  'Singleton last-completed watchdog assessment; read back when a concurrent run holds the advisory lock so contention can never be reported as a healthy fleet.';
COMMENT ON TABLE app_private.network_center_watchdog_runs IS
  'Bounded out-of-band watchdog run log (14 days, 10000 rows per job); the only record of periodic health that is not written by the worker being watched.';
COMMENT ON FUNCTION public.network_center_watchdog_liveness_v1(
  integer, timestamptz, integer
) IS
  'Service-role-only out-of-band worker liveness sweep. Reads app_private.network_worker_release_heartbeats (the source behind network_center_admin_worker_release_status_v1), opens one deduped CRITICAL WORKER_HEARTBEAT_STALE incident per affected building, resolves it when the worker reports again, holds no worker credential and writes no worker identity into any tenant-readable row.';
COMMENT ON FUNCTION public.network_center_watchdog_maintenance_v1(timestamptz) IS
  'Service-role-only fleet-global maintenance scheduler: raw partition pre-creation, hourly rollup, expired lease reclamation, expired client purge and maintenance-window transitions every run, plus the daily SLA rollup and retention once per UTC day. network_center_worker_maintenance_v2 deliberately stopped doing this work and named a trusted scheduler as its owner; this function is that owner.';

-- =============================================================================
-- ENABLING THE SCHEDULE - operator deployment step, deliberately NOT run here.
--
-- Option A (recommended, in-database, no secret anywhere). Matches
-- 20260603000011_recurring_vouchers_cron.sql. pg_cron runs as the database
-- superuser, so no GRANT is needed or given:
--
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule(
--     'network_center_watchdog_liveness_v1',
--     '*/2 * * * *',
--     $cron$SELECT public.network_center_watchdog_liveness_v1(300);$cron$
--   );
--   SELECT cron.schedule(
--     'network_center_watchdog_maintenance_v1',
--     '17 * * * *',
--     $cron$SELECT public.network_center_watchdog_maintenance_v1();$cron$
--   );
--
-- With a 300-second staleness threshold and a two-minute tick, a stopped worker
-- is detected within 7 minutes worst case, which meets the original plan's
-- "within six minutes" intent to within one tick.
--
-- Option B (additional, out-of-database). Point any external scheduler or
-- uptime monitor at the `network-watchdog` Edge function:
--
--   POST https://<project-ref>.supabase.co/functions/v1/network-watchdog/liveness
--   POST https://<project-ref>.supabase.co/functions/v1/network-watchdog/maintenance
--   header: x-network-watchdog-secret: <NETWORK_WATCHDOG_CRON_SECRET>
--
-- The function answers 200 only when the fleet is healthy, 503 when a monitored
-- worker is stale, and 5xx when liveness could not be determined - so a plain
-- uptime monitor is a working alert channel even though no notification
-- consumer exists yet (network_outbox_deliveries still has no reader).
--
-- Disabling: SELECT cron.unschedule('network_center_watchdog_liveness_v1');
-- =============================================================================

COMMIT;

NOTIFY pgrst, 'reload schema';
