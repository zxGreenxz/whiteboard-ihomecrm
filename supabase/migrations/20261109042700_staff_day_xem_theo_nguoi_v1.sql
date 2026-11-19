-- Chủ công ty / super admin xem «Hôm nay» của từng quản lý (plan 2026-11-09, PR 1A).
--
-- VÌ SAO CẦN HÀM MỚI. `/my-day` chỉ có hàm «của chính tôi». RLS bốn bảng v5 mở cho
-- chính mình hoặc `is_admin()`, mà `is_admin()` ≡ `is_super_admin()`: tài khoản Chủ công ty
-- không phải super admin nên hôm nay không đọc được gì của quản lý.
-- Không dùng lại `get_my_day_summary()`: hàm đó có GHI (`v5_recompute_streak` upsert
-- `salary_streak_state`) và trả tiền tạm tính. Xem người khác thì không được ghi hộ họ,
-- và plan chốt các màn của chủ không quy ra tiền.
--
-- CỔNG. Dùng `app_private.staff_day_can_view_v1` / `staff_day_viewer_org_v1` dựng ở
-- 20261109042309_gps_checkin_v1. Dữ liệu gắn toà còn lọc thêm bằng `accessible_building_ids()`
-- (DATA_ENVIRONMENTS).
--
-- THU TIỀN. Lấy từ `invoice_payment_collections.actor_id`, không từ `income_expenses.collect_*`:
-- GPS của phiếu thu không còn được ghi từ 19/07/2026 (đo production 09/11). Sự kiện thu tiền
-- chỉ có toạ độ khi phiếu thật sự có GPS — thu chuyển khoản không chứng minh người đó có mặt.
--
-- Chỉ đọc (mọi hàm STABLE), không đổi một dòng dữ liệu nào, không đụng công thức lương.
-- Idempotent: CREATE OR REPLACE, ACL khẳng định lại.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.staff_day_can_view_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.staff_day_viewer_org_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.staff_day_user_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.staff_day_member_ids_v1(uuid,date)') IS NULL
    OR to_regprocedure('app_private.gps_checkin_day_v1(uuid,uuid,date)') IS NULL
    OR to_regprocedure('app_private.v5_salary_org_of_user_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.v5_n_chuan_for_org_v1(date,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.v5_salary_config_for_org_v1(uuid)') IS NULL
    OR to_regprocedure('public.v5_route_candidates(uuid)') IS NULL
    OR to_regprocedure('public.accessible_building_ids()') IS NULL
    OR to_regprocedure('public.vn_local_date(timestamp with time zone)') IS NULL
    OR to_regclass('public.invoice_payment_collections') IS NULL
    OR to_regclass('public.invoice_payment_tenders') IS NULL THEN
    RAISE EXCEPTION 'staff_day_requires_missing';
  END IF;
END $requires$;

