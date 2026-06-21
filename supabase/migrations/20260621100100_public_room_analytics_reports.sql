-- =============================================================================
-- Bộ đo đếm trang công khai "Phòng trống" — LỚP ĐỌC (báo cáo, prefix pra_)
-- =============================================================================
-- 6 RPC chỉ-đọc cho chủ/quản lý (tab "Thống kê" trong /sale-phong):
--   pra_summary · pra_timeseries · pra_top_rooms · pra_funnel · pra_by_token · pra_errors
-- Authz: SECURITY DEFINER + scope owner_id = ANY(current_visible_owner_ids())
--        OR is_super_admin() OR is_admin()  (đối xứng employer↔staff như fa_*).
-- Tham số chung: p_start_date, p_end_date (lọc theo NGÀY giờ VN), p_token (1 link),
--   p_building_ids (lọc theo "phiên có chạm toà" — vì event cấp trang không có
--   building_id), p_exclude_staff (loại lượt xem nội bộ qua metadata.is_staff).
-- Bucket ngày/giờ theo Asia/Ho_Chi_Minh. numeric có thể về string qua PostgREST.
-- =============================================================================

BEGIN;

-- Drop trước (cho phép re-apply khi đổi RETURNS TABLE) — idempotent.
DROP FUNCTION IF EXISTS public.pra_summary(date,date,text,uuid[],boolean);
DROP FUNCTION IF EXISTS public.pra_timeseries(date,date,text,uuid[],boolean,text);
DROP FUNCTION IF EXISTS public.pra_top_rooms(date,date,text,uuid[],boolean,int);
DROP FUNCTION IF EXISTS public.pra_funnel(date,date,text,uuid[],boolean);
DROP FUNCTION IF EXISTS public.pra_by_token(date,date,text,uuid[],boolean);
DROP FUNCTION IF EXISTS public.pra_errors(date,date,text,uuid[],boolean,int);

-- ── 1. pra_summary: KPI tổng hợp ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pra_summary(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false
)
RETURNS TABLE (
  total_sessions   bigint,
  total_views      bigint,   -- = total_sessions (số lượt mở trang)
  room_opens       bigint,
  impressions      bigint,
  contact_clicks   bigint,
  favorites        bigint,
  deposit_dialogs  bigint,
  errors           bigint,
  avg_session_ms   numeric,
  unique_rooms_seen bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.* FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
  ),
  sess AS (  -- lọc theo toà: phiên có ≥1 event chạm toà được chọn
    SELECT DISTINCT session_id FROM ev
    WHERE p_building_ids IS NULL OR building_id = ANY(p_building_ids)
  ),
  evf AS (
    SELECT e.* FROM ev e JOIN sess s ON s.session_id = e.session_id
  )
  SELECT
    COUNT(DISTINCT session_id),
    COUNT(DISTINCT session_id),
    COUNT(*) FILTER (WHERE event_type = 'room_open'),
    COUNT(*) FILTER (WHERE event_type = 'impression'),
    COUNT(*) FILTER (WHERE event_type = 'contact_click'),
    COUNT(*) FILTER (WHERE event_type = 'favorite'),
    COUNT(*) FILTER (WHERE event_type = 'deposit_dialog'),
    COUNT(*) FILTER (WHERE event_type = 'error'),
    COALESCE((
      SELECT AVG(mx) FROM (
        SELECT MAX(duration_ms) AS mx FROM evf
        WHERE event_type='session' AND duration_ms IS NOT NULL
        GROUP BY session_id
      ) d
    ), 0)::numeric,
    COUNT(DISTINCT room_id) FILTER (WHERE room_id IS NOT NULL)
  FROM evf;
