-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.org_today_v1(p_organization_id uuid) md5(prosrc)=bf0d7a3c20c7ab3bea0f463ca1f5b138
CREATE OR REPLACE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT (pg_catalog.now() AT TIME ZONE
            app_private.org_timezone_v1(
              COALESCE(
                p_organization_id,
                -- Không truyền org: suy ra từ membership ACTIVE của người gọi.
                -- CỐ Ý để membership THẮNG profiles.organization_id — án lệ đã ghi:
                -- 6/10 profile trỏ SAI org. Nhiều org mà không truyền tham số thì
                -- KHÔNG đoán: `min(...) FILTER (count = 1)` trả NULL ⇒ rơi về mặc
                -- định, chứ không chọn bừa một org.
                -- `min(uuid)` KHÔNG tồn tại trong Postgres ⇒ gộp qua text rồi cast lại.
                (SELECT CASE WHEN count(DISTINCT m.organization_id) = 1
                             THEN min(m.organization_id::text)::uuid END
                   FROM public.organization_memberships m
                  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE')
              )
            ))::date;
$function$

