BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_service_directory_v1(
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
  IF NOT app_private.copilot_page_flag_allows_v1('services.list', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('services.view', p_organization_id);
  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('services.view', p_organization_id) scope;
  IF NOT v_org_wide AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'dich_vu_id', result.id,
    'ma', result.code,
    'ten', result.name,
    'loai_phi', result.fee_type,
    'cach_tinh_gia', result.pricing_type,
    'don_vi', result.unit,
    'gia_mac_dinh', result.unit_price,
    'bat_buoc', result.is_mandatory,
    'toa_ap_dung', result.applicable_buildings
  ) ORDER BY result.rn), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT s.id, s.code, s.name, s.fee_type::text AS fee_type, s.pricing_type::text AS pricing_type,
      s.unit, s.unit_price, s.is_mandatory,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'toa_nha', linked.name,
          'gia_ap_dung', COALESCE(linked.unit_price_override, s.unit_price)
        ) ORDER BY linked.name, linked.id)
        FROM (
          SELECT b.id, b.name, bs.unit_price_override
          FROM public.building_services bs
          JOIN public.buildings b ON b.id = bs.building_id
            AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
          WHERE bs.service_id = s.id AND bs.organization_id = p_organization_id
            AND bs.is_active AND bs.building_id = ANY(v_buildings)
        ) linked
      ), '[]'::jsonb) AS applicable_buildings,
      row_number() OVER (ORDER BY s.name, s.id) AS rn
    FROM public.services s
    WHERE s.organization_id = p_organization_id AND s.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.building_services bs
          WHERE bs.service_id = s.id AND bs.organization_id = p_organization_id
            AND bs.is_active AND bs.building_id = ANY(v_buildings)
        )
        OR (
          v_org_wide AND s.user_id = ANY(public.current_visible_owner_ids())
          AND NOT EXISTS (
            SELECT 1 FROM public.building_services bs
            WHERE bs.service_id = s.id AND bs.organization_id = p_organization_id AND bs.is_active
          )
        )
      )
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(coalesce(s.name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(s.code, '')) LIKE v_needle ESCAPE '\'
        OR EXISTS (
          SELECT 1 FROM public.building_services bs
          JOIN public.buildings b ON b.id = bs.building_id
            AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
          WHERE bs.service_id = s.id AND bs.organization_id = p_organization_id
            AND bs.is_active AND bs.building_id = ANY(v_buildings)
            AND app_private.copilot_fold_text_v1(coalesce(b.name, '')) LIKE v_needle ESCAPE '\'
        )
      )
    ORDER BY s.name, s.id
    LIMIT v_limit
  ) result;

  RETURN jsonb_build_object('gioi_han', v_limit, 'so_luong', jsonb_array_length(v_rows), 'dich_vu', v_rows);
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_service_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_service_directory_v1(uuid, text, integer) TO authenticated;

DO $nghiem_thu$
DECLARE v_fn regprocedure := to_regprocedure('public.copilot_service_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN RAISE EXCEPTION 'copilot_service_directory_v1 missing'; END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated execute missing';
  END IF;
END
$nghiem_thu$;

COMMIT;
