-- Authoritative room/contract month snapshots for the standalone Business
-- Performance report. No historical backfill: rollout captures only the real
-- current state and later months accumulate through pg_cron.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE public.finance_month_snapshot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  snapshot_month date NOT NULL,
  as_of_date date,
  as_of_timestamp timestamptz,
  scheduled_for timestamptz NOT NULL,
  captured_at timestamptz,
  finalized_at timestamptz,
  status text NOT NULL DEFAULT 'PROVISIONAL',
  capture_version integer NOT NULL DEFAULT 1,
  source_timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  is_late boolean NOT NULL DEFAULT false,
  late_reason text,
  room_count integer,
  contract_count integer,
  validation_summary jsonb,
  capture_source text NOT NULL DEFAULT 'CRON',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT finance_month_snapshot_runs_org_month_uq
    UNIQUE (organization_id, snapshot_month),
  CONSTRAINT finance_month_snapshot_runs_month_start_check
    CHECK (snapshot_month = date_trunc('month', snapshot_month)::date),
  CONSTRAINT finance_month_snapshot_runs_status_check
    CHECK (status IN ('PROVISIONAL', 'FINALIZED', 'MISSED')),
  CONSTRAINT finance_month_snapshot_runs_source_check
    CHECK (capture_source IN ('ROLLOUT', 'CRON', 'MONITOR')),
  CONSTRAINT finance_month_snapshot_runs_timezone_check
    CHECK (source_timezone = 'Asia/Ho_Chi_Minh'),
  CONSTRAINT finance_month_snapshot_runs_counts_check CHECK (
    (room_count IS NULL OR room_count >= 0)
    AND (contract_count IS NULL OR contract_count >= 0)
  ),
  CONSTRAINT finance_month_snapshot_runs_state_check CHECK (
    (status IN ('PROVISIONAL', 'FINALIZED')
      AND as_of_date IS NOT NULL
      AND as_of_timestamp IS NOT NULL
      AND captured_at IS NOT NULL
      AND room_count IS NOT NULL
      AND contract_count IS NOT NULL
      AND validation_summary IS NOT NULL)
    OR
    (status = 'MISSED'
      AND finalized_at IS NULL
      AND room_count IS NULL
      AND contract_count IS NULL)
  )
);

CREATE TABLE public.finance_room_month_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_run_id uuid NOT NULL
    REFERENCES public.finance_month_snapshot_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  snapshot_month date NOT NULL,
  building_id uuid NOT NULL,
  building_name text NOT NULL,
  room_id uuid NOT NULL,
  room_name text NOT NULL,
  room_status text NOT NULL,
  listed_rent numeric(15,2),
  occupancy_group text NOT NULL,
  active_contract_count integer NOT NULL,
  as_of_timestamp timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  CONSTRAINT finance_room_month_snapshots_run_room_uq
    UNIQUE (snapshot_run_id, room_id),
  CONSTRAINT finance_room_month_snapshots_month_start_check
    CHECK (snapshot_month = date_trunc('month', snapshot_month)::date),
  CONSTRAINT finance_room_month_snapshots_group_check
    CHECK (occupancy_group IN ('OCCUPIED', 'RESERVED', 'MAINTENANCE', 'AVAILABLE', 'UNAVAILABLE')),
  CONSTRAINT finance_room_month_snapshots_contract_count_check
    CHECK (active_contract_count >= 0),
  CONSTRAINT finance_room_month_snapshots_rent_check
    CHECK (listed_rent IS NULL OR listed_rent <> 'NaN'::numeric)
);

CREATE TABLE public.finance_contract_month_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_run_id uuid NOT NULL
    REFERENCES public.finance_month_snapshot_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  snapshot_month date NOT NULL,
  building_id uuid NOT NULL,
  building_name text NOT NULL,
  room_id uuid NOT NULL,
  room_name text NOT NULL,
  contract_id uuid NOT NULL,
  contract_number text,
  contract_status text NOT NULL,
  rent_price numeric(15,2) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  actual_end_date date,
  effective_end_date date NOT NULL,
  as_of_timestamp timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  CONSTRAINT finance_contract_month_snapshots_run_contract_uq
    UNIQUE (snapshot_run_id, contract_id),
  CONSTRAINT finance_contract_month_snapshots_month_start_check
    CHECK (snapshot_month = date_trunc('month', snapshot_month)::date),
  CONSTRAINT finance_contract_month_snapshots_rent_check
    CHECK (rent_price <> 'NaN'::numeric)
);

