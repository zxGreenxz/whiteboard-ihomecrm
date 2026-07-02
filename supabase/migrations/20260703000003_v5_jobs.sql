-- ============================================================
-- V5 JOBS (S2b) — logic job định kỳ đặt TRONG DB (dễ test),
-- edge fn salary-v5-jobs chỉ là transport + cron_runs.
-- KHÔNG pg_cron (repo không có) — Vercel Cron + worker watchdog gọi edge fn.
-- Job KHÔNG SINH TIỀN — cron chết 1 tuần không sai lương.
-- REVERT: scripts/v5_rollback_s2.sql
-- ============================================================

-- ---------- cron_runs helpers (idempotent + heartbeat) ----------
CREATE OR REPLACE FUNCTION public.v5_cron_start(p_job TEXT, p_idem TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.cron_runs(job, idem_key) VALUES (p_job, p_idem);
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false; -- đã chạy (idempotent) — caller bỏ qua
END; $$;

CREATE OR REPLACE FUNCTION public.v5_cron_finish(p_job TEXT, p_idem TEXT, p_rows INT, p_error TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.cron_runs SET finished_at = now(), rows_affected = p_rows, error = p_error
  WHERE job = p_job AND idem_key = p_idem;
$$;

-- ---------- TIER (02:00 VN, gộp vào nightly): dọn phiên/SAD quá hạn ----------
CREATE OR REPLACE FUNCTION public.v5_run_tier()
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_expired INT;
BEGIN
  v_expired := public.v5_expire_stale(public.vn_local_date(now()));
  RETURN jsonb_build_object('expired_sessions', v_expired);
END; $$;

-- ---------- SCORE (06:00 VN, gộp nightly): tuyến gợi ý per staff ----------
-- Trả điểm ưu tiên per (staff, toà) từ VIEW building_coverage + scope staff_assignments.
-- score = D×(1+P/20) + 10·phòng-trống + 5·HĐ-đáo-hạn(cap 10) + 15·sự-cố-mở (kỳ-thu để S3 khi nối chu kỳ thu)
CREATE OR REPLACE FUNCTION public.v5_daily_missions(p_user UUID)
RETURNS TABLE (
  building_id UUID, building_name TEXT, cluster_id TEXT,
  days_since_touch INT, days_since_full INT, vacant_rooms BIGINT,
  score NUMERIC, color TEXT, reason TEXT
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_sla INT := COALESCE((v_cfg->'coverage_v5'->>'sla_days')::int, 4);
  v_sla_hot INT := COALESCE((v_cfg->'coverage_v5'->>'sla_hot_days')::int, 3);
  v_remind JSONB := COALESCE(v_cfg->'coverage_v5'->'remind', '[3,4,6]'::jsonb);
  v_remind_hot JSONB := COALESCE(v_cfg->'coverage_v5'->'remind_hot', '[2,3,5]'::jsonb);
BEGIN
  RETURN QUERY
  WITH scope AS (
    SELECT DISTINCT sa.building_id FROM public.staff_assignments sa WHERE sa.staff_id = p_user AND sa.building_id IS NOT NULL
  ), base AS (
    SELECT bc.building_id, bc.building_name, bc.cluster_id,
           COALESCE(bc.days_since_touch, 999) AS d,
           COALESCE(bc.days_since_full, 999) AS df,
           bc.vacant_rooms, bc.rooms_total,
           (SELECT COUNT(*) FROM public.contracts c JOIN public.rooms r ON r.id = c.room_id
            WHERE r.building_id = bc.building_id AND c.status = 'ACTIVE'
              AND c.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS expiring,
           (SELECT COUNT(*) FROM public.jobs j WHERE j.building_id = bc.building_id AND j.status = 'IN_PROGRESS') AS open_jobs
    FROM public.building_coverage bc JOIN scope s ON s.building_id = bc.building_id
    WHERE bc.rooms_total > 0
  )
  SELECT b.building_id, b.building_name, b.cluster_id,
         NULLIF(b.d, 999)::int, NULLIF(b.df, 999)::int, b.vacant_rooms,
         ROUND(LEAST(b.d, 60) * (1 + b.rooms_total / 20.0)
               + CASE WHEN b.vacant_rooms > 0 THEN 10 ELSE 0 END
               + LEAST(5 * b.expiring, 10)
               + CASE WHEN b.open_jobs > 0 THEN 15 ELSE 0 END, 1) AS score,
         CASE
           WHEN b.d >= (CASE WHEN b.vacant_rooms > 0 THEN (v_remind_hot->>1)::int ELSE (v_remind->>1)::int END) THEN 'red'
           WHEN b.d >= (CASE WHEN b.vacant_rooms > 0 THEN (v_remind_hot->>0)::int ELSE (v_remind->>0)::int END) THEN 'yellow'
           ELSE 'green'
         END AS color,
         TRIM(BOTH ' ·' FROM CONCAT_WS(' · ',
           CASE WHEN b.d >= 999 THEN 'Chưa có dấu chân nào' ELSE b.d || ' ngày chưa ghé' END,
           CASE WHEN b.vacant_rooms > 0 THEN b.vacant_rooms || ' phòng đang chào khách' END,
           CASE WHEN b.expiring > 0 THEN b.expiring || ' HĐ sắp đáo hạn' END,
           CASE WHEN b.open_jobs > 0 THEN 'có việc đang mở' END
         )) AS reason
  FROM base b
  ORDER BY score DESC;
END; $$;
REVOKE ALL ON FUNCTION public.v5_daily_missions(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_daily_missions(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.v5_run_score()
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT := 0; v_staff RECORD;
BEGIN
  FOR v_staff IN SELECT DISTINCT staff_id FROM public.staff_assignments WHERE building_id IS NOT NULL LOOP
    v_n := v_n + (SELECT COUNT(*) FROM public.v5_daily_missions(v_staff.staff_id));
  END LOOP;
  RETURN jsonb_build_object('mission_rows', v_n);
END; $$;

-- ---------- DIGEST (07:00 VN): 1 bản tin gộp/người/ngày ----------
-- Trả danh sách push cần gửi; edge fn gửi qua send-push rồi finish.
-- Dedup: notifications metadata v5=digest theo (user, date); tắt CN + ngày phép-duyệt.
CREATE OR REPLACE FUNCTION public.v5_run_digest()
RETURNS TABLE (user_id UUID, title TEXT, body TEXT, url TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := public.vn_local_date(now());
  v_staff RECORD; v_m RECORD;
  v_lines TEXT; v_cnt INT;
BEGIN
  IF EXTRACT(dow FROM v_today) = 0 THEN RETURN; END IF; -- CN nghỉ, không digest
  FOR v_staff IN SELECT DISTINCT sa.staff_id FROM public.staff_assignments sa WHERE sa.building_id IS NOT NULL LOOP
    -- ngày phép-duyệt: im lặng
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.salary_attendance_day d
      WHERE d.user_id = v_staff.staff_id AND d.work_date = v_today AND d.status IN ('leave_approved','pending_leave'));
    v_lines := ''; v_cnt := 0;
    FOR v_m IN SELECT * FROM public.v5_daily_missions(v_staff.staff_id) WHERE color IN ('red','yellow') LIMIT 3 LOOP
      v_cnt := v_cnt + 1;
      v_lines := v_lines || CASE WHEN v_lines = '' THEN '' ELSE E'\n' END || '• ' || v_m.building_name || ' — ' || v_m.reason;
    END LOOP;
    CONTINUE WHEN v_cnt = 0;
    BEGIN
      INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
      VALUES (v_staff.staff_id, 'CUSTOM', 'IN_APP', 'PENDING',
        'Tuyến hôm nay: ' || v_cnt || ' toà nên ghé', v_lines,
        jsonb_build_object('v5','digest','date', v_today, 'url', '/my-day'));
    EXCEPTION WHEN unique_violation THEN CONTINUE; -- đã digest hôm nay
    END;
    user_id := v_staff.staff_id;
    title := 'Tuyến hôm nay: ' || v_cnt || ' toà nên ghé';
    body := v_lines;
    url := '/my-day';
    RETURN NEXT;
  END LOOP;
END; $$;
-- dedup digest 1/người/ngày
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_v5_digest
  ON public.notifications (user_id, (metadata->>'date'))
  WHERE (metadata->>'v5') = 'digest';

-- ---------- CLOSE_PERIOD (03:00–06:45 VN ngày 1): chuyển tháng ----------
-- 1) expire dồn của tháng cũ; 2) vật chất hoá pending money config;
-- 3) chốt streak tháng cũ: bank full_month nếu đứt-không-phép = 0;
-- 4) mở SSS tháng mới: free reset; reserve carry + earn (đứt-không-phép ≤1 → +1, cap tồn).
-- (LOCK/salary_adjustments do CHỦ bấm ở S4 — job này KHÔNG sinh tiền.)
CREATE OR REPLACE FUNCTION public.v5_close_period(p_new_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev DATE := (date_trunc('month', p_new_month) - INTERVAL '1 month')::date;
  v_new DATE := date_trunc('month', p_new_month)::date;
  v_cfg JSONB;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_rules JSONB;
  v_pending JSONB;
  v_staff RECORD;
  v_sss public.salary_streak_state;
  v_n INT; v_miles JSONB; v_fm JSONB;
  v_earn INT; v_reserve INT;
  v_processed INT := 0;
BEGIN
  PERFORM public.v5_expire_stale(v_new);

  -- vật chất hoá pending money patch (đọc-hiệu-lực đã áp; đây là bước ghi cứng)
  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;
  v_pending := v_rules->'system_v5'->'pending_money_patch';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) = 'object'
     AND (v_pending->>'effective_month')::date <= v_new THEN
    v_rules := v_rules || COALESCE(v_pending->'patch', '{}'::jsonb);
    v_rules := jsonb_set(v_rules, '{system_v5,pending_money_patch}', 'null'::jsonb);
    UPDATE public.salary_bonus_rules SET rules = v_rules, updated_at = now() WHERE user_id = v_owner;
  END IF;
  v_cfg := public.get_salary_v5_config();

  FOR v_staff IN SELECT DISTINCT staff_id FROM public.staff_assignments WHERE building_id IS NOT NULL LOOP
    -- chốt tháng cũ
    PERFORM public.v5_recompute_streak(v_staff.staff_id, v_prev);
    SELECT * INTO v_sss FROM public.salary_streak_state WHERE user_id = v_staff.staff_id AND period_month = v_prev;
    IF FOUND THEN
      v_n := public.v5_n_chuan(v_prev, v_staff.staff_id);
      v_miles := public.public_v5_effective_milestones(v_cfg->'streak_v5'->'milestones', v_cfg->'streak_v5'->'deltas', v_n);
      SELECT m INTO v_fm FROM jsonb_array_elements(v_miles) m WHERE m->>'milestone' = 'full_month';
      -- TRỌN THÁNG: đứt-không-phép = 0 (khiên cứu vẫn tính là lỡ — phải sạch tuyệt đối)
      IF v_sss.breaks_no_leave = 0 AND v_fm IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sss.milestones_banked) b WHERE b->>'milestone' = 'full_month') THEN
        UPDATE public.salary_streak_state
        SET milestones_banked = milestones_banked || jsonb_build_array(jsonb_build_object(
              'milestone','full_month','delta',(v_fm->>'delta')::numeric,'banked_at', now())),
            updated_at = now()
        WHERE user_id = v_staff.staff_id AND period_month = v_prev;
      END IF;
      -- khiên dự trữ tháng mới: carry + earn (đứt-không-phép ≤ 1 → +1), cap tồn
      v_earn := CASE WHEN v_sss.breaks_no_leave <= COALESCE((v_cfg->'streak_v5'->'shield_earn'->>'max_breaks_no_leave')::int,1)
                     THEN COALESCE((v_cfg->'streak_v5'->'shield_earn'->>'gain')::int,1) ELSE 0 END;
      v_reserve := LEAST(COALESCE((v_cfg->'streak_v5'->>'reserve_cap')::int,2),
                         GREATEST(v_sss.shields_reserve - v_sss.shields_reserve_used, 0) + v_earn);
    ELSE
      v_reserve := 0;
    END IF;
    INSERT INTO public.salary_streak_state (user_id, period_month, shields_free_left, shields_reserve)
    VALUES (v_staff.staff_id, v_new, COALESCE((v_cfg->'streak_v5'->>'shields_free')::int,3), v_reserve)
    ON CONFLICT (user_id, period_month) DO UPDATE SET shields_reserve = EXCLUDED.shields_reserve, updated_at = now();
    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object('prev_month', v_prev, 'new_month', v_new, 'staff_processed', v_processed);
END; $$;

-- Job runner tổng (edge fn gọi 1 hàm — mọi logic + quyền trong DB)
CREATE OR REPLACE FUNCTION public.v5_run_job(p_job TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_job = 'tier' THEN RETURN public.v5_run_tier();
  ELSIF p_job = 'score' THEN RETURN public.v5_run_score();
  ELSIF p_job = 'close_period' THEN RETURN public.v5_close_period(date_trunc('month', public.vn_local_date(now()))::date);
  ELSE RAISE EXCEPTION 'job không hợp lệ: %', p_job;
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.v5_run_tier() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v5_run_score() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v5_run_digest() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v5_close_period(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v5_run_job(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v5_cron_start(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v5_cron_finish(TEXT, TEXT, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_run_tier() TO service_role;
GRANT EXECUTE ON FUNCTION public.v5_run_score() TO service_role;
GRANT EXECUTE ON FUNCTION public.v5_run_digest() TO service_role;
GRANT EXECUTE ON FUNCTION public.v5_close_period(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.v5_run_job(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.v5_cron_start(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.v5_cron_finish(TEXT, TEXT, INT, TEXT) TO service_role;