$$;
REVOKE ALL ON FUNCTION public.pra_summary(date,date,text,uuid[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_summary(date,date,text,uuid[],boolean) TO authenticated;

-- ── 2. pra_timeseries: lưu lượng theo ngày/giờ ───────────────────────────────
CREATE OR REPLACE FUNCTION public.pra_timeseries(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false,
  p_bucket        text    DEFAULT 'day'  -- 'day' | 'hour'
)
RETURNS TABLE (
  bucket         timestamptz,
  sessions       bigint,
  events         bigint,
  room_opens     bigint,
  contact_clicks bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.*,
           date_trunc(CASE WHEN p_bucket='hour' THEN 'hour' ELSE 'day' END,
                      (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS b
    FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
  ),
  sess AS (
    SELECT DISTINCT session_id FROM ev
    WHERE p_building_ids IS NULL OR building_id = ANY(p_building_ids)
  ),
  evf AS (SELECT e.* FROM ev e JOIN sess s ON s.session_id = e.session_id)
  SELECT
    b,
    COUNT(DISTINCT session_id),
    COUNT(*),
    COUNT(*) FILTER (WHERE event_type='room_open'),
    COUNT(*) FILTER (WHERE event_type='contact_click')
  FROM evf
  GROUP BY b
  ORDER BY b;
$$;
REVOKE ALL ON FUNCTION public.pra_timeseries(date,date,text,uuid[],boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_timeseries(date,date,text,uuid[],boolean,text) TO authenticated;

-- ── 3. pra_top_rooms: phòng được xem nhiều (mở chi tiết + hiển thị) ───────────
CREATE OR REPLACE FUNCTION public.pra_top_rooms(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false,
  p_limit         int     DEFAULT 50
)
RETURNS TABLE (
  room_id          uuid,
  room_name        text,
  room_code        text,
  building_name    text,
  open_count       bigint,
  impression_count bigint,
  total_dwell_ms   numeric,
  avg_dwell_ms     numeric,
  contact_clicks   bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.* FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND e.room_id IS NOT NULL
      AND (p_token IS NULL OR e.token = p_token)
      AND (p_building_ids IS NULL OR e.building_id = ANY(p_building_ids))
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
  )
  SELECT
    room_id,
    (array_agg(room_name     ORDER BY created_at DESC) FILTER (WHERE room_name     IS NOT NULL))[1],
    (array_agg(room_code     ORDER BY created_at DESC) FILTER (WHERE room_code     IS NOT NULL))[1],
    (array_agg(building_name ORDER BY created_at DESC) FILTER (WHERE building_name IS NOT NULL))[1],
    COUNT(*) FILTER (WHERE event_type='room_open'),
    COUNT(*) FILTER (WHERE event_type='impression'),
    COALESCE(SUM(dwell_ms) FILTER (WHERE event_type='room_open'), 0)::numeric,
    COALESCE(AVG(dwell_ms) FILTER (WHERE event_type='room_open' AND dwell_ms IS NOT NULL), 0)::numeric,
    COUNT(*) FILTER (WHERE event_type='contact_click')
  FROM ev
  GROUP BY room_id
  ORDER BY COUNT(*) FILTER (WHERE event_type='room_open') DESC,
           COUNT(*) FILTER (WHERE event_type='impression') DESC,
           SUM(dwell_ms) FILTER (WHERE event_type='room_open') DESC NULLS LAST
  LIMIT GREATEST(LEAST(p_limit, 200), 1);
$$;
REVOKE ALL ON FUNCTION public.pra_top_rooms(date,date,text,uuid[],boolean,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_top_rooms(date,date,text,uuid[],boolean,int) TO authenticated;

-- ── 4. pra_funnel: phễu Xem trang → Hiển thị → Mở phòng → Liên hệ ─────────────
CREATE OR REPLACE FUNCTION public.pra_funnel(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false
)
RETURNS TABLE (
  sessions              bigint,
  sessions_impression   bigint,
  sessions_opened_room  bigint,
  sessions_contacted    bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.* FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
  ),
  sess AS (
    SELECT DISTINCT session_id FROM ev
    WHERE p_building_ids IS NULL OR building_id = ANY(p_building_ids)
  ),
  evf AS (SELECT e.* FROM ev e JOIN sess s ON s.session_id = e.session_id)
  SELECT
    COUNT(DISTINCT session_id),
    COUNT(DISTINCT session_id) FILTER (WHERE event_type='impression'),
    COUNT(DISTINCT session_id) FILTER (WHERE event_type='room_open'),
    COUNT(DISTINCT session_id) FILTER (WHERE event_type='contact_click')
  FROM evf;
$$;
REVOKE ALL ON FUNCTION public.pra_funnel(date,date,text,uuid[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_funnel(date,date,text,uuid[],boolean) TO authenticated;

-- ── 5. pra_by_token: tách theo từng link chia sẻ (sale) ──────────────────────
CREATE OR REPLACE FUNCTION public.pra_by_token(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false
)
RETURNS TABLE (
  token          text,
  label          text,
  revoked        boolean,
  sessions       bigint,
  views          bigint,
  room_opens     bigint,
  contact_clicks bigint,
  errors         bigint,
  avg_session_ms numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.* FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
  ),
  sess AS (
    SELECT DISTINCT session_id FROM ev
    WHERE p_building_ids IS NULL OR building_id = ANY(p_building_ids)
  ),
  evf AS (SELECT e.* FROM ev e JOIN sess s ON s.session_id = e.session_id)
  SELECT
    evf.token,
    t.label,
    t.revoked,
    COUNT(DISTINCT evf.session_id),
    COUNT(DISTINCT evf.session_id),
    COUNT(*) FILTER (WHERE evf.event_type='room_open'),
    COUNT(*) FILTER (WHERE evf.event_type='contact_click'),
    COUNT(*) FILTER (WHERE evf.event_type='error'),
    COALESCE((
      SELECT AVG(mx) FROM (
        SELECT MAX(e2.duration_ms) AS mx FROM evf e2
        WHERE e2.token = evf.token
          AND e2.event_type='session' AND e2.duration_ms IS NOT NULL
        GROUP BY e2.session_id
      ) d
    ), 0)::numeric
  FROM evf
  LEFT JOIN public.public_room_share_tokens t ON t.token = evf.token
  GROUP BY evf.token, t.label, t.revoked
  ORDER BY COUNT(DISTINCT evf.session_id) DESC;
$$;
REVOKE ALL ON FUNCTION public.pra_by_token(date,date,text,uuid[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_by_token(date,date,text,uuid[],boolean) TO authenticated;

-- ── 6. pra_errors: nhật ký lỗi (mới nhất trước) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.pra_errors(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false,
  p_limit         int     DEFAULT 200
)
RETURNS TABLE (
  created_at  timestamptz,
  token       text,
  session_id  text,
  kind        text,
  message     text,
  context     text,
  user_agent  text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    e.created_at,
    e.token,
    e.session_id,
    e.metadata->>'kind',
    e.metadata->>'msg',
    e.metadata->>'where',
    e.metadata->>'ua'
  FROM public.public_room_events e
  WHERE e.event_type = 'error'
    AND (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          BETWEEN p_start_date AND p_end_date
    AND (p_token IS NULL OR e.token = p_token)
    AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
    AND ( e.owner_id = ANY (public.current_visible_owner_ids())
       OR public.is_super_admin() OR public.is_admin() )
  ORDER BY e.created_at DESC
  LIMIT GREATEST(LEAST(p_limit, 500), 1);
$$;
REVOKE ALL ON FUNCTION public.pra_errors(date,date,text,uuid[],boolean,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_errors(date,date,text,uuid[],boolean,int) TO authenticated;

COMMIT;