CREATE INDEX finance_month_snapshot_runs_status_idx
  ON public.finance_month_snapshot_runs(organization_id, status, snapshot_month DESC);
CREATE INDEX finance_room_month_snapshots_scope_idx
  ON public.finance_room_month_snapshots(organization_id, snapshot_month, building_id);
CREATE INDEX finance_room_month_snapshots_run_idx
  ON public.finance_room_month_snapshots(snapshot_run_id);
CREATE INDEX finance_contract_month_snapshots_scope_idx
  ON public.finance_contract_month_snapshots(organization_id, snapshot_month, building_id);
CREATE INDEX finance_contract_month_snapshots_run_idx
  ON public.finance_contract_month_snapshots(snapshot_run_id);

ALTER TABLE public.finance_month_snapshot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_room_month_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_contract_month_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.finance_month_snapshot_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finance_room_month_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finance_contract_month_snapshots FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.guard_finance_month_snapshot_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $snapshot_immutability$
DECLARE
  v_status text;
  v_old_run_id uuid;
  v_new_run_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'finance_month_snapshot_runs' THEN
    IF TG_OP IN ('UPDATE', 'DELETE')
       AND OLD.status IN ('FINALIZED', 'MISSED') THEN
      RAISE EXCEPTION 'Finalized or missed finance snapshot is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE'
       AND (
         NEW.id IS DISTINCT FROM OLD.id
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.snapshot_month IS DISTINCT FROM OLD.snapshot_month
       ) THEN
      RAISE EXCEPTION 'Finance snapshot identity is immutable'
        USING ERRCODE = '55000';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_old_run_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.snapshot_run_id END;
  v_new_run_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.snapshot_run_id END;

  IF v_old_run_id IS NOT NULL THEN
    SELECT run.status
      INTO v_status
    FROM public.finance_month_snapshot_runs run
    WHERE run.id = v_old_run_id;
    IF v_status IN ('FINALIZED', 'MISSED') THEN
      RAISE EXCEPTION 'Finalized or missed finance snapshot detail is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF v_new_run_id IS NOT NULL THEN
    SELECT run.status
      INTO v_status
    FROM public.finance_month_snapshot_runs run
    WHERE run.id = v_new_run_id;
    IF v_status IS DISTINCT FROM 'PROVISIONAL' THEN
      RAISE EXCEPTION 'Finance snapshot detail requires a provisional run'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$snapshot_immutability$;

REVOKE ALL ON FUNCTION app_private.guard_finance_month_snapshot_immutability_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER finance_month_snapshot_runs_immutable_guard
BEFORE UPDATE OR DELETE ON public.finance_month_snapshot_runs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_month_snapshot_immutability_v1();

CREATE TRIGGER finance_room_month_snapshots_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.finance_room_month_snapshots
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_month_snapshot_immutability_v1();

CREATE TRIGGER finance_contract_month_snapshots_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.finance_contract_month_snapshots
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_month_snapshot_immutability_v1();

