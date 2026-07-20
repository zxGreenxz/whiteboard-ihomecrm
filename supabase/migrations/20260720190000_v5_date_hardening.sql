-- =============================================
-- Migration: Gia co truc THOI GIAN cua engine V5 (audit 2026-07-20)
--
-- 4 loi doc lap, deu lien quan "moc thoi gian nao duoc dung":
--
-- (1) v5_tick_from_job — bo fallback `COALESCE(completion_time, created_at)`.
--     Sau 20260720180000 da co CHECK bao dam COMPLETED => completion_time NOT
--     NULL, nen fallback la code chet. Bo di de neu co gi sai thi no LOI TO
--     thay vi am tham cham cong theo NGAY TAO.
--
-- (2) v5_tick_attendance — KHONG he validate p_date (chi validate p_source).
--     Them clamp: tu choi ngay tuong lai va tu choi ghi vao thang DA CHOT.
--
-- (3) complete_inspection — phien mo 23:50, hoan thanh 00:10 bi danh `expired`
--     va return SOM => v5_tick_attendance khong bao gio chay. Mat ca ngay cong
--     (~230k) LAN moc tron thang (500k) vi breaks_no_leave += 1. Bat ky ai bat
--     dau trong 8 phut truoc nua dem deu roi vao ho nay VE MAT CAU TRUC (cong
--     dwell yeu cau 8-15 phut tai cho). Sua: an han 4 gio qua nua dem, tick vao
--     dung `session_date` cua phien (= ngay BAT DAU, la ngay nhan vien co mat).
--
-- (4) v5_recompute_streak — moc `full_month` chi duoc `v5_close_period` bank
--     MOT LAN duy nhat (07:13 ngay mung 1), va bi chan boi idem_key theo THANG
--     tren cron_runs => nut "Chay lai" la no-op im lang. Duyet phep / tick bu
--     su co thiet bi SAU ngay 1 khong bao gio duoc danh gia lai. Sua: dua viec
--     danh gia full_month vao chinh recompute (gate "thang da troi het"), nen
--     moi lan recompute deu phan anh du lieu moi nhat.
--     Luu y: danh gia lai chay CA HAI CHIEU — neu mot ngay bi void sau khi da
--     bank, moc se bi go. Thang da LOCKED khong bi anh huong (salary_monthly
--     dong bang rieng).
--
-- (5) v5_daily_missions — `CURRENT_DATE` la bieu thuc ngay DUY NHAT trong 8
--     file v5 khong di qua vn_local_date(). Session timezone = UTC nen tu
--     00:00-07:00 VN no la HOM QUA. Chi anh huong `score` + chuoi ly do, khong
--     anh huong tien — nhung pha quy uoc.
-- =============================================

BEGIN;

