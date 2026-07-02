-- ============================================================
-- V5 FOUNDATION (S1) — Hệ thống lương-thưởng v5 "dấu chân"
-- Nguồn: docs/bang-luong/V5-HE-THONG-LUONG-THUONG-THONG-NHAT.md (Ch.9, Ch.10)
--        docs/bang-luong/V5-PLAN-THUC-HIEN.md (US-1.1 → US-1.6)
-- BẢNG CHỈ CHỨA STATE + BẰNG CHỨNG — KHÔNG CỘT TIỀN (C9).
-- Feature flags OFF mặc định → không đổi hành vi hệ hiện tại.
-- REVERT: scripts/v5_rollback_s1.sql (+ git tag pre-v5-salary)
-- ============================================================

-- ---------- 1. inspection_sessions: phiên kiểm tra nhà FULL/QUICK ----------
CREATE TABLE IF NOT EXISTS public.inspection_sessions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  building_id               UUID NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  type                      TEXT NOT NULL CHECK (type IN ('FULL','QUICK')),
  -- KHÔNG có 'failed': fail chuẩn = presence (mục sửa B7)
  status                    TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','passed','quick_done','presence','expired','cancelled')),
  session_date              DATE NOT NULL,            -- ngày VN (vn_local_date)
  started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                  TIMESTAMPTZ,
  dwell_seconds             INT NOT NULL DEFAULT 0,   -- CỘNG DỒN các phiên cùng ngày cùng toà (C1)
  checklist                 JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{key,label,required,done,photo_id}]
  random_item_key           TEXT,                     -- +1 mục sâu random theo seed ngày+toà
  condition_note            TEXT,                     -- 'OK' | mô tả vấn đề ("Tình trạng nhà")
  photos_count              INT NOT NULL DEFAULT 0,
  device_id                 TEXT,
  device_issue              JSONB,                    -- {reported_at, reason, evidence, approved_by, approved_at}
  paired_income_expense_id  UUID REFERENCES public.income_expenses(id) ON DELETE SET NULL, -- CHECK-NHANH sau thu tiền
  job_id                    UUID REFERENCES public.jobs(id) ON DELETE SET NULL,            -- tái dùng pipeline jobs nếu có
  spawned_job_id            UUID REFERENCES public.jobs(id) ON DELETE SET NULL,            -- job sửa tự sinh khi "Có vấn đề"
  fail_reasons              TEXT[],
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insp_sess_user_date ON public.inspection_sessions(user_id, session_date);
CREATE INDEX IF NOT EXISTS idx_insp_sess_bld_date  ON public.inspection_sessions(building_id, session_date);
COMMENT ON TABLE public.inspection_sessions IS 'v5: phiên kiểm tra nhà FULL/QUICK. Fail chuẩn = presence (không có failed). State + bằng chứng, KHÔNG cột tiền.';

-- ---------- 2. inspection_photos: ảnh bằng chứng từng mục ----------
CREATE TABLE IF NOT EXISTS public.inspection_photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES public.inspection_sessions(id) ON DELETE CASCADE,
  slot            TEXT NOT NULL,          -- checklist item key
  storage_path    TEXT NOT NULL,
  sha256_hash     TEXT NOT NULL,
  exif_time       TIMESTAMPTZ,
  lat             NUMERIC,
  lng             NUMERIC,
  distance_m      INT,
  geofence_status TEXT,                   -- 'ok' | 'out_of_range' | 'gps_denied'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sha256_hash)        -- chống nộp lại cùng ảnh trong 1 phiên
);
CREATE INDEX IF NOT EXISTS idx_insp_photo_hash ON public.inspection_photos(sha256_hash);
COMMENT ON TABLE public.inspection_photos IS 'v5: ảnh camera-only từng mục checklist; hash để chống nộp lại/chụp hộ.';

