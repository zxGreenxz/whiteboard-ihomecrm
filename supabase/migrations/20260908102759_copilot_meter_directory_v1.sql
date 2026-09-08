-- G1-C: read-only directory of meters under the caller's selected organization and building scope.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_meter_directory_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_meter_type text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_org_wide boolean := false;
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.meters.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('meters.view', p_organization_id);
  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('meters.view', p_organization_id) scope;
  IF NOT v_org_wide AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'cong_to_id', s.id,
      'ma', s.code,
      'ten', s.name,
      'loai', s.meter_type,
      'trang_thai', s.status,
      'chi_so_dau', s.initial_reading,
      'ngay_lap', s.installation_date,
      'toa_nha', s.building_name,
      'phong', s.room_name,
      'chi_so_moi_nhat', CASE WHEN s.reading_date IS NULL THEN NULL ELSE jsonb_build_object(
        'ky', s.settlement_month,
        'chi_so_cuoi', s.current_reading,
        'ngay_ghi', s.reading_date,
        'trang_thai', s.reading_status
      ) END
    ) ORDER BY s.building_name, s.room_name NULLS FIRST, s.code, s.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      m.id,
      m.code,
      m.name,
      m.meter_type::text AS meter_type,
      m.status,
      m.initial_reading,
      m.installation_date,
      b.name AS building_name,
      r.name AS room_name,
      mr.settlement_month,
      mr.current_reading,
      mr.reading_date,
      mr.status AS reading_status
    FROM public.meters m
    JOIN public.buildings b
      ON b.id = m.building_id
      AND b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
    LEFT JOIN public.rooms r
      ON r.id = m.room_id
      AND r.organization_id = p_organization_id
      AND r.building_id = m.building_id
      AND r.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT
        reading.settlement_month,
        reading.current_reading,
        reading.reading_date,
        reading.status
      FROM public.meter_readings reading
      WHERE reading.organization_id = p_organization_id
        AND reading.meter_id = m.id
        AND reading.building_id = m.building_id
        AND reading.building_id = ANY(v_buildings)
        AND reading.deleted_at IS NULL
      ORDER BY reading.settlement_month DESC NULLS LAST, reading.reading_date DESC, reading.id DESC
      LIMIT 1
    ) mr ON true
    WHERE m.organization_id = p_organization_id
      AND m.building_id = ANY(v_buildings)
      AND m.deleted_at IS NULL
      AND (p_meter_type IS NULL OR m.meter_type::text = p_meter_type)
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(m.code) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(m.name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(b.name) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(r.name, '')) LIKE v_needle ESCAPE '\'
      )
    ORDER BY b.name, r.name NULLS FIRST, m.code, m.id
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'cong_to', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_meter_directory_v1(uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_meter_directory_v1(uuid, text, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.meters.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền và rollout DEMO',
  'migration:20260908102759_copilot_meter_directory_v1',
  'migration:20260908102759_copilot_meter_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_meter_directory_v1(uuid,text,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_meter_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_meter_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
