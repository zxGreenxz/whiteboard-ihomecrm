BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_hotline_directory_v1(
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
  v_org_wide boolean := false;
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.hotlines.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('hotline.view', p_organization_id) scope;
  IF NOT COALESCE(v_org_wide, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma', 'HOT-' || upper(substring(replace(s.id::text, '-', '') FROM 1 FOR 8)),
      'ten', s.name,
      'so_dien_thoai', s.phone_number,
      'trang_thai', s.is_active
    )
    ORDER BY s.name, s.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT h.id, h.name, h.phone_number, COALESCE(h.is_active, true) AS is_active
    FROM public.hotlines h
    WHERE h.organization_id = p_organization_id
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(h.name) LIKE v_needle ESCAPE '\\'
        OR app_private.copilot_fold_text_v1(h.phone_number) LIKE v_needle ESCAPE '\\'
      )
    ORDER BY h.name, h.id
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'hotline', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_hotline_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_hotline_directory_v1(uuid, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.hotlines.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền hotline trong công ty và rollout DEMO',
  'migration:20260908135519_copilot_hotline_directory_v1',
  'migration:20260908135519_copilot_hotline_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_hotline_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_hotline_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_hotline_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