-- ---------- 3. salary_attendance_day (SAD): xương sống ngày-công ----------
CREATE TABLE IF NOT EXISTS public.salary_attendance_day (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  work_date     DATE NOT NULL,
  -- 9 trạng thái (mục sửa B8): phép = leave_approved TRUNG TÍNH, không phải tick
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','pending_check','pending_leave','ticked',
                                  'leave_approved','neutral','expired','flagged','voided')),
  tick_source   TEXT CHECK (tick_source IN ('JOB','FULL','PAYMENT','MANUAL_DEVICE_ISSUE')),
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- append-only: [{at, source, ref_id, note}]
  voided_reason TEXT,
  audit         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{at, by, action, detail}] — xương sống kháng nghị C2
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)                        -- idempotent: 1 dòng/người/ngày
);
CREATE INDEX IF NOT EXISTS idx_sad_user_month ON public.salary_attendance_day(user_id, work_date);
COMMENT ON TABLE public.salary_attendance_day IS 'v5 SAD: 1 dòng/người/ngày. ticked = có ngày-công (binary). leave_approved = ngày trung tính (loại khỏi N_chuẩn, bắc cầu streak). Ghi CHỈ qua RPC SECURITY DEFINER.';

-- ---------- 4. salary_streak_state (SSS): trạng thái chuỗi theo tháng ----------
CREATE TABLE IF NOT EXISTS public.salary_streak_state (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_month         DATE NOT NULL,                 -- ngày 1 của tháng
  current_streak       INT NOT NULL DEFAULT 0,
  best_streak          INT NOT NULL DEFAULT 0,
  milestones_banked    JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{milestone, delta, banked_at}] — BANKED không rơi
  breaks_no_leave      INT NOT NULL DEFAULT 0,        -- số lần đứt KHÔNG-phép (full_month = 0)
  shields_free_left    INT NOT NULL DEFAULT 3,
  shields_reserve      INT NOT NULL DEFAULT 0,        -- cap tồn 2 (config)
  shields_reserve_used INT NOT NULL DEFAULT 0,        -- cap tiêu 1/tháng (config, chỉ nới)
  sim_cap2             JSONB NOT NULL DEFAULT '{}'::jsonb, -- mô phỏng cap tiêu 2 (US-6.3), KHÔNG hiển thị cho staff
  last_active_date     DATE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_month)
);
COMMENT ON TABLE public.salary_streak_state IS 'v5 SSS: best-streak BANKED theo tháng; recompute được 100% từ SAD + config. Ghi CHỈ qua RPC SECURITY DEFINER.';

-- ---------- 5. cron_runs: heartbeat + idempotency cho jobs ----------
CREATE TABLE IF NOT EXISTS public.cron_runs (
  id            BIGSERIAL PRIMARY KEY,
  job           TEXT NOT NULL,            -- 'tier' | 'score' | 'digest' | 'close_period'
  idem_key      TEXT NOT NULL,            -- vd '2026-07-03' / '2026-07' — chống chạy đôi
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  rows_affected INT,
  UNIQUE (job, idem_key)
);
COMMENT ON TABLE public.cron_runs IS 'v5: mỗi lần edge fn salary-v5-jobs chạy ghi 1 dòng; watchdog worker đọc heartbeat từ đây.';

-- ---------- 6. salary_award_errors: KHÔNG nuốt lỗi im lặng ----------
CREATE TABLE IF NOT EXISTS public.salary_award_errors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   UUID,
  fn_name    TEXT NOT NULL,
  source_id  UUID,
  error_text TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.salary_award_errors IS 'v5: mọi RPC ghi tiền/tick PHẢI log lỗi vào đây trước khi RAISE — truy vết "làm xong sao không thấy công".';

-- ---------- 7. GPS thu tiền: CHỈ income_expenses (mục sửa B6) ----------
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS collect_lat             NUMERIC,
  ADD COLUMN IF NOT EXISTS collect_lng             NUMERIC,
  ADD COLUMN IF NOT EXISTS collect_distance_m      INT,
  ADD COLUMN IF NOT EXISTS collect_geofence_status TEXT; -- 'ok' | 'out_of_range' | 'gps_denied'
COMMENT ON COLUMN public.income_expenses.collect_geofence_status IS 'v5: GPS lúc bấm Thu tiền, so với toà của phòng trên phiếu, bán kính từ config acceptance_geofence (1 nguồn sự thật — B11). Ghi nền im lặng, KHÔNG bao giờ chặn phiếu.';

