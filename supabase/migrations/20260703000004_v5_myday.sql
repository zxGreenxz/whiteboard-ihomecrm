-- ============================================================
-- V5 MY-DAY (S3) — RPC cho màn "Ngày hôm nay của tôi" + phép 1-chạm +
-- báo sự cố thiết bị (US-2.8, US-3.1, US-5.3).
-- REVERT: scripts/v5_rollback_s3.sql
-- ============================================================

-- Guard self-or-admin cho v5_daily_missions (staff chỉ xem tuyến của mình)
CREATE OR REPLACE FUNCTION public.v5_daily_missions_self()
RETURNS TABLE (
  building_id UUID, building_name TEXT, cluster_id TEXT,
  days_since_touch INT, days_since_full INT, vacant_rooms BIGINT,
  score NUMERIC, color TEXT, reason TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
ROWS 20 AS $$
  SELECT * FROM public.v5_daily_missions(auth.uid());
$$;
REVOKE ALL ON FUNCTION public.v5_daily_missions_self() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_daily_missions_self() TO authenticated;

-- ---------- get_my_day_summary(): 1 round-trip cho màn /my-day ----------
CREATE OR REPLACE FUNCTION public.get_my_day_summary()
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := public.vn_local_date(now());
  v_month DATE := date_trunc('month', v_today)::date;
  v_cfg JSONB := public.get_salary_v5_config();
  v_sad public.salary_attendance_day;
  v_streak JSONB;
  v_n INT; v_rate NUMERIC; v_ticked INT;
  v_pending JSONB;
  v_quota INT; v_used INT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;

  SELECT * INTO v_sad FROM public.salary_attendance_day WHERE user_id = v_uid AND work_date = v_today;
  v_streak := public.v5_recompute_streak(v_uid, v_month); -- lazy-touch: luôn tươi khi mở màn

  v_n := public.v5_n_chuan(v_month, v_uid);
  v_rate := CASE WHEN v_n > 0 THEN (v_cfg->'attendance_v5'->>'budget')::numeric / v_n ELSE 0 END;
  SELECT COUNT(*) INTO v_ticked FROM public.salary_attendance_day
  WHERE user_id = v_uid AND status = 'ticked' AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;

  -- các toà đang nợ check-sau-thu-tiền hôm nay
  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('building_id', e->>'building_id',
           'building_name', (SELECT name FROM public.buildings b WHERE b.id = (e->>'building_id')::uuid))), '[]'::jsonb)
    INTO v_pending
  FROM public.salary_attendance_day sad, jsonb_array_elements(sad.evidence) e
  WHERE sad.user_id = v_uid AND sad.work_date = v_today AND sad.status = 'pending_check'
    AND e->>'kind' = 'pending_check';

  v_quota := COALESCE((v_cfg->'attendance_v5'->>'paid_leave_days_per_month')::int, 1);
  SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
  WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
    AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;

  RETURN jsonb_build_object(
    'today', jsonb_build_object('date', v_today, 'status', COALESCE(v_sad.status, 'pending'),
                                'tick_source', v_sad.tick_source),
    'attend', jsonb_build_object('n_chuan', v_n, 'day_rate', ROUND(v_rate),
                                 'ticked_days', v_ticked,
                                 'tam_tinh', ROUND(v_rate * LEAST(v_ticked, v_n)),
                                 'budget', (v_cfg->'attendance_v5'->>'budget')::numeric),
    'streak', v_streak,
    'pending_checks', v_pending,
    'leave', jsonb_build_object('quota', v_quota, 'used', v_used, 'left', GREATEST(v_quota - v_used, 0)),
    'stage', v_cfg->'system_v5'->>'stage',
    'as_of', now()
  );
END; $$;
REVOKE ALL ON FUNCTION public.get_my_day_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_day_summary() TO authenticated;

