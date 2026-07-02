-- ============================================================
-- V5 MONEY + LOCK (S4a) — tính tiền v5 + 3 ASSERT + ghi 2 dòng
-- salary_adjustments khi LOCK + nghi án/kết án (C2) + shadow report.
-- TIỀN CHỈ SINH KHI LOCK và CHỈ KHI feature_flags.v5_money = true
-- (shadow: hàm apply RAISE — assert CẤM ghi, US-6.1).
-- LỆCH SPEC CÓ CHỦ ĐÍCH (ghi log): nhánh UNION hiển thị trong RPC
-- salary_work_ledger để BACKLOG (display-only); nguồn TIỀN duy nhất
-- vẫn là salary_adjustments qua v5_apply_lock_adjustments (đúng C9).
-- REVERT: scripts/v5_rollback_s4.sql
-- ============================================================

-- ---------- v5_month_money: tiền v5 của 1 người 1 tháng (đọc-only) ----------
CREATE OR REPLACE FUNCTION public.v5_month_money(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_month DATE := date_trunc('month', p_month)::date;
  v_n INT; v_rate NUMERIC; v_ticked INT;
  v_budget NUMERIC := (v_cfg->'attendance_v5'->>'budget')::numeric;
  v_sbudget NUMERIC := (v_cfg->'streak_v5'->>'budget')::numeric;
  v_soft JSONB := v_cfg->'attendance_v5'->'soft_floor';
  v_attend NUMERIC; v_streak NUMERIC;
  v_banked JSONB;
BEGIN
  v_n := public.v5_n_chuan(v_month, p_user);
  v_rate := CASE WHEN v_n > 0 THEN v_budget / v_n ELSE 0 END;
  SELECT COUNT(*) INTO v_ticked FROM public.salary_attendance_day
  WHERE user_id = p_user AND status = 'ticked'
    AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;

  v_attend := ROUND(v_rate * LEAST(v_ticked, v_n));
  -- sàn mềm (tuỳ chọn config): ≥ at_days ngày → tối thiểu amount
  IF COALESCE((v_soft->>'enabled')::boolean, false) AND v_ticked >= (v_soft->>'at_days')::int THEN
    v_attend := GREATEST(v_attend, (v_soft->>'amount')::numeric);
  END IF;
  v_attend := LEAST(v_attend, v_budget); -- ASSERT trần 6tr

  SELECT COALESCE(milestones_banked, '[]'::jsonb) INTO v_banked
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_month;
  v_banked := COALESCE(v_banked, '[]'::jsonb);
  SELECT COALESCE(SUM((b->>'delta')::numeric), 0) INTO v_streak FROM jsonb_array_elements(v_banked) b;
  v_streak := LEAST(v_streak, v_sbudget); -- ASSERT trần 3tr

  RETURN jsonb_build_object(
    'month', v_month, 'n_chuan', v_n, 'day_rate', ROUND(v_rate),
    'ticked_days', v_ticked,
    'attend_amount', v_attend, 'attend_budget', v_budget,
    'streak_amount', v_streak, 'streak_budget', v_sbudget,
    'banked', v_banked,
    'total', v_attend + v_streak
  );
END; $$;
REVOKE ALL ON FUNCTION public.v5_month_money(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_month_money(UUID, DATE) TO authenticated, service_role;

-- ---------- get_salary_progress_v5: self-view lưới tháng (US-4.1) ----------
CREATE OR REPLACE FUNCTION public.get_salary_progress_v5(p_month DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_month DATE := date_trunc('month', COALESCE(p_month, public.vn_local_date(now())))::date;
  v_days JSONB;
BEGIN
  PERFORM public.v5_recompute_streak(v_uid, v_month);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'date', d.d, 'is_workday', (EXTRACT(dow FROM d.d) <> 0
        AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h
              WHERE h.user_id=(SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1)
                AND h.holiday_date=d.d)),
    'status', COALESCE(sad.status, 'pending'), 'source', sad.tick_source
  ) ORDER BY d.d), '[]'::jsonb) INTO v_days
  FROM generate_series(v_month, (v_month + INTERVAL '1 month')::date - 1, INTERVAL '1 day') d(d)
  LEFT JOIN public.salary_attendance_day sad ON sad.user_id = v_uid AND sad.work_date = d.d
  WHERE d.d <= public.vn_local_date(now());

  RETURN public.v5_month_money(v_uid, v_month) || jsonb_build_object('days', v_days);