-- ---------- 8. buildings.cluster_id: cụm địa lý cho piggyback/tuyến ----------
ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS cluster_id TEXT;
COMMENT ON COLUMN public.buildings.cluster_id IS 'v5: cụm đường (vd PVC, PVB) để gợi ý đi tuyến 1 chuyến 2-3 toà ≤500m.';

-- ---------- 9. ALTER CHECK salary_adjustments.source (+ATTEND_V5, STREAK_V5) ----------
ALTER TABLE public.salary_adjustments DROP CONSTRAINT IF EXISTS salary_adjustments_source_check;
ALTER TABLE public.salary_adjustments ADD CONSTRAINT salary_adjustments_source_check
  CHECK (source IN ('MANUAL','ADVANCE_IE','ROOM_RENT','KPI','ATTEND_V5','STREAK_V5'));

-- ---------- 10. VIEW building_coverage: derive D từ 3 nguồn dấu chân (US-1.1) ----------
CREATE OR REPLACE VIEW public.building_coverage AS
WITH touches AS (
  -- Nguồn 1: job hoàn thành có ảnh (camera-only pipeline sẵn có).
  -- LƯU Ý DỮ LIỆU THẬT: ảnh hoàn thành được MERGE vào jobs.attachments
  -- (completion_attachments đa số rỗng) → chấp nhận cả hai cột.
  SELECT j.building_id,
         public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS d,
         'job'::text AS src
  FROM public.jobs j
  WHERE j.status = 'COMPLETED'
    AND ( (jsonb_typeof(COALESCE(j.completion_attachments, '[]'::jsonb)) = 'array'
           AND jsonb_array_length(COALESCE(j.completion_attachments, '[]'::jsonb)) > 0)
       OR (jsonb_typeof(COALESCE(j.attachments, '[]'::jsonb)) = 'array'
           AND jsonb_array_length(COALESCE(j.attachments, '[]'::jsonb)) > 0) )
  UNION ALL
  -- Nguồn 2: phiên kiểm tra đạt presence trở lên (passed/quick_done/presence đều reset SLA)
  SELECT s.building_id, s.session_date, 'inspection'::text
  FROM public.inspection_sessions s
  WHERE s.status IN ('passed','quick_done','presence')
  UNION ALL
  -- Nguồn 3: phiếu thu bấm tại chỗ có GPS khớp toà
  SELECT ie.building_id,
         public.vn_local_date(ie.created_at),
         'payment'::text
  FROM public.income_expenses ie
  WHERE ie.collect_geofence_status = 'ok' AND ie.building_id IS NOT NULL
),
fulls AS (
  SELECT s.building_id, MAX(s.session_date) AS last_full_date
  FROM public.inspection_sessions s
  WHERE s.type = 'FULL' AND s.status = 'passed'
  GROUP BY s.building_id
),
jobs30 AS (
  SELECT j.building_id, COUNT(*) AS jobs_30d
  FROM public.jobs j
  WHERE j.status = 'COMPLETED'
    AND COALESCE(j.completion_time, j.created_at) >= now() - INTERVAL '30 days'
  GROUP BY j.building_id
)
SELECT b.id                                   AS building_id,
       b.name                                 AS building_name,
       b.cluster_id,
       (SELECT COUNT(*) FROM public.rooms r WHERE r.building_id = b.id)                            AS rooms_total,
       (SELECT COUNT(*) FROM public.rooms r WHERE r.building_id = b.id AND r.status = 'AVAILABLE') AS vacant_rooms,
       COALESCE(j30.jobs_30d, 0)              AS jobs_30d,
       t.last_touch_date,
       f.last_full_date,
       (public.vn_local_date(now()) - t.last_touch_date) AS days_since_touch,
       (public.vn_local_date(now()) - f.last_full_date)  AS days_since_full
FROM public.buildings b
LEFT JOIN (SELECT building_id, MAX(d) AS last_touch_date FROM touches GROUP BY building_id) t ON t.building_id = b.id
LEFT JOIN fulls f  ON f.building_id  = b.id
LEFT JOIN jobs30 j30 ON j30.building_id = b.id;
COMMENT ON VIEW public.building_coverage IS 'v5: đồng hồ D per toà từ 3 nguồn dấu chân (job/inspection/payment-GPS). VIEW derive — không materialize phase này.';

