-- =============================================================================
-- PANALYTICS-C01 (×7, P2) — re-anchor bảo mật 02/09/2026: mọi RPC báo cáo
-- `pra_*` gate bằng owner heuristic `current_visible_owner_ids() OR
-- is_super_admin() OR is_admin()`, KHÔNG kiểm quyền nghiệp vụ
-- `sale_phong.view_analytics` (key đã tồn tại trong catalog từ 13/07 nhưng
-- chưa hàm nào dùng). Hệ quả: admin per-tenant bất kỳ đọc được analytics của
-- chủ khác miễn lọt bộ lọc owner.
--
-- VÁ: thêm helper `app_private.pra_can_view_analytics_v1(owner)` và thay ĐÚNG
-- MỘT dòng gate trong 7 hàm (thân còn lại chép NGUYÊN VĂN từ
-- 20260831023938 và 20260621100100 — không sửa gì khác).
--
-- LUẬT MỚI, theo thứ tự:
--   1. Chủ dữ liệu tự xem được (owner = auth.uid()) — GIỮ NGUYÊN hành vi hiện
--      tại. Đo prod 02/09: chỉ 1 owner có dữ liệu (16.329 sự kiện) và chính là
--      tài khoản hệ thống, nên vá này không cắt ai đang dùng.
--   2. Super admin xem được (như cũ).
--   3. Người khác: phải có `sale_phong.view_analytics` TRONG tổ chức của chủ
--      dữ liệu. Đo prod: quyền đã ALLOW cho vai "Chủ công ty" (2 org) và
--      "Chủ sở hữu tổ chức" — tức chủ doanh nghiệp vẫn xem bình thường.
--   `is_admin()` bị bỏ khỏi đường quyết định: đó là admin per-tenant, không
--   nói gì về quyền xem analytics của CHỦ KHÁC.
--
-- VÌ SAO DÙNG authorized_scope_v3 CHỨ KHÔNG authorize_tenant_action_v3: 7 hàm
-- này là `LANGUAGE sql STABLE` và PostgREST chạy hàm STABLE trong transaction
-- READ ONLY. `authorize_tenant_action_v3` lấy khoá dòng (25006 — án lệ đã trả
-- giá 5 lần, và vừa làm CI đỏ ở 20260902084858). `authorized_scope_v3(key, org)`
-- là STABLE, KHÔNG chạm khoá — đo trực tiếp trên catalog 02/09.
--
-- Chữ ký 7 hàm không đổi ⇒ CREATE OR REPLACE, không DROP, ACL giữ nguyên.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_private.pra_can_view_analytics_v1(p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT
    p_owner IS NOT NULL
    AND (
      p_owner = (SELECT auth.uid())
      OR public.is_super_admin()
      OR EXISTS (
        SELECT 1
          FROM public.buildings b
         CROSS JOIN LATERAL app_private.authorized_scope_v3('sale_phong.view_analytics', b.organization_id) s
         WHERE b.user_id = p_owner
           AND b.organization_id IS NOT NULL
           AND b.deleted_at IS NULL
           AND (s.org_wide OR COALESCE(array_length(s.building_ids, 1), 0) > 0)
      )
    );
$fn$;

COMMENT ON FUNCTION app_private.pra_can_view_analytics_v1(uuid) IS
'Ai được xem analytics phòng trống của một chủ dữ liệu: chính chủ · super admin · người có sale_phong.view_analytics trong tổ chức của chủ đó. STABLE và KHÔNG lấy khoá — 7 hàm pra_* gọi nó vẫn chạy được trong transaction READ ONLY của PostgREST (PANALYTICS-C01, 02/09/2026).';

REVOKE ALL ON FUNCTION app_private.pra_can_view_analytics_v1(uuid) FROM PUBLIC, anon;

-- ── pra_summary ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pra_summary(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false
)
RETURNS TABLE (
  total_sessions    bigint,
  total_views       bigint,   -- = total_sessions (số lượt mở trang)
  room_opens        bigint,
  impressions       bigint,
  contact_clicks    bigint,
  favorites         bigint,
  deposit_dialogs   bigint,
  errors            bigint,   -- lỗi LOGIC của ứng dụng (đã gộp trùng)
  avg_session_ms    numeric,
  unique_rooms_seen bigint,
  errors_external   bigint,   -- lỗi do trình duyệt in-app / tiện ích bên thứ ba
  error_hits        bigint,   -- tổng số LẦN lỗi ứng dụng xảy ra (cộng bộ đếm n)
  -- ĐƠN VỊ KHÁC NHAU, đừng lẫn: `errors`/`errors_external` đếm CẶP (phiên × vân
  -- tay) — tức "bao nhiêu lượt khách dính". Hai cột dưới đếm VÂN TAY — tức "bao
  -- nhiêu lỗi riêng biệt", đúng con số mà bảng "Nhóm lỗi" hiển thị. Đo trên
  -- production 31/08: ngoài app có 688 cặp nhưng chỉ 2 vân tay.
  error_groups          bigint,
  error_groups_external bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  WITH ev AS (
    SELECT e.*,
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'fp',''),
             md5(COALESCE(e.metadata->>'kind','') || '|' || COALESCE(e.metadata->>'msg',''))
           ) END AS fpk,
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'source',''),
             CASE
               WHEN COALESCE(e.metadata->>'msg','') ~* '(zalojsv2|zalojsbridge|fbnavigatorbridge|__gcrweb|webkit[.]messagehandlers)'
                 OR COALESCE(e.metadata->>'src','') ~* '^(chrome|safari|moz|ms-browser)-extension:'
                 OR (COALESCE(e.metadata->>'msg','') ~* '^script error' AND COALESCE(e.metadata->>'src','') = '')
               THEN 'external'
               ELSE 'app'
             END
           ) END AS srcclass,
           CASE WHEN e.event_type <> 'error' THEN NULL
                WHEN e.metadata->>'n' ~ '^[0-9]{1,9}$'
                THEN GREATEST((e.metadata->>'n')::int, 1) ELSE 1 END AS nval
    FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
  ),
  sess AS (  -- lọc theo toà: phiên có >=1 event chạm toà được chọn
    SELECT DISTINCT ev.session_id FROM ev
    WHERE p_building_ids IS NULL OR ev.building_id = ANY(p_building_ids)
  ),
  evf AS (
    SELECT ev.* FROM ev JOIN sess s ON s.session_id = ev.session_id
  ),
  errper AS (  -- 1 dòng / (phiên, vân tay) — ĐÚNG HAI khoá, cùng luật pra_errors
    -- KHÔNG được gộp thêm theo srcclass. Cùng một vân tay trong cùng một phiên
    -- có thể vừa có dòng CŨ (phân loại theo mẫu chữ lúc đọc) vừa có dòng MỚI
    -- (mang sẵn khoá 'source'); gộp ba khoá sẽ tách chúng làm hai và đếm MỘT lỗi
    -- vào cả `errors` lẫn `errors_external`. Phiên sống qua F5 (sessionStorage)
    -- còn bộ đếm phía client thì reset, nên đường này có thật.
    SELECT evf.session_id, evf.fpk,
           CASE WHEN bool_or(evf.srcclass = 'app') THEN 'app' ELSE 'external' END AS srcclass,
           MAX(evf.nval) AS n_max
    FROM evf WHERE evf.event_type = 'error'
    GROUP BY evf.session_id, evf.fpk
  )
  SELECT
    COUNT(DISTINCT evf.session_id),
    COUNT(DISTINCT evf.session_id),
    COUNT(*) FILTER (WHERE evf.event_type = 'room_open'),
    COUNT(*) FILTER (WHERE evf.event_type = 'impression'),
    COUNT(*) FILTER (WHERE evf.event_type = 'contact_click'),
    COUNT(*) FILTER (WHERE evf.event_type = 'favorite'),
    COUNT(*) FILTER (WHERE evf.event_type = 'deposit_dialog'),
    (SELECT COUNT(*) FROM errper WHERE errper.srcclass = 'app'),
    COALESCE((
      SELECT AVG(mx) FROM (
        SELECT MAX(e2.duration_ms) AS mx FROM evf e2
        WHERE e2.event_type='session' AND e2.duration_ms IS NOT NULL
        GROUP BY e2.session_id
      ) d
    ), 0)::numeric,
    COUNT(DISTINCT evf.room_id) FILTER (WHERE evf.room_id IS NOT NULL),
    (SELECT COUNT(*) FROM errper WHERE errper.srcclass = 'external'),
    (SELECT COALESCE(SUM(errper.n_max), 0)::bigint FROM errper WHERE errper.srcclass = 'app'),
    (SELECT COUNT(DISTINCT errper.fpk) FROM errper WHERE errper.srcclass = 'app'),
    (SELECT COUNT(DISTINCT errper.fpk) FROM errper WHERE errper.srcclass = 'external')
  FROM evf;
