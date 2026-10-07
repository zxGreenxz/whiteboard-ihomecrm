-- A leave recipient can belong to both the real and demo organizations.
-- Derive the notification organization from the attendance row just written,
-- not from the recipient. Preserve the existing quota, auth, and retry behavior.
CREATE OR REPLACE FUNCTION public.request_paid_leave(p_date DATE, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_cfg JSONB := public.get_salary_v5_config();
  v_bank_from DATE := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_month DATE := date_trunc('month', p_date)::date;
  v_rate INT := COALESCE((v_cfg->'attendance_v5'->>'paid_leave_days_per_month')::int, 1);
  v_quota INT; v_used INT;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_cur TEXT;
  v_org UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;
  IF p_date < public.vn_local_date(now()) THEN
    RAISE EXCEPTION 'Chỉ xin phép cho hôm nay hoặc ngày tới';
  END IF;
  IF EXTRACT(dow FROM p_date) = 0 THEN
    RAISE EXCEPTION 'Chủ nhật đã là ngày nghỉ — không cần xin phép';
  END IF;
  IF p_date >= v_bank_from THEN
    -- Phep tich luy theo NAM: so du = LEAST(12, so-thang-da-troi × rate) − da dung trong nam
    v_quota := LEAST(12, EXTRACT(month FROM p_date)::int * v_rate);
    SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
    WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
      AND work_date >= date_trunc('year', p_date)::date
      AND work_date < (date_trunc('year', p_date) + INTERVAL '1 year')::date;
    IF v_used >= v_quota THEN
      RAISE EXCEPTION 'Số dư phép năm đã hết (tích lũy % — đã dùng %)', v_quota, v_used;
    END IF;
  ELSE
    v_quota := v_rate;
    SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
    WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
      AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
    IF v_used >= v_quota THEN
      RAISE EXCEPTION 'Đã dùng hết % ngày phép có lương của tháng này', v_quota;
    END IF;
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
    updated_at = now()
  RETURNING organization_id INTO v_org;

  -- bao chu (auto-nhac lai sau 24h do digest dam nhiem)
  INSERT INTO public.notifications (organization_id, user_id, type, channel, status, subject, content, metadata)
  VALUES (v_org, v_owner, 'CUSTOM', 'IN_APP', 'PENDING', 'Xin phép nghỉ có lương',
          (SELECT COALESCE(full_name, 'Nhân viên') FROM public.profiles WHERE id = v_uid) || ' xin phép ngày ' || to_char(p_date, 'DD/MM') || COALESCE(' — ' || p_reason, ''),
          jsonb_build_object('v5', 'leave_request', 'staff_id', v_uid, 'date', p_date));

  RETURN jsonb_build_object('status', 'pending_leave', 'date', p_date, 'quota_left', v_quota - v_used - 1);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, error_text, payload)
  VALUES (v_uid, 'request_paid_leave', SQLERRM, jsonb_build_object('date', p_date));
  RAISE;
END; $$;
