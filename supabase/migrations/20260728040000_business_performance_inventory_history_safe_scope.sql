-- Keep historical room inventory on the same safe analysis-only boundary as
-- the live occupancy wrappers. Snapshot detail remains hidden behind this
-- aggregate facade; restricted finance permission is not needed for room data.

BEGIN;

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
    p_require_restricted => false
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

COMMENT ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) IS
  'Scoped room inventory history for analysis users; restricted finance data is not returned.';

COMMIT;