$fn$;

-- ── pra_timeseries ─────────────────────────────────────────────
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
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
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

-- ── pra_top_rooms ─────────────────────────────────────────────
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
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
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

-- ── pra_funnel ─────────────────────────────────────────────
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
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
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

-- ── pra_errors ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pra_errors(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false,
  p_limit         int     DEFAULT 200,
  p_source        text    DEFAULT NULL   -- NULL = tất cả | 'app' | 'external'
)
RETURNS TABLE (
  created_at  timestamptz,
  token       text,
  session_id  text,
  kind        text,
  message     text,
  context     text,
  user_agent  text,
  source      text,
  line_no     int,
  col_no      int,
  stack       text,
  href        text,
  viewport    text,
  build       text,
  fingerprint text,
  n           int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  WITH ev AS (
    SELECT e.*,
           -- Vân tay: ưu tiên của client; dòng cũ suy ra từ kind|msg để lỗi lặp
           -- trong lịch sử vẫn gộp được.
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'fp',''),
             md5(COALESCE(e.metadata->>'kind','') || '|' || COALESCE(e.metadata->>'msg',''))
           ) END AS fpk,
           -- Phân loại nguồn cho dòng cũ (chưa có khóa 'source') ngay lúc đọc.
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'source',''),
             CASE
               WHEN COALESCE(e.metadata->>'msg','') ~* '(zalojsv2|zalojsbridge|fbnavigatorbridge|__gcrweb|webkit[.]messagehandlers)'
                 OR COALESCE(e.metadata->>'src','') ~* '^(chrome|safari|moz|ms-browser)-extension:'
                 OR (COALESCE(e.metadata->>'msg','') ~* '^script error' AND COALESCE(e.metadata->>'src','') = '')
               THEN 'external'
               ELSE 'app'
             END
           ) END AS srcclass,
           CASE WHEN e.event_type <> 'error' THEN NULL
                WHEN e.metadata->>'n' ~ '^[0-9]{1,9}$'
                THEN GREATEST((e.metadata->>'n')::int, 1) ELSE 1 END AS nval
    FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
  ),
  sess AS (  -- cùng ngữ nghĩa pra_summary: phiên có >=1 event chạm toà được chọn
    SELECT DISTINCT ev.session_id FROM ev
    WHERE p_building_ids IS NULL OR ev.building_id = ANY(p_building_ids)
  ),
  err AS (
    SELECT ev.* FROM ev JOIN sess s ON s.session_id = ev.session_id
    WHERE ev.event_type = 'error'
  ),
  one AS (
    SELECT DISTINCT ON (err.session_id, err.fpk)
           err.*,
           MAX(err.nval) OVER (PARTITION BY err.session_id, err.fpk) AS n_max
    FROM err
    ORDER BY err.session_id, err.fpk, err.created_at DESC
  )
  SELECT
    one.created_at,
    one.token,
    one.session_id,
    one.metadata->>'kind',
    one.metadata->>'msg',
    COALESCE(NULLIF(one.metadata->>'where',''), NULLIF(one.metadata->>'src','')),
    one.metadata->>'ua',
    one.srcclass,
    CASE WHEN one.metadata->>'line' ~ '^[0-9]{1,9}$' THEN (one.metadata->>'line')::int END,
    CASE WHEN one.metadata->>'col'  ~ '^[0-9]{1,9}$' THEN (one.metadata->>'col')::int  END,
    one.metadata->>'stack',
    one.metadata->>'href',
    one.metadata->>'vp',
    one.metadata->>'build',
    one.fpk,
    one.n_max
  FROM one
  WHERE (p_source IS NULL OR one.srcclass = p_source)
  ORDER BY one.created_at DESC
  LIMIT GREATEST(LEAST(p_limit, 500), 1);