-- ---------------------------------------------------------------------------
-- 1. Trạng thái ngày công và nguồn làm nên ngày công.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.staff_day_tick_info_v1(p_user uuid, p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT jsonb_build_object(
    'status', COALESCE(sad.status, 'pending'),
    'tick_source', sad.tick_source,
    'ticked_at', first_tick.at,
    'building_name', COALESCE(sb.name, jb.name, pb.name)
  )
  FROM (SELECT p_user AS user_id, p_date AS work_date) one
  LEFT JOIN public.salary_attendance_day sad
    ON sad.user_id = one.user_id AND sad.work_date = one.work_date
  LEFT JOIN LATERAL (
    SELECT (x->>'at')::timestamptz AS at, x->>'source' AS source, x->>'ref_id' AS ref_id
    FROM jsonb_array_elements(COALESCE(sad.evidence, '[]'::jsonb)) x
    WHERE x ? 'source'
    ORDER BY (x->>'at')::timestamptz
    LIMIT 1
  ) first_tick ON true
  -- `PAYMENT` có hai dạng: phiếu thu, hoặc phiên check sau thu tiền; `MANUAL_DEVICE_ISSUE` trỏ phiên.
  LEFT JOIN public.inspection_sessions s
    ON first_tick.source IN ('FULL', 'PAYMENT', 'MANUAL_DEVICE_ISSUE') AND s.id::text = first_tick.ref_id
  LEFT JOIN public.buildings sb ON sb.id = s.building_id
  LEFT JOIN public.jobs j
    ON first_tick.source = 'JOB' AND j.id::text = first_tick.ref_id
  LEFT JOIN public.buildings jb ON jb.id = j.building_id
  LEFT JOIN public.income_expenses ie
    ON first_tick.source = 'PAYMENT' AND ie.id::text = first_tick.ref_id
  LEFT JOIN public.buildings pb ON pb.id = ie.building_id;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_tick_info_v1(uuid, date) IS
  'Trang thai ngay cong mot ngay va moc dau tien lam nen ngay cong; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 2. Loại của từng ngày: nguồn chung của lịch tháng và báo cáo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.staff_day_kinds_v1(
  p_user uuid,
  p_org uuid,
  p_from date,
  p_to date,
  p_first_day date
)
RETURNS TABLE (d date, kind text, tick_source text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT g.ts::date AS d,
         CASE
           WHEN sad.status = 'ticked' THEN 'ticked'
           WHEN sad.status = 'leave_approved' THEN 'leave'
           WHEN sad.status = 'pending_leave' THEN 'pending_leave'
           WHEN sad.status IN ('flagged', 'voided') THEN 'flagged'
           WHEN g.ts::date > public.vn_local_date(now()) THEN 'future'
           WHEN g.ts::date < p_first_day THEN 'before_start'
           WHEN EXTRACT(dow FROM g.ts) = 0 THEN 'sunday'
           WHEN EXISTS (SELECT 1 FROM public.salary_holidays h
                        WHERE h.organization_id = p_org AND h.holiday_date = g.ts::date) THEN 'holiday'
           WHEN g.ts::date = public.vn_local_date(now()) THEN 'today_pending'
           ELSE 'missed'
         END AS kind,
         sad.tick_source
  FROM generate_series(p_from::timestamp, p_to::timestamp, INTERVAL '1 day') AS g(ts)
  LEFT JOIN public.salary_attendance_day sad
    ON sad.user_id = p_user AND sad.work_date = g.ts::date;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_kinds_v1(uuid, uuid, date, date, date) IS
  'Loai cua tung ngay trong mot khoang cho mot nguoi; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 3. Dòng sự kiện của một ngày: nguồn chung của màn hiện tại, hành trình, cả đội.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.staff_day_events_v1(p_user uuid, p_date date, p_buildings uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  WITH bounds AS (
    SELECT (p_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t0,
           ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t1
  ),
  counted AS (
    SELECT first_tick.ref_id
    FROM public.salary_attendance_day sad
    CROSS JOIN LATERAL (
      SELECT x->>'ref_id' AS ref_id
      FROM jsonb_array_elements(sad.evidence) x
      WHERE x ? 'source'
      ORDER BY (x->>'at')::timestamptz
      LIMIT 1
    ) first_tick
    WHERE sad.user_id = p_user AND sad.work_date = p_date AND sad.status = 'ticked'
  ),
  -- Phiên «có mặt» bị job đêm đổi thành `expired` mà giữ `fail_reasons`: với người xem nó vẫn là
  -- có mặt, chỉ phiên mở rồi bỏ mới là hết giờ. `complete_inspection` không ghi `ended_at` cho
  -- phiên có mặt, nên giờ xong lấy theo ảnh cuối và thời gian ở toà.
  sess AS (
    SELECT s.id, s.building_id, s.type,
           CASE WHEN s.status = 'expired' AND s.fail_reasons IS NOT NULL THEN 'presence' ELSE s.status END AS status,
           s.started_at,
           -- `ended_at` của phiên `expired` là lúc bấm hoàn tất ở ngày sau, không phải lúc rời toà.
           CASE WHEN s.status = 'expired' THEN NULL ELSE s.ended_at END AS ended_at,
           s.dwell_seconds,
           s.condition_note, s.fail_reasons, s.spawned_job_id, s.checklist,
           b.name AS building_name,
           b.latitude::double precision AS lat,
           b.longitude::double precision AS lng,
           (SELECT max(prev.session_date)
            FROM public.inspection_sessions prev
            WHERE prev.building_id = s.building_id
              AND prev.type = 'FULL'
              AND prev.status = 'passed'
              AND prev.session_date < p_date) AS prev_full_date
    FROM public.inspection_sessions s
    JOIN public.buildings b ON b.id = s.building_id
    WHERE s.user_id = p_user
      AND s.session_date = p_date
      AND s.status <> 'cancelled'
      AND s.building_id = ANY (p_buildings)
  ),
  photos AS (
    SELECT p.session_id,
           min(p.created_at) AS first_at,
           max(p.created_at) AS last_at,
           jsonb_agg(jsonb_build_object(
             'path', p.storage_path,
             'slot', p.slot,
             'label', (SELECT c->>'label'
                       FROM sess s2, jsonb_array_elements(s2.checklist) c
                       WHERE s2.id = p.session_id AND c->>'key' = p.slot
                       LIMIT 1),
             'geofence_status', p.geofence_status,
             'distance_m', p.distance_m,
             'lat', p.lat,
             'lng', p.lng
           ) ORDER BY p.created_at) AS items
    FROM public.inspection_photos p
    WHERE p.session_id IN (SELECT id FROM sess)
    GROUP BY p.session_id
  ),
  events AS (
    SELECT s.started_at AS at, 1 AS ord, jsonb_build_object(
      'kind', 'session_open',
      'at', s.started_at,
      'session_id', s.id,
      'building_id', s.building_id,
      'building_name', s.building_name,
      'lat', s.lat,
      'lng', s.lng,
      'type', s.type,
      'status', s.status,
      'prev_full_date', s.prev_full_date
    ) AS e
    FROM sess s

    UNION ALL
    SELECT ph.first_at, 2, jsonb_build_object(
      'kind', 'session_photos',
      'at', ph.first_at,
      'session_id', s.id,
      'building_id', s.building_id,
      'building_name', s.building_name,
      'lat', s.lat,
      'lng', s.lng,
      'photos', ph.items
    )
    FROM sess s
    JOIN photos ph ON ph.session_id = s.id

    UNION ALL
    SELECT finish.at, 3, jsonb_build_object(
      'kind', 'session_done',
      'at', finish.at,
      'session_id', s.id,
      'building_id', s.building_id,
      'building_name', s.building_name,
      'lat', s.lat,
      'lng', s.lng,
      'type', s.type,
      'status', s.status,
      'dwell_seconds', s.dwell_seconds,
      'condition_note', s.condition_note,
      'fail_reasons', to_jsonb(s.fail_reasons),
      'spawned_job_id', s.spawned_job_id,
      'counted', s.id::text IN (SELECT ref_id FROM counted)
    )
    FROM sess s
    LEFT JOIN photos ph ON ph.session_id = s.id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        s.ended_at,
        GREATEST(ph.last_at, s.started_at + make_interval(secs => COALESCE(s.dwell_seconds, 0)))
      ) AS at
    ) finish
    WHERE s.status IN ('passed', 'quick_done', 'presence')

    UNION ALL
    SELECT j.completion_time, 4, jsonb_build_object(
      'kind', 'job_done',
      'at', j.completion_time,
      'job_id', j.id,
      'title', j.title,
      'building_id', j.building_id,
      'building_name', b.name,
      'lat', j.completion_lat,
      'lng', j.completion_lng,
      'distance_m', round(j.completion_distance_m),
      'geofence_status', j.completion_geofence_status,
      'photo_count', GREATEST(
        CASE WHEN jsonb_typeof(j.completion_attachments) = 'array'
             THEN jsonb_array_length(j.completion_attachments) ELSE 0 END,
        CASE WHEN jsonb_typeof(j.attachments) = 'array'
             THEN jsonb_array_length(j.attachments) ELSE 0 END
      ),
      'counted', j.id::text IN (SELECT ref_id FROM counted)
    )
    FROM public.jobs j
    LEFT JOIN public.buildings b ON b.id = j.building_id
    CROSS JOIN bounds
    WHERE j.assignee_id = p_user
      AND j.status = 'COMPLETED'
      AND j.completion_time >= bounds.t0
      AND j.completion_time < bounds.t1
      AND (j.building_id IS NULL OR j.building_id = ANY (p_buildings))

    UNION ALL
    SELECT c.created_at, 5, jsonb_build_object(
      'kind', 'payment',
      'at', c.created_at,
      'collection_id', c.id,
      'building_id', i.building_id,
      'building_name', b.name,
      'room_name', r.name,
      'methods', (SELECT jsonb_agg(DISTINCT t.payment_method)
                  FROM public.invoice_payment_tenders t
                  WHERE t.collection_id = c.id),
      'lat', gps.collect_lat,
      'lng', gps.collect_lng,
      'distance_m', gps.collect_distance_m,
      'geofence_status', gps.collect_geofence_status
    )
    FROM public.invoice_payment_collections c
    JOIN public.invoices i ON i.id = c.invoice_id
    JOIN public.buildings b ON b.id = i.building_id
    LEFT JOIN public.rooms r ON r.id = i.room_id
    LEFT JOIN LATERAL (
      SELECT ie.collect_lat, ie.collect_lng, ie.collect_distance_m, ie.collect_geofence_status
      FROM public.invoice_payment_tenders t
      JOIN public.income_expenses ie ON ie.id = t.voucher_id
      WHERE t.collection_id = c.id
        AND ie.collect_geofence_status IS NOT NULL
      LIMIT 1
    ) gps ON true
    CROSS JOIN bounds
    WHERE c.actor_id = p_user
      AND c.status = 'ACTIVE'
      AND c.created_at >= bounds.t0
      AND c.created_at < bounds.t1
      AND i.building_id = ANY (p_buildings)
  )
  SELECT COALESCE(jsonb_agg(e ORDER BY at, ord), '[]'::jsonb) FROM events;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_events_v1(uuid, date, uuid[]) IS
  'Su kien cua mot nguoi trong mot ngay gio VN, loc theo danh sach toa; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 4. Phiên đang làm.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.staff_day_now_v1(p_user uuid, p_date date, p_buildings uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT jsonb_build_object(
    'session_id', s.id,
    'building_id', s.building_id,
    'building_name', b.name,
    'type', s.type,
    'status', s.status,
    'started_at', s.started_at,
    'photos_count', s.photos_count,
    'items_total', (SELECT count(*) FROM jsonb_array_elements(s.checklist) c
                    WHERE COALESCE((c->>'required')::boolean, false)),
    'items_done', (SELECT count(*) FROM jsonb_array_elements(s.checklist) c
                   WHERE COALESCE((c->>'required')::boolean, false)
                     AND COALESCE((c->>'done')::boolean, false)),
    'items_missing', COALESCE((SELECT jsonb_agg(c->>'label') FROM jsonb_array_elements(s.checklist) c
                               WHERE COALESCE((c->>'required')::boolean, false)
                                 AND NOT COALESCE((c->>'done')::boolean, false)), '[]'::jsonb),
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'path', p.storage_path,
        'slot', p.slot,
        'label', (SELECT c->>'label' FROM jsonb_array_elements(s.checklist) c
                  WHERE c->>'key' = p.slot LIMIT 1),
        'geofence_status', p.geofence_status,
        'distance_m', p.distance_m
      ) ORDER BY p.created_at)
      FROM public.inspection_photos p WHERE p.session_id = s.id
    ), '[]'::jsonb)
  )
  FROM public.inspection_sessions s
  JOIN public.buildings b ON b.id = s.building_id
  WHERE s.user_id = p_user
    AND s.session_date = p_date
    -- Phiên «có mặt» đã bấm hoàn tất; chỉ còn tính là đang làm nếu vừa có thao tác.
    AND (s.status = 'open' OR (s.status = 'presence' AND s.updated_at >= now() - INTERVAL '15 minutes'))
    AND s.building_id = ANY (p_buildings)
  ORDER BY s.started_at DESC
  LIMIT 1;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_now_v1(uuid, date, uuid[]) IS
  'Phien kiem tra dang do gan nhat trong ngay; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 5. Tuyến gợi ý của một người, kèm cờ đã ghé hôm nay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.staff_day_route_items_v1(p_user uuid, p_today date, p_buildings uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  WITH visited AS (
    SELECT DISTINCT (e->>'building_id')::uuid AS building_id
    FROM jsonb_array_elements(app_private.staff_day_events_v1(p_user, p_today, p_buildings)) e
    WHERE e->>'kind' IN ('session_open', 'session_done', 'job_done')
      AND e->>'building_id' IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(
    (to_jsonb(c) - 'ordinality') || jsonb_build_object('visited_today', c.building_id IN (SELECT building_id FROM visited))
    ORDER BY ord
  ), '[]'::jsonb)
  FROM public.v5_route_candidates(p_user) WITH ORDINALITY AS c
  CROSS JOIN LATERAL (SELECT c.ordinality AS ord) o
  WHERE c.building_id = ANY (p_buildings);
