-- G1-C: read-only sale availability and active pass-listing directory under selected organization/building scope.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_sale_listing_directory_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_listing_kind text DEFAULT NULL,
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
  v_listing_kind text := NULLIF(upper(btrim(coalesce(p_listing_kind, ''))), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_listing_kind IS NOT NULL AND v_listing_kind NOT IN ('AVAILABLE', 'PASS') THEN
    RAISE EXCEPTION 'invalid_listing_kind' USING ERRCODE = '22023';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.sale-listings.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('sale_phong.view', p_organization_id);
  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('sale_phong.view', p_organization_id) scope;
  IF NOT v_org_wide AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma', s.code,
      'ten', s.name,
      'toa_nha', s.building_name,
      'tang', s.floor,
      'gia_thue', s.rent_price,
      'tien_coc', s.deposit_amount,
      'dien_tich', s.area,
      'loai_phong', s.room_type,
      'trang_thai_sale', s.listing_kind,
      'ngay_trong', s.available_on
    ) ORDER BY s.building_name, s.floor DESC, s.name, s.code NULLS LAST
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      r.code,
      r.name,
      b.name AS building_name,
      r.floor,
      CASE WHEN pl.id IS NULL THEN r.rent_price ELSE COALESCE(pl.pass_price, r.rent_price) END AS rent_price,
      r.deposit_amount,
      r.area,
      r.room_type,
      CASE WHEN pl.id IS NULL THEN 'AVAILABLE' ELSE 'PASS' END AS listing_kind,
      CASE WHEN pl.id IS NULL THEN NULL ELSE pl.avail_date END AS available_on
    FROM public.rooms r
    JOIN public.buildings b
      ON b.id = r.building_id
      AND b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = r.id
      AND pl.building_id = r.building_id
      AND pl.organization_id = p_organization_id
      AND pl.active = true
    WHERE r.organization_id = p_organization_id
      AND r.building_id = ANY(v_buildings)
      AND r.deleted_at IS NULL
      AND (r.status::text = 'AVAILABLE' OR pl.id IS NOT NULL)
      AND (
        v_listing_kind IS NULL
        OR (v_listing_kind = 'AVAILABLE' AND pl.id IS NULL AND r.status::text = 'AVAILABLE')
        OR (v_listing_kind = 'PASS' AND pl.id IS NOT NULL)
      )
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(coalesce(r.code, '')) LIKE v_needle ESCAPE '\\'
        OR app_private.copilot_fold_text_v1(r.name) LIKE v_needle ESCAPE '\\'
        OR app_private.copilot_fold_text_v1(b.name) LIKE v_needle ESCAPE '\\'
      )
    ORDER BY b.name, r.floor DESC, r.name, r.code NULLS LAST
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'phong_sale', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_sale_listing_directory_v1(uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_sale_listing_directory_v1(uuid, text, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.sale-listings.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền, redaction và rollout DEMO',
  'migration:20260908111504_copilot_sale_listing_directory_v1',
  'migration:20260908111504_copilot_sale_listing_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_sale_listing_directory_v1(uuid,text,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_sale_listing_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_sale_listing_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
