-- Hermes đọc đầy đủ — ĐỢT 2, Gói Z (tích hợp, 18/10/2026): theo web main #209 cho thông báo. Áp SAU 20261018030600 (Gói C) và
-- TRƯỚC công tắc 20261018090000_hermes_w2_enable_v1. Không DROP, không đổi chữ ký/kiểu trả về, không GRANT/REVOKE.
-- public.notifications_inbox_v1 (thân = 20261018030100, đổi một điều kiện): web (useNotifications.ts inboxScope, #209) khi đã
-- chọn công ty chỉ hiện thông báo của ĐÚNG công ty đó (mọi dòng mang organization_id — trigger autofill_org_strict);
-- Hermes luôn có công ty của kết nối ⇒ bỏ nhánh "dòng chưa gắn công ty không phải LIFECYCLE".
-- Kiểm: infra/hermes-broker/wave2-z-c.test.mjs (khớp web mới; đột biến về thân cũ).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- /notifications (useNotifications.ts; route cần notifications.view): thông báo IN_APP của CHÍNH người gọi thuộc công ty
-- p_organization_id, mới trước, trần p_limit. Chưa đọc = status PENDING.
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
    count(*) FILTER (WHERE n.status::text='PENDING') OVER ()
  FROM public.notifications n
  WHERE n.user_id=auth.uid() AND n.channel::text='IN_APP'
    AND n.organization_id=p_organization_id
    AND (NOT COALESCE(p_unread_only,false) OR n.status::text='PENDING')
    AND (p_type IS NULL OR n.type::text=p_type)
  ORDER BY n.created_at DESC,n.id DESC
  LIMIT p_limit;
END $fn$;

ALTER FUNCTION public.notifications_inbox_v1(uuid,boolean,text,integer) OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