-- ---------------------------------------------------------------------------
-- (2) v5_tick_attendance: clamp p_date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.v5_tick_attendance(
  p_user UUID, p_date DATE, p_source TEXT, p_ref UUID, p_note TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB;
  v_month DATE := date_trunc('month', p_date)::date;
  v_already BOOLEAN := false;
  v_n INT;
  v_rate NUMERIC;
  v_ticked INT;
  v_streak JSONB;
BEGIN
  IF p_source NOT IN ('JOB','FULL','PAYMENT','MANUAL_DEVICE_ISSUE') THEN
    RAISE EXCEPTION 'tick_source không hợp lệ: %', p_source;
  END IF;
  -- Clamp ngày (20260720190000): ngày công không được ở tương lai, và không
  -- được ghi vào kỳ lương đã chốt (snapshot đã đóng băng → sẽ lệch sổ).
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Ngày chấm công không được rỗng.';
  END IF;
  IF p_date > public.vn_local_date(now()) THEN
    RAISE EXCEPTION 'Không thể chấm công cho ngày tương lai (%).', p_date;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.salary_monthly sm
    WHERE sm.staff_id = p_user AND sm.period_month = v_month AND sm.locked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Kỳ lương % đã chốt — không thể thêm ngày công.', to_char(v_month, 'MM/YYYY');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('v5_tick' || p_user::text || p_date::text));

  INSERT INTO public.salary_attendance_day (user_id, work_date, status, tick_source, evidence)
  VALUES (p_user, p_date, 'ticked', p_source,
          jsonb_build_array(jsonb_build_object('at', now(), 'source', p_source, 'ref_id', p_ref, 'note', p_note)))
  ON CONFLICT (user_id, work_date) DO UPDATE SET
    -- ngày đã ticked: chỉ append evidence (binary — không double);
    -- pending*/neutral → nâng thành ticked; voided/flagged/expired/leave_approved GIỮ NGUYÊN (xử qua đường riêng)
    status = CASE WHEN salary_attendance_day.status IN ('pending','pending_check','pending_leave','neutral')
                  THEN 'ticked' ELSE salary_attendance_day.status END,
    tick_source = CASE WHEN salary_attendance_day.status IN ('pending','pending_check','pending_leave','neutral')
                       THEN p_source ELSE salary_attendance_day.tick_source END,
    evidence = salary_attendance_day.evidence ||
               jsonb_build_array(jsonb_build_object('at', now(), 'source', p_source, 'ref_id', p_ref, 'note', p_note)),
    updated_at = now();

  SELECT status <> 'ticked' OR tick_source <> p_source INTO v_already
  FROM public.salary_attendance_day WHERE user_id = p_user AND work_date = p_date;

  -- gỡ thông báo treo pending_check của ngày này (nếu có) khi đã tick
  UPDATE public.notifications SET status = 'READ'
  WHERE user_id = p_user AND (metadata->>'v5') = 'pending_check' AND (metadata->>'date') = p_date::text
    AND status <> 'READ';

  -- cập nhật chuỗi (recompute từ SAD — nguồn sự thật duy nhất)
  v_streak := public.v5_recompute_streak(p_user, v_month);

  v_cfg := public.get_salary_v5_config();
  v_n := public.v5_n_chuan(v_month, p_user);
  v_rate := CASE WHEN v_n > 0 THEN (v_cfg->'attendance_v5'->>'budget')::numeric / v_n ELSE 0 END;
  SELECT COUNT(*) INTO v_ticked FROM public.salary_attendance_day
  WHERE user_id = p_user AND status = 'ticked'
    AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;

  RETURN jsonb_build_object(
    'ticked', true,
    'already_ticked_today', (SELECT status = 'ticked' FROM public.salary_attendance_day
                             WHERE user_id = p_user AND work_date = p_date) AND v_ticked > 0,
    'work_date', p_date, 'source', p_source,
    'n_chuan', v_n, 'day_rate', ROUND(v_rate), 'ticked_days', v_ticked,
    'attend_tam_tinh', ROUND(v_rate * LEAST(v_ticked, v_n)),
    'streak', v_streak
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (p_user, 'v5_tick_attendance', p_ref, SQLERRM,
          jsonb_build_object('date', p_date, 'source', p_source));
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.v5_tick_attendance(UUID, DATE, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_tick_attendance(UUID, DATE, TEXT, UUID, TEXT) TO service_role;
-- (chỉ các RPC SECDEF bên dưới gọi nội bộ; client KHÔNG gọi trực tiếp hàm lõi)

-- ---------------------------------------------------------------------------
-- (1) v5_tick_from_job: bo fallback created_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.v5_tick_from_job(p_job_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_j public.jobs;
BEGIN
  SELECT * INTO v_j FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND OR v_j.status <> 'COMPLETED' OR v_j.assignee_id <> v_uid THEN
    RETURN jsonb_build_object('ticked', false, 'reason', 'job_not_eligible');
  END IF;
  -- bằng chứng ảnh: chấp nhận cả attachments (nơi ảnh được merge) lẫn completion_attachments
  IF NOT public.job_photo_ok(v_j.completion_attachments, v_j.attachments) THEN
    RETURN jsonb_build_object('ticked', false, 'reason', 'no_photo_evidence');
  END IF;
  -- completion_time NOT NULL được bảo đảm bởi CHECK jobs_completed_needs_completion_time
  RETURN public.v5_tick_attendance(v_uid, public.vn_local_date(v_j.completion_time), 'JOB', p_job_id, v_j.title);
END; $$;
REVOKE ALL ON FUNCTION public.v5_tick_from_job(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_tick_from_job(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- (3) complete_inspection: an han 4 gio qua nua dem
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_inspection(p_session UUID, p_condition_note TEXT DEFAULT 'OK')
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_sess public.inspection_sessions;
  v_reqs JSONB;
  v_missing TEXT[] := '{}';
  v_dwell_total INT;
  v_photos_ok INT;
  v_geo_ok BOOLEAN;
  v_pass BOOLEAN;
  v_tick JSONB := NULL;
  v_spawned UUID := NULL;
  v_pending_b BOOLEAN := false;
  it JSONB;
BEGIN
  SELECT * INTO v_sess FROM public.inspection_sessions WHERE id = p_session;
  IF NOT FOUND OR v_sess.user_id <> v_uid THEN RAISE EXCEPTION 'Phiên không hợp lệ'; END IF;
  IF v_sess.status NOT IN ('open','presence') THEN
    RETURN jsonb_build_object('status', v_sess.status, 'message', 'Phiên đã đóng trước đó');
  END IF;
  -- Ân hạn qua nửa đêm (20260720190000): phiên bắt đầu 23:50 hoàn thành 00:10 KHÔNG
  -- được rơi vào khoảng trống. Ngày công tính theo session_date (ngày nhân viên
  -- thực sự có mặt), miễn là chưa quá 4 giờ kể từ lúc bắt đầu.
  IF v_sess.session_date <> public.vn_local_date(now())
     AND now() - v_sess.started_at > INTERVAL '4 hours' THEN
    UPDATE public.inspection_sessions SET status='expired', ended_at=now(), updated_at=now() WHERE id = p_session;
    RETURN jsonb_build_object('status','expired','message','Phiên đã quá hạn — hôm nay là cơ hội mới');
  END IF;

  v_reqs := public.v5_building_reqs(v_sess.building_id);

  -- Chốt dwell phiên hiện tại = now - started_at (cap 900s) — đồng hồ thật, không cần chụp thêm ảnh
  UPDATE public.inspection_sessions SET
    dwell_seconds = GREATEST(dwell_seconds, LEAST(EXTRACT(EPOCH FROM (now() - started_at))::int, 900)),
    updated_at = now()
  WHERE id = p_session;

  -- Σ dwell các phiên CÙNG NGÀY CÙNG TOÀ (C1 — cộng dồn), mỗi phiên cap 900s
  SELECT COALESCE(SUM(LEAST(GREATEST(dwell_seconds,
           COALESCE(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))::int, 0)), 900)), 0)
  INTO v_dwell_total
  FROM public.inspection_sessions
  WHERE user_id = v_uid AND building_id = v_sess.building_id AND session_date = v_sess.session_date;

  SELECT COUNT(*) INTO v_photos_ok FROM public.inspection_photos WHERE session_id = p_session;
  SELECT EXISTS (SELECT 1 FROM public.inspection_photos WHERE session_id = p_session AND geofence_status = 'ok')
    INTO v_geo_ok;

  IF v_sess.type = 'QUICK' THEN
    v_pass := v_photos_ok >= 2 AND v_geo_ok;
    IF NOT v_pass THEN
      IF v_photos_ok < 2 THEN v_missing := array_append(v_missing, 'Còn ' || (2 - v_photos_ok) || ' ảnh nữa'); END IF;
      IF NOT v_geo_ok THEN v_missing := array_append(v_missing, 'Cần ≥1 ảnh trong bán kính toà'); END IF;
    END IF;
  ELSE
    FOR it IN SELECT * FROM jsonb_array_elements(v_sess.checklist) LOOP
      IF (it->>'required')::boolean AND NOT COALESCE((it->>'done')::boolean, false) THEN
        v_missing := array_append(v_missing, it->>'label');
      END IF;
    END LOOP;
    IF v_photos_ok < (v_reqs->>'photos_min')::int THEN
      v_missing := array_append(v_missing, 'Còn ' || ((v_reqs->>'photos_min')::int - v_photos_ok) || ' ảnh nữa');
    END IF;
    IF v_dwell_total < (v_reqs->>'dwell_min_seconds')::int THEN
      v_missing := array_append(v_missing,
        'Ở lại thêm ' || CEIL(((v_reqs->>'dwell_min_seconds')::int - v_dwell_total) / 60.0) || ' phút nữa');
    END IF;
    IF NOT v_geo_ok THEN v_missing := array_append(v_missing, 'Cần ≥1 ảnh trong bán kính toà'); END IF;
    v_pass := COALESCE(array_length(v_missing, 1), 0) = 0;
  END IF;

  IF v_pass AND v_sess.type = 'FULL' AND p_condition_note IS NOT NULL AND p_condition_note <> 'OK' THEN
    INSERT INTO public.jobs (user_id, title, description, building_id, status, priority, assignee_id)
    VALUES (v_uid, 'Sửa chữa từ kiểm tra nhà', p_condition_note, v_sess.building_id, 'IN_PROGRESS', 'NORMAL', v_uid)
    RETURNING id INTO v_spawned;
  END IF;

  IF v_pass THEN
    UPDATE public.inspection_sessions SET
      status = CASE WHEN type = 'FULL' THEN 'passed' ELSE 'quick_done' END,
      condition_note = p_condition_note, spawned_job_id = v_spawned,
      ended_at = now(), fail_reasons = NULL, updated_at = now()
    WHERE id = p_session;

    IF v_sess.type = 'FULL' THEN
      v_tick := public.v5_tick_attendance(v_uid, v_sess.session_date, 'FULL', p_session, NULL);
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.salary_attendance_day sad
        WHERE sad.user_id = v_uid AND sad.work_date = v_sess.session_date AND sad.status = 'pending_check'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(sad.evidence) e
                      WHERE e->>'kind' = 'pending_check' AND e->>'building_id' = v_sess.building_id::text)
      ) INTO v_pending_b;
      IF v_pending_b THEN
        v_tick := public.v5_tick_attendance(v_uid, v_sess.session_date, 'PAYMENT', p_session, 'check-sau-thu-tiền');
      END IF;
    END IF;

    RETURN jsonb_build_object('status', CASE WHEN v_sess.type='FULL' THEN 'passed' ELSE 'quick_done' END,
                              'spawned_job_id', v_spawned, 'tick', v_tick,
                              'dwell_total_seconds', v_dwell_total);
  ELSE
    UPDATE public.inspection_sessions SET
      status = 'presence',
      condition_note = p_condition_note, fail_reasons = v_missing, updated_at = now()
    WHERE id = p_session;
    RETURN jsonb_build_object('status', 'presence', 'missing', to_jsonb(v_missing),
      'message', 'Còn ' || COALESCE(array_length(v_missing,1),0) || ' mục nữa là đủ công hôm nay',
      'dwell_total_seconds', v_dwell_total);
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (v_uid, 'complete_inspection', p_session, SQLERRM, NULL);
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.complete_inspection(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_inspection(UUID, TEXT) TO authenticated;

-- v5_expire_stale khong duoc quet mat phien trong cua so an han 4 gio.
CREATE OR REPLACE FUNCTION public.v5_expire_stale(p_before DATE)
RETURNS INT LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT;
BEGIN
  UPDATE public.inspection_sessions SET status='expired', updated_at=now()
  WHERE status IN ('open','presence') AND session_date < p_before
    AND now() - started_at > INTERVAL '4 hours';  -- ân hạn qua nửa đêm (20260720190000)
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.salary_attendance_day SET status='expired', updated_at=now()
  WHERE status IN ('pending','pending_check') AND work_date < p_before;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.v5_expire_stale(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_expire_stale(DATE) TO service_role;

-- ---------------------------------------------------------------------------
-- (4) v5_recompute_streak: danh gia lai moc full_month
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.v5_recompute_streak(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_today DATE := public.vn_local_date(now());
  v_start DATE := date_trunc('month', p_month)::date;
  v_month_end DATE := (v_start + INTERVAL '1 month')::date - 1;
  v_end DATE := LEAST((v_start + INTERVAL '1 month')::date - 1, v_today);
  v_reset DATE;
  v_free_cap INT := COALESCE((v_cfg->'streak_v5'->>'shields_free')::int, 3);
  v_spend_cap INT := COALESCE((v_cfg->'streak_v5'->>'spend_cap')::int, 1);
  v_reserve INT;
  v_free INT; v_res_used INT := 0;
  v_cur INT := 0; v_best INT := 0; v_breaks INT := 0;
  v_cur2 INT := 0; v_best2 INT := 0; v_free2 INT; v_res2 INT; v_res_used2 INT := 0; -- sim cap 2
  v_d DATE;
  v_status TEXT;
  v_is_workday BOOLEAN;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_n INT;
  v_miles JSONB;
  v_deltas JSONB := v_cfg->'streak_v5'->'deltas';
  v_banked JSONB := '[]'::jsonb;
  v_prev_banked JSONB;
  v_last_active DATE;
  v_fm JSONB;
  m JSONB;
  i INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('v5_sss' || p_user::text || v_start::text));
  SELECT milestones_banked, shields_reserve, reset_from_date
    INTO v_prev_banked, v_reserve, v_reset
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_start;
  v_prev_banked := COALESCE(v_prev_banked, '[]'::jsonb);
  v_reserve := COALESCE(v_reserve, 0);
  v_free := v_free_cap; v_free2 := v_free_cap; v_res2 := v_reserve;

  v_n := public.v5_n_chuan(v_start, p_user);
  v_miles := public_v5_effective_milestones(v_cfg->'streak_v5'->'milestones', v_deltas, v_n);

  v_d := v_start;
  WHILE v_d <= v_end LOOP
    IF v_reset IS NOT NULL AND v_d < v_reset THEN
      v_cur := 0; v_cur2 := 0; -- trước mốc reset (án gian lận): trung tính, không tích
      v_d := v_d + 1; CONTINUE;
    END IF;
    v_is_workday := EXTRACT(dow FROM v_d) <> 0
      AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = v_d);
    SELECT status INTO v_status FROM public.salary_attendance_day
      WHERE user_id = p_user AND work_date = v_d;

    IF NOT v_is_workday OR v_status IN ('leave_approved','pending_leave') THEN
      NULL; -- bắc cầu: CN / lễ / phép (kể cả phép đang chờ — bridge tạm US-2.6)
    ELSIF v_status = 'ticked' THEN
      v_cur := v_cur + 1; v_best := GREATEST(v_best, v_cur);
      v_cur2 := v_cur2 + 1; v_best2 := GREATEST(v_best2, v_cur2);
      v_last_active := v_d;
    ELSIF v_d < v_today THEN
      -- ngày-làm quá khứ không tick, không phép → lỡ
      v_breaks := v_breaks + 1;
      IF v_free > 0 THEN v_free := v_free - 1;               -- khiên miễn phí: bắc cầu
      ELSIF v_reserve - v_res_used > 0 AND v_res_used < v_spend_cap THEN v_res_used := v_res_used + 1;
      ELSE v_cur := 0; END IF;                                -- đứt
      IF v_free2 > 0 THEN v_free2 := v_free2 - 1;
      ELSIF v_res2 - v_res_used2 > 0 AND v_res_used2 < 2 THEN v_res_used2 := v_res_used2 + 1;
      ELSE v_cur2 := 0; END IF;
    END IF;
    v_d := v_d + 1;
  END LOOP;

  -- bank mốc theo best (full_month xử riêng bên dưới)
  FOR i IN 0 .. jsonb_array_length(v_miles) - 1 LOOP
    m := v_miles->i;
    IF (m->>'milestone') <> 'full_month' AND (m->>'milestone')::int <= v_best THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', (m->>'milestone')::int, 'delta', (m->>'delta')::numeric,
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE b->>'milestone' = m->>'milestone' LIMIT 1), now()::text)));
    END IF;
  END LOOP;

  -- TRỌN THÁNG (20260720190000): đánh giá NGAY TẠI ĐÂY thay vì chỉ ở v5_close_period.
  -- Trước đây close_period bank một lần duy nhất sáng mùng 1 và bị idem_key theo
  -- THÁNG chặn chạy lại → duyệt phép / tick bù sự cố thiết bị sau ngày 1 không bao
  -- giờ được tính. Giờ mỗi lần recompute (tick, duyệt phép, admin bấm) đều phản ánh
  -- dữ liệu mới nhất. Gate: tháng đã trôi hết + sạch tuyệt đối + không án gian lận.
  SELECT m INTO v_fm FROM jsonb_array_elements(v_miles) m WHERE m->>'milestone' = 'full_month';
  IF v_month_end < v_today THEN
    IF v_fm IS NOT NULL AND v_breaks = 0 AND v_reset IS NULL THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', 'full_month', 'delta', (v_fm->>'delta')::numeric,
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE b->>'milestone' = 'full_month' LIMIT 1), now()::text)));
    END IF;
    -- tháng đã hết mà không sạch → KHÔNG giữ mốc cũ (đánh giá lại cả hai chiều)
  ELSE
    -- tháng đang chạy: giữ nguyên nếu close_period đã bank trước đó
    v_banked := v_banked || COALESCE(
      (SELECT jsonb_agg(b) FROM jsonb_array_elements(v_prev_banked) b WHERE b->>'milestone' = 'full_month'),
      '[]'::jsonb);
  END IF;

  INSERT INTO public.salary_streak_state AS s
    (user_id, period_month, current_streak, best_streak, milestones_banked, breaks_no_leave,
     shields_free_left, shields_reserve, shields_reserve_used, sim_cap2, last_active_date, reset_from_date, updated_at)
  VALUES (p_user, v_start, v_cur, v_best, v_banked, v_breaks,
          v_free, v_reserve, v_res_used,
          jsonb_build_object('best_streak', v_best2, 'reserve_used', v_res_used2),
          v_last_active, v_reset, now())
  ON CONFLICT (user_id, period_month) DO UPDATE SET
    current_streak = EXCLUDED.current_streak,
    best_streak = EXCLUDED.best_streak,
    milestones_banked = EXCLUDED.milestones_banked,
    breaks_no_leave = EXCLUDED.breaks_no_leave,
    shields_free_left = EXCLUDED.shields_free_left,
    shields_reserve_used = EXCLUDED.shields_reserve_used,
    sim_cap2 = EXCLUDED.sim_cap2,
    last_active_date = EXCLUDED.last_active_date,
    updated_at = now();

  RETURN jsonb_build_object(
    'current', v_cur, 'best', v_best, 'breaks_no_leave', v_breaks,
    'shields_free_left', v_free, 'shields_reserve_left', v_reserve - v_res_used,
    'banked', v_banked,
    'next', (SELECT jsonb_build_object('milestone', (mm->>'milestone')::int, 'delta', (mm->>'delta')::numeric,
                                       'days_to_go', (mm->>'milestone')::int - v_cur)
             FROM jsonb_array_elements(v_miles) mm
             WHERE mm->>'milestone' <> 'full_month' AND (mm->>'milestone')::int > v_best
             ORDER BY (mm->>'milestone')::int LIMIT 1)
  );
END; $$;
REVOKE ALL ON FUNCTION public.v5_recompute_streak(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_recompute_streak(UUID, DATE) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (5) v5_daily_missions: CURRENT_DATE → vn_local_date(now())
-- ---------------------------------------------------------------------------
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
  v_today DATE := public.vn_local_date(now());  -- 20260720190000: KHÔNG dùng CURRENT_DATE (session TZ = UTC)
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
              AND c.end_date BETWEEN v_today AND v_today + 30) AS expiring,
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

COMMIT;

NOTIFY pgrst, 'reload schema';
