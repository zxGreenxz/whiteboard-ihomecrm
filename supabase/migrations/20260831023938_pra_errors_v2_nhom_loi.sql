-- =============================================================================
-- Trang công khai "Phòng trống" — LỚP ĐỌC lỗi v2 (phân loại nguồn + gộp nhóm)
-- =============================================================================
-- Ba khiếm khuyết của bản cũ, đều đã tái hiện được:
--
--  1. Cột "Vị trí" LUÔN trống. Bộ ghi lưu đường dẫn file vào khóa `src`
--     (tracking.ts), còn `pra_errors` lại đọc `metadata->>'where'`. Hai bên
--     chưa bao giờ gặp nhau. Nay đọc COALESCE(where, src).
--
--  2. `pra_errors` NHẬN `p_building_ids` nhưng không dùng — bộ lọc "Toà nhà"
--     trên tab Lỗi im lặng không có tác dụng, trong khi 4 RPC pra_* khác đều
--     lọc theo "phiên có chạm toà". Nay dùng chung CTE `sess` như pra_summary.
--
--  3. KPI "Số lỗi phát sinh" (pra_summary) đếm SAU khi thu hẹp theo toà, còn
--     danh sách lỗi thì không → hai con số cạnh nhau mà lệch nhau. Nay cùng
--     một ngữ nghĩa.
--
-- Hai năng lực mới:
--
--  * `source` (app | external): lỗi do trình duyệt in-app của bên thứ ba tiêm
--    vào trang (Zalo WebView với `zaloJSV2`, cầu nối Facebook, tiện ích mở
--    rộng...) KHÔNG phải lỗi của ứng dụng và không sửa được từ phía mình. Vẫn
--    ghi để biết bao nhiêu khách gặp, nhưng tách khỏi lỗi thật. Dòng CŨ không
--    có khóa `source` được phân loại NGAY LÚC ĐỌC theo mẫu chữ, nên lịch sử
--    cũng được xếp đúng chỗ mà không phải viết lại dữ liệu.
--
--  * Gộp lỗi trùng: client gửi kèm vân tay `fp` và bộ đếm `n` (số lần lặp trong
--    phiên). Một lỗi bắn 500 lần chỉ tốn vài dòng thay vì 500 dòng. Bên đọc lấy
--    MAX(n) theo (session_id, fp) — an toàn khi client gửi lại bản cập nhật n,
--    và an toàn cả khi một batch được gửi trùng do cơ chế gửi lại.
--    GIỚI HẠN ĐÃ BIẾT: n reset khi khách F5, nên lỗi lặp XUYÊN tải trang bị đếm
--    thiếu. Đây là đánh đổi có chủ ý để không phải giữ trạng thái qua reload.
--    Dòng cũ chưa có `fp` thì vân tay suy ra từ md5(kind|msg).
--
-- Đổi RETURNS TABLE ⇒ bắt buộc DROP rồi CREATE (CREATE OR REPLACE sẽ đẻ overload
-- và PostgREST chọn nhầm bản). Kèm dựng lại REVOKE/GRANT sau mỗi DROP.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ── 1. pra_errors v2: nhật ký lỗi, 1 dòng / (phiên, vân tay) ─────────────────
DROP FUNCTION IF EXISTS public.pra_errors(date,date,text,uuid[],boolean,int);
DROP FUNCTION IF EXISTS public.pra_errors(date,date,text,uuid[],boolean,int,text);

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
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
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

COMMENT ON FUNCTION public.pra_errors(date,date,text,uuid[],boolean,int,text) IS
'Nhật ký lỗi trang công khai, 1 dòng cho mỗi (phiên, vân tay lỗi); n = số lần lặp
(MAX theo nhóm). p_source lọc app/external. Vị trí = COALESCE(where, src).
Lọc toà theo "phiên có chạm toà", đồng bộ với pra_summary.';

REVOKE ALL ON FUNCTION public.pra_errors(date,date,text,uuid[],boolean,int,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_errors(date,date,text,uuid[],boolean,int,text) TO authenticated;

-- ── 2. pra_error_groups: gộp theo vân tay (view phân tích chính) ─────────────
-- Gộp Ở SERVER, không gộp ở trình duyệt: kỳ nhiều lỗi có thể vượt trần 500 dòng
-- của pra_errors, gộp phía client sẽ cho tổng sai mà không ai biết.
DROP FUNCTION IF EXISTS public.pra_error_groups(date,date,text,uuid[],boolean,text,int);

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
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
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

COMMENT ON FUNCTION public.pra_error_groups(date,date,text,uuid[],boolean,text,int) IS
'Gộp lỗi trang công khai theo vân tay: total_count = tổng MAX(n) qua từng phiên,
sessions = số phiên dính. Kèm bản mẫu mới nhất (stack/ua/href/build) để soi chi
tiết. p_source lọc app/external.';

REVOKE ALL ON FUNCTION public.pra_error_groups(date,date,text,uuid[],boolean,text,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_error_groups(date,date,text,uuid[],boolean,text,int) TO authenticated;

-- ── 3. pra_summary: tách lỗi app / ngoài app, đếm theo lỗi LOGIC ─────────────
-- LƯU Ý KHI ĐỌC BÁO CÁO: cột `errors` từ nay là số lỗi LOGIC của ứng dụng
-- (đã gộp trùng, đã bỏ nhóm ngoài app), nên sẽ THẤP HƠN con số cũ. Đó là thay
-- đổi ngữ nghĩa có chủ ý, không phải mất dữ liệu — phần chênh nằm ở
-- `errors_external` và ở `error_hits`.
DROP FUNCTION IF EXISTS public.pra_summary(date,date,text,uuid[],boolean);

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
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
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

COMMENT ON FUNCTION public.pra_summary(date,date,text,uuid[],boolean) IS
'KPI tổng hợp trang công khai. errors / errors_external đếm CẶP (phiên × vân tay)
— bao nhiêu lượt khách dính lỗi. error_groups / error_groups_external đếm VÂN TAY
— bao nhiêu lỗi riêng biệt, khớp số dòng của pra_error_groups. error_hits = tổng
số lần lỗi ứng dụng xảy ra (cộng bộ đếm lặp trong phiên).';

REVOKE ALL ON FUNCTION public.pra_summary(date,date,text,uuid[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_summary(date,date,text,uuid[],boolean) TO authenticated;

-- ── 4. pra_by_token: cột "Lỗi" đếm cùng luật với hai hàm trên ────────────────
-- Chữ ký không đổi ⇒ chỉ thay thân hàm.
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
      AND ( e.owner_id = ANY (public.current_visible_owner_ids())
         OR public.is_super_admin() OR public.is_admin() )
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

COMMENT ON FUNCTION public.pra_by_token(date,date,text,uuid[],boolean) IS
'Thống kê theo từng link chia sẻ. Cột errors đếm lỗi LOGIC của ứng dụng (gộp
theo (phiên, vân tay), bỏ nhóm ngoài app) — cùng luật với pra_summary.';

REVOKE ALL ON FUNCTION public.pra_by_token(date,date,text,uuid[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pra_by_token(date,date,text,uuid[],boolean) TO authenticated;

COMMIT;
