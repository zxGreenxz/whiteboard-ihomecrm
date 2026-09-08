BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_auto_debt_status_v1(
  p_organization_id uuid,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_auto_debt_allowed boolean := false;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.auto-debt.status', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(scope.org_wide, false)
  INTO v_auto_debt_allowed
  FROM app_private.authorized_scope_v3('auto_debt.view', p_organization_id) scope;
  IF NOT COALESCE(v_auto_debt_allowed, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'pham_vi', s.pham_vi,
      'trang_thai', s.is_enabled,
      'da_cau_hinh_tai_khoan', s.has_bank_account,
      'da_cau_hinh_quy_tac', s.has_matching_rules
    )
    ORDER BY s.pham_vi, s.sort_key
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      CASE WHEN c.building_id IS NULL THEN 'TOAN_CONG_TY' ELSE 'THEO_TOA_NHA' END AS pham_vi,
      COALESCE(c.is_enabled, false) AS is_enabled,
      NULLIF(btrim(c.bank_account), '') IS NOT NULL AS has_bank_account,
      c.matching_rules IS NOT NULL
        AND c.matching_rules NOT IN ('null'::jsonb, '{}'::jsonb, '[]'::jsonb) AS has_matching_rules,
      c.created_at AS sort_key
    FROM public.auto_debt_config c
    LEFT JOIN public.buildings b
      ON b.id = c.building_id
      AND b.organization_id = c.organization_id
    WHERE c.organization_id = p_organization_id
      AND (c.building_id IS NULL OR (b.id IS NOT NULL AND b.deleted_at IS NULL))
    ORDER BY pham_vi, sort_key
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'cau_hinh', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_auto_debt_status_v1(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_auto_debt_status_v1(uuid, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.auto-debt.status',
  'disabled',
  'G1-C: chờ kiểm thử quyền cấu hình tài chính, phạm vi công ty và rollout DEMO',
  'migration:20260908153826_copilot_auto_debt_status_v1',
  'migration:20260908153826_copilot_auto_debt_status_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_auto_debt_status_v1(uuid,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_auto_debt_status_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_auto_debt_status_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