$fn$;

-- ── pra_error_groups ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pra_error_groups(
  p_start_date    date,
  p_end_date      date,
  p_token         text    DEFAULT NULL,
  p_building_ids  uuid[]  DEFAULT NULL,
  p_exclude_staff boolean DEFAULT false,
  p_source        text    DEFAULT NULL,
  p_limit         int     DEFAULT 100
)
RETURNS TABLE (
  fingerprint       text,
  kind              text,
  message           text,
  source            text,
  context           text,
  total_count       bigint,
  sessions          bigint,
  first_seen        timestamptz,
  last_seen         timestamptz,
  sample_stack      text,
  sample_user_agent text,
  sample_href       text,
  sample_build      text,
  sample_token      text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  WITH ev AS (
    SELECT e.*,
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'fp',''),
             md5(COALESCE(e.metadata->>'kind','') || '|' || COALESCE(e.metadata->>'msg',''))
           ) END AS fpk,
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'source',''),
             CASE
               WHEN COALESCE(e.metadata->>'msg','') ~* '(zalojsv2|zalojsbridge|fbnavigatorbridge|__gcrweb|webkit[.]messagehandlers)'
                 OR COALESCE(e.metadata->>'src','') ~* '^(chrome|safari|moz|ms-browser)-extension:'
                 OR (COALESCE(e.metadata->>'msg','') ~* '^script error' AND COALESCE(e.metadata->>'src','') = '')
               THEN 'external'
               ELSE 'app'
             END
           ) END AS srcclass,
           CASE WHEN e.event_type <> 'error' THEN NULL
                WHEN e.metadata->>'n' ~ '^[0-9]{1,9}$'
                THEN GREATEST((e.metadata->>'n')::int, 1) ELSE 1 END AS nval
    FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
  ),
  sess AS (
    SELECT DISTINCT ev.session_id FROM ev
    WHERE p_building_ids IS NULL OR ev.building_id = ANY(p_building_ids)
  ),
  err AS (
    SELECT ev.* FROM ev JOIN sess s ON s.session_id = ev.session_id
    WHERE ev.event_type = 'error'
  ),
  per AS (  -- dedup trong phiên trước, rồi mới cộng ngang các phiên
    SELECT err.session_id, err.fpk,
           MAX(err.nval)       AS n_max,
           MIN(err.created_at) AS first_at,
           MAX(err.created_at) AS last_at
    FROM err GROUP BY err.session_id, err.fpk
  ),
  samp AS (  -- bản mẫu mới nhất của mỗi vân tay (stack/ua/href để soi chi tiết)
    SELECT DISTINCT ON (err.fpk)
           err.fpk, err.metadata, err.srcclass, err.token
    FROM err
    ORDER BY err.fpk, err.created_at DESC
  )
  SELECT
    per.fpk,
    samp.metadata->>'kind',
    samp.metadata->>'msg',
    samp.srcclass,
    COALESCE(NULLIF(samp.metadata->>'where',''), NULLIF(samp.metadata->>'src','')),
    SUM(per.n_max)::bigint,
    COUNT(*)::bigint,
    MIN(per.first_at),
    MAX(per.last_at),
    samp.metadata->>'stack',
    samp.metadata->>'ua',
    samp.metadata->>'href',
    samp.metadata->>'build',
    samp.token
  FROM per JOIN samp ON samp.fpk = per.fpk
  WHERE (p_source IS NULL OR samp.srcclass = p_source)
  GROUP BY per.fpk, samp.metadata, samp.srcclass, samp.token
  ORDER BY SUM(per.n_max) DESC, MAX(per.last_at) DESC
  LIMIT GREATEST(LEAST(p_limit, 200), 1);