$fn$;

COMMENT ON FUNCTION app_private.staff_day_route_items_v1(uuid, date, uuid[]) IS
  'Tuyen goi y cua mot nguoi, loc theo toa nguoi xem duoc, them co da ghe; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 6. Màn «Hôm nay — cả đội».
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_day_team_v1(p_date date DEFAULT NULL, p_org uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_today date := public.vn_local_date(now());
  v_date date := COALESCE(p_date, v_today);
  v_buildings uuid[];
  v_member record;
  v_events jsonb;
  v_route jsonb;
  v_gps jsonb;
  v_last jsonb;
  v_prev_date date;
  v_members jsonb := '[]'::jsonb;
  v_overdue jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := app_private.staff_day_viewer_org_v1(p_org);

  IF v_date > v_today THEN
    RAISE EXCEPTION 'staff_day_future_date' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(b.id), '{}'::uuid[]) INTO v_buildings
  FROM public.buildings b
  WHERE b.organization_id = v_org
    AND b.id IN (SELECT public.accessible_building_ids());

  FOR v_member IN
    SELECT x.user_id, app_private.staff_day_user_v1(x.user_id) AS u
    FROM app_private.staff_day_member_ids_v1(v_org, v_date) AS x(user_id)
    ORDER BY app_private.staff_day_user_v1(x.user_id) ->> 'name', x.user_id
  LOOP
    v_events := app_private.staff_day_events_v1(v_member.user_id, v_date, v_buildings);
    v_route := app_private.staff_day_route_items_v1(v_member.user_id, v_today, v_buildings);
    v_gps := app_private.gps_checkin_day_v1(v_org, v_member.user_id, v_date);

    SELECT e INTO v_last
    FROM jsonb_array_elements(v_events) WITH ORDINALITY AS t(e, n)
    WHERE e->>'kind' <> 'session_photos'
    ORDER BY n DESC
    LIMIT 1;

    IF v_last IS NULL THEN
      SELECT max(d) INTO v_prev_date
      FROM (
        SELECT max(s.session_date) AS d
        FROM public.inspection_sessions s
        WHERE s.user_id = v_member.user_id
          AND s.session_date < v_date
          AND s.session_date >= v_date - 30
          AND s.status <> 'cancelled'
          AND s.building_id = ANY (v_buildings)
        UNION ALL
        SELECT max(public.vn_local_date(j.completion_time))
        FROM public.jobs j
        WHERE j.assignee_id = v_member.user_id
          AND j.status = 'COMPLETED'
          AND j.completion_time < (v_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
          AND j.completion_time >= ((v_date - 30)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
          AND j.building_id = ANY (v_buildings)
      ) candidates;

      IF v_prev_date IS NOT NULL THEN
        SELECT e INTO v_last
        FROM jsonb_array_elements(
          app_private.staff_day_events_v1(v_member.user_id, v_prev_date, v_buildings)
        ) WITH ORDINALITY AS t(e, n)
        WHERE e->>'kind' <> 'session_photos'
        ORDER BY n DESC
        LIMIT 1;
      END IF;
    END IF;

    v_members := v_members || jsonb_build_array(jsonb_build_object(
      'user', v_member.u,
      'buildings_assigned', jsonb_array_length(v_route),
      'day', app_private.staff_day_tick_info_v1(v_member.user_id, v_date),
      'now', CASE WHEN v_date = v_today
                  THEN app_private.staff_day_now_v1(v_member.user_id, v_date, v_buildings) END,
      'visited_today', (
        SELECT count(DISTINCT e->>'building_id')
        FROM jsonb_array_elements(v_events) e
        WHERE e->>'kind' IN ('session_open', 'session_done', 'job_done')
          AND e->>'building_id' IS NOT NULL
      ),
      'due_remaining', (
        SELECT count(*)
        FROM jsonb_array_elements(v_route) r
        WHERE (r->>'priority_bucket')::int IN (0, 1)
          AND NOT (r->>'visited_today')::boolean
      ),
      'jobs_done', (
        SELECT count(*) FROM jsonb_array_elements(v_events) e WHERE e->>'kind' = 'job_done'
      ),
      'payments', (
        SELECT count(*) FROM jsonb_array_elements(v_events) e WHERE e->>'kind' = 'payment'
      ),
      'last_event', v_last,
      'gps', (v_gps - 'slots') || jsonb_build_object('last_ok', (
        SELECT s
        FROM jsonb_array_elements(v_gps->'slots') WITH ORDINALITY AS t(s, n)
        WHERE s->>'status' IN ('ok', 'ok_stationary')
        ORDER BY n DESC
        LIMIT 1
      ))
    ));

    v_overdue := v_overdue || COALESCE((
      SELECT jsonb_agg(r || jsonb_build_object('manager_name', v_member.u->>'name'))
      FROM jsonb_array_elements(v_route) r
      WHERE NOT (r->>'visited_today')::boolean
        AND (
          r->>'last_touch_date' IS NULL
          OR (r->>'days_since_touch')::int > (r->>'touch_sla_days')::int
          OR r->>'last_full_date' IS NULL
          OR (r->>'days_since_full')::int > (r->>'full_interval_days')::int
        )
    ), '[]'::jsonb);

    v_last := NULL;
    v_prev_date := NULL;
  END LOOP;

  RETURN jsonb_build_object(
    'date', v_date,
    'is_today', v_date = v_today,
    'as_of', now(),
    'organization_id', v_org,
    'members', v_members,
    'overdue_buildings', (
      SELECT COALESCE(jsonb_agg(o ORDER BY kind_order, days DESC NULLS FIRST, name), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
                 'building_id', r->>'building_id',
                 'building_name', max(r->>'building_name'),
                 'kind', CASE WHEN bool_or(is_touch) THEN 'touch' ELSE 'full' END,
                 'days', CASE WHEN bool_or(is_touch)
                              THEN max((r->>'days_since_touch')::int)
                              ELSE max((r->>'days_since_full')::int) END,
                 'managers', jsonb_agg(DISTINCT r->>'manager_name')
               ) AS o,
               CASE WHEN bool_or(is_touch) THEN 0 ELSE 1 END AS kind_order,
               CASE WHEN bool_or(is_touch)
                    THEN max((r->>'days_since_touch')::int)
                    ELSE max((r->>'days_since_full')::int) END AS days,
               max(r->>'building_name') AS name
        FROM (
          SELECT r,
                 (r->>'last_touch_date' IS NULL
                  OR (r->>'days_since_touch')::int > (r->>'touch_sla_days')::int) AS is_touch
          FROM jsonb_array_elements(v_overdue) r
        ) flagged
        GROUP BY r->>'building_id'
      ) grouped
    )
  );
END;
$fn$;

COMMENT ON FUNCTION public.staff_day_team_v1(date, uuid) IS
  'Hom nay ca doi cho Chu cong ty/super admin. Chi doc, khong co tien.';

-- ---------------------------------------------------------------------------
-- 7. Màn «Một quản lý — hiện tại».
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_day_summary_v1(p_user uuid, p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_today date := public.vn_local_date(now());
  v_date date := COALESCE(p_date, v_today);
  v_month date := date_trunc('month', v_date)::date;
  v_org uuid;
  v_buildings uuid[];
  v_events jsonb;
BEGIN
  IF v_uid IS NULL OR NOT app_private.staff_day_can_view_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_date > v_today THEN
    RAISE EXCEPTION 'staff_day_future_date' USING ERRCODE = '22023';
  END IF;

  v_org := app_private.v5_salary_org_of_user_v1(p_user);
  v_buildings := ARRAY(SELECT public.accessible_building_ids());
  v_events := app_private.staff_day_events_v1(p_user, v_date, v_buildings);

  RETURN jsonb_build_object(
    'date', v_date,
    'is_today', v_date = v_today,
    'as_of', now(),
    'user', app_private.staff_day_user_v1(p_user),
    'day', app_private.staff_day_tick_info_v1(p_user, v_date),
    'attend', jsonb_build_object(
      'n_chuan', CASE WHEN v_org IS NULL THEN NULL
                      ELSE app_private.v5_n_chuan_for_org_v1(v_month, p_user, v_org) END,
      'ticked_days', (
        SELECT count(*) FROM public.salary_attendance_day sad
        WHERE sad.user_id = p_user AND sad.status = 'ticked'
          AND sad.work_date >= v_month
          AND sad.work_date < (v_month + INTERVAL '1 month')::date
      )
    ),
    'streak', (
      SELECT jsonb_build_object(
        'current', sss.current_streak,
        'best', sss.best_streak,
        'breaks_no_leave', sss.breaks_no_leave,
        'updated_at', sss.updated_at
      )
      FROM public.salary_streak_state sss
      WHERE sss.user_id = p_user AND sss.period_month = v_month
    ),
    'pending_checks', COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'building_id', e->>'building_id',
        'building_name', (SELECT b.name FROM public.buildings b WHERE b.id = (e->>'building_id')::uuid)
      ))
      FROM public.salary_attendance_day sad, jsonb_array_elements(sad.evidence) e
      WHERE sad.user_id = p_user AND sad.work_date = v_date
        AND sad.status = 'pending_check'
        AND e->>'kind' = 'pending_check'
        AND (e->>'building_id')::uuid = ANY (v_buildings)
    ), '[]'::jsonb),
    'now', CASE WHEN v_date = v_today
                THEN app_private.staff_day_now_v1(p_user, v_date, v_buildings) END,
    'gps', CASE WHEN v_org IS NULL THEN NULL
                ELSE app_private.gps_checkin_day_v1(v_org, p_user, v_date) END,
    'open_jobs', (
      SELECT jsonb_build_object(
        'total', count(*),
        'items', COALESCE(jsonb_agg(x.o ORDER BY x.rn) FILTER (WHERE x.rn <= 5), '[]'::jsonb)
      )
      FROM (
        SELECT jsonb_build_object(
                 'id', j.id, 'code', j.code, 'title', j.title,
                 'building_id', j.building_id, 'building_name', b.name,
                 'deadline', j.deadline, 'priority', j.priority
               ) AS o,
               row_number() OVER (ORDER BY j.deadline NULLS LAST, j.created_at) AS rn
        FROM public.jobs j
        LEFT JOIN public.buildings b ON b.id = j.building_id
        WHERE j.assignee_id = p_user
          AND j.status = 'IN_PROGRESS'
          AND (j.building_id IS NULL OR j.building_id = ANY (v_buildings))
      ) x
    ),
    'recent_events', COALESCE((
      SELECT jsonb_agg(e ORDER BY n DESC)
      FROM (
        SELECT e, n
        FROM jsonb_array_elements(v_events) WITH ORDINALITY AS t(e, n)
        WHERE e->>'kind' <> 'session_photos'
        ORDER BY n DESC
        LIMIT 5
      ) last_five
    ), '[]'::jsonb)
  );
