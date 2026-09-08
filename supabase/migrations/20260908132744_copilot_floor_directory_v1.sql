BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_floor_directory_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_categories_allowed boolean := false;
  v_buildings_allowed boolean := false;
  v_buildings uuid[];
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.floors.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    scope.org_wide OR COALESCE(cardinality(scope.building_ids), 0) > 0,
    false
  )
  INTO v_categories_allowed
  FROM app_private.authorized_scope_v3('categories.view', p_organization_id) scope;
  IF NOT COALESCE(v_categories_allowed, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    scope.org_wide OR COALESCE(cardinality(scope.building_ids), 0) > 0,
    false
  )
  INTO v_buildings_allowed
  FROM app_private.authorized_scope_v3('buildings.view', p_organization_id) scope;
  IF NOT COALESCE(v_buildings_allowed, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  v_buildings := public.copilot_org_scope_buildings_v1('buildings.view', p_organization_id);

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma', 'TANG-' || upper(substring(replace(s.id::text, '-', '') FROM 1 FOR 8)),
      'so_tang', s.floor_number,
      'ten', s.name,
      'trang_thai', s.status,
      'toa_nha', s.building_name
    )
    ORDER BY s.building_name, s.floor_number, s.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT f.id, f.floor_number, f.name, f.status, b.name AS building_name
    FROM public.floors f
    JOIN public.buildings b
      ON b.id = f.building_id
      AND b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
    WHERE f.organization_id = p_organization_id
      AND f.building_id = ANY(v_buildings)
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(coalesce(f.name, '')) LIKE v_needle ESCAPE '\\'
        OR app_private.copilot_fold_text_v1(f.floor_number::text) LIKE v_needle ESCAPE '\\'
        OR app_private.copilot_fold_text_v1(b.name) LIKE v_needle ESCAPE '\\'
      )
    ORDER BY b.name, f.floor_number, f.id
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tang', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_floor_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_floor_directory_v1(uuid, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.floors.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền danh mục, phạm vi toà và rollout DEMO',
  'migration:20260908132744_copilot_floor_directory_v1',
  'migration:20260908132744_copilot_floor_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_floor_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_floor_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_floor_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
