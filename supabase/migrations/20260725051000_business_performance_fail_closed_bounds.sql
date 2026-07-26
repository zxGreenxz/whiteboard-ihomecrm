BEGIN;

DROP FUNCTION IF EXISTS app_private.business_performance_authorized_buildings_v1(uuid);

CREATE OR REPLACE FUNCTION app_private.business_performance_analysis_decision_v1(
  p_actor uuid,
  p_organization_id uuid,
  p_building_id uuid
)
RETURNS TABLE(allowed boolean, authorization_version bigint, analysis_provenance jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_analysis_decision$
DECLARE
  v_primary_allowed boolean;
  v_primary_version bigint;
  v_primary_reason text;
  v_fallback_allowed boolean;
  v_fallback_version bigint;
  v_fallback_reason text;
  v_legacy_detail_deny boolean := false;
  v_legacy_detail_allow boolean := false;
  v_legacy_view_deny boolean := false;
  v_legacy_view_allow boolean := false;
BEGIN
  IF p_actor IS NULL OR p_organization_id IS NULL OR p_building_id IS NULL THEN
    RETURN QUERY
    SELECT false, NULL::bigint, jsonb_build_object(
      'permission_key', 'reports_finance.analysis',
      'decision_reason', 'INVALID_DECISION_INPUT',
      'fallback_used', false
    );
    RETURN;
  END IF;

  SELECT decision.allowed, decision.authorization_version, decision.decision_reason
    INTO v_primary_allowed, v_primary_version, v_primary_reason
  FROM app_private.authorize_tenant_action_v3(
    p_actor => p_actor,
    p_organization_id => p_organization_id,
    p_permission_key => 'reports_finance.analysis',
    p_building_id => p_building_id,
    p_cashbook_id => NULL
  ) AS decision;

  -- Only DEFAULT_DENY represents a rollout gap. Missing or inactive definitions
  -- and every other canonical denial remain authoritative hard denials.
  IF NOT COALESCE(v_primary_allowed, false)
     AND v_primary_reason IS DISTINCT FROM 'DEFAULT_DENY' THEN
    RETURN QUERY
    SELECT false, v_primary_version, jsonb_build_object(
      'permission_key', 'reports_finance.analysis',
      'decision_reason', 'CANONICAL_DETAIL_DENY',
      'canonical_decision_reason', COALESCE(v_primary_reason, 'NO_RESULT'),
      'fallback_used', false
    );
    RETURN;
  END IF;

  WITH applicable_detail_assignments AS (
    SELECT COALESCE(sa.permissions, r.permissions) AS permissions
    FROM public.staff_assignments sa
    LEFT JOIN public.roles r
      ON r.id = sa.role_id
     AND r.organization_id = p_organization_id
    WHERE sa.staff_id = p_actor
      AND sa.organization_id = p_organization_id
      AND (
        sa.building_id = p_building_id
        OR (
          sa.area_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.area_buildings ab
            WHERE ab.organization_id = p_organization_id
              AND ab.area_id = sa.area_id
              AND ab.building_id = p_building_id
          )
        )
        OR (sa.building_id IS NULL AND sa.area_id IS NULL)
      )
  )
  SELECT
    COALESCE(bool_or(
      (permissions -> 'reports_finance') ? 'analysis'
      AND permissions -> 'reports_finance' -> 'analysis' IS DISTINCT FROM 'true'::jsonb
    ), false),
    COALESCE(bool_or(
      (permissions -> 'reports_finance') ? 'analysis'
      AND permissions -> 'reports_finance' -> 'analysis' = 'true'::jsonb
    ), false)
    INTO v_legacy_detail_deny, v_legacy_detail_allow
  FROM applicable_detail_assignments;

  IF v_legacy_detail_deny THEN
    RETURN QUERY
    SELECT false, v_primary_version, jsonb_build_object(
      'permission_key', 'reports_finance.analysis',
      'decision_reason', 'LEGACY_DETAIL_DENY',
      'canonical_decision_reason', v_primary_reason,
      'fallback_used', false
    );
    RETURN;
  END IF;

  IF COALESCE(v_primary_allowed, false) THEN
    RETURN QUERY
    SELECT true, v_primary_version, jsonb_build_object(
      'permission_key', 'reports_finance.analysis',
      'decision_reason', 'CANONICAL_DETAIL_ALLOW',
      'canonical_decision_reason', v_primary_reason,
      'fallback_used', false
    );
    RETURN;
  END IF;

  IF v_legacy_detail_allow THEN
    RETURN QUERY
    SELECT true, v_primary_version, jsonb_build_object(
      'permission_key', 'reports_finance.analysis',
      'decision_reason', 'LEGACY_DETAIL_ALLOW',
      'canonical_decision_reason', v_primary_reason,
      'fallback_used', false
    );
    RETURN;
  END IF;

  SELECT decision.allowed, decision.authorization_version, decision.decision_reason
    INTO v_fallback_allowed, v_fallback_version, v_fallback_reason
  FROM app_private.authorize_tenant_action_v3(
    p_actor => p_actor,
    p_organization_id => p_organization_id,
    p_permission_key => 'reports_finance.view',
    p_building_id => p_building_id,
    p_cashbook_id => NULL
  ) AS decision;

  IF NOT COALESCE(v_fallback_allowed, false)
     AND v_fallback_reason IS DISTINCT FROM 'DEFAULT_DENY' THEN
    RETURN QUERY
    SELECT false, COALESCE(v_fallback_version, v_primary_version), jsonb_build_object(
      'permission_key', 'reports_finance.view',
      'decision_reason', 'CANONICAL_VIEW_DENY',
      'canonical_decision_reason', COALESCE(v_fallback_reason, 'NO_RESULT'),
      'fallback_used', true,
      'primary_decision_reason', v_primary_reason
    );
    RETURN;
  END IF;

  WITH applicable_view_assignments AS (
    SELECT COALESCE(sa.permissions, r.permissions) AS permissions
    FROM public.staff_assignments sa
    LEFT JOIN public.roles r
      ON r.id = sa.role_id
     AND r.organization_id = p_organization_id
    WHERE sa.staff_id = p_actor
      AND sa.organization_id = p_organization_id
      AND (
        sa.building_id = p_building_id
        OR (
          sa.area_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.area_buildings ab
            WHERE ab.organization_id = p_organization_id
              AND ab.area_id = sa.area_id
              AND ab.building_id = p_building_id
          )
        )
        OR (sa.building_id IS NULL AND sa.area_id IS NULL)
      )
  )
  SELECT
    COALESCE(bool_or(
      (permissions -> 'reports_finance') ? 'view'
      AND permissions -> 'reports_finance' -> 'view' IS DISTINCT FROM 'true'::jsonb
    ), false),
    COALESCE(bool_or(
      (permissions -> 'reports_finance') ? 'view'
      AND permissions -> 'reports_finance' -> 'view' = 'true'::jsonb
    ), false)
    INTO v_legacy_view_deny, v_legacy_view_allow
  FROM applicable_view_assignments;

  IF v_legacy_view_deny THEN
    RETURN QUERY
    SELECT false, COALESCE(v_fallback_version, v_primary_version), jsonb_build_object(
      'permission_key', 'reports_finance.view',
      'decision_reason', 'LEGACY_VIEW_DENY',
      'canonical_decision_reason', v_fallback_reason,
      'fallback_used', true,
      'primary_decision_reason', v_primary_reason
    );
    RETURN;
  END IF;

  IF COALESCE(v_fallback_allowed, false) THEN
    RETURN QUERY
    SELECT true, COALESCE(v_fallback_version, v_primary_version), jsonb_build_object(
      'permission_key', 'reports_finance.view',
      'decision_reason', 'CANONICAL_VIEW_ALLOW',
      'canonical_decision_reason', v_fallback_reason,
      'fallback_used', true,
      'primary_decision_reason', v_primary_reason
    );
    RETURN;
  END IF;

  IF v_legacy_view_allow THEN
    RETURN QUERY
    SELECT true, COALESCE(v_fallback_version, v_primary_version), jsonb_build_object(
      'permission_key', 'reports_finance.view',
      'decision_reason', 'LEGACY_VIEW_ALLOW',
      'canonical_decision_reason', v_fallback_reason,
      'fallback_used', true,
      'primary_decision_reason', v_primary_reason
    );
    RETURN;
  END IF;

  RETURN QUERY
  SELECT false, COALESCE(v_fallback_version, v_primary_version), jsonb_build_object(
    'permission_key', 'reports_finance.view',
    'decision_reason', 'NO_DECISION',
    'canonical_decision_reason', v_fallback_reason,
    'fallback_used', true,
    'primary_decision_reason', v_primary_reason
  );