-- ---------- Phép 1-chạm (US-5.3): xin ----------
CREATE OR REPLACE FUNCTION public.request_paid_leave(p_date DATE, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_cfg JSONB := public.get_salary_v5_config();
  v_month DATE := date_trunc('month', p_date)::date;
  v_quota INT := COALESCE((v_cfg->'attendance_v5'->>'paid_leave_days_per_month')::int, 1);
  v_used INT;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_cur TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;
  IF p_date < public.vn_local_date(now()) THEN
    RAISE EXCEPTION 'Chỉ xin phép cho hôm nay hoặc ngày tới';
  END IF;
  IF EXTRACT(dow FROM p_date) = 0 THEN
    RAISE EXCEPTION 'Chủ nhật đã là ngày nghỉ — không cần xin phép';
  END IF;
  SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
  WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
    AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
  IF v_used >= v_quota THEN
    RAISE EXCEPTION 'Đã dùng hết % ngày phép có lương của tháng này', v_quota;
  END IF;

  SELECT status INTO v_cur FROM public.salary_attendance_day WHERE user_id = v_uid AND work_date = p_date;
  IF v_cur = 'ticked' THEN RAISE EXCEPTION 'Ngày này đã có ngày công rồi'; END IF;
  IF v_cur IN ('leave_approved','pending_leave') THEN
    RETURN jsonb_build_object('status', v_cur, 'date', p_date); -- idempotent
  END IF;

  INSERT INTO public.salary_attendance_day (user_id, work_date, status, evidence, audit)
  VALUES (v_uid, p_date, 'pending_leave',
          jsonb_build_array(jsonb_build_object('at', now(), 'kind', 'leave_request', 'reason', p_reason)),
          jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'request_leave')))
  ON CONFLICT (user_id, work_date) DO UPDATE SET
    status = 'pending_leave',
    evidence = salary_attendance_day.evidence || jsonb_build_array(jsonb_build_object('at', now(), 'kind', 'leave_request', 'reason', p_reason)),
    audit = salary_attendance_day.audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'request_leave')),
    updated_at = now();

  -- báo chủ (auto-nhắc lại sau 24h do digest đảm nhiệm)
  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES (v_owner, 'CUSTOM', 'IN_APP', 'PENDING', 'Xin phép nghỉ có lương',
          (SELECT COALESCE(full_name, 'Nhân viên') FROM public.profiles WHERE id = v_uid) || ' xin phép ngày ' || to_char(p_date, 'DD/MM') || COALESCE(' — ' || p_reason, ''),
          jsonb_build_object('v5', 'leave_request', 'staff_id', v_uid, 'date', p_date));

  RETURN jsonb_build_object('status', 'pending_leave', 'date', p_date, 'quota_left', v_quota - v_used - 1);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, error_text, payload)
  VALUES (v_uid, 'request_paid_leave', SQLERRM, jsonb_build_object('date', p_date));
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.request_paid_leave(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_paid_leave(DATE, TEXT) TO authenticated;

-- ---------- Phép 1-chạm: chủ duyệt/từ chối ----------
CREATE OR REPLACE FUNCTION public.approve_leave(p_user UUID, p_date DATE, p_approve BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cur TEXT;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ được duyệt phép'; END IF;
  SELECT status INTO v_cur FROM public.salary_attendance_day WHERE user_id = p_user AND work_date = p_date;
  IF v_cur IS DISTINCT FROM 'pending_leave' THEN
    RAISE EXCEPTION 'Ngày này không ở trạng thái chờ duyệt phép';
  END IF;

  UPDATE public.salary_attendance_day SET
    status = CASE WHEN p_approve THEN 'leave_approved' ELSE 'pending' END,
    audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(),
            'action', CASE WHEN p_approve THEN 'approve_leave' ELSE 'decline_leave' END)),
    updated_at = now()
  WHERE user_id = p_user AND work_date = p_date;

  PERFORM public.v5_recompute_streak(p_user, date_trunc('month', p_date)::date);

  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES (p_user, 'CUSTOM', 'IN_APP', 'PENDING',
    CASE WHEN p_approve THEN 'Phép đã duyệt ✅' ELSE 'Phép chưa được duyệt' END,
    CASE WHEN p_approve
      THEN 'Phép ngày ' || to_char(p_date,'DD/MM') || ' đã duyệt ✅ — ngày trung tính, chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh'
      ELSE 'Phép ngày ' || to_char(p_date,'DD/MM') || ' chưa được duyệt — trao đổi thêm với chủ nhé' END,
    jsonb_build_object('v5','leave_result','date', p_date, 'approved', p_approve, 'url', '/my-day'));

  RETURN jsonb_build_object('approved', p_approve, 'date', p_date);