END; $$;
REVOKE ALL ON FUNCTION public.get_salary_progress_v5(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_salary_progress_v5(DATE) TO authenticated;

-- ---------- Nghi án / kết án (C2 — máy flag, CHỦ kết án, 48h kháng nghị) ----------
CREATE OR REPLACE FUNCTION public.v5_flag_day(p_user UUID, p_date DATE, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ được gắn nghi án'; END IF;
  UPDATE public.salary_attendance_day SET
    status = 'flagged',
    audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(),
            'action', 'flag', 'reason', p_reason, 'appeal_deadline', now() + INTERVAL '48 hours')),
    updated_at = now()
  WHERE user_id = p_user AND work_date = p_date AND status IN ('ticked','pending_check','presence','pending');
  IF NOT FOUND THEN RAISE EXCEPTION 'Ngày này không ở trạng thái gắn nghi án được'; END IF;
  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES (p_user, 'CUSTOM', 'IN_APP', 'PENDING', 'Ngày công đang được xem lại',
    'Ngày ' || to_char(p_date,'DD/MM') || ' đang được chủ xem lại bằng chứng — bạn có 48h để phản hồi trong app',
    jsonb_build_object('v5','flagged','date', p_date, 'url', '/my-day'));
  RETURN jsonb_build_object('flagged', true, 'date', p_date);
END; $$;
REVOKE ALL ON FUNCTION public.v5_flag_day(UUID, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_flag_day(UUID, DATE, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.v5_appeal(p_date DATE, p_text TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid();
BEGIN
  UPDATE public.salary_attendance_day SET
    audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'appeal', 'text', p_text)),
    updated_at = now()
  WHERE user_id = v_uid AND work_date = p_date AND status = 'flagged';
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có nghi án đang mở ở ngày này'; END IF;
  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES ((SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1),
    'CUSTOM','IN_APP','PENDING','Kháng nghị nghi án',
    (SELECT COALESCE(full_name,'Nhân viên') FROM public.profiles WHERE id = v_uid) || ' phản hồi ngày ' || to_char(p_date,'DD/MM') || ': ' || p_text,
    jsonb_build_object('v5','appeal','staff_id', v_uid, 'date', p_date));
  RETURN jsonb_build_object('appealed', true);
END; $$;
REVOKE ALL ON FUNCTION public.v5_appeal(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_appeal(DATE, TEXT) TO authenticated;

-- Kết án: confirm=true → voided + TƯỚC mốc banked THÁNG (ngoại lệ duy nhất của banked)
--         confirm=false → trả về ticked (xử có lợi nhân viên)
CREATE OR REPLACE FUNCTION public.v5_verdict(p_user UUID, p_date DATE, p_confirm BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_month DATE := date_trunc('month', p_date)::date;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ được kết án'; END IF;
  IF p_confirm THEN
    UPDATE public.salary_attendance_day SET
      status = 'voided', voided_reason = COALESCE(p_note, 'Gian lận dữ liệu ảnh (đã kết án)'),
      audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'action', 'verdict_confirm', 'note', p_note)),
      updated_at = now()
    WHERE user_id = p_user AND work_date = p_date AND status = 'flagged';
    IF NOT FOUND THEN RAISE EXCEPTION 'Ngày này không ở trạng thái nghi án'; END IF;
    -- tước toàn bộ mốc banked THÁNG hiện hành + tính lại từ ngày kế (C2)
    UPDATE public.salary_streak_state SET
      milestones_banked = '[]'::jsonb, reset_from_date = p_date + 1, updated_at = now()
    WHERE user_id = p_user AND period_month = v_month;
    PERFORM public.v5_recompute_streak(p_user, v_month);
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
    VALUES (p_user, 'CUSTOM', 'IN_APP', 'PENDING', 'Kết luận xem xét ngày ' || to_char(p_date,'DD/MM'),
      'Ngày ' || to_char(p_date,'DD/MM') || ' không được tính công sau khi xem xét bằng chứng. Các ngày làm thật khác giữ nguyên. Chuỗi tính lại từ ' || to_char(p_date + 1,'DD/MM') || '.',
      jsonb_build_object('v5','verdict','date', p_date, 'confirmed', true));
  ELSE
    UPDATE public.salary_attendance_day SET
      status = 'ticked',
      audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'action', 'verdict_clear', 'note', p_note)),
      updated_at = now()
    WHERE user_id = p_user AND work_date = p_date AND status = 'flagged';
    IF NOT FOUND THEN RAISE EXCEPTION 'Ngày này không ở trạng thái nghi án'; END IF;
    PERFORM public.v5_recompute_streak(p_user, v_month);
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
    VALUES (p_user, 'CUSTOM', 'IN_APP', 'PENDING', 'Ngày công đã được xác nhận lại ✅',
      'Ngày ' || to_char(p_date,'DD/MM') || ' đã được xác nhận hợp lệ — cảm ơn bạn đã phản hồi.',
      jsonb_build_object('v5','verdict','date', p_date, 'confirmed', false));
  END IF;
  RETURN jsonb_build_object('confirmed', p_confirm, 'date', p_date);