$fn$;

-- ── pra_by_token ─────────────────────────────────────────────
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
AS $fn$
  WITH ev AS (
    SELECT e.*,
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'fp',''),
             md5(COALESCE(e.metadata->>'kind','') || '|' || COALESCE(e.metadata->>'msg',''))
           ) END AS fpk,
           CASE WHEN e.event_type = 'error' THEN COALESCE(
             NULLIF(e.metadata->>'source',''),
             CASE
               WHEN COALESCE(e.metadata->>'msg','') ~* '(zalojsv2|zalojsbridge|fbnavigatorbridge|__gcrweb|webkit[.]messagehandlers)'
                 OR COALESCE(e.metadata->>'src','') ~* '^(chrome|safari|moz|ms-browser)-extension:'
                 OR (COALESCE(e.metadata->>'msg','') ~* '^script error' AND COALESCE(e.metadata->>'src','') = '')
               THEN 'external'
               ELSE 'app'
             END
           ) END AS srcclass
    FROM public.public_room_events e
    WHERE (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN p_start_date AND p_end_date
      AND (p_token IS NULL OR e.token = p_token)
      AND (NOT p_exclude_staff OR COALESCE(e.metadata->>'is_staff','') <> 'true')
      -- PANALYTICS-C01 (02/09/2026): gate theo QUYỀN sale_phong.view_analytics
      -- trong đúng tổ chức của chủ dữ liệu, thay owner heuristic + is_admin().
      AND app_private.pra_can_view_analytics_v1(e.owner_id)
  ),
  sess AS (
    SELECT DISTINCT ev.session_id FROM ev
    WHERE p_building_ids IS NULL OR ev.building_id = ANY(p_building_ids)
  ),
  evf AS (SELECT ev.* FROM ev JOIN sess s ON s.session_id = ev.session_id)
  SELECT
    evf.token,
    t.label,
    t.revoked,
    COUNT(DISTINCT evf.session_id),
    COUNT(DISTINCT evf.session_id),
    COUNT(*) FILTER (WHERE evf.event_type='room_open'),
    COUNT(*) FILTER (WHERE evf.event_type='contact_click'),
    COUNT(DISTINCT (evf.session_id, evf.fpk))
      FILTER (WHERE evf.event_type='error' AND evf.srcclass='app'),
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
$fn$;

