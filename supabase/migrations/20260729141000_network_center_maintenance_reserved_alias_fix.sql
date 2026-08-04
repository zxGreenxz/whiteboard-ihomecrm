-- =============================================================================
-- Network Center additive forward-fix: `window` is a PostgreSQL RESERVED
-- keyword and cannot be used as a bare table alias.
--
-- 20260729020000_network_center_current_telemetry.sql:783 built the
-- maintenance-window correction inside app_private.network_center_rollup_sla_
-- daily_v1 as a dynamic EXECUTE whose text contained
--
--     FROM public.network_maintenance_windows window
--     WHERE window.organization_id = sample.organization_id
--
-- A table alias must be a ColId. `window` is catcode R in pg_get_keywords(), so
-- the parser consumes it as the start of a WINDOW clause and then rejects the
-- WHERE that follows:
--
--     ERROR:  42601 syntax error at or near "WHERE"
--
-- LATE BINDING IS WHY EVERY GATE PASSED. The broken text lives inside a
-- conditional dynamic EXECUTE, so it is an opaque string until that branch runs.
-- plpgsql raw-parses its ordinary SQL statements at CREATE FUNCTION time, which
-- is why a reserved alias in static SQL would have failed the migration; a
-- reserved alias inside EXECUTE is parsed only on execution. Consequently the
-- migration applied cleanly, the catalog-descriptor audit passed (the function
-- exists), and the 99-function-body digest check passed (the stored body is
-- byte-identical to the reviewed text -- the reviewed text is the bug). This is
-- the same class as the `state.enabled` defect repaired by 20260729140000, one
-- layer deeper: 140000 was a late-bound COLUMN reference in static SQL, this is
-- a late-bound SYNTAX error in dynamic SQL.
--
-- MEASURED CONSEQUENCE ON PRODUCTION. pg_cron job 20 runs
-- public.network_center_watchdog_maintenance_v1 at '17 * * * *'. It failed on
-- every run since it was scheduled (12:17, 13:17, 14:17 UTC on 2026-08-02) with
-- the error above, raised from
--   PL/pgSQL function network_center_rollup_sla_daily_v1(date) line 76 at EXECUTE
--   PL/pgSQL function network_center_watchdog_maintenance_v1(timestamptz) line 66.
-- pg_cron rolls the whole job transaction back, so the daily branch takes every
-- earlier statement down with it and NOTHING in fleet maintenance has ever run:
-- raw-partition pre-creation (ensure_raw_partitions_v1), retention_v1,
-- rollup_hourly_v1, rollup_sla_daily_v1, expired-lease reclamation, expired
-- client purge and maintenance-window status transitions. Partitions were
-- pre-created 31 days ahead at migration time and nothing extends them, so
-- telemetry INGEST fails once that horizon is reached.
--
-- SCOPE OF THE REPAIR. The whole SQL corpus was scanned for reserved
-- (catcode R) and type_func_name (catcode T) keywords standing where the
-- grammar demands a ColId -- bare and AS-qualified table aliases after
-- FROM/JOIN/UPDATE/INSERT INTO, and CTE names -- using the live PostgreSQL 17
-- keyword catalog rather than a hand-written list. 544 .sql files plus every
-- .ts/.mjs/.ps1/.sh/.md/.json/.yml file that embeds SQL. This is the ONLY
-- instance. Nothing else in the corpus needs repair, so this migration
-- redefines exactly one function.
--
-- Nothing else about the function changes: signature, RETURNS integer, LANGUAGE
-- plpgsql, VOLATILE, SECURITY DEFINER, the pinned
-- search_path='pg_catalog, app_private, public' plus TimeZone=UTC, the postgres
-- ownership and the owner-only ACL are all re-declared exactly as production
-- already has them, and asserted after the fact by the runtime proof below.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729141000::bigint);

-- Fail closed rather than ship another late-bound reference: refuse to run if
-- the function this migration replaces is not the one that is live, or if the
-- relations its dynamic SQL names have moved.
DO $preflight$
DECLARE
  v_secdef boolean;
  v_config text[];
  v_missing text;