END; $$;
REVOKE ALL ON FUNCTION public.v5_verdict(UUID, DATE, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_verdict(UUID, DATE, BOOLEAN, TEXT) TO authenticated;

-- ---------- 3 ASSERT + bảng đối soát (US-4.5) ----------
CREATE OR REPLACE FUNCTION public.v5_lock_assert(p_month DATE)
RETURNS TABLE (
  staff_id UUID, staff_name TEXT,
  n_chuan INT, ticked_days INT, attend_amount NUMERIC, streak_amount NUMERIC, total NUMERIC,
  a1_caps_ok BOOLEAN, a2_no_open_flags BOOLEAN, a3_payment_join_ok BOOLEAN, all_ok BOOLEAN
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month DATE := date_trunc('month', p_month)::date;
  v_staff RECORD; v_m JSONB;
  v_flags INT; v_badpay INT;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ xem đối soát'; END IF;
  FOR v_staff IN SELECT DISTINCT sa.staff_id, p.full_name FROM public.staff_assignments sa
                 JOIN public.profiles p ON p.id = sa.staff_id WHERE sa.building_id IS NOT NULL LOOP
    v_m := public.v5_month_money(v_staff.staff_id, v_month);
    SELECT COUNT(*) INTO v_flags FROM public.salary_attendance_day
    WHERE user_id = v_staff.staff_id AND status = 'flagged'
      AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
    -- ASSERT 3: 100% tick nguồn PAYMENT join ngược phiếu thu thật có GPS ok
    SELECT COUNT(*) INTO v_badpay
    FROM public.salary_attendance_day sad
    WHERE sad.user_id = v_staff.staff_id AND sad.status='ticked' AND sad.tick_source='PAYMENT'
      AND sad.work_date >= v_month AND sad.work_date < (v_month + INTERVAL '1 month')::date
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(sad.evidence) e
        JOIN public.income_expenses ie ON ie.id = NULLIF(e->>'ref_id','')::uuid
        WHERE ie.collect_geofence_status = 'ok'
      )
      -- tick PAYMENT qua phiên check-nhanh: evidence ref là session — chấp nhận nếu phiên có paired ie hợp lệ
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(sad.evidence) e
        JOIN public.inspection_sessions s ON s.id = NULLIF(e->>'ref_id','')::uuid
        LEFT JOIN public.income_expenses ie2 ON ie2.id = s.paired_income_expense_id
        WHERE s.status IN ('quick_done','passed')
          AND (ie2.collect_geofence_status = 'ok' OR EXISTS (
            SELECT 1 FROM public.income_expenses ie3
            WHERE ie3.user_id = v_staff.staff_id AND ie3.building_id = s.building_id
              AND ie3.collect_geofence_status = 'ok'
              AND public.vn_local_date(ie3.created_at) = s.session_date))
      );

    staff_id := v_staff.staff_id; staff_name := v_staff.full_name;
    n_chuan := (v_m->>'n_chuan')::int; ticked_days := (v_m->>'ticked_days')::int;
    attend_amount := (v_m->>'attend_amount')::numeric; streak_amount := (v_m->>'streak_amount')::numeric;
    total := (v_m->>'total')::numeric;
    a1_caps_ok := attend_amount <= (v_m->>'attend_budget')::numeric AND streak_amount <= (v_m->>'streak_budget')::numeric;
    a2_no_open_flags := v_flags = 0;
    a3_payment_join_ok := v_badpay = 0;
    all_ok := a1_caps_ok AND a2_no_open_flags AND a3_payment_join_ok;
    RETURN NEXT;
  END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.v5_lock_assert(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_lock_assert(DATE) TO authenticated;

-- ---------- Ghi 2 dòng salary_adjustments khi LOCK (nguồn tiền DUY NHẤT — C9) ----------
CREATE OR REPLACE FUNCTION public.v5_apply_lock_adjustments(p_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month DATE := date_trunc('month', p_month)::date;
  v_cfg JSONB := public.get_salary_v5_config();
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_row RECORD; v_m JSONB; v_sm UUID;
  v_n INT := 0;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ được chốt tiền v5'; END IF;
  -- ASSERT CẤM ghi tiền trong shadow (US-6.1): chỉ khi flag v5_money = true
  IF NOT COALESCE((v_cfg->'system_v5'->'feature_flags'->>'v5_money')::boolean, false) THEN
    RAISE EXCEPTION 'v5_money đang TẮT (shadow) — không được ghi tiền v5 vào lương';
  END IF;

  FOR v_row IN SELECT * FROM public.v5_lock_assert(v_month) LOOP
    IF NOT v_row.all_ok THEN
      RAISE EXCEPTION 'CHẶN LOCK: % chưa qua đủ 3 ASSERT (caps=%, flags=%, payment_join=%)',
        v_row.staff_name, v_row.a1_caps_ok, v_row.a2_no_open_flags, v_row.a3_payment_join_ok;
    END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM public.v5_lock_assert(v_month) LOOP
    -- đảm bảo salary_monthly (DRAFT) tồn tại
    SELECT id INTO v_sm FROM public.salary_monthly WHERE staff_id = v_row.staff_id AND period_month = v_month;
    IF v_sm IS NULL THEN
      INSERT INTO public.salary_monthly (user_id, staff_id, period_month, status)
      VALUES (v_owner, v_row.staff_id, v_month, 'DRAFT') RETURNING id INTO v_sm;
    END IF;
    -- idempotent: xoá dòng v5 cũ của kỳ rồi ghi lại
    DELETE FROM public.salary_adjustments WHERE salary_monthly_id = v_sm AND source IN ('ATTEND_V5','STREAK_V5');
    IF v_row.attend_amount > 0 THEN
      INSERT INTO public.salary_adjustments (salary_monthly_id, user_id, kind, label, amount, source)
      VALUES (v_sm, v_owner, 'BONUS', 'Chuyên cần v5 (' || v_row.ticked_days || '/' || v_row.n_chuan || ' ngày công)', v_row.attend_amount, 'ATTEND_V5');
    END IF;
    IF v_row.streak_amount > 0 THEN
      INSERT INTO public.salary_adjustments (salary_monthly_id, user_id, kind, label, amount, source)
      VALUES (v_sm, v_owner, 'BONUS', 'Thưởng chuỗi v5 (mốc đã khoá)', v_row.streak_amount, 'STREAK_V5');
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('month', v_month, 'staff_applied', v_n);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, error_text, payload)
  VALUES (auth.uid(), 'v5_apply_lock_adjustments', SQLERRM, jsonb_build_object('month', p_month));
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.v5_apply_lock_adjustments(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_apply_lock_adjustments(DATE) TO authenticated;

-- ---------- Shadow report (US-6.2/6.3) ----------
CREATE OR REPLACE FUNCTION public.v5_shadow_report(p_month DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month DATE := date_trunc('month', p_month)::date;
  v_rows JSONB := '[]'::jsonb;
  v_staff RECORD; v_m JSONB; v_sss public.salary_streak_state;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ xem shadow report'; END IF;
  FOR v_staff IN SELECT DISTINCT sa.staff_id, p.full_name FROM public.staff_assignments sa
                 JOIN public.profiles p ON p.id = sa.staff_id WHERE sa.building_id IS NOT NULL LOOP
    v_m := public.v5_month_money(v_staff.staff_id, v_month);
    SELECT * INTO v_sss FROM public.salary_streak_state WHERE user_id = v_staff.staff_id AND period_month = v_month;
    v_rows := v_rows || jsonb_build_array(v_m || jsonb_build_object(
      'staff_id', v_staff.staff_id, 'staff_name', v_staff.full_name,
      'best_streak', COALESCE(v_sss.best_streak, 0),
      'breaks_no_leave', COALESCE(v_sss.breaks_no_leave, 0),
      'shields_used', COALESCE((SELECT COUNT(*)::int FROM public.salary_attendance_day sad
        WHERE sad.user_id = v_staff.staff_id AND sad.work_date >= v_month
          AND sad.work_date < (v_month + INTERVAL '1 month')::date AND sad.status='ticked'), 0),
      'sim_cap2', COALESCE(v_sss.sim_cap2, '{}'::jsonb)
    ));
  END LOOP;
  RETURN jsonb_build_object('month', v_month, 'rows', v_rows,
    'coverage', (SELECT jsonb_agg(jsonb_build_object('b', building_name, 'd', days_since_touch, 'full_d', days_since_full))
                 FROM public.building_coverage WHERE rooms_total > 0));
END; $$;
REVOKE ALL ON FUNCTION public.v5_shadow_report(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_shadow_report(DATE) TO authenticated;
