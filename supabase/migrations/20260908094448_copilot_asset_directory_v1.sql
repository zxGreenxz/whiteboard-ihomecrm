BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_asset_directory_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS jsonb
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
  IF NOT app_private.copilot_page_flag_allows_v1('assets.list', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('assets.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('assets.view', p_organization_id) s;
  IF NOT v_org_wide AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tai_san_id', s.id,
    'ma', s.code,
    'ten', s.name,
    'nhom', s.category_name,
    'tinh_trang', s.condition,
    'so_luong', s.quantity,
    'toa_nha', s.building_name,
    'phong', s.room_name,
    'bao_tri_gan_nhat', s.latest_maintenance
  ) ORDER BY s.rn), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT a.id, a.code, a.name, c.name AS category_name, a.condition::text AS condition,
      a.quantity, b.name AS building_name, r.name AS room_name,
      (SELECT jsonb_build_object('trang_thai', m.status, 'ngay', m.maintenance_date)
         FROM public.asset_maintenance m
        WHERE m.asset_id = a.id AND m.organization_id = p_organization_id
        ORDER BY m.maintenance_date DESC, m.id DESC LIMIT 1) AS latest_maintenance,
      row_number() OVER (ORDER BY b.name NULLS LAST, r.name NULLS LAST, a.name, a.id) AS rn
    FROM public.assets a
    LEFT JOIN public.buildings b ON b.id = a.building_id
      AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
      AND b.id = ANY(v_buildings)
    LEFT JOIN public.rooms r ON r.id = a.room_id AND r.organization_id = p_organization_id
      AND r.deleted_at IS NULL AND r.building_id = a.building_id
    LEFT JOIN public.asset_categories c ON c.id = a.category_id
      AND c.organization_id = p_organization_id
    WHERE a.organization_id = p_organization_id AND a.deleted_at IS NULL
      AND (b.id IS NOT NULL OR (a.building_id IS NULL AND v_org_wide
        AND a.user_id = ANY(public.current_visible_owner_ids())))
      AND (v_needle IS NULL
        OR app_private.copilot_fold_text_v1(coalesce(a.name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(a.code, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(c.name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(r.name, '')) LIKE v_needle ESCAPE '\')
    ORDER BY b.name NULLS LAST, r.name NULLS LAST, a.name, a.id
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object('gioi_han', v_limit, 'so_luong', jsonb_array_length(v_rows), 'tai_san', v_rows);
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_asset_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_asset_directory_v1(uuid, text, integer) TO authenticated;

DO $nghiem_thu$
DECLARE v_fn regprocedure := to_regprocedure('public.copilot_asset_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN RAISE EXCEPTION 'copilot_asset_directory_v1 missing'; END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated execute missing';
  END IF;
END
$nghiem_thu$;

COMMIT;
