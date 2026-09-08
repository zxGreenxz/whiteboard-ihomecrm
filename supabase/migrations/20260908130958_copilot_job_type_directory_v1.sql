BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_job_type_directory_v1(
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
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.job-types.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(scope.org_wide, false) INTO v_org_wide
    FROM app_private.authorized_scope_v3('task_types.view', p_organization_id) scope;
  IF NOT COALESCE(v_org_wide, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_needle := CASE
    WHEN v_query IS NULL THEN NULL
    ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
  END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma', 'LCV-' || upper(substring(replace(j.id::text, '-', '') FROM 1 FOR 8)),
      'ten', j.name,
      'bo_phan', j.department_name,
      'nhom', j.group_name,
      'han_lien_he_phut', j.customer_contact_deadline,
      'han_tiep_nhan_phut', j.acceptance_deadline,
      'han_hoan_thanh_phut', j.completion_deadline
    )
    ORDER BY j.name, j.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      jt.id,
      jt.name,
      jt.customer_contact_deadline,
      jt.acceptance_deadline,
      jt.completion_deadline,
      d.name AS department_name,
      g.name AS group_name
    FROM public.job_types jt
    LEFT JOIN public.departments d
      ON d.id = jt.default_department_id
      AND d.organization_id = p_organization_id
    LEFT JOIN public.job_groups g
      ON g.id = jt.job_group_id
      AND g.organization_id = p_organization_id
    WHERE jt.organization_id = p_organization_id
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(jt.name) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(d.name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(coalesce(g.name, '')) LIKE v_needle ESCAPE '\'
      )
    ORDER BY jt.name, jt.id
    LIMIT v_limit
  ) j;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'loai_cong_viec', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_job_type_directory_v1(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_job_type_directory_v1(uuid, text, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.job-types.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền, phạm vi tổ chức và rollout DEMO',
  'migration:20260908130958_copilot_job_type_directory_v1',
  'migration:20260908130958_copilot_job_type_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_job_type_directory_v1(uuid,text,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_job_type_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_job_type_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
