BEGIN;
-- ============================================================
-- V5.1 dot 2 (chu quyet 26/08): ap THANG TIEN moi 6tr + 2.5tr (dinh dong n_top)
-- cho CA thang 7-8/2026 — thay vi giu thang cu 3tr + full_month cho ky legacy.
--
-- CHI doi thang tien. CO CHE khien/phep cua ky legacy GIU NGUYEN (free 3,
-- du tru cap 2/tieu 1, quota phep theo thang) — khong bat qua khu choi lai
-- luat khien moi (ap hoi to free-1 se lam tut chuoi thang 8 da song).
--
-- Joey T7: 9tr -> 8.5tr (best 24 = N_chuan 24 -> dinh dong -> full 2.5tr).
-- Nathan T7: 9tr -> 8.5tr. Thang 8 dang chay: banked map sang delta moi.
--
-- Idempotent: CREATE OR REPLACE + recompute cuoi file chay lai vo hai.
-- ============================================================

-- ---------- 1. Legacy recompute: giu co che khien cu, DOI thang moc sang 2.5tr n_top ----------
CREATE OR REPLACE FUNCTION public.v5_recompute_streak_legacy(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_today DATE := public.vn_local_date(now());
  v_start DATE := date_trunc('month', p_month)::date;
  v_month_end DATE := (v_start + INTERVAL '1 month')::date - 1;
  v_end DATE := LEAST(v_month_end, v_today);
  v_reset DATE;
  v_free_cap INT := 3;
  v_spend_cap INT := 1;
  v_reserve INT;
  v_free INT; v_res_used INT := 0;
  v_cur INT := 0; v_best INT := 0; v_breaks INT := 0;
  v_cur2 INT := 0; v_best2 INT := 0; v_free2 INT; v_res2 INT; v_res_used2 INT := 0;
  v_d DATE; v_status TEXT; v_is_workday BOOLEAN;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_n INT; v_miles JSONB;
  v_deltas JSONB := '[300000,400000,500000,500000,400000,400000]'::jsonb;
  v_banked JSONB := '[]'::jsonb; v_prev_banked JSONB;
  v_last_active DATE; v_milestone JSONB; i INT; v_at INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('v5_sss' || p_user::text || v_start::text));
  SELECT milestones_banked, shields_reserve, reset_from_date
    INTO v_prev_banked, v_reserve, v_reset
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_start;
  v_prev_banked := COALESCE(v_prev_banked, '[]'::jsonb);
  v_reserve := COALESCE(v_reserve, 0);
  v_free := v_free_cap; v_free2 := v_free_cap; v_res2 := v_reserve;
  v_n := public.v5_n_chuan(v_start, p_user);
  v_miles := public.public_v5_effective_milestones('[4,8,13,18,23,"n_top"]'::jsonb, v_deltas, v_n);
  v_d := v_start;
  WHILE v_d <= v_end LOOP
    IF v_reset IS NOT NULL AND v_d < v_reset THEN
      v_cur := 0; v_cur2 := 0; v_d := v_d + 1; CONTINUE;
    END IF;
    v_is_workday := EXTRACT(dow FROM v_d) <> 0
      AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = v_d);
    SELECT status INTO v_status FROM public.salary_attendance_day
      WHERE user_id = p_user AND work_date = v_d;
    IF NOT v_is_workday OR v_status IN ('leave_approved','pending_leave') THEN
      NULL; -- bac cau: CN / le / phep
    ELSIF v_status = 'ticked' THEN
      v_cur := v_cur + 1; v_best := GREATEST(v_best, v_cur);
      v_cur2 := v_cur2 + 1; v_best2 := GREATEST(v_best2, v_cur2);
      v_last_active := v_d;
    ELSIF v_d < v_today THEN
      v_breaks := v_breaks + 1;
      IF v_free > 0 THEN v_free := v_free - 1;
      ELSIF v_reserve - v_res_used > 0 AND v_res_used < v_spend_cap THEN v_res_used := v_res_used + 1;
      ELSE v_cur := 0; END IF;
      IF v_free2 > 0 THEN v_free2 := v_free2 - 1;
      ELSIF v_res2 - v_res_used2 > 0 AND v_res_used2 < 2 THEN v_res_used2 := v_res_used2 + 1;
      ELSE v_cur2 := 0; END IF;
    END IF;
    v_d := v_d + 1;
  END LOOP;
  FOR i IN 0 .. jsonb_array_length(v_miles) - 1 LOOP
    v_milestone := v_miles->i;
    v_at := COALESCE((v_milestone->>'at')::int, (v_milestone->>'milestone')::int);
    IF v_at <= v_best THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', v_at, 'delta', (v_milestone->>'delta')::numeric,
        'top', (v_milestone->>'milestone') = 'n_top',
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE (b->>'milestone') = v_at::text LIMIT 1), now()::text)));
    END IF;
  END LOOP;
  INSERT INTO public.salary_streak_state AS s
    (user_id, period_month, current_streak, best_streak, milestones_banked, breaks_no_leave,
     shields_free_left, shields_reserve, shields_reserve_used, sim_cap2, last_active_date, reset_from_date, updated_at)
  VALUES (p_user, v_start, v_cur, v_best, v_banked, v_breaks,
          v_free, v_reserve, v_res_used,
          jsonb_build_object('best_streak', v_best2, 'reserve_used', v_res_used2),
          v_last_active, v_reset, now())
  ON CONFLICT (user_id, period_month) DO UPDATE SET
    current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak,
    milestones_banked = EXCLUDED.milestones_banked, breaks_no_leave = EXCLUDED.breaks_no_leave,
    shields_free_left = EXCLUDED.shields_free_left, shields_reserve_used = EXCLUDED.shields_reserve_used,
    sim_cap2 = EXCLUDED.sim_cap2, last_active_date = EXCLUDED.last_active_date, updated_at = now();
  RETURN jsonb_build_object(
    'current', v_cur, 'best', v_best, 'breaks_no_leave', v_breaks,
    'shields_free_left', v_free, 'shields_reserve_left', v_reserve - v_res_used,
    'banked', v_banked,
    'next', (SELECT jsonb_build_object(
               'milestone', COALESCE((mm->>'at')::int,(mm->>'milestone')::int),
               'delta', (mm->>'delta')::numeric,
               'days_to_go', COALESCE((mm->>'at')::int,(mm->>'milestone')::int) - v_cur)
             FROM jsonb_array_elements(v_miles) mm
             WHERE COALESCE((mm->>'at')::int,(mm->>'milestone')::int) > v_best
             ORDER BY COALESCE((mm->>'at')::int,(mm->>'milestone')::int) LIMIT 1)
  );
