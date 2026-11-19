-- Báo cáo đánh giá theo kỳ cho Chủ công ty / super admin (plan 2026-11-09, Đợt 2 và mục 3.1).
--
-- Đặt các chỉ số của từng quản lý cạnh nhau. KHÔNG tự chấm điểm, KHÔNG quy ra tiền.
-- Chủ tự ghi nhận xét và xếp loại A/B/C cho từng người theo kỳ (`staff_period_reviews`).
--
-- «Toà quá hạn ghé» (số toà · số lần): với mỗi toà trong phạm vi của người đó, «một lần» là một
-- khoảng giữa hai lần chạm liên tiếp dài hơn SLA của toà, có phần nằm trong kỳ. Lần chạm dùng
-- ba nguồn của view `building_coverage`, thêm phiên có mặt đã bị job đêm đổi thành `expired`
-- (vẫn giữ `fail_reasons`): người đã đến thì không tính là quá hạn. Phạm vi toà là phạm vi HIỆN
-- TẠI (bảng phân công không lưu lịch sử). Nhìn lùi 365 ngày để tìm lần chạm trước kỳ.
--
-- «Thu tiền có GPS khớp» chỉ đếm được ở phiếu có GPS; từ 19/07/2026 phiếu thu không còn được ghi
-- GPS nên báo cáo trả riêng tổng lượt thu và số có GPS khớp để không báo oan.
--
-- Báo cáo chỉ đọc. Bảng nhận xét nằm trong `app_private`, chỉ vào qua hai hàm dưới đây.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, ACL khẳng định lại.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.staff_day_viewer_org_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.staff_day_member_ids_v1(uuid,date)') IS NULL
    OR to_regprocedure('app_private.staff_day_kinds_v1(uuid,uuid,date,date,date)') IS NULL
    OR to_regprocedure('app_private.staff_day_route_items_v1(uuid,date,uuid[])') IS NULL
    OR to_regprocedure('app_private.gps_checkin_day_v1(uuid,uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'staff_period_requires_missing';
  END IF;
END $requires$;

CREATE TABLE IF NOT EXISTS app_private.staff_period_reviews (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_from date NOT NULL,
  period_to date NOT NULL,
  rating text CHECK (rating IN ('A', 'B', 'C')),
  note text CHECK (char_length(note) <= 2000),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id, period_from, period_to),
  CONSTRAINT staff_period_reviews_period_check CHECK (period_to >= period_from)
);

ALTER TABLE app_private.staff_period_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.staff_period_reviews FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Toà quá hạn ghé trong kỳ của một người.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.staff_period_overdue_v1(
  p_route jsonb,
  p_from date,
  p_to date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  WITH scope AS (
    SELECT (r->>'building_id')::uuid AS building_id,
           r->>'building_name' AS building_name,
           (r->>'touch_sla_days')::int AS sla
    FROM jsonb_array_elements(p_route) r
  ),
  touches AS (
    SELECT j.building_id, public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS d
    FROM public.jobs j
    JOIN scope USING (building_id)
    WHERE j.status = 'COMPLETED'
      AND j.completion_time >= ((p_from - 365)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND ( (jsonb_typeof(COALESCE(j.completion_attachments, '[]'::jsonb)) = 'array'
             AND jsonb_array_length(COALESCE(j.completion_attachments, '[]'::jsonb)) > 0)
         OR (jsonb_typeof(COALESCE(j.attachments, '[]'::jsonb)) = 'array'
             AND jsonb_array_length(COALESCE(j.attachments, '[]'::jsonb)) > 0) )
    UNION
    SELECT s.building_id, s.session_date
    FROM public.inspection_sessions s
    JOIN scope USING (building_id)
    WHERE (s.status IN ('passed', 'quick_done', 'presence')
           OR (s.status = 'expired' AND s.fail_reasons IS NOT NULL))
      AND s.session_date >= p_from - 365
    UNION
    SELECT ie.building_id, public.vn_local_date(ie.created_at)
    FROM public.income_expenses ie
    JOIN scope USING (building_id)
    WHERE ie.collect_geofence_status = 'ok'
      AND ie.created_at >= ((p_from - 365)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
  ),
  marks AS (
    SELECT t.building_id, t.d FROM touches t WHERE t.d <= p_to
    UNION
    SELECT sc.building_id, p_to + 1 FROM scope sc  -- khoảng còn đang mở tới hết kỳ
  ),
  gaps AS (
    SELECT m.building_id, m.d,
           lag(m.d) OVER (PARTITION BY m.building_id ORDER BY m.d) AS prev
    FROM marks m
  ),
  counted AS (
    SELECT g.building_id,
           count(*) AS times,
           max(g.d - COALESCE(g.prev, p_from - 1) - 1) AS max_gap_days
    FROM gaps g
    JOIN scope sc USING (building_id)
    -- Khoảng kết thúc đúng ngày đầu kỳ nằm trọn trước kỳ.
    WHERE g.d > p_from
      AND g.d - COALESCE(g.prev, p_from - 1) - 1 > sc.sla
    GROUP BY g.building_id
  )
  SELECT jsonb_build_object(
    'buildings', count(*),
    'times', COALESCE(sum(c.times), 0),
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'building_id', c.building_id,
      'building_name', sc.building_name,
      'times', c.times,
      'max_gap_days', c.max_gap_days
    ) ORDER BY c.max_gap_days DESC, sc.building_name), '[]'::jsonb)
  )
  FROM counted c
  JOIN scope sc USING (building_id);