-- Nghiệm thu: cả 7 hàm phải dùng helper mới và KHÔNG còn owner heuristic;
-- helper phải STABLE (không thì PostgREST ném 25006 ở tầng hàm cha).
DO $$
DECLARE r record; v_thieu text[] := '{}'; v_con text[] := '{}'; v_vol "char";
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('pra_summary','pra_timeseries','pra_top_rooms','pra_funnel',
                         'pra_errors','pra_error_groups','pra_by_token')
  LOOP
    IF position('pra_can_view_analytics_v1' in r.prosrc) = 0 THEN
      v_thieu := v_thieu || r.proname;
    END IF;
    IF position('current_visible_owner_ids' in r.prosrc) > 0 THEN
      v_con := v_con || r.proname;
    END IF;
  END LOOP;
  IF array_length(v_thieu, 1) > 0 THEN
    RAISE EXCEPTION 'Các hàm chưa dùng gate mới: %. DỪNG.', array_to_string(v_thieu, ', ');
  END IF;
  IF array_length(v_con, 1) > 0 THEN
    RAISE EXCEPTION 'Các hàm còn owner heuristic: %. DỪNG.', array_to_string(v_con, ', ');
  END IF;

  SELECT p.provolatile INTO v_vol FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'pra_can_view_analytics_v1';
  IF v_vol IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'pra_can_view_analytics_v1 phải STABLE (provolatile=%). DỪNG.', v_vol;
  END IF;
END $$;