-- ---------- 11. RLS ----------
ALTER TABLE public.inspection_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspection_photos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_attendance_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_streak_state   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_runs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_award_errors   ENABLE ROW LEVEL SECURITY;

-- inspection_sessions: staff thấy + mở/sửa phiên CỦA MÌNH; admin thấy hết
DROP POLICY IF EXISTS insp_sess_select ON public.inspection_sessions;
CREATE POLICY insp_sess_select ON public.inspection_sessions FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS insp_sess_insert ON public.inspection_sessions;
CREATE POLICY insp_sess_insert ON public.inspection_sessions FOR INSERT
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS insp_sess_update ON public.inspection_sessions;
CREATE POLICY insp_sess_update ON public.inspection_sessions FOR UPDATE
  USING (user_id = auth.uid() OR public.is_admin());

-- inspection_photos: đọc theo phiên của mình; ghi qua RPC SECDEF (không policy insert cho staff)
DROP POLICY IF EXISTS insp_photo_select ON public.inspection_photos;
CREATE POLICY insp_photo_select ON public.inspection_photos FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.inspection_sessions s
                 WHERE s.id = session_id AND (s.user_id = auth.uid() OR public.is_admin())));

-- SAD/SSS: staff đọc CỦA MÌNH; mọi ghi qua RPC SECDEF
DROP POLICY IF EXISTS sad_select ON public.salary_attendance_day;
CREATE POLICY sad_select ON public.salary_attendance_day FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS sss_select ON public.salary_streak_state;
CREATE POLICY sss_select ON public.salary_streak_state FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());

-- cron_runs + salary_award_errors: chỉ admin đọc
DROP POLICY IF EXISTS cron_runs_admin ON public.cron_runs;
CREATE POLICY cron_runs_admin ON public.cron_runs FOR SELECT USING (public.is_admin());
DROP POLICY IF EXISTS sae_admin ON public.salary_award_errors;
CREATE POLICY sae_admin ON public.salary_award_errors FOR SELECT USING (public.is_admin());

GRANT SELECT ON public.building_coverage TO authenticated;
REVOKE ALL ON public.building_coverage FROM anon;

-- ---------- 12. Seed catalog settings v5 vào salary_bonus_rules.rules (US-1.3) ----------
-- Merge KHÔNG phá key cũ; feature flags OFF mặc định.
UPDATE public.salary_bonus_rules
SET rules = rules || jsonb_build_object(
  'attendance_v5', jsonb_build_object(
    'budget', 6000000,
    'paid_leave_days_per_month', 1,          -- range 0–4, không dồn
    'soft_floor', jsonb_build_object('enabled', true, 'at_days', 13, 'amount', 3000000),
    'supplement_deadline', '23:59',
    'snooze_last_remind', '17:00'
  ),
  'streak_v5', jsonb_build_object(
    'budget', 3000000,
    'milestones', jsonb_build_array(4, 8, 13, 18, 23, 'full_month'),
    'deltas', jsonb_build_array(300000, 500000, 600000, 600000, 500000, 500000), -- Σ = budget
    'shields_free', 3,
    'shield_earn', jsonb_build_object('max_breaks_no_leave', 1, 'gain', 1, 'cap_per_month', 1),
    'reserve_cap', 2,
    'spend_cap', 1                            -- chỉ được NỚI (1→2), không siết
  ),
  'coverage_v5', jsonb_build_object(
    'sla_days', 4, 'sla_hot_days', 3,
    'remind', jsonb_build_array(3, 4, 6), 'remind_hot', jsonb_build_array(2, 3, 5),
    'full_interval_days', 7,
    'dwell_min_minutes', jsonb_build_array(8, 12, 18),
    'photos_min', jsonb_build_array(4, 5, 7),
    'size_breaks', jsonb_build_array(10, 20),
    'points', jsonb_build_object('red', 25, 'yellow', 15, 'green', 5, 'perfect_day', 10),
    'busy_jobs_30d', 6, 'cluster_m', 500, 'quota_divisor', 4,
    'quiet_hours', jsonb_build_array('21:00', '07:00'),
    'grace_days', 14,
    'building_overrides', '{}'::jsonb          -- chỉ sla/dwell/photos/cờ-nóng per toà
  ),
  'system_v5', jsonb_build_object(
    'feature_flags', jsonb_build_object('v5_money', false, 'v5_coverage', false, 'fallback_v3', true),
    'stage', 'off',                            -- off|grace|shadow_coverage|shadow_money|live
    'cron_schedule', jsonb_build_object('tier','19:00','score','23:00','digest','00:00','close_period','20:00 last-day'), -- UTC
    'review_hours', 72, 'appeal_hours', 48,
    'config_version', 1,
    'pending_money_patch', NULL,               -- {patch, effective_month} — key 💰 hiệu lực tháng kế
    'audit', '[]'::jsonb
  )
)
WHERE NOT (rules ? 'system_v5');

