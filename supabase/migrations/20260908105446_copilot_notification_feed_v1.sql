-- G1-C: read-only, own-user in-app notification feed under one selected organization.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_notification_feed_v1(
  p_organization_id uuid,
  p_unread_only boolean DEFAULT false,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_allowed boolean := false;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_unread integer := 0;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.notifications.feed', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT scope.org_wide INTO v_allowed
    FROM app_private.authorized_scope_v3('notifications.view', p_organization_id) scope;
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) FILTER (WHERE n.status IS DISTINCT FROM 'READ')::integer
    INTO v_unread
  FROM public.notifications n
  WHERE n.organization_id = p_organization_id
    AND n.user_id = v_actor
    AND n.channel = 'IN_APP';

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'thong_bao_id', s.id,
      'loai', s.type,
      'trang_thai', s.status,
      'thoi_diem', s.created_at
    ) ORDER BY s.created_at DESC, s.id DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT n.id, n.type::text AS type, n.status::text AS status, n.created_at
    FROM public.notifications n
    WHERE n.organization_id = p_organization_id
      AND n.user_id = v_actor
      AND n.channel = 'IN_APP'
      AND (NOT coalesce(p_unread_only, false) OR n.status IS DISTINCT FROM 'READ')
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'tong_chua_doc', v_unread,
    'so_luong', jsonb_array_length(v_rows),
    'thong_bao', v_rows
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_notification_feed_v1(uuid, boolean, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_notification_feed_v1(uuid, boolean, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.notifications.feed',
  'disabled',
  'G1-C: chờ kiểm thử quyền, nội dung redaction và rollout DEMO',
  'migration:20260908105446_copilot_notification_feed_v1',
  'migration:20260908105446_copilot_notification_feed_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_notification_feed_v1(uuid,boolean,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_notification_feed_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_notification_feed_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