END;
$business_performance_analysis_decision$;

REVOKE ALL ON FUNCTION app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid) FROM service_role;
COMMENT ON FUNCTION app_private.business_performance_analysis_decision_v1(uuid, uuid, uuid) IS
  'Private deny-wins analysis decision. Legacy detail/view fallback is considered only for canonical DEFAULT_DENY; inactive or missing permission definitions hard-deny.';

CREATE OR REPLACE FUNCTION public.business_performance_pnl_v1(
  p_organization_id uuid,
  p_basis text,
  p_start_date date,
  p_end_date date,
  p_building_ids uuid[]
)
RETURNS TABLE(month date, building_id uuid, building_name text, is_virtual boolean, revenue numeric, expense numeric, net numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_pnl$
DECLARE
  v_max_date_span_days CONSTANT integer := 400;
  v_building_ids uuid[];
  v_row record;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_start_date IS NULL
     OR p_end_date IS NULL
     OR p_end_date < p_start_date
     OR (p_end_date - p_start_date) > v_max_date_span_days THEN
    RAISE EXCEPTION 'Invalid business performance date range: expected ordered dates spanning at most 400 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_basis IS NULL OR p_basis NOT IN ('ACCRUAL', 'VOUCHER_DATE') THEN
    RAISE EXCEPTION 'Unsupported business performance basis'
      USING ERRCODE = '22023';
  END IF;

  IF p_basis = 'ACCRUAL' THEN
    FOR v_row IN
      SELECT *
      FROM public.fa_monthly_pnl_accrual(
        p_start_date => p_start_date,
        p_end_date => p_end_date,
        p_building_ids => v_building_ids
      )
    LOOP
      IF v_row.building_id IS NULL
         OR NOT COALESCE(v_row.building_id = ANY(v_building_ids), false) THEN
        RAISE EXCEPTION 'Business performance access denied'
          USING ERRCODE = '42501';
      END IF;

      month := v_row.month;
      building_id := v_row.building_id;
      building_name := v_row.building_name;
      is_virtual := v_row.is_virtual;
      revenue := v_row.revenue;
      expense := v_row.expense;
      net := v_row.net;
      RETURN NEXT;
    END LOOP;
  ELSE
    FOR v_row IN
      SELECT *
      FROM public.fa_monthly_pnl(
        p_start_date => p_start_date,
        p_end_date => p_end_date,
        p_building_ids => v_building_ids
      )
    LOOP
      IF v_row.building_id IS NULL
         OR NOT COALESCE(v_row.building_id = ANY(v_building_ids), false) THEN
        RAISE EXCEPTION 'Business performance access denied'
          USING ERRCODE = '42501';
      END IF;

      month := v_row.month;
      building_id := v_row.building_id;
      building_name := v_row.building_name;
      is_virtual := v_row.is_virtual;
      revenue := v_row.revenue;
      expense := v_row.expense;
      net := v_row.net;
      RETURN NEXT;
    END LOOP;
  END IF;
END;
$business_performance_pnl$;

REVOKE ALL ON FUNCTION public.business_performance_pnl_v1(uuid, text, date, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_pnl_v1(uuid, text, date, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_pnl_v1(uuid, text, date, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_pnl_v1(uuid, text, date, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_pnl_v1(uuid, text, date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.business_performance_pnl_v1(uuid, text, date, date, uuid[]) IS
  'Org-bound Business Performance P&L for authorized physical buildings. Date span is limited to 400 days and includes the current 13-month UI window.';

CREATE OR REPLACE FUNCTION public.business_performance_occupancy_snapshot_v1(
  p_organization_id uuid,
  p_as_of_date date,
  p_building_ids uuid[]
)
RETURNS TABLE(building_id uuid, building_name text, total integer, occupied integer, reserved integer, maintenance integer, unavailable integer, available integer, occupancy_pct numeric, committed_pct numeric, missed_revenue numeric, generated_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_occupancy_snapshot$
DECLARE
  v_building_ids uuid[];
  v_seen_building_ids uuid[] := ARRAY[]::uuid[];
  v_row record;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => false
  ) AS scope;

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'Invalid business performance as-of date: expected a non-null date'
      USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    WITH allowed AS (
      SELECT b.id, b.name
      FROM public.buildings b
      WHERE b.organization_id = p_organization_id
        AND b.deleted_at IS NULL
        AND b.is_virtual = false
        AND b.id = ANY(v_building_ids)
    ),
    classified AS (
      SELECT
        r.building_id AS bid,
        r.rent_price,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.contracts c
            WHERE c.organization_id = p_organization_id
              AND c.room_id = r.id
              AND c.deleted_at IS NULL
              AND c.status = 'ACTIVE'
              AND c.start_date <= p_as_of_date
              AND (c.actual_end_date IS NULL OR c.actual_end_date >= p_as_of_date)
          ) THEN 'occupied'
          WHEN r.status = 'RESERVED' THEN 'reserved'
          WHEN r.status = 'MAINTENANCE' THEN 'maintenance'
          WHEN r.status = 'AVAILABLE' THEN 'available'
          ELSE 'unavailable'
        END AS grp
      FROM allowed a
      JOIN public.rooms r
        ON r.building_id = a.id
       AND r.organization_id = p_organization_id
      WHERE r.deleted_at IS NULL
    ),
    agg AS (
      SELECT
        bid,
        count(*)::integer AS total,
        count(*) FILTER (WHERE grp = 'occupied')::integer AS occupied,
        count(*) FILTER (WHERE grp = 'reserved')::integer AS reserved,
        count(*) FILTER (WHERE grp = 'maintenance')::integer AS maintenance,
        count(*) FILTER (WHERE grp = 'unavailable')::integer AS unavailable,
        count(*) FILTER (WHERE grp = 'available')::integer AS available,
        COALESCE(
          sum(GREATEST(rent_price, 0)) FILTER (WHERE grp = 'available'),
          0
        )::numeric AS missed_revenue
      FROM classified
      GROUP BY bid
    )
    SELECT
      a.id AS building_id,
      a.name AS building_name,
      COALESCE(g.total, 0) AS total,
      COALESCE(g.occupied, 0) AS occupied,
      COALESCE(g.reserved, 0) AS reserved,
      COALESCE(g.maintenance, 0) AS maintenance,
      COALESCE(g.unavailable, 0) AS unavailable,
      COALESCE(g.available, 0) AS available,
      CASE
        WHEN COALESCE(g.total, 0) = 0 THEN 0
        ELSE round(g.occupied * 100.0 / g.total, 1)
      END::numeric AS occupancy_pct,
      CASE
        WHEN COALESCE(g.total, 0) = 0 THEN 0
        ELSE round((g.occupied + g.reserved) * 100.0 / g.total, 1)
      END::numeric AS committed_pct,
      COALESCE(g.missed_revenue, 0) AS missed_revenue,
      now() AS generated_at
    FROM allowed a
    LEFT JOIN agg g ON g.bid = a.id
    ORDER BY a.name
  LOOP
    IF v_row.building_id IS NULL
       OR NOT COALESCE(v_row.building_id = ANY(v_building_ids), false)
       OR COALESCE(v_row.building_id = ANY(v_seen_building_ids), false) THEN
      RAISE EXCEPTION 'Business performance access denied'
        USING ERRCODE = '42501';
    END IF;

    v_seen_building_ids := array_append(v_seen_building_ids, v_row.building_id);
    building_id := v_row.building_id;
    building_name := v_row.building_name;
    total := v_row.total;
    occupied := v_row.occupied;
    reserved := v_row.reserved;
    maintenance := v_row.maintenance;
    unavailable := v_row.unavailable;
    available := v_row.available;
    occupancy_pct := v_row.occupancy_pct;
    committed_pct := v_row.committed_pct;
    missed_revenue := v_row.missed_revenue;
    generated_at := v_row.generated_at;
    RETURN NEXT;
  END LOOP;

  IF cardinality(v_seen_building_ids) <> cardinality(v_building_ids) THEN
    RAISE EXCEPTION 'Business performance access denied'
      USING ERRCODE = '42501';
  END IF;
END;
$business_performance_occupancy_snapshot$;

REVOKE ALL ON FUNCTION public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.business_performance_occupancy_snapshot_v1(uuid, date, uuid[]) IS
  'Org-bound occupancy snapshot for an exact authorized physical building set. Rejects a null as-of date with SQLSTATE 22023.';

CREATE OR REPLACE FUNCTION public.business_performance_upcoming_vacancy_v1(
  p_organization_id uuid,
  p_as_of_date date,
  p_window_days integer,
  p_building_ids uuid[]
)
RETURNS TABLE(contract_id uuid, contract_number text, building_id uuid, building_name text, room_id uuid, room_name text, effective_end_date date, days_remaining integer, rent_price numeric, extension_applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_upcoming_vacancy$
DECLARE
  v_max_window_days CONSTANT integer := 366;
  v_building_ids uuid[];
  v_row record;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => false
  ) AS scope;

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'Invalid business performance as-of date: expected a non-null date'
      USING ERRCODE = '22023';
  END IF;

  IF p_window_days IS NULL
     OR p_window_days < 0
     OR p_window_days > v_max_window_days THEN
    RAISE EXCEPTION 'Invalid business performance vacancy window: expected 0 to 366 days'
      USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    WITH allowed AS (
      SELECT b.id, b.name
      FROM public.buildings b
      WHERE b.organization_id = p_organization_id
        AND b.deleted_at IS NULL
        AND b.is_virtual = false
        AND b.id = ANY(v_building_ids)
    ),
    allowed_rooms AS (
      SELECT
        r.id AS room_id,
        r.name AS room_name,
        r.rent_price,
        a.id AS building_id,
        a.name AS building_name
      FROM allowed a
      JOIN public.rooms r
        ON r.building_id = a.id
       AND r.organization_id = p_organization_id
      WHERE r.deleted_at IS NULL
    ),
    eff AS (
      SELECT
        c.id AS contract_id,
        c.contract_number,
        room.building_id,
        room.building_name,
        room.room_id,
        room.room_name,
        room.rent_price,
        GREATEST(
          c.end_date,
          COALESCE((
            SELECT max(ce.new_end_date::date)
            FROM public.contract_extensions ce
            WHERE ce.organization_id = p_organization_id
              AND ce.contract_id = c.id
              AND ce.status IN ('APPROVED', 'COMPLETED')
          ), c.end_date)
        )::date AS eff_end,
        EXISTS (
          SELECT 1
          FROM public.contract_extensions ce
          WHERE ce.organization_id = p_organization_id
            AND ce.contract_id = c.id
            AND ce.status IN ('APPROVED', 'COMPLETED')
            AND ce.new_end_date::date > c.end_date
        ) AS ext_applied
      FROM allowed_rooms room
      JOIN public.contracts c
        ON c.room_id = room.room_id
       AND c.organization_id = p_organization_id
      WHERE c.deleted_at IS NULL
        AND c.status = 'ACTIVE'
        AND c.start_date <= p_as_of_date
        AND (c.actual_end_date IS NULL OR c.actual_end_date >= p_as_of_date)
    ),
    per_room AS (
      SELECT DISTINCT ON (e.room_id)
        e.contract_id,
        e.contract_number,
        e.building_id,
        e.building_name,
        e.room_id,
        e.room_name,
        e.rent_price,
        e.eff_end,
        e.ext_applied
      FROM eff e
      ORDER BY e.room_id, e.eff_end DESC, e.contract_id
    )
    SELECT
      vacancy.contract_id,
      vacancy.contract_number,
      vacancy.building_id,
      vacancy.building_name,
      vacancy.room_id,
      vacancy.room_name,
      vacancy.eff_end AS effective_end_date,
      (vacancy.eff_end - p_as_of_date)::integer AS days_remaining,
      vacancy.rent_price::numeric AS rent_price,
      vacancy.ext_applied AS extension_applied
    FROM per_room vacancy
    WHERE (vacancy.eff_end - p_as_of_date)
      BETWEEN 0 AND p_window_days
    ORDER BY vacancy.eff_end, vacancy.building_name, vacancy.room_name
  LOOP
    IF v_row.building_id IS NULL
       OR NOT COALESCE(v_row.building_id = ANY(v_building_ids), false) THEN
      RAISE EXCEPTION 'Business performance access denied'
        USING ERRCODE = '42501';
    END IF;

    contract_id := v_row.contract_id;
    contract_number := v_row.contract_number;
    building_id := v_row.building_id;
    building_name := v_row.building_name;
    room_id := v_row.room_id;
    room_name := v_row.room_name;
    effective_end_date := v_row.effective_end_date;
    days_remaining := v_row.days_remaining;
    rent_price := v_row.rent_price;
    extension_applied := v_row.extension_applied;
    RETURN NEXT;
  END LOOP;
END;
$business_performance_upcoming_vacancy$;

REVOKE ALL ON FUNCTION public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.business_performance_upcoming_vacancy_v1(uuid, date, integer, uuid[]) IS
  'Org-bound upcoming-vacancy rows for an exact authorized physical building set. The window must be between 0 and 366 days.';

CREATE OR REPLACE FUNCTION public.business_performance_occupancy_monthly_v1(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date,
  p_building_ids uuid[]
)
RETURNS TABLE(month date, building_id uuid, building_name text, total_rooms integer, occupied_rooms integer, occupancy_pct numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_occupancy_monthly$
DECLARE
  v_max_date_span_days CONSTANT integer := 400;
  v_building_ids uuid[];
  v_row record;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => false
  ) AS scope;

  IF p_start_date IS NULL
     OR p_end_date IS NULL
     OR p_end_date < p_start_date
     OR (p_end_date - p_start_date) > v_max_date_span_days THEN
    RAISE EXCEPTION 'Invalid business performance date range: expected ordered dates spanning at most 400 days'
      USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.fa_occupancy_monthly(
      p_start_date => p_start_date,
      p_end_date => p_end_date,
      p_building_ids => v_building_ids
    )
  LOOP
    IF v_row.building_id IS NULL
       OR NOT COALESCE(v_row.building_id = ANY(v_building_ids), false) THEN
      RAISE EXCEPTION 'Business performance access denied'
        USING ERRCODE = '42501';
    END IF;

    month := v_row.month;
    building_id := v_row.building_id;
    building_name := v_row.building_name;
    total_rooms := v_row.total_rooms;
    occupied_rooms := v_row.occupied_rooms;
    occupancy_pct := v_row.occupancy_pct;
    RETURN NEXT;
  END LOOP;
END;
$business_performance_occupancy_monthly$;

REVOKE ALL ON FUNCTION public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.business_performance_occupancy_monthly_v1(uuid, date, date, uuid[]) IS
  'Org-bound monthly occupancy trend for an exact authorized physical building set. Date span is limited to 400 days.';

COMMIT;

NOTIFY pgrst, 'reload schema';
