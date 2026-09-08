BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_asset_maintenance_directory_v1(
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
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.assets.maintenance.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('assets.view', p_organization_id);
  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('assets.view', p_organization_id) scope;
  IF NOT COALESCE(v_org_wide, false) AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma', 'BT-' || upper(substring(replace(s.id::text, '-', '') FROM 1 FOR 8)),
      'tai_san', s.asset_name,
      'ngay', s.maintenance_date,
      'trang_thai', s.status
    )
    ORDER BY s.maintenance_date DESC, s.id DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT m.id, m.maintenance_date, m.status, a.name AS asset_name
    FROM public.asset_maintenance m
    JOIN public.assets a ON a.id = m.asset_id
      AND a.organization_id = p_organization_id
      AND a.deleted_at IS NULL
    LEFT JOIN public.buildings b ON b.id = a.building_id
      AND b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.id = ANY(v_buildings)
    WHERE m.organization_id = p_organization_id
      AND (b.id IS NOT NULL OR (a.building_id IS NULL AND v_org_wide))
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(a.name) LIKE v_needle ESCAPE '\\'
        OR app_private.copilot_fold_text_v1(coalesce(a.code, '')) LIKE v_needle ESCAPE '\\'
      )
    ORDER BY m.maintenance_date DESC, m.id DESC
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'bao_tri', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_asset_maintenance_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_asset_maintenance_directory_v1(uuid, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.assets.maintenance.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền bảo trì tài sản trong công ty và rollout DEMO',
  'migration:20260908144903_copilot_asset_maintenance_directory_v1',
  'migration:20260908144903_copilot_asset_maintenance_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_asset_maintenance_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_asset_maintenance_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_asset_maintenance_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