CREATE OR REPLACE FUNCTION app_private.capture_finance_month_snapshot_v1(
  p_organization_id uuid,
  p_as_of_timestamp timestamptz,
  p_finalize boolean DEFAULT false
)
RETURNS TABLE(
  snapshot_run_id uuid,
  snapshot_status text,
  captured_room_count integer,
  captured_contract_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $capture_finance_month_snapshot$
DECLARE
  v_local_timestamp timestamp;
  v_local_date date;
  v_month date;
  v_month_end date;
  v_scheduled_for timestamptz;
  v_run_id uuid;
  v_existing_status text;
  v_room_count integer;
  v_contract_count integer;
  v_partition_count integer;
  v_final_status text;
  v_is_late boolean;
BEGIN
  IF p_organization_id IS NULL OR p_as_of_timestamp IS NULL THEN
    RAISE EXCEPTION 'Organization and capture timestamp are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.organizations organization_row
  WHERE organization_row.id = p_organization_id
    AND organization_row.status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active organization not found'
      USING ERRCODE = '22023';
  END IF;

  v_local_timestamp := p_as_of_timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_local_date := v_local_timestamp::date;
  v_month := date_trunc('month', v_local_date)::date;
  v_month_end := (v_month + interval '1 month - 1 day')::date;
  v_scheduled_for := make_timestamptz(
    extract(year FROM v_local_date)::integer,
    extract(month FROM v_local_date)::integer,
    extract(day FROM v_local_date)::integer,
    23,
    55,
    0,
    'Asia/Ho_Chi_Minh'
  );

  IF COALESCE(p_finalize, false)
     AND (
       v_local_date <> v_month_end
       OR v_local_timestamp::time < time '23:50:00'
     ) THEN
    RAISE EXCEPTION 'Finance snapshot can finalize only in the month-end cutoff window'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || ':' || v_month::text, 0)
  );

  SELECT run.id, run.status
    INTO v_run_id, v_existing_status
  FROM public.finance_month_snapshot_runs run
  WHERE run.organization_id = p_organization_id
    AND run.snapshot_month = v_month
  FOR UPDATE;

  IF v_existing_status IN ('FINALIZED', 'MISSED') THEN
    RETURN QUERY
    SELECT run.id, run.status, run.room_count, run.contract_count
    FROM public.finance_month_snapshot_runs run
    WHERE run.id = v_run_id;
    RETURN;
  END IF;

  IF v_run_id IS NULL THEN
    INSERT INTO public.finance_month_snapshot_runs (
      organization_id,
      snapshot_month,
      as_of_date,
      as_of_timestamp,
      scheduled_for,
      captured_at,
      status,
      capture_version,
      room_count,
      contract_count,
      validation_summary,
      capture_source
    ) VALUES (
      p_organization_id,
      v_month,
      v_local_date,
      p_as_of_timestamp,
      v_scheduled_for,
      clock_timestamp(),
      'PROVISIONAL',
      0,
      0,
      0,
      '{}'::jsonb,
      'CRON'
    )
    RETURNING id INTO v_run_id;
  END IF;

  DELETE FROM public.finance_contract_month_snapshots detail
  WHERE detail.snapshot_run_id = v_run_id;
  DELETE FROM public.finance_room_month_snapshots detail
  WHERE detail.snapshot_run_id = v_run_id;

  INSERT INTO public.finance_room_month_snapshots (
    snapshot_run_id,
    organization_id,
    snapshot_month,
    building_id,
    building_name,
    room_id,
    room_name,
    room_status,
    listed_rent,
    occupancy_group,
    active_contract_count,
    as_of_timestamp,
    captured_at
  )
  SELECT
    v_run_id,
    p_organization_id,
    v_month,
    building_row.id,
    COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building'),
    room_row.id,
    COALESCE(NULLIF(btrim(room_row.name), ''), 'Unnamed room'),
    room_row.status::text,
    room_row.rent_price,
    CASE
      WHEN contract_count.active_count > 0 THEN 'OCCUPIED'
      WHEN room_row.status::text = 'RESERVED' THEN 'RESERVED'
      WHEN room_row.status::text = 'MAINTENANCE' THEN 'MAINTENANCE'
      WHEN room_row.status::text = 'AVAILABLE' THEN 'AVAILABLE'
      ELSE 'UNAVAILABLE'
    END,
    contract_count.active_count,
    p_as_of_timestamp,
    clock_timestamp()
  FROM public.buildings building_row
  JOIN public.rooms room_row
    ON room_row.building_id = building_row.id
   AND room_row.deleted_at IS NULL
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS active_count
    FROM public.contracts contract_row
    WHERE contract_row.room_id = room_row.id
      AND contract_row.organization_id = p_organization_id
      AND contract_row.deleted_at IS NULL
      AND contract_row.status::text = 'ACTIVE'
      AND contract_row.start_date <= v_local_date
      AND (
        contract_row.actual_end_date IS NULL
        OR contract_row.actual_end_date >= v_local_date
      )
  ) contract_count
  WHERE building_row.organization_id = p_organization_id
    AND building_row.deleted_at IS NULL
    AND building_row.is_virtual = false;

  INSERT INTO public.finance_contract_month_snapshots (
    snapshot_run_id,
    organization_id,
    snapshot_month,
    building_id,
    building_name,
    room_id,
    room_name,
    contract_id,
    contract_number,
    contract_status,
    rent_price,
    start_date,
    end_date,
    actual_end_date,
    effective_end_date,
    as_of_timestamp,
    captured_at
  )
  SELECT
    v_run_id,
    p_organization_id,
    v_month,
    building_row.id,
    COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building'),
    room_row.id,
    COALESCE(NULLIF(btrim(room_row.name), ''), 'Unnamed room'),
    contract_row.id,
    contract_row.contract_number,
    contract_row.status::text,
    contract_row.rent_price,
    contract_row.start_date,
    contract_row.end_date,
    contract_row.actual_end_date,
    GREATEST(
      contract_row.end_date,
      COALESCE(extension_row.extended_end_date, contract_row.end_date)
    )::date,
    p_as_of_timestamp,
    clock_timestamp()
  FROM public.contracts contract_row
  JOIN public.rooms room_row
    ON room_row.id = contract_row.room_id
   AND room_row.deleted_at IS NULL
  JOIN public.buildings building_row
    ON building_row.id = room_row.building_id
   AND building_row.organization_id = p_organization_id
   AND building_row.deleted_at IS NULL
   AND building_row.is_virtual = false
  LEFT JOIN LATERAL (
    SELECT max(extension_row.new_end_date::date) AS extended_end_date
    FROM public.contract_extensions extension_row
    WHERE extension_row.contract_id = contract_row.id
      AND extension_row.status IN ('APPROVED', 'COMPLETED')
  ) extension_row ON true
  WHERE contract_row.organization_id = p_organization_id
    AND contract_row.deleted_at IS NULL
    AND contract_row.status::text = 'ACTIVE'
    AND contract_row.start_date <= v_local_date
    AND (
      contract_row.actual_end_date IS NULL
      OR contract_row.actual_end_date >= v_local_date
    );

  SELECT count(*)::integer
    INTO v_room_count
  FROM public.finance_room_month_snapshots detail
  WHERE detail.snapshot_run_id = v_run_id;

  SELECT count(*)::integer
    INTO v_contract_count
  FROM public.finance_contract_month_snapshots detail
  WHERE detail.snapshot_run_id = v_run_id;

  SELECT count(*)::integer
    INTO v_partition_count
  FROM public.finance_room_month_snapshots detail
  WHERE detail.snapshot_run_id = v_run_id
    AND detail.occupancy_group IN (
      'OCCUPIED', 'RESERVED', 'MAINTENANCE', 'AVAILABLE', 'UNAVAILABLE'
    );

  IF v_partition_count IS DISTINCT FROM v_room_count
     OR EXISTS (
       SELECT 1
       FROM public.finance_room_month_snapshots detail
       WHERE detail.snapshot_run_id = v_run_id
         AND (
           detail.organization_id <> p_organization_id
           OR detail.snapshot_month <> v_month
         )
     )
     OR EXISTS (
       SELECT 1
       FROM public.finance_contract_month_snapshots detail
       WHERE detail.snapshot_run_id = v_run_id
         AND (
           detail.organization_id <> p_organization_id
           OR detail.snapshot_month <> v_month
         )
     ) THEN
    RAISE EXCEPTION 'snapshot partition validation failed'
      USING ERRCODE = '55000';
  END IF;

  v_final_status := CASE WHEN COALESCE(p_finalize, false)
    THEN 'FINALIZED' ELSE 'PROVISIONAL' END;
  v_is_late := p_as_of_timestamp > v_scheduled_for + interval '5 minutes';

  UPDATE public.finance_month_snapshot_runs run
  SET
    as_of_date = v_local_date,
    as_of_timestamp = p_as_of_timestamp,
    scheduled_for = v_scheduled_for,
    captured_at = clock_timestamp(),
    finalized_at = CASE WHEN v_final_status = 'FINALIZED'
      THEN clock_timestamp() ELSE NULL END,
    status = v_final_status,
    capture_version = run.capture_version + 1,
    is_late = v_is_late,
    late_reason = CASE WHEN v_is_late THEN 'Captured after daily cutoff' ELSE NULL END,
    room_count = v_room_count,
    contract_count = v_contract_count,
    validation_summary = jsonb_build_object(
      'partition_valid', true,
      'room_count', v_room_count,
      'contract_count', v_contract_count,
      'groups', (
        SELECT COALESCE(jsonb_object_agg(group_count.occupancy_group, group_count.row_count), '{}'::jsonb)
        FROM (
          SELECT detail.occupancy_group, count(*)::integer AS row_count
          FROM public.finance_room_month_snapshots detail
          WHERE detail.snapshot_run_id = v_run_id
          GROUP BY detail.occupancy_group
        ) group_count
      )
    ),
    updated_at = clock_timestamp()
  WHERE run.id = v_run_id;

  RETURN QUERY
  SELECT run.id, run.status, run.room_count, run.contract_count
  FROM public.finance_month_snapshot_runs run
  WHERE run.id = v_run_id;