END; $function$;
REVOKE ALL ON FUNCTION public.v5_recompute_streak_legacy(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_recompute_streak_legacy(UUID, DATE) TO service_role;

-- ---------- 2. v5_month_money: MOT tran duy nhat = config budget (2.5tr moi ky) ----------
CREATE OR REPLACE FUNCTION public.v5_month_money(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_month DATE := date_trunc('month', p_month)::date;
  v_n INT; v_rate NUMERIC; v_ticked INT;
  v_budget NUMERIC := (v_cfg->'attendance_v5'->>'budget')::numeric;
  v_sbudget NUMERIC := (v_cfg->'streak_v5'->>'budget')::numeric;
  v_soft JSONB := v_cfg->'attendance_v5'->'soft_floor';
  v_attend NUMERIC; v_streak NUMERIC; v_banked JSONB;
BEGIN
  v_n := public.v5_n_chuan(v_month, p_user);
  v_rate := CASE WHEN v_n > 0 THEN v_budget / v_n ELSE 0 END;
  SELECT COUNT(*) INTO v_ticked FROM public.salary_attendance_day
  WHERE user_id = p_user AND status = 'ticked'
    AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
  v_attend := ROUND(v_rate * LEAST(v_ticked, v_n));
  IF COALESCE((v_soft->>'enabled')::boolean, false) AND v_ticked >= (v_soft->>'at_days')::int THEN
    v_attend := GREATEST(v_attend, (v_soft->>'amount')::numeric);
  END IF;
  v_attend := LEAST(v_attend, v_budget);
  SELECT COALESCE(milestones_banked, '[]'::jsonb) INTO v_banked
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_month;
  v_banked := COALESCE(v_banked, '[]'::jsonb);
  SELECT COALESCE(SUM((b->>'delta')::numeric), 0) INTO v_streak FROM jsonb_array_elements(v_banked) b;
  v_streak := LEAST(v_streak, v_sbudget);
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

-- ---------- 3. v5_close_period: bo bank full_month cho ky legacy (thang moi da dung dinh dong) ----------
CREATE OR REPLACE FUNCTION public.v5_close_period(p_new_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev DATE := (date_trunc('month', p_new_month) - INTERVAL '1 month')::date;
  v_new DATE := date_trunc('month', p_new_month)::date;
  v_cfg JSONB;
  v_bank_from DATE;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_rules JSONB; v_pending JSONB;
  v_staff RECORD;
  v_sss public.salary_streak_state;
  v_earn INT;
  v_processed INT := 0;
BEGIN
  PERFORM public.v5_expire_stale(v_new);
  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;
  v_pending := v_rules->'system_v5'->'pending_money_patch';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) = 'object'
     AND (v_pending->>'effective_month')::date <= v_new THEN
    v_rules := v_rules || COALESCE(v_pending->'patch', '{}'::jsonb);
    v_rules := jsonb_set(v_rules, '{system_v5,pending_money_patch}', 'null'::jsonb);
    UPDATE public.salary_bonus_rules SET rules = v_rules, updated_at = now() WHERE user_id = v_owner;
  END IF;
  v_cfg := public.get_salary_v5_config();
  v_bank_from := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');

  FOR v_staff IN SELECT DISTINCT staff_id FROM public.staff_assignments WHERE building_id IS NOT NULL LOOP
    PERFORM public.v5_recompute_streak(v_staff.staff_id, v_prev);
    SELECT * INTO v_sss FROM public.salary_streak_state WHERE user_id = v_staff.staff_id AND period_month = v_prev;
    IF FOUND AND v_prev < v_bank_from THEN
      -- LEGACY: earn reserve cu (nghi-ngang <=1 -> +1) do vao seed lop 2 (1 lan)
      v_earn := CASE WHEN v_sss.breaks_no_leave <= 1 THEN 1 ELSE 0 END;
      INSERT INTO public.salary_shield_seed (user_id, perfect_seed, legacy_earn_applied, organization_id)
      VALUES (v_staff.staff_id,
              LEAST(3, GREATEST(v_sss.shields_reserve - v_sss.shields_reserve_used, 0) + v_earn),
              true, v_sss.organization_id)
      ON CONFLICT (user_id) DO UPDATE SET
        perfect_seed = LEAST(3, salary_shield_seed.perfect_seed + v_earn),
        legacy_earn_applied = true, updated_at = now()
      WHERE NOT salary_shield_seed.legacy_earn_applied;
    END IF;
    INSERT INTO public.salary_streak_state (user_id, period_month, shields_free_left, shields_reserve)
    VALUES (v_staff.staff_id, v_new, COALESCE((v_cfg->'streak_v5'->>'shields_free')::int, 1), 0)
    ON CONFLICT (user_id, period_month) DO UPDATE SET updated_at = now();
    v_processed := v_processed + 1;
  END LOOP;
  RETURN jsonb_build_object('prev_month', v_prev, 'new_month', v_new, 'staff_processed', v_processed);
END; $$;

-- ---------- 4. Recompute lai thang 7-8 cho moi nhan vien co ho so ----------
DO $recompute$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT user_id, period_month FROM public.salary_streak_state
           WHERE period_month IN (DATE '2026-07-01', DATE '2026-08-01') LOOP
    PERFORM public.v5_recompute_streak(r.user_id, r.period_month);
  END LOOP;
END $recompute$;

COMMIT;