-- ---------- 13. Calendar chung (C10): vn_workdays + v5_n_chuan ----------
-- Ngày-làm = T2–T7 trừ salary_holidays(owner). CN + lễ + phép-duyệt = trung tính.
CREATE OR REPLACE FUNCTION public.vn_workdays(p_month DATE)
RETURNS SETOF DATE
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d::date
  FROM generate_series(date_trunc('month', p_month),
                       date_trunc('month', p_month) + INTERVAL '1 month - 1 day',
                       INTERVAL '1 day') AS g(d)
  WHERE EXTRACT(dow FROM d) <> 0                     -- bỏ CN
    AND d::date NOT IN (
      SELECT h.holiday_date FROM public.salary_holidays h
      WHERE h.user_id = (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1)
    );
$$;
REVOKE ALL ON FUNCTION public.vn_workdays(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vn_workdays(DATE) TO authenticated, service_role;

-- N_chuẩn(user, tháng) = COUNT(T2–T7) − holidays − phép-đã-duyệt-CỦA-người-đó (mục sửa A2)
CREATE OR REPLACE FUNCTION public.v5_n_chuan(p_month DATE, p_user UUID)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT (SELECT COUNT(*) FROM public.vn_workdays(p_month))::int
       - (SELECT COUNT(*) FROM public.salary_attendance_day sad
          WHERE sad.user_id = p_user
            AND sad.status = 'leave_approved'
            AND sad.work_date >= date_trunc('month', p_month)::date
            AND sad.work_date <  (date_trunc('month', p_month) + INTERVAL '1 month')::date)::int;
$$;
REVOKE ALL ON FUNCTION public.v5_n_chuan(DATE, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_n_chuan(DATE, UUID) TO authenticated, service_role;

-- ---------- 14. RPC get_salary_v5_config(): 1 nguồn đọc config hiệu-lực (US-1.4) ----------
-- Merge default-đã-seed → global → (building_overrides để consumer tự áp per toà).
-- Key 💰 pending: nếu pending_money_patch.effective_month <= tháng VN hiện tại → merge lúc đọc
-- (job close_period sẽ vật chất hoá; đọc-hiệu-lực đảm bảo không lệch giữa 2 thời điểm).
CREATE OR REPLACE FUNCTION public.get_salary_v5_config()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner UUID;
  v_rules JSONB;
  v_pending JSONB;
  v_eff JSONB;
BEGIN
  SELECT user_id INTO v_owner FROM public.super_admins ORDER BY created_at LIMIT 1;
  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner;
  IF v_rules IS NULL OR NOT (v_rules ? 'system_v5') THEN
    RETURN NULL; -- chưa seed v5
  END IF;

  v_eff := jsonb_build_object(
    'attendance_v5', v_rules->'attendance_v5',
    'streak_v5',     v_rules->'streak_v5',
    'coverage_v5',   v_rules->'coverage_v5',
    'system_v5',     v_rules->'system_v5'
  );

  -- áp pending key 💰 nếu đã tới tháng hiệu lực
  v_pending := v_rules->'system_v5'->'pending_money_patch';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) = 'object'
     AND (v_pending->>'effective_month')::date <= date_trunc('month', public.vn_local_date(now()))::date THEN
    v_eff := v_eff || COALESCE(v_pending->'patch', '{}'::jsonb);
  END IF;

  RETURN v_eff || jsonb_build_object(
    'version', v_rules->'system_v5'->'config_version',
    'as_of', public.vn_local_date(now())
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_salary_v5_config() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_salary_v5_config() TO authenticated, service_role;

-- ---------- 15. RPC set_salary_v5_config(p_patch): owner-only + audit + 💰 hiệu lực tháng kế ----------
-- p_patch dạng {"attendance_v5": {...}, "coverage_v5": {...}, ...} (merge từng block).
-- attendance_v5/streak_v5 = KEY 💰 → gói vào pending_money_patch (effective đầu tháng kế).
-- coverage_v5/system_v5 = áp ngay (feature_flags/kill-switch phải tức thời).
CREATE OR REPLACE FUNCTION public.set_salary_v5_config(p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner UUID;
  v_rules JSONB;
  v_money JSONB := '{}'::jsonb;
  v_now   JSONB := '{}'::jsonb;
  v_key   TEXT;
  v_audit JSONB;
  v_next_month DATE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Chỉ chủ được đổi cấu hình lương v5';
  END IF;
  SELECT user_id INTO v_owner FROM public.super_admins ORDER BY created_at LIMIT 1;
  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key IN ('attendance_v5','streak_v5') THEN
      v_money := v_money || jsonb_build_object(v_key, (COALESCE(v_rules->v_key,'{}'::jsonb)) || (p_patch->v_key));
    ELSIF v_key IN ('coverage_v5','system_v5') THEN
      v_now := v_now || jsonb_build_object(v_key, (COALESCE(v_rules->v_key,'{}'::jsonb)) || (p_patch->v_key));
    ELSE
      RAISE EXCEPTION 'Block không hợp lệ: %', v_key;
    END IF;
  END LOOP;

  -- validate bất biến: Σ deltas = streak budget (nếu đổi streak_v5)
  IF v_money ? 'streak_v5' THEN
    IF (SELECT COALESCE(SUM(value::numeric),0) FROM jsonb_array_elements_text(v_money->'streak_v5'->'deltas'))
       <> (v_money->'streak_v5'->>'budget')::numeric THEN
      RAISE EXCEPTION 'Σ deltas phải bằng streak budget';
    END IF;
  END IF;
  IF v_money ? 'attendance_v5' THEN
    IF (v_money->'attendance_v5'->>'paid_leave_days_per_month')::int NOT BETWEEN 0 AND 4 THEN
      RAISE EXCEPTION 'paid_leave_days_per_month phải trong [0,4]';
    END IF;
  END IF;

  v_next_month := (date_trunc('month', public.vn_local_date(now())) + INTERVAL '1 month')::date;
  v_audit := COALESCE(v_rules->'system_v5'->'audit', '[]'::jsonb);
  v_audit := (v_audit || jsonb_build_array(jsonb_build_object(
    'at', now(), 'by', auth.uid(), 'patch', p_patch,
    'money_effective', CASE WHEN v_money <> '{}'::jsonb THEN to_jsonb(v_next_month) ELSE NULL END
  )));
  -- giữ tối đa 50 entry audit
  IF jsonb_array_length(v_audit) > 50 THEN
    v_audit := (SELECT jsonb_agg(e) FROM (
      SELECT e FROM jsonb_array_elements(v_audit) WITH ORDINALITY t(e, i)
      ORDER BY i DESC LIMIT 50) s);
  END IF;

  v_rules := v_rules || v_now; -- áp ngay coverage/system
  IF v_money <> '{}'::jsonb THEN
    v_rules := jsonb_set(v_rules, '{system_v5,pending_money_patch}',
      jsonb_build_object('patch', v_money, 'effective_month', v_next_month));
  END IF;
  v_rules := jsonb_set(v_rules, '{system_v5,audit}', v_audit);
  v_rules := jsonb_set(v_rules, '{system_v5,config_version}',
    to_jsonb(COALESCE((v_rules->'system_v5'->>'config_version')::int, 1) + 1));

  UPDATE public.salary_bonus_rules SET rules = v_rules, updated_at = now() WHERE user_id = v_owner;
  RETURN public.get_salary_v5_config();
END;
$$;
REVOKE ALL ON FUNCTION public.set_salary_v5_config(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_salary_v5_config(JSONB) TO authenticated;