END;
$capture_finance_month_snapshot$;

REVOKE ALL ON FUNCTION app_private.capture_finance_month_snapshot_v1(uuid, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.business_performance_inventory_history_v1(
  p_organization_id uuid,
  p_start_month date,
  p_end_month date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  snapshot_month date,
  building_id uuid,
  building_name text,
  snapshot_status text,
  snapshot_missing boolean,
  availability_reason text,
  total integer,
  occupied integer,
  reserved integer,
  maintenance integer,
  unavailable integer,
  available integer,
  occupancy_pct numeric,
  committed_pct numeric,
  listed_rent_opportunity numeric,
  capacity_current numeric,
  capacity_blocked numeric,
  capacity_theory numeric,
  invalid_rent_room_count integer,
  as_of_date date,
  as_of_timestamp timestamptz,
  captured_at timestamptz,
  is_late boolean,
  capture_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_inventory_history$
DECLARE
  v_building_ids uuid[];
  v_current_month date;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_start_month IS NULL
     OR p_end_month IS NULL
     OR p_start_month <> date_trunc('month', p_start_month)::date
     OR p_end_month <> date_trunc('month', p_end_month)::date
     OR p_end_month < p_start_month
     OR p_end_month > (p_start_month + interval '23 months')::date THEN
    RAISE EXCEPTION 'Invalid finance snapshot month range'
      USING ERRCODE = '22023';
  END IF;

  v_current_month := date_trunc(
    'month',
    clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh'
  )::date;

  RETURN QUERY
  WITH months AS MATERIALIZED (
    SELECT generate_series(p_start_month, p_end_month, interval '1 month')::date AS month
  ),
  requested_buildings AS MATERIALIZED (
    SELECT building_row.id, COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building') AS name
    FROM public.buildings building_row
    WHERE building_row.organization_id = p_organization_id
      AND building_row.deleted_at IS NULL
      AND building_row.is_virtual = false
      AND building_row.id = ANY(v_building_ids)
  ),
  matrix AS MATERIALIZED (
    SELECT
      month_row.month,
      building_row.id AS building_id,
      building_row.name AS building_name,
      run.id AS run_id,
      run.status,
      run.as_of_date,
      run.as_of_timestamp,
      run.captured_at,
      run.is_late,
      run.capture_version,
      CASE
        WHEN run.id IS NULL THEN true
        WHEN run.status = 'MISSED' THEN true
        WHEN run.status = 'FINALIZED' THEN false
        WHEN run.status = 'PROVISIONAL' AND month_row.month = v_current_month THEN false
        ELSE true
      END AS snapshot_missing,
      CASE
        WHEN run.id IS NULL THEN 'NO_SNAPSHOT'
        WHEN run.status = 'MISSED' THEN 'MISSED_CUTOFF'
        WHEN run.status = 'PROVISIONAL' AND month_row.month <> v_current_month
          THEN 'NOT_FINALIZED'
        ELSE NULL
      END AS availability_reason
    FROM months month_row
    CROSS JOIN requested_buildings building_row
    LEFT JOIN public.finance_month_snapshot_runs run
      ON run.organization_id = p_organization_id
     AND run.snapshot_month = month_row.month
  ),
  aggregates AS MATERIALIZED (
    SELECT
      matrix.month,
      matrix.building_id,
      count(detail.id)::integer AS total,
      count(detail.id) FILTER (WHERE detail.occupancy_group = 'OCCUPIED')::integer AS occupied,
      count(detail.id) FILTER (WHERE detail.occupancy_group = 'RESERVED')::integer AS reserved,
      count(detail.id) FILTER (WHERE detail.occupancy_group = 'MAINTENANCE')::integer AS maintenance,
      count(detail.id) FILTER (WHERE detail.occupancy_group = 'UNAVAILABLE')::integer AS unavailable,
      count(detail.id) FILTER (WHERE detail.occupancy_group = 'AVAILABLE')::integer AS available,
      COALESCE(sum(GREATEST(detail.listed_rent, 0))
        FILTER (WHERE detail.occupancy_group = 'AVAILABLE'), 0)::numeric AS listed_rent_opportunity,
      COALESCE(sum(GREATEST(detail.listed_rent, 0))
        FILTER (WHERE detail.occupancy_group IN ('OCCUPIED', 'RESERVED', 'AVAILABLE')), 0)::numeric
        AS capacity_current,
      COALESCE(sum(GREATEST(detail.listed_rent, 0))
        FILTER (WHERE detail.occupancy_group IN ('MAINTENANCE', 'UNAVAILABLE')), 0)::numeric
        AS capacity_blocked,
      count(detail.id) FILTER (
        WHERE detail.listed_rent IS NULL OR detail.listed_rent <= 0
      )::integer AS invalid_rent_room_count
    FROM matrix
    LEFT JOIN public.finance_room_month_snapshots detail
      ON detail.snapshot_run_id = matrix.run_id
     AND detail.building_id = matrix.building_id
     AND NOT matrix.snapshot_missing
    GROUP BY matrix.month, matrix.building_id
  )
  SELECT
    matrix.month,
    matrix.building_id,
    matrix.building_name,
    COALESCE(matrix.status, 'MISSING') AS snapshot_status,
    matrix.snapshot_missing,
    matrix.availability_reason,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.total END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.occupied END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.reserved END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.maintenance END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.unavailable END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.available END,
    CASE
      WHEN matrix.snapshot_missing OR aggregate_row.total = 0 THEN NULL
      ELSE round(aggregate_row.occupied * 100.0 / aggregate_row.total, 1)
    END::numeric AS occupancy_pct,
    CASE
      WHEN matrix.snapshot_missing OR aggregate_row.total = 0 THEN NULL
      ELSE round((aggregate_row.occupied + aggregate_row.reserved) * 100.0 / aggregate_row.total, 1)
    END::numeric AS committed_pct,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.listed_rent_opportunity END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.capacity_current END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.capacity_blocked END,
    CASE WHEN matrix.snapshot_missing THEN NULL
      ELSE aggregate_row.capacity_current + aggregate_row.capacity_blocked END,
    CASE WHEN matrix.snapshot_missing THEN NULL ELSE aggregate_row.invalid_rent_room_count END,
    matrix.as_of_date,
    matrix.as_of_timestamp,
    matrix.captured_at,
    matrix.is_late,
    matrix.capture_version
  FROM matrix
  JOIN aggregates aggregate_row
    ON aggregate_row.month = matrix.month
   AND aggregate_row.building_id = matrix.building_id
  ORDER BY matrix.month, lower(matrix.building_name) COLLATE "C", matrix.building_id;
END;
$business_performance_inventory_history$;

REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.run_finance_month_snapshot_job_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $run_finance_month_snapshot_job$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_local_timestamp timestamp := v_now AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_local_date date := v_local_timestamp::date;
  v_current_month date := date_trunc('month', v_local_date)::date;
  v_previous_month date := (date_trunc('month', v_local_date) - interval '1 month')::date;
  v_previous_month_end date := (v_current_month - interval '1 day')::date;
  v_finalize boolean;
  v_organization record;
  v_run_id uuid;
  v_status text;
BEGIN
  v_finalize := v_local_date = (v_current_month + interval '1 month - 1 day')::date
    AND v_local_timestamp::time >= time '23:50:00';

  FOR v_organization IN
    SELECT organization_row.id
    FROM public.organizations organization_row
    WHERE organization_row.status = 'ACTIVE'
    ORDER BY organization_row.id
  LOOP
    BEGIN
      IF v_local_date <= (v_current_month + interval '2 days')::date THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(v_organization.id::text || ':' || v_previous_month::text, 0)
        );

        SELECT run.id, run.status
          INTO v_run_id, v_status
        FROM public.finance_month_snapshot_runs run
        WHERE run.organization_id = v_organization.id
          AND run.snapshot_month = v_previous_month
        FOR UPDATE;

        IF v_run_id IS NULL THEN
          INSERT INTO public.finance_month_snapshot_runs (
            organization_id,
            snapshot_month,
            scheduled_for,
            status,
            capture_version,
            capture_source,
            late_reason
          ) VALUES (
            v_organization.id,
            v_previous_month,
            make_timestamptz(
              extract(year FROM v_previous_month_end)::integer,
              extract(month FROM v_previous_month_end)::integer,
              extract(day FROM v_previous_month_end)::integer,
              23,
              55,
              0,
              'Asia/Ho_Chi_Minh'
            ),
            'MISSED',
            1,
            'MONITOR',
            'Month-end cutoff was missed; mutable current data was not backfilled'
          );
        ELSIF v_status = 'PROVISIONAL' THEN
          DELETE FROM public.finance_contract_month_snapshots detail
          WHERE detail.snapshot_run_id = v_run_id;
          DELETE FROM public.finance_room_month_snapshots detail
          WHERE detail.snapshot_run_id = v_run_id;
          UPDATE public.finance_month_snapshot_runs run
          SET
            as_of_date = NULL,
            as_of_timestamp = NULL,
            captured_at = NULL,
            finalized_at = NULL,
            status = 'MISSED',
            room_count = NULL,
            contract_count = NULL,
            validation_summary = NULL,
            capture_source = 'MONITOR',
            late_reason = 'Month-end cutoff was missed; mutable current data was not backfilled',
            updated_at = clock_timestamp()
          WHERE run.id = v_run_id;
        END IF;
      END IF;

      PERFORM 1
      FROM app_private.capture_finance_month_snapshot_v1(
        v_organization.id,
        v_now,
        v_finalize
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Finance snapshot capture failed for organization %: %',
        v_organization.id, SQLERRM;
    END;
  END LOOP;
END;
$run_finance_month_snapshot_job$;

REVOKE ALL ON FUNCTION app_private.run_finance_month_snapshot_job_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DO $unschedule_finance_snapshot$
BEGIN
  PERFORM cron.unschedule('finance_month_snapshot_daily_v1')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'finance_month_snapshot_daily_v1'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$unschedule_finance_snapshot$;

SELECT cron.schedule(
  'finance_month_snapshot_daily_v1',
  '55 16 * * *',
  $cron$SELECT app_private.run_finance_month_snapshot_job_v1();$cron$
);

-- Rollout captures only this real current instant. No historical backfill.
DO $rollout_finance_snapshot$
DECLARE
  v_organization record;
  v_run_id uuid;
BEGIN
  FOR v_organization IN
    SELECT organization_row.id
    FROM public.organizations organization_row
    WHERE organization_row.status = 'ACTIVE'
    ORDER BY organization_row.id
  LOOP
    BEGIN
      SELECT capture.snapshot_run_id
        INTO v_run_id
      FROM app_private.capture_finance_month_snapshot_v1(
        v_organization.id,
        clock_timestamp(),
        false
      ) capture;

      UPDATE public.finance_month_snapshot_runs run
      SET capture_source = 'ROLLOUT', updated_at = clock_timestamp()
      WHERE run.id = v_run_id
        AND run.status = 'PROVISIONAL';
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Initial finance snapshot skipped for organization %: %',
        v_organization.id, SQLERRM;
    END;
  END LOOP;
END;
$rollout_finance_snapshot$;

COMMENT ON TABLE public.finance_month_snapshot_runs IS
  'Authoritative per-organization month snapshot manifest. FINALIZED and MISSED runs are immutable.';
COMMENT ON TABLE public.finance_room_month_snapshots IS
  'Physical room replace-set captured under one finance month snapshot run.';
COMMENT ON TABLE public.finance_contract_month_snapshots IS
  'Active contract replace-set captured under one finance month snapshot run.';
COMMENT ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) IS
  'Org-bound physical inventory history. Missing/MISSED months carry state and NULL metrics instead of fake zeroes.';

COMMIT;