BEGIN
  IF to_regprocedure('app_private.network_center_rollup_sla_daily_v1(date)')
     IS NULL THEN
    RAISE EXCEPTION
      'app_private.network_center_rollup_sla_daily_v1(date) is missing'
      USING ERRCODE = '42883';
  END IF;

  -- Identify by OID, not by pg_get_function_identity_arguments: that function
  -- renders parameter NAMES too ('p_day date'), so comparing it with 'date'
  -- silently matches nothing and every assertion below it becomes vacuous.
  SELECT p.prosecdef, p.proconfig
  INTO v_secdef, v_config
  FROM pg_proc p
  WHERE p.oid
    = to_regprocedure('app_private.network_center_rollup_sla_daily_v1(date)');
  IF NOT FOUND OR v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION
      'network_center_rollup_sla_daily_v1 lost SECURITY DEFINER before the fix'
      USING ERRCODE = '42501';
  END IF;
  IF v_config IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, app_private, public', 'TimeZone=UTC'
     ]::text[] THEN
    RAISE EXCEPTION
      'network_center_rollup_sla_daily_v1 proconfig is % , not the pinned pair',
      coalesce(v_config::text, '<null>')
      USING ERRCODE = '42501';
  END IF;

  FOR v_missing IN
    SELECT relation
    FROM unnest(ARRAY[
      'public.network_device_samples',
      'public.network_devices',
      'public.network_sla_daily',
      'public.network_maintenance_windows',
      'public.network_incidents'
    ]) AS relation
    WHERE to_regclass(relation) IS NULL
  LOOP
    RAISE EXCEPTION 'Relation % named by the SLA rollup is missing', v_missing
      USING ERRCODE = '42P01';
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION app_private.network_center_rollup_sla_daily_v1(
  p_day date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_rows integer;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'SLA day is required' USING ERRCODE = '22023';
  END IF;
  v_start := p_day::timestamp AT TIME ZONE 'UTC';
  v_end := (p_day + 1)::timestamp AT TIME ZONE 'UTC';

  WITH reachability AS (
    SELECT
      s.organization_id,
      s.building_id,
      count(*)::bigint AS sample_count,
      avg(CASE WHEN s.reachable THEN 1::numeric ELSE 0::numeric END) AS uptime_ratio
    FROM public.network_device_samples s
    JOIN public.network_devices d
      ON d.organization_id = s.organization_id
     AND d.building_id = s.building_id
     AND d.id = s.device_id
     AND d.device_kind = 'MIKROTIK'
     AND d.is_active
    WHERE s.observed_at >= v_start
      AND s.observed_at < v_end
    GROUP BY s.organization_id, s.building_id
  )
  INSERT INTO public.network_sla_daily (
    organization_id,
    building_id,
    sla_day,
    sample_count,
    total_seconds,
    excluded_maintenance_seconds,
    eligible_seconds,
    uptime_seconds,
    outage_seconds,
    uptime_pct,
    incident_count,
    mttr_seconds,
    updated_at
  )
  SELECT
    r.organization_id,
    r.building_id,
    p_day,
    r.sample_count,
    86400,
    0,
    86400,
    round(86400::numeric * r.uptime_ratio)::bigint,
    86400 - round(86400::numeric * r.uptime_ratio)::bigint,
    round(100::numeric * r.uptime_ratio, 4),
    0,
    NULL,
    now()
  FROM reachability r
  ON CONFLICT (organization_id, building_id, sla_day)
  DO UPDATE SET
    sample_count = EXCLUDED.sample_count,
    total_seconds = EXCLUDED.total_seconds,
    excluded_maintenance_seconds = 0,
    eligible_seconds = EXCLUDED.total_seconds,
    uptime_seconds = EXCLUDED.uptime_seconds,
    outage_seconds = EXCLUDED.outage_seconds,
    uptime_pct = EXCLUDED.uptime_pct,
    incident_count = 0,
    mttr_seconds = NULL,
    updated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF to_regclass('public.network_maintenance_windows') IS NOT NULL THEN
    -- FORWARD FIX: the NOT EXISTS probe below aliased
    -- public.network_maintenance_windows as `window`, a reserved keyword that
    -- the parser reads as the start of a WINDOW clause, so this whole statement
    -- died with 42601 on every execution. The alias is now
    -- `maintenance_window`, an ordinary identifier. Nothing else changed.
    EXECUTE $sql$
      WITH maintenance AS (
        SELECT
          organization_id,
          building_id,
          least(
            86400::bigint,
            greatest(
              0::bigint,
              round(sum(extract(epoch FROM (
                least(ends_at, $3) - greatest(starts_at, $2)
              ))))::bigint
            )
          ) AS excluded_seconds
        FROM public.network_maintenance_windows
        WHERE status <> 'CANCELLED'
          AND starts_at < $3
          AND ends_at > $2
        GROUP BY organization_id, building_id
      ),
      effective_reachability AS (
        SELECT
          sample.organization_id,
          sample.building_id,
          count(*)::bigint AS sample_count,
          avg(CASE WHEN sample.reachable THEN 1::numeric ELSE 0::numeric END) AS uptime_ratio
        FROM public.network_device_samples sample
        JOIN public.network_devices device
          ON device.organization_id = sample.organization_id
         AND device.building_id = sample.building_id
         AND device.id = sample.device_id
         AND device.device_kind = 'MIKROTIK'
         AND device.is_active
        WHERE sample.observed_at >= $2
          AND sample.observed_at < $3
          AND NOT EXISTS (
            SELECT 1
            FROM public.network_maintenance_windows maintenance_window
            WHERE maintenance_window.organization_id = sample.organization_id
              AND maintenance_window.building_id = sample.building_id
              AND maintenance_window.status <> 'CANCELLED'
              AND sample.observed_at >= maintenance_window.starts_at
              AND sample.observed_at < maintenance_window.ends_at
          )
        GROUP BY sample.organization_id, sample.building_id
      ),
      recalculated AS (
        SELECT
          daily.organization_id,
          daily.building_id,
          maintenance.excluded_seconds,
          coalesce(effective.sample_count, daily.sample_count) AS sample_count,
          coalesce(effective.uptime_ratio, daily.uptime_pct / 100) AS uptime_ratio,
          86400 - maintenance.excluded_seconds AS eligible_seconds
        FROM public.network_sla_daily daily
        JOIN maintenance
          ON maintenance.organization_id = daily.organization_id
         AND maintenance.building_id = daily.building_id
        LEFT JOIN effective_reachability effective
          ON effective.organization_id = daily.organization_id
         AND effective.building_id = daily.building_id
        WHERE daily.sla_day = $1
      )
      UPDATE public.network_sla_daily s
      SET
        sample_count = r.sample_count,
        excluded_maintenance_seconds = r.excluded_seconds,
        eligible_seconds = r.eligible_seconds,
        uptime_seconds = CASE
          WHEN r.eligible_seconds = 0 THEN 0
          ELSE round(r.eligible_seconds::numeric * r.uptime_ratio)::bigint
        END,
        outage_seconds = CASE
          WHEN r.eligible_seconds = 0 THEN 0
          ELSE r.eligible_seconds - round(r.eligible_seconds::numeric * r.uptime_ratio)::bigint
        END,
        uptime_pct = CASE
          WHEN r.eligible_seconds = 0 THEN 100
          ELSE round(100::numeric * r.uptime_ratio, 4)
        END,
        updated_at = now()
      FROM recalculated r
      WHERE s.sla_day = $1
        AND s.organization_id = r.organization_id
        AND s.building_id = r.building_id
    $sql$ USING p_day, v_start, v_end;
  END IF;

  IF to_regclass('public.network_incidents') IS NOT NULL THEN
    EXECUTE $sql$
      WITH incident_stats AS (
        SELECT
          organization_id,
          building_id,
          count(*)::integer AS incident_count,
          avg(extract(epoch FROM (resolved_at - opened_at)))
            FILTER (WHERE resolved_at IS NOT NULL AND resolved_at >= opened_at) AS mttr_seconds
        FROM public.network_incidents
        WHERE availability_impact
          AND opened_at < $3
          AND (resolved_at IS NULL OR resolved_at >= $2)
        GROUP BY organization_id, building_id
      )
      UPDATE public.network_sla_daily s
      SET
        incident_count = i.incident_count,
        mttr_seconds = i.mttr_seconds,
        updated_at = now()
      FROM incident_stats i
      WHERE s.sla_day = $1
        AND s.organization_id = i.organization_id
        AND s.building_id = i.building_id
    $sql$ USING p_day, v_start, v_end;
  END IF;

  RETURN v_rows;
END;
$fn$;

-- Re-declared verbatim from 20260729020000. CREATE OR REPLACE preserves the
-- existing owner and ACL, so this widens nothing; it only keeps the migration
-- self-sufficient on a cluster where the function is created here first.
REVOKE ALL ON FUNCTION app_private.network_center_rollup_sla_daily_v1(date)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.network_center_rollup_sla_daily_v1(date) IS
  'Repeat-safe daily building SLA rollup. Owner-only; the trusted scheduler reaches it through public.network_center_watchdog_maintenance_v1. Its maintenance-window correction is dynamic SQL, so it is parsed only when executed - the reason a reserved-keyword table alias survived apply and every catalog audit until pg_cron ran it.';

-- The defect survived apply, the descriptor audit and the body-digest audit
-- because nothing ever EXECUTED the branch. Execute it. A dynamic statement is
-- parsed and planned before any row is touched, so a run that matches zero rows
-- still resolves every keyword, relation and column in both EXECUTE blocks --
-- which is exactly the resolution step this defect skipped for three cron runs.
--
-- The probe day is 10 years before today: raw sample partitions only ever span
-- [today-1, today+31], so the reachability CTE is empty and the function writes
-- nothing. The proof asserts that emptiness before and after, so it can never
-- become a stealth production mutation, and asserts that both to_regclass
-- guards are satisfied so it can never become a vacuous pass over two skipped
-- branches.
DO $runtime_proof$
DECLARE
  v_probe_day date := ((clock_timestamp() AT TIME ZONE 'UTC')::date - 3650);
  v_probe_start timestamptz := v_probe_day::timestamp AT TIME ZONE 'UTC';
  v_probe_end timestamptz := (v_probe_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_rows integer;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_src text;
BEGIN
  IF to_regclass('public.network_maintenance_windows') IS NULL
     OR to_regclass('public.network_incidents') IS NULL THEN
    RAISE EXCEPTION
      'Both conditional EXECUTE branches must be reachable for this proof to mean anything'
      USING ERRCODE = '42P01';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.network_device_samples s
    WHERE s.observed_at >= v_probe_start
      AND s.observed_at < v_probe_end
  ) OR EXISTS (
    SELECT 1
    FROM public.network_sla_daily daily
    WHERE daily.sla_day = v_probe_day
  ) THEN
    RAISE EXCEPTION 'SLA rollup probe day % is not empty; refusing to write', v_probe_day
      USING ERRCODE = '22023';
  END IF;

  v_rows := app_private.network_center_rollup_sla_daily_v1(v_probe_day);

  IF v_rows IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SLA rollup probe wrote % rows on an empty day', v_rows
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.network_sla_daily daily
    WHERE daily.sla_day = v_probe_day
  ) THEN
    RAISE EXCEPTION 'SLA rollup probe left a row behind on day %', v_probe_day
      USING ERRCODE = '22023';
  END IF;

  SELECT p.prosecdef, p.provolatile, p.proconfig, p.prosrc
  INTO v_secdef, v_volatile, v_config, v_src
  FROM pg_proc p
  WHERE p.oid
    = to_regprocedure('app_private.network_center_rollup_sla_daily_v1(date)');
  IF NOT FOUND
     OR v_secdef IS NOT TRUE
     OR v_volatile <> 'v'
     OR v_config IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, app_private, public', 'TimeZone=UTC'
        ]::text[] THEN
    RAISE EXCEPTION 'Network Center SLA rollup definer profile regressed'
      USING ERRCODE = '42501';
  END IF;

  IF has_function_privilege(
       'service_role', 'app_private.network_center_rollup_sla_daily_v1(date)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'app_private.network_center_rollup_sla_daily_v1(date)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'app_private.network_center_rollup_sla_daily_v1(date)', 'EXECUTE'
     )
     OR has_function_privilege(
       'public', 'app_private.network_center_rollup_sla_daily_v1(date)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Network Center SLA rollup grant surface widened'
      USING ERRCODE = '42501';
  END IF;

  IF v_src NOT LIKE '%network_maintenance_windows maintenance_window%' THEN
    RAISE EXCEPTION 'The repaired maintenance-window alias is not in the live body'
      USING ERRCODE = '22023';
  END IF;
END;
$runtime_proof$;

-- Fleet-wide sweep for the same shape in every other live Network Center
-- function body, not just the one repaired above. Deliberately narrow: it looks
-- only for a reserved `window` standing directly after a relation reference in
-- FROM/JOIN, and exempts the legitimate `WINDOW <name> AS (` clause. A broader
-- keyword sweep belongs in the repository scanner, where a false positive costs
-- an investigation instead of blocking a production rollout.
DO $fleet_sweep$
DECLARE
  v_offender text;
BEGIN
  SELECT string_agg(
    schema_row.nspname || '.' || function_row.proname, ', ' ORDER BY function_row.proname
  )
  INTO v_offender
  FROM pg_proc function_row
  JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
  WHERE schema_row.nspname IN ('public', 'app_private')
    AND function_row.proname LIKE 'network\_%'
    AND function_row.prosrc IS NOT NULL
    AND function_row.prosrc ~*
      '(from|join)[[:space:]]+[a-z_][a-z_0-9$]*(\.[a-z_][a-z_0-9$]*)*[[:space:]]+window[[:space:]]*($|[^a-z_0-9$])'
    AND function_row.prosrc !~* 'window[[:space:]]+[a-z_][a-z_0-9$]*[[:space:]]+as[[:space:]]*\(';
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'Reserved keyword `window` is still used as a table alias in: %', v_offender
      USING ERRCODE = '42601';
  END IF;
END;
$fleet_sweep$;

COMMIT;

NOTIFY pgrst, 'reload schema';