END; $$;
REVOKE ALL ON FUNCTION public.approve_leave(UUID, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_leave(UUID, DATE, BOOLEAN) TO authenticated;

-- ---------- Báo sự cố thiết bị trong phiên (US-2.8) ----------
CREATE OR REPLACE FUNCTION public.report_device_issue(p_session UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_sess public.inspection_sessions;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
BEGIN
  SELECT * INTO v_sess FROM public.inspection_sessions WHERE id = p_session;
  IF NOT FOUND OR v_sess.user_id <> v_uid THEN RAISE EXCEPTION 'Phiên không hợp lệ'; END IF;
  UPDATE public.inspection_sessions SET
    device_issue = jsonb_build_object('reported_at', now(), 'reason', p_reason),
    updated_at = now()
  WHERE id = p_session;
  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES (v_owner, 'CUSTOM', 'IN_APP', 'PENDING', 'Báo sự cố thiết bị (kiểm tra nhà)',
    (SELECT COALESCE(full_name,'Nhân viên') FROM public.profiles WHERE id = v_uid) || ' báo sự cố tại toà ' ||
    (SELECT name FROM public.buildings WHERE id = v_sess.building_id) || ': ' || p_reason,
    jsonb_build_object('v5','device_issue','session_id', p_session, 'staff_id', v_uid));
  RETURN jsonb_build_object('reported', true);
END; $$;
REVOKE ALL ON FUNCTION public.report_device_issue(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_device_issue(UUID, TEXT) TO authenticated;

-- Chủ duyệt sự cố thiết bị → tick tay MANUAL_DEVICE_ISSUE + audit
CREATE OR REPLACE FUNCTION public.approve_device_issue(p_session UUID, p_approve BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sess public.inspection_sessions; v_tick JSONB;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ được duyệt sự cố thiết bị'; END IF;
  SELECT * INTO v_sess FROM public.inspection_sessions WHERE id = p_session;
  IF NOT FOUND OR v_sess.device_issue IS NULL THEN RAISE EXCEPTION 'Không có báo cáo sự cố ở phiên này'; END IF;
  UPDATE public.inspection_sessions SET
    device_issue = device_issue || jsonb_build_object('approved', p_approve, 'approved_by', auth.uid(), 'approved_at', now()),
    updated_at = now()
  WHERE id = p_session;
  IF p_approve THEN
    v_tick := public.v5_tick_attendance(v_sess.user_id, v_sess.session_date, 'MANUAL_DEVICE_ISSUE', p_session, 'duyệt sự cố thiết bị');
  END IF;
  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES (v_sess.user_id, 'CUSTOM', 'IN_APP', 'PENDING',
    CASE WHEN p_approve THEN 'Sự cố thiết bị đã duyệt ✅' ELSE 'Sự cố thiết bị chưa được duyệt' END,
    CASE WHEN p_approve THEN 'Ngày công ' || to_char(v_sess.session_date,'DD/MM') || ' đã được ghi nhận (duyệt tay do sự cố thiết bị)'
         ELSE 'Báo cáo sự cố ngày ' || to_char(v_sess.session_date,'DD/MM') || ' chưa được duyệt — trao đổi thêm với chủ nhé' END,
    jsonb_build_object('v5','device_issue_result','session_id', p_session, 'url', '/my-day'));
  RETURN jsonb_build_object('approved', p_approve, 'tick', v_tick);
END; $$;
REVOKE ALL ON FUNCTION public.approve_device_issue(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_device_issue(UUID, BOOLEAN) TO authenticated;
