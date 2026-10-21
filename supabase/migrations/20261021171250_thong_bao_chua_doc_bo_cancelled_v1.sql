-- Một định nghĩa "chưa đọc" cho mọi nơi đọc thông báo, và CANCELLED (việc đã xong) ẩn khỏi hộp thư — plan
-- 2026-10-21-realtime-thong-bao-toi-uu.md, gói B mục B7 (CRITIC-8).
--
-- VÌ SAO: từ 20261021171249 thông báo nhắc việc lỗi thời được đổi PENDING → CANCELLED thay vì xoá. Trước đó ba nơi
-- đọc định nghĩa "chưa đọc" khác nhau: chuông web status = 'PENDING', Hermes notifications_inbox_v1 status = 'PENDING',
-- Copilot copilot_notification_feed_v1 status IS DISTINCT FROM 'READ' ⇒ dòng CANCELLED sẽ làm Copilot báo số chưa
-- đọc cao hơn chuông và Hermes. Nay:
--   * public.notification_is_unread_v1(status) = (status = 'PENDING'); chuông web (gói C) dùng .eq('status','PENDING')
--     có chú thích trỏ về hàm này.
--   * notifications_inbox_v1 (Hermes, vùng parity w2c-notifications): bỏ dòng CANCELLED khỏi danh sách, total_count
--     và unread_count. Chữ ký, kiểu trả về, INVOKER, search_path rỗng, cổng quyền, trần p_limit giữ nguyên
--     (thân = 20261018080000_hermes_w2z_shared_fixes_v1.sql + chỗ đổi). Web (gói C) loại CANCELLED cùng đợt và
--     cập nhật infra/hermes-broker/web-parity.json.
--   * copilot_notification_feed_v1: chưa đọc = PENDING, bỏ dòng CANCELLED (thân = 20260908105446 + chỗ đổi; cờ
--     rollout copilot.notifications.feed không đụng).
-- Không ghi dữ liệu, không DROP. File riêng (không gộp vào 20261021171249) để hàng rào gói Hermes
-- (infra/hermes-broker/wave2-sql-paths.mjs REVIEWED_SUCCESSORS) ghim đúng một file nhỏ, ít đổi.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.notification_is_unread_v1(p_status public.notification_status)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT coalesce(p_status = 'PENDING'::public.notification_status, false);
$fn$;
REVOKE ALL ON FUNCTION public.notification_is_unread_v1(public.notification_status) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notification_is_unread_v1(public.notification_status) TO authenticated, service_role;
COMMENT ON FUNCTION public.notification_is_unread_v1(public.notification_status) IS
  'Định nghĩa DUY NHẤT của "chưa đọc": status = PENDING. READ = đã đọc; CANCELLED = việc đã xong, ẩn khỏi hộp thư.';

CREATE OR REPLACE FUNCTION public.notifications_inbox_v1(p_organization_id uuid,p_unread_only boolean DEFAULT false,
  p_type text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS TABLE(id uuid,type text,subject text,content text,status text,created_at timestamptz,total_count bigint,unread_count bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('notifications','view')
    THEN RAISE EXCEPTION 'notifications_inbox_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 2000
    THEN RAISE EXCEPTION 'notifications_inbox_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT n.id,n.type::text,n.subject,n.content,n.status::text,n.created_at,count(*) OVER (),
    count(*) FILTER (WHERE public.notification_is_unread_v1(n.status)) OVER ()
  FROM public.notifications n
  WHERE n.user_id=auth.uid() AND n.channel::text='IN_APP'
    AND n.organization_id=p_organization_id
    AND n.status::text IS DISTINCT FROM 'CANCELLED'
    AND (NOT COALESCE(p_unread_only,false) OR public.notification_is_unread_v1(n.status))
    AND (p_type IS NULL OR n.type::text=p_type)
  ORDER BY n.created_at DESC,n.id DESC
  LIMIT p_limit;
END $fn$;
ALTER FUNCTION public.notifications_inbox_v1(uuid,boolean,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notifications_inbox_v1(uuid,boolean,text,integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.notifications_inbox_v1(uuid,boolean,text,integer) TO authenticated;

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

  SELECT count(*) FILTER (WHERE public.notification_is_unread_v1(n.status))::integer
    INTO v_unread
  FROM public.notifications n
  WHERE n.organization_id = p_organization_id
    AND n.user_id = v_actor
    AND n.channel = 'IN_APP'
    AND n.status IS DISTINCT FROM 'CANCELLED';

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
      AND n.status IS DISTINCT FROM 'CANCELLED'
      AND (NOT coalesce(p_unread_only, false) OR public.notification_is_unread_v1(n.status))
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

DO $nghiem_thu$
DECLARE
  v_unread regprocedure := to_regprocedure('public.notification_is_unread_v1(public.notification_status)');
  v_inbox  regprocedure := to_regprocedure('public.notifications_inbox_v1(uuid,boolean,text,integer)');
  v_feed   regprocedure := to_regprocedure('public.copilot_notification_feed_v1(uuid,boolean,integer)');
BEGIN
  IF v_unread IS NULL OR v_inbox IS NULL OR v_feed IS NULL THEN
    RAISE EXCEPTION 'thong_bao_chua_doc_missing' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', v_unread, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_unread, 'EXECUTE')
     OR has_function_privilege('anon', v_inbox, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_inbox, 'EXECUTE')
     OR has_function_privilege('anon', v_feed, 'EXECUTE') OR has_function_privilege('service_role', v_feed, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_feed, 'EXECUTE') THEN
    RAISE EXCEPTION 'thong_bao_chua_doc_acl_invalid' USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_inbox) THEN
    RAISE EXCEPTION 'notifications_inbox_v1 phải SECURITY INVOKER' USING ERRCODE = '55000';
  END IF;
END
$nghiem_thu$;

COMMIT;
NOTIFY pgrst, 'reload schema';
