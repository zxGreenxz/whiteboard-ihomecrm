BEGIN;
-- ============================================================
-- V5.1 bo sung: get_my_day_summary hien SO DU PHEP THEO NAM cho ky >= shield_bank_from
-- (dong bo voi request_paid_leave trong 20260826120000). Truoc moc do giu quota thang.
-- Body giu nguyen ban hien hanh, chi thay khoi tinh v_quota/v_used.
-- Idempotent: CREATE OR REPLACE.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_day_summary() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := public.vn_local_date(now());
  v_month DATE := date_trunc('month', v_today)::date;
  v_cfg JSONB := public.get_salary_v5_config();
  v_bank_from DATE := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_sad public.salary_attendance_day;
  v_streak JSONB;
  v_n INT; v_rate NUMERIC; v_ticked INT;
  v_pending JSONB;
  v_leave_rate INT := COALESCE((v_cfg->'attendance_v5'->>'paid_leave_days_per_month')::int, 1);
  v_quota INT; v_used INT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;

  SELECT * INTO v_sad FROM public.salary_attendance_day WHERE user_id = v_uid AND work_date = v_today;
  v_streak := public.v5_recompute_streak(v_uid, v_month); -- lazy-touch: luon tuoi khi mo man

  v_n := public.v5_n_chuan(v_month, v_uid);
  v_rate := CASE WHEN v_n > 0 THEN (v_cfg->'attendance_v5'->>'budget')::numeric / v_n ELSE 0 END;
  SELECT COUNT(*) INTO v_ticked FROM public.salary_attendance_day
  WHERE user_id = v_uid AND status = 'ticked' AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;

  -- cac toa dang no check-sau-thu-tien hom nay
  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('building_id', e->>'building_id',
           'building_name', (SELECT name FROM public.buildings b WHERE b.id = (e->>'building_id')::uuid))), '[]'::jsonb)
    INTO v_pending
  FROM public.salary_attendance_day sad, jsonb_array_elements(sad.evidence) e
  WHERE sad.user_id = v_uid AND sad.work_date = v_today AND sad.status = 'pending_check'
    AND e->>'kind' = 'pending_check';

  IF v_today >= v_bank_from THEN
    -- V5.1: phep tich luy theo NAM — so du = LEAST(12, so-thang-da-troi × rate) − da dung trong nam
    v_quota := LEAST(12, EXTRACT(month FROM v_today)::int * v_leave_rate);
    SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
    WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
      AND work_date >= date_trunc('year', v_today)::date
      AND work_date < (date_trunc('year', v_today) + INTERVAL '1 year')::date;
  ELSE
    v_quota := v_leave_rate;
    SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
    WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
      AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
  END IF;

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

COMMIT;