END;
$fn$;

COMMENT ON FUNCTION public.staff_day_summary_v1(uuid, date) IS
  'Hom nay cua mot nguoi. Khac get_my_day_summary: khong ghi streak, khong tra tien.';

-- ---------------------------------------------------------------------------
-- 8. Tuyến còn phải ghé.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_day_route_v1(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL OR NOT app_private.staff_day_can_view_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'as_of', now(),
    'items', app_private.staff_day_route_items_v1(
      p_user,
      public.vn_local_date(now()),
      ARRAY(SELECT public.accessible_building_ids())
    )
  );
END;
$fn$;

COMMENT ON FUNCTION public.staff_day_route_v1(uuid) IS
  'Tuyen goi y hom nay cua mot nguoi, kem co da ghe. Chi doc.';

-- ---------------------------------------------------------------------------
-- 9. Màn «Hành trình một ngày».
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_day_journey_v1(p_user uuid, p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_today date := public.vn_local_date(now());
  v_date date := COALESCE(p_date, v_today);
  v_org uuid;
BEGIN
  IF v_uid IS NULL OR NOT app_private.staff_day_can_view_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_date > v_today THEN
    RAISE EXCEPTION 'staff_day_future_date' USING ERRCODE = '22023';
  END IF;

  v_org := app_private.v5_salary_org_of_user_v1(p_user);

  RETURN jsonb_build_object(
    'date', v_date,
    'is_today', v_date = v_today,
    'as_of', now(),
    'user', app_private.staff_day_user_v1(p_user),
    'day', app_private.staff_day_tick_info_v1(p_user, v_date),
    'events', app_private.staff_day_events_v1(
      p_user, v_date, ARRAY(SELECT public.accessible_building_ids())
    ),
    'gps', CASE WHEN v_org IS NULL THEN NULL
                ELSE app_private.gps_checkin_day_v1(v_org, p_user, v_date) END
  );
END;
$fn$;

COMMENT ON FUNCTION public.staff_day_journey_v1(uuid, date) IS
  'Dong su kien mot ngay cua mot nguoi de ve ban do va dong thoi gian. Chi doc.';

-- ---------------------------------------------------------------------------
-- 10. Màn «Lịch tháng».
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_day_calendar_v1(p_user uuid, p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_today date := public.vn_local_date(now());
  v_month date := date_trunc('month', COALESCE(p_month, v_today))::date;
  v_next date := (v_month + INTERVAL '1 month')::date;
  v_org uuid;
  v_first_month date;
  v_buildings uuid[];
  v_days jsonb;
BEGIN
  IF v_uid IS NULL OR NOT app_private.staff_day_can_view_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := app_private.v5_salary_org_of_user_v1(p_user);
  v_buildings := ARRAY(SELECT public.accessible_building_ids());
  v_first_month := date_trunc('month', COALESCE(
    (app_private.v5_salary_config_for_org_v1(v_org)->'system_v5'->>'effective_from')::date,
    DATE '2026-07-01'
  ))::date;

  WITH days AS (
    SELECT k.d, k.kind, k.tick_source
    FROM app_private.staff_day_kinds_v1(p_user, v_org, v_month, (v_next - 1)::date, v_first_month) k
  ),
  touches AS (
    SELECT s.session_date AS d, s.building_id, 'session' AS src
    FROM public.inspection_sessions s
    WHERE s.user_id = p_user
      AND s.session_date >= v_month AND s.session_date < v_next
      AND s.status <> 'cancelled'
      AND s.building_id = ANY (v_buildings)
    UNION ALL
    SELECT public.vn_local_date(j.completion_time), j.building_id, 'job'
    FROM public.jobs j
    WHERE j.assignee_id = p_user
      AND j.status = 'COMPLETED'
      AND j.completion_time >= (v_month::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND j.completion_time < (v_next::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND j.building_id = ANY (v_buildings)
  ),
  per_day AS (
    SELECT t.d,
           count(DISTINCT t.building_id) AS buildings,
           count(*) FILTER (WHERE t.src = 'session') AS sessions,
           count(*) FILTER (WHERE t.src = 'job') AS jobs
    FROM touches t
    GROUP BY t.d
  ),
  pay AS (
    SELECT public.vn_local_date(c.created_at) AS d, count(*) AS payments
    FROM public.invoice_payment_collections c
    JOIN public.invoices i ON i.id = c.invoice_id
    WHERE c.actor_id = p_user
      AND c.status = 'ACTIVE'
      AND c.created_at >= (v_month::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND c.created_at < (v_next::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND i.building_id = ANY (v_buildings)
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'date', days.d,
    'kind', days.kind,
    'tick_source', days.tick_source,
    'buildings', COALESCE(per_day.buildings, 0),
    'sessions', COALESCE(per_day.sessions, 0),
    'jobs', COALESCE(per_day.jobs, 0),
    'payments', COALESCE(pay.payments, 0),
    'gps', gps.counts
  ) ORDER BY days.d), '[]'::jsonb)
  INTO v_days
  FROM days
  LEFT JOIN per_day ON per_day.d = days.d
  LEFT JOIN pay ON pay.d = days.d
  LEFT JOIN LATERAL (
    SELECT app_private.gps_checkin_day_v1(v_org, p_user, days.d) -> 'counts' AS counts
    WHERE days.d <= v_today
      AND v_org IS NOT NULL
      AND EXISTS (SELECT 1 FROM app_private.gps_checkin_settings cfg WHERE cfg.organization_id = v_org)
  ) gps ON true;

  RETURN jsonb_build_object(
    'month', v_month,
    'first_month', v_first_month,
    'as_of', now(),
    'user', app_private.staff_day_user_v1(p_user),
    'days', v_days,
    'totals', jsonb_build_object(
      'ticked_days', (SELECT count(*) FROM jsonb_array_elements(v_days) x WHERE x->>'kind' = 'ticked'),
      'n_chuan', CASE WHEN v_org IS NULL THEN NULL
                      ELSE app_private.v5_n_chuan_for_org_v1(v_month, p_user, v_org) END,
      'leave_days', (SELECT count(*) FROM jsonb_array_elements(v_days) x WHERE x->>'kind' = 'leave'),
      'visits', (SELECT COALESCE(sum((x->>'buildings')::int), 0) FROM jsonb_array_elements(v_days) x),
      'best_streak', (SELECT sss.best_streak FROM public.salary_streak_state sss
                      WHERE sss.user_id = p_user AND sss.period_month = v_month),
      'current_streak', (SELECT sss.current_streak FROM public.salary_streak_state sss
                         WHERE sss.user_id = p_user AND sss.period_month = v_month)
    )
  );
END;
$fn$;

COMMENT ON FUNCTION public.staff_day_calendar_v1(uuid, date) IS
  'Lich thang theo nguoi: loai ngay, so toa da ghe, tong thang. Chi doc, khong co tien.';

-- ---------------------------------------------------------------------------
-- 11. Quyền gọi.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app_private.staff_day_tick_info_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_kinds_v1(uuid, uuid, date, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_events_v1(uuid, date, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_now_v1(uuid, date, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_route_items_v1(uuid, date, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.staff_day_team_v1(date, uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.staff_day_summary_v1(uuid, date) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.staff_day_route_v1(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.staff_day_journey_v1(uuid, date) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.staff_day_calendar_v1(uuid, date) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.staff_day_team_v1(date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_day_summary_v1(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_day_route_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_day_journey_v1(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_day_calendar_v1(uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 12. Tự kiểm: ACL đúng như ý định.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_public text[] := ARRAY[
    'public.staff_day_team_v1(date,uuid)',
    'public.staff_day_summary_v1(uuid,date)',
    'public.staff_day_route_v1(uuid)',
    'public.staff_day_journey_v1(uuid,date)',
    'public.staff_day_calendar_v1(uuid,date)'
  ];
  v_private text[] := ARRAY[
    'app_private.staff_day_tick_info_v1(uuid,date)',
    'app_private.staff_day_kinds_v1(uuid,uuid,date,date,date)',
    'app_private.staff_day_events_v1(uuid,date,uuid[])',
    'app_private.staff_day_now_v1(uuid,date,uuid[])',
    'app_private.staff_day_route_items_v1(uuid,date,uuid[])'
  ];
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY v_public LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'staff_day_acl_public_failed: %', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY v_private LOOP
    IF has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'staff_day_acl_private_failed: %', v_sig;
    END IF;
  END LOOP;
END $check$;

COMMIT;
NOTIFY pgrst, 'reload schema';
