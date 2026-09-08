BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_service_quota_directory_v1(
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
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.service-quotas.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('service_quotas.view', p_organization_id) scope;
  IF NOT COALESCE(v_org_wide, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma', 'DM-' || upper(substring(replace(s.id::text, '-', '') FROM 1 FOR 8)),
      'ten', s.name,
      'bac', s.tiers
    )
    ORDER BY s.name, s.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT q.id, q.name, COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'so_bac', t.tier_number,
        'tu', t.from_value,
        'den', t.to_value,
        'don_gia', t.unit_price
      ) ORDER BY t.tier_number, t.id)
      FROM (
        SELECT t.id, t.tier_number, t.from_value, t.to_value, t.unit_price
        FROM public.service_quota_tiers t
        WHERE t.quota_id = q.id
          AND t.organization_id = p_organization_id
        ORDER BY t.tier_number, t.id
        LIMIT 50
      ) t
    ), '[]'::jsonb) AS tiers
    FROM public.service_quotas q
    WHERE q.organization_id = p_organization_id
      AND q.deleted_at IS NULL
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(q.name) LIKE v_needle ESCAPE '\\'
      )
    ORDER BY q.name, q.id
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'dinh_muc', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_service_quota_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_service_quota_directory_v1(uuid, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.service-quotas.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền định mức dịch vụ trong công ty và rollout DEMO',
  'migration:20260908142038_copilot_service_quota_directory_v1',
  'migration:20260908142038_copilot_service_quota_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_service_quota_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_service_quota_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_service_quota_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