$fn$;

COMMENT ON FUNCTION app_private.staff_period_overdue_v1(jsonb, date, date) IS
  'So toa va so lan vuot SLA ghe trong ky, theo danh sach toa truyen vao; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 2. Báo cáo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_period_report_v1(p_from date, p_to date, p_org uuid DEFAULT NULL)
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
  v_to date;
  v_first_day date;
  v_is_month boolean;
  v_buildings uuid[];
  v_member record;
  v_members jsonb := '[]'::jsonb;
  v_route jsonb;
  v_att record;
  v_sess record;
  v_photo record;
  v_job record;
  v_pay record;
  v_gps record;
  v_workdays integer;
  v_streak record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := app_private.staff_day_viewer_org_v1(p_org);

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 OR p_from > v_today THEN
    RAISE EXCEPTION 'staff_period_invalid' USING ERRCODE = '22023';
  END IF;

  v_to := LEAST(p_to, v_today);
  v_is_month := p_from = date_trunc('month', p_from)::date
    AND p_to = (date_trunc('month', p_from) + INTERVAL '1 month - 1 day')::date;
  v_first_day := COALESCE(
    (app_private.v5_salary_config_for_org_v1(v_org)->'system_v5'->>'effective_from')::date,
    DATE '2026-07-01'
  );

  SELECT COALESCE(array_agg(b.id), '{}'::uuid[]) INTO v_buildings
  FROM public.buildings b
  WHERE b.organization_id = v_org
    AND b.id IN (SELECT public.accessible_building_ids());

  SELECT count(*) INTO v_workdays
  FROM generate_series(p_from::timestamp, v_to::timestamp, INTERVAL '1 day') AS g(ts)
  WHERE EXTRACT(dow FROM g.ts) <> 0
    AND g.ts::date >= v_first_day
    AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h
                    WHERE h.organization_id = v_org AND h.holiday_date = g.ts::date);

  FOR v_member IN
    SELECT x.user_id, app_private.staff_day_user_v1(x.user_id) AS u
    FROM app_private.staff_day_member_ids_v1(v_org, v_to) AS x(user_id)
    ORDER BY app_private.staff_day_user_v1(x.user_id) ->> 'name', x.user_id
  LOOP
    v_route := app_private.staff_day_route_items_v1(v_member.user_id, v_today, v_buildings);

    SELECT count(*) FILTER (WHERE sad.status = 'ticked') AS ticked,
           count(*) FILTER (WHERE sad.status = 'leave_approved') AS leave_days,
           count(*) FILTER (WHERE sad.status IN ('flagged', 'voided')) AS flagged
    INTO v_att
    FROM public.salary_attendance_day sad
    WHERE sad.user_id = v_member.user_id
      AND sad.work_date BETWEEN p_from AND v_to;

    SELECT count(*) FILTER (WHERE s.type = 'FULL' AND s.status = 'passed') AS full_passed,
           count(*) FILTER (WHERE s.type = 'FULL'
                              AND (s.status = 'presence' OR (s.status = 'expired' AND s.fail_reasons IS NOT NULL))) AS full_presence,
           count(*) FILTER (WHERE s.type = 'FULL' AND s.status = 'expired' AND s.fail_reasons IS NULL) AS full_expired,
           round(avg(s.dwell_seconds) FILTER (WHERE s.type = 'FULL' AND s.status = 'passed')) AS avg_dwell_seconds
    INTO v_sess
    FROM public.inspection_sessions s
    WHERE s.user_id = v_member.user_id
      AND s.session_date BETWEEN p_from AND v_to
      AND s.building_id = ANY (v_buildings);

    SELECT count(*) AS total,
           count(*) FILTER (WHERE p.geofence_status = 'out_of_range') AS out_of_range,
           count(*) FILTER (WHERE p.geofence_status = 'gps_denied') AS gps_denied
    INTO v_photo
    FROM public.inspection_photos p
    JOIN public.inspection_sessions s ON s.id = p.session_id
    WHERE s.user_id = v_member.user_id
      AND s.session_date BETWEEN p_from AND v_to
      AND s.building_id = ANY (v_buildings);

    SELECT count(*) AS total,
           count(*) FILTER (WHERE j.status = 'COMPLETED'
                              AND (j.deadline IS NULL OR j.completion_time <= j.deadline)) AS on_time
    INTO v_job
    FROM public.jobs j
    WHERE j.assignee_id = v_member.user_id
      AND (j.building_id IS NULL OR j.building_id = ANY (v_buildings))
      AND (
        (j.status = 'COMPLETED'
         AND j.completion_time >= (p_from::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
         AND j.completion_time < ((v_to + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
        -- Việc đang làm chỉ tính khi đã thật sự quá hạn, không tính từ sáng của ngày đến hạn.
        OR (j.status = 'IN_PROGRESS'
            AND j.deadline >= (p_from::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
            AND j.deadline < ((v_to + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
            AND j.deadline < now())
      );

    SELECT count(*) AS total,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1
             FROM public.invoice_payment_tenders t
             JOIN public.income_expenses ie ON ie.id = t.voucher_id
             WHERE t.collection_id = c.id AND ie.collect_geofence_status = 'ok'
           )) AS gps_ok
    INTO v_pay
    FROM public.invoice_payment_collections c
    JOIN public.invoices i ON i.id = c.invoice_id
    WHERE c.actor_id = v_member.user_id
      AND c.status = 'ACTIVE'
      AND c.created_at >= (p_from::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND c.created_at < ((v_to + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND i.building_id = ANY (v_buildings);

    SELECT COALESCE(sum((day_gps.counts->>'ok')::int), 0) AS ok,
           COALESCE(sum((day_gps.counts->>'stationary')::int), 0) AS stationary,
           COALESCE(sum((day_gps.counts->>'missing')::int), 0) AS missing,
           COALESCE(sum((day_gps.counts->>'paused')::int), 0) AS paused,
           COALESCE(sum((day_gps.counts->>'mock')::int), 0) AS mock
    INTO v_gps
    FROM generate_series(p_from::timestamp, v_to::timestamp, INTERVAL '1 day') AS g(ts)
    CROSS JOIN LATERAL (
      SELECT app_private.gps_checkin_day_v1(v_org, v_member.user_id, g.ts::date) -> 'counts' AS counts
    ) day_gps;

    SELECT sss.best_streak, sss.breaks_no_leave INTO v_streak
    FROM public.salary_streak_state sss
    WHERE v_is_month AND sss.user_id = v_member.user_id AND sss.period_month = p_from;

    v_members := v_members || jsonb_build_array(jsonb_build_object(
      'user', v_member.u,
      'metrics', jsonb_build_object(
        'ticked_days', v_att.ticked,
        'n_chuan', GREATEST(v_workdays - v_att.leave_days, 0),
        'best_streak', v_streak.best_streak,
        'breaks_no_leave', v_streak.breaks_no_leave,
        'leave_days', v_att.leave_days,
        'full_passed', v_sess.full_passed,
        'full_presence', v_sess.full_presence,
        'full_expired', v_sess.full_expired,
        'avg_dwell_seconds', v_sess.avg_dwell_seconds,
        'photos_total', v_photo.total,
        'photos_out_of_range', v_photo.out_of_range,
        'photos_gps_denied', v_photo.gps_denied,
        'jobs_total', v_job.total,
        'jobs_on_time', v_job.on_time,
        'payments_total', v_pay.total,
        'payments_gps_ok', v_pay.gps_ok,
        'gps_ok', v_gps.ok,
        'gps_stationary', v_gps.stationary,
        'gps_missing', v_gps.missing,
        'gps_paused', v_gps.paused,
        'gps_mock', v_gps.mock,
        'flagged', v_att.flagged
      ),
      'overdue', app_private.staff_period_overdue_v1(v_route, p_from, v_to),
      'days', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('date', k.d, 'kind', k.kind) ORDER BY k.d), '[]'::jsonb)
        FROM app_private.staff_day_kinds_v1(v_member.user_id, v_org, p_from, p_to, v_first_day) k
      ),
      'review', (
        SELECT jsonb_build_object('rating', r.rating, 'note', r.note, 'updated_at', r.updated_at)
        FROM app_private.staff_period_reviews r
        WHERE r.organization_id = v_org
          AND r.user_id = v_member.user_id
          AND r.period_from = p_from
          AND r.period_to = p_to
      )
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'measured_to', v_to,
    'is_month', v_is_month,
    'as_of', now(),
    'organization_id', v_org,
    'members', v_members
  );
END;
$fn$;

COMMENT ON FUNCTION public.staff_period_report_v1(date, date, uuid) IS
  'Bao cao so sanh quan ly theo ky, toi da 93 ngay. Chi Chu cong ty/super admin thanh vien. Khong co tien, khong cham diem.';

-- ---------------------------------------------------------------------------
-- 3. Nhận xét và xếp loại tay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_period_review_set_v1(
  p_user uuid,
  p_from date,
  p_to date,
  p_rating text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_note text := NULLIF(btrim(p_note), '');
  v_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  v_org := app_private.staff_day_viewer_org_v1(NULL);

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92
    OR (p_rating IS NOT NULL AND p_rating NOT IN ('A', 'B', 'C'))
    OR char_length(COALESCE(v_note, '')) > 2000
    OR NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = p_user AND m.organization_id = v_org AND m.status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'staff_period_review_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.staff_period_reviews AS r (
    organization_id, user_id, period_from, period_to, rating, note, updated_by
  ) VALUES (v_org, p_user, p_from, p_to, p_rating, v_note, v_uid)
  ON CONFLICT (organization_id, user_id, period_from, period_to) DO UPDATE
    SET rating = EXCLUDED.rating, note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
  RETURNING r.updated_at INTO v_at;

  RETURN jsonb_build_object('user_id', p_user, 'rating', p_rating, 'note', v_note, 'updated_at', v_at);
END;
$fn$;

COMMENT ON FUNCTION public.staff_period_review_set_v1(uuid, date, date, text, text) IS
  'Luu nhan xet va xep loai A/B/C cua chu cho mot nguoi theo ky. Khong anh huong tien luong.';

-- ---------------------------------------------------------------------------
-- 4. Quyền gọi.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app_private.staff_period_overdue_v1(jsonb, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.staff_period_report_v1(date, date, uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.staff_period_review_set_v1(uuid, date, date, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_period_report_v1(date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_period_review_set_v1(uuid, date, date, text, text) TO authenticated;

DO $check$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.staff_period_report_v1(date,date,uuid)',
    'public.staff_period_review_set_v1(uuid,date,date,text,text)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'staff_period_acl_failed: %', v_sig;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'app_private.staff_period_overdue_v1(jsonb,date,date)', 'EXECUTE')
    OR has_table_privilege('authenticated', 'app_private.staff_period_reviews', 'SELECT') THEN
    RAISE EXCEPTION 'staff_period_acl_private_failed';
  END IF;
END $check$;

COMMIT;
NOTIFY pgrst, 'reload schema';
