BEGIN;
-- ============================================================
-- V5.1 (spec docs/superpowers/specs/2026-08-26-v5-khien-3-lop-phep-tich-luy-moc-2tr5-design.md)
-- Khien 3 lop + phep tich luy nam + thang streak 2.5tr dinh dong. HIEU LUC 2026-09-01.
--
-- Thang < 2026-09-01 chay nhanh LEGACY voi HANG SO DONG BANG trong ham
-- (khong doc config moi) — vi config bi patch ngay trong migration nay.
-- Kho khien lop 2-3 SUY RA thuan tuy tu salary_attendance_day ke tu
-- shield_bank_from (mo phong chronological) — recompute bao nhieu lan
-- ket qua van y het, khong co bug tru-trung.
--
-- Idempotent: CREATE OR REPLACE / IF NOT EXISTS / ON CONFLICT / guard config.
-- ============================================================

-- ---------- 1. Bang seed quy doi khien du tru cu → lop 2 ----------
CREATE TABLE IF NOT EXISTS public.salary_shield_seed (
  user_id UUID PRIMARY KEY,
  perfect_seed INT NOT NULL DEFAULT 0 CHECK (perfect_seed BETWEEN 0 AND 3),
  legacy_earn_applied BOOLEAN NOT NULL DEFAULT false,
  organization_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.salary_shield_seed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salary_shield_seed FROM PUBLIC, anon, authenticated;

-- Seed 1 lan tu ton kho reserve thang 08/2026 (chay lai khong nhan doi)
INSERT INTO public.salary_shield_seed (user_id, perfect_seed, organization_id)
SELECT s.user_id, LEAST(3, GREATEST(s.shields_reserve - s.shields_reserve_used, 0)), s.organization_id
FROM public.salary_streak_state s
WHERE s.period_month = DATE '2026-08-01'
ON CONFLICT (user_id) DO NOTHING;

-- ---------- 2. Cot cache hien thi ----------
ALTER TABLE public.salary_streak_state
  ADD COLUMN IF NOT EXISTS shields_perfect INT,
  ADD COLUMN IF NOT EXISTS sunday_points NUMERIC(8,1);

-- ---------- 3. Patch config (kem audit; thang legacy dung hang so trong ham) ----------
DO $cfg$
DECLARE
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_rules JSONB;
BEGIN
  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;
  IF v_rules IS NULL THEN RETURN; END IF;
  IF (v_rules->'streak_v5'->>'budget')::numeric = 2500000 THEN RETURN; END IF; -- idempotent
  v_rules := jsonb_set(v_rules, '{streak_v5,budget}', '2500000');
  v_rules := jsonb_set(v_rules, '{streak_v5,milestones}', '[4,8,13,18,23,"n_top"]');
  v_rules := jsonb_set(v_rules, '{streak_v5,deltas}', '[300000,400000,500000,500000,400000,400000]');
  v_rules := jsonb_set(v_rules, '{streak_v5,shields_free}', '1');
  v_rules := jsonb_set(v_rules, '{streak_v5,perfect_shield_cap}', '3');
  v_rules := jsonb_set(v_rules, '{streak_v5,sunday_point}', '0.5');
  v_rules := v_rules #- '{streak_v5,spend_cap}' #- '{streak_v5,reserve_cap}' #- '{streak_v5,shield_earn}';
  v_rules := jsonb_set(v_rules, '{system_v5,shield_bank_from}', '"2026-09-01"');
  v_rules := jsonb_set(v_rules, '{attendance_v5,leave_accrual}', '"yearly"');
  v_rules := jsonb_set(v_rules, '{system_v5,audit}',
    COALESCE(v_rules->'system_v5'->'audit','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'at', now(), 'by', v_owner,
      'patch', 'migration 20260826120000: v5.1 khien 3 lop + phep nam + moc 2tr5 (chu duyet 26/08)',
      'money_effective', '2026-09-01')));
  UPDATE public.salary_bonus_rules SET rules = v_rules, updated_at = now() WHERE user_id = v_owner;
END $cfg$;

-- ---------- 4. Helper moc hieu luc v2 (sentinel n_top; giu full_month cho legacy) ----------
CREATE OR REPLACE FUNCTION public.public_v5_effective_milestones(p_miles JSONB, p_deltas JSONB, p_n INT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_out JSONB := '[]'::jsonb;
  v_cut NUMERIC := 0;
  v_top NUMERIC := NULL;   -- delta cua n_top neu co
  v_fm NUMERIC := NULL;    -- delta cua full_month neu co (legacy)
  i INT; v_m TEXT; v_delta NUMERIC;
  v_last INT; v_merged BOOLEAN := false;
BEGIN
  FOR i IN 0 .. jsonb_array_length(p_miles) - 1 LOOP
    v_m := p_miles->>i; v_delta := (p_deltas->>i)::numeric;
    IF v_m = 'full_month' THEN v_fm := v_delta;
    ELSIF v_m = 'n_top' THEN v_top := v_delta;
    ELSIF v_m::int <= p_n THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('milestone', v_m::int, 'at', v_m::int, 'delta', v_delta));
    ELSE v_cut := v_cut + v_delta;
    END IF;
  END LOOP;
  IF v_top IS NOT NULL THEN
    -- n_top = moc dong tai p_n; don phan cat vao no; trung moc so thi MERGE
    FOR i IN 0 .. jsonb_array_length(v_out) - 1 LOOP
      IF (v_out->i->>'at')::int = p_n THEN
        v_out := jsonb_set(v_out, ARRAY[i::text,'delta'],
                 to_jsonb(((v_out->i->>'delta')::numeric + v_top + v_cut)));
        v_merged := true;
      END IF;
    END LOOP;
    IF NOT v_merged THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('milestone','n_top','at',p_n,'delta', v_top + v_cut));
    END IF;
  ELSIF v_fm IS NOT NULL THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('milestone','full_month','delta', v_fm + v_cut));
  ELSIF v_cut > 0 AND jsonb_array_length(v_out) > 0 THEN
    v_last := jsonb_array_length(v_out) - 1;
    v_out := jsonb_set(v_out, ARRAY[v_last::text,'delta'],
             to_jsonb(((v_out->v_last->>'delta')::numeric + v_cut)));
  END IF;
  RETURN v_out;
END; $$;

-- ---------- 5. Kho khien suy ra tu so (noi bo) ----------
-- Tra {perfect, sunday} tai 00:00 mung 1 cua thang p_upto (chua tinh bien co trong p_upto).
CREATE OR REPLACE FUNCTION public.v5_shield_bank(p_user UUID, p_upto DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_from DATE := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_cap INT := COALESCE((v_cfg->'streak_v5'->>'perfect_shield_cap')::int, 3);
  v_sun NUMERIC := COALESCE((v_cfg->'streak_v5'->>'sunday_point')::numeric, 0.5);
  v_free_cap INT := COALESCE((v_cfg->'streak_v5'->>'shields_free')::int, 1);
  v_today DATE := public.vn_local_date(now());
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_perfect INT := COALESCE((SELECT perfect_seed FROM public.salary_shield_seed WHERE user_id = p_user), 0);
  v_sunday NUMERIC := 0;
  v_m DATE; v_d DATE; v_mend DATE; v_reset DATE;
  v_free INT; v_miss INT; v_leave INT;
  v_status TEXT; v_is_workday BOOLEAN;
BEGIN
  v_m := v_from;
  WHILE v_m < date_trunc('month', p_upto)::date LOOP
    v_mend := (v_m + INTERVAL '1 month')::date - 1;
    SELECT reset_from_date INTO v_reset FROM public.salary_streak_state
      WHERE user_id = p_user AND period_month = v_m;
    v_free := v_free_cap; v_miss := 0; v_leave := 0;
    v_d := v_m;
    WHILE v_d <= LEAST(v_mend, v_today) LOOP
      IF v_reset IS NOT NULL AND v_d < v_reset THEN v_d := v_d + 1; CONTINUE; END IF;
      v_is_workday := EXTRACT(dow FROM v_d) <> 0
        AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = v_d);
      SELECT status INTO v_status FROM public.salary_attendance_day
        WHERE user_id = p_user AND work_date = v_d;
      IF EXTRACT(dow FROM v_d) = 0 AND v_status = 'ticked' THEN
        v_sunday := v_sunday + v_sun;                    -- diem CN, tich theo thoi gian thuc
      ELSIF v_is_workday AND v_status IN ('leave_approved','pending_leave') THEN
        v_leave := v_leave + 1;                          -- phep: trung tinh, nhung mat suat lop 2
      ELSIF v_is_workday AND v_status = 'ticked' THEN
        NULL;
      ELSIF v_is_workday AND v_d < v_today THEN
        v_miss := v_miss + 1;                            -- lo → tieu free → perfect → sunday
        IF v_free > 0 THEN v_free := v_free - 1;
        ELSIF v_perfect > 0 THEN v_perfect := v_perfect - 1;
        ELSIF v_sunday >= 1 THEN v_sunday := v_sunday - 1;
        END IF;                                          -- het sach: chuoi thang do dut (bank khong am)
      END IF;
      v_d := v_d + 1;
    END LOOP;
    IF v_mend < v_today AND v_miss = 0 AND v_leave = 0 THEN
      v_perfect := LEAST(v_cap, v_perfect + 1);          -- thang hoan hao 100%
    END IF;
    v_m := (v_m + INTERVAL '1 month')::date;
  END LOOP;
  RETURN jsonb_build_object('perfect', v_perfect, 'sunday', v_sunday);
END; $$;
REVOKE ALL ON FUNCTION public.v5_shield_bank(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_shield_bank(UUID, DATE) TO service_role;

-- ---------- 6. Recompute LEGACY (thang < bank_from) — HANG SO DONG BANG ----------
-- Body = ban 20260721150000 hien hanh; chi thay cac dong doc config bang hang so:
-- free=3, spend_cap=1, deltas/milestones cu (full_month), budget khong doc o day.
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
  v_deltas JSONB := '[300000,500000,600000,600000,500000,500000]'::jsonb;
  v_banked JSONB := '[]'::jsonb; v_prev_banked JSONB;
  v_last_active DATE; v_fm JSONB; v_milestone JSONB; i INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('v5_sss' || p_user::text || v_start::text));
  SELECT milestones_banked, shields_reserve, reset_from_date
    INTO v_prev_banked, v_reserve, v_reset
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_start;
  v_prev_banked := COALESCE(v_prev_banked, '[]'::jsonb);
  v_reserve := COALESCE(v_reserve, 0);
  v_free := v_free_cap; v_free2 := v_free_cap; v_res2 := v_reserve;
  v_n := public.v5_n_chuan(v_start, p_user);
  v_miles := public.public_v5_effective_milestones('[4,8,13,18,23,"full_month"]'::jsonb, v_deltas, v_n);
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
    IF (v_milestone->>'milestone') <> 'full_month' AND (v_milestone->>'milestone')::int <= v_best THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', (v_milestone->>'milestone')::int, 'delta', (v_milestone->>'delta')::numeric,
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE b->>'milestone' = v_milestone->>'milestone' LIMIT 1), now()::text)));
    END IF;
  END LOOP;
  SELECT milestone_item.value INTO v_fm
  FROM jsonb_array_elements(v_miles) AS milestone_item(value)
  WHERE milestone_item.value->>'milestone' = 'full_month';
  IF v_month_end < v_today THEN
    IF v_fm IS NOT NULL AND v_breaks = 0 AND v_reset IS NULL THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', 'full_month', 'delta', (v_fm->>'delta')::numeric,
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE b->>'milestone' = 'full_month' LIMIT 1), now()::text)));
    END IF;
  ELSE
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
    current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak,
    milestones_banked = EXCLUDED.milestones_banked, breaks_no_leave = EXCLUDED.breaks_no_leave,
    shields_free_left = EXCLUDED.shields_free_left, shields_reserve_used = EXCLUDED.shields_reserve_used,
    sim_cap2 = EXCLUDED.sim_cap2, last_active_date = EXCLUDED.last_active_date, updated_at = now();
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
END; $function$;
REVOKE ALL ON FUNCTION public.v5_recompute_streak_legacy(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_recompute_streak_legacy(UUID, DATE) TO service_role;

-- ---------- 7. Recompute v2 (dispatcher + luat moi) ----------
CREATE OR REPLACE FUNCTION public.v5_recompute_streak(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_bank_from DATE := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_today DATE := public.vn_local_date(now());
  v_start DATE := date_trunc('month', p_month)::date;
  v_month_end DATE := (v_start + INTERVAL '1 month')::date - 1;
  v_end DATE := LEAST(v_month_end, v_today);
  v_reset DATE;
  v_free_cap INT := COALESCE((v_cfg->'streak_v5'->>'shields_free')::int, 1);
  v_sun_pt NUMERIC := COALESCE((v_cfg->'streak_v5'->>'sunday_point')::numeric, 0.5);
  v_bank JSONB; v_perfect INT; v_sunday NUMERIC;
  v_free INT; v_cur INT := 0; v_best INT := 0; v_breaks INT := 0;
  v_d DATE; v_status TEXT; v_is_workday BOOLEAN;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_n INT; v_miles JSONB;
  v_banked JSONB := '[]'::jsonb; v_prev_banked JSONB;
  v_last_active DATE; v_milestone JSONB; i INT; v_at INT;
BEGIN
  IF v_start < v_bank_from THEN
    RETURN public.v5_recompute_streak_legacy(p_user, p_month);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('v5_sss' || p_user::text || v_start::text));
  SELECT milestones_banked, reset_from_date INTO v_prev_banked, v_reset
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_start;
  v_prev_banked := COALESCE(v_prev_banked, '[]'::jsonb);

  v_bank := public.v5_shield_bank(p_user, v_start);
  v_perfect := (v_bank->>'perfect')::int;
  v_sunday := (v_bank->>'sunday')::numeric;
  v_free := v_free_cap;

  v_n := public.v5_n_chuan(v_start, p_user);
  v_miles := public.public_v5_effective_milestones(
    COALESCE(v_cfg->'streak_v5'->'milestones', '[4,8,13,18,23,"n_top"]'::jsonb),
    COALESCE(v_cfg->'streak_v5'->'deltas', '[300000,400000,500000,500000,400000,400000]'::jsonb), v_n);

  v_d := v_start;
  WHILE v_d <= v_end LOOP
    IF v_reset IS NOT NULL AND v_d < v_reset THEN
      v_cur := 0; v_d := v_d + 1; CONTINUE;
    END IF;
    v_is_workday := EXTRACT(dow FROM v_d) <> 0
      AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = v_d);
    SELECT status INTO v_status FROM public.salary_attendance_day
      WHERE user_id = p_user AND work_date = v_d;
    IF EXTRACT(dow FROM v_d) = 0 AND v_status = 'ticked' THEN
      v_sunday := v_sunday + v_sun_pt;   -- diem CN tich ngay khi xay ra (dung duoc trong thang)
    END IF;
    IF NOT v_is_workday OR v_status IN ('leave_approved','pending_leave') THEN
      NULL; -- bac cau: CN / le / phep (ke ca phep dang cho)
    ELSIF v_status = 'ticked' THEN
      v_cur := v_cur + 1; v_best := GREATEST(v_best, v_cur);
      v_last_active := v_d;
    ELSIF v_d < v_today THEN
      v_breaks := v_breaks + 1;
      IF v_free > 0 THEN v_free := v_free - 1;             -- lop 1: mien phi (1/thang)
      ELSIF v_perfect > 0 THEN v_perfect := v_perfect - 1; -- lop 2: thang-hoan-hao
      ELSIF v_sunday >= 1 THEN v_sunday := v_sunday - 1;   -- lop 3: diem CN (1 ngay = 1.0)
      ELSE v_cur := 0; END IF;                             -- het 3 lop → dut
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
     shields_free_left, shields_reserve, shields_reserve_used, sim_cap2,
     shields_perfect, sunday_points, last_active_date, reset_from_date, updated_at)
  VALUES (p_user, v_start, v_cur, v_best, v_banked, v_breaks,
          v_free, 0, 0, '{}'::jsonb,
          v_perfect, v_sunday, v_last_active, v_reset, now())
  ON CONFLICT (user_id, period_month) DO UPDATE SET
    current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak,
    milestones_banked = EXCLUDED.milestones_banked, breaks_no_leave = EXCLUDED.breaks_no_leave,
    shields_free_left = EXCLUDED.shields_free_left,
    shields_perfect = EXCLUDED.shields_perfect, sunday_points = EXCLUDED.sunday_points,
    sim_cap2 = EXCLUDED.sim_cap2, last_active_date = EXCLUDED.last_active_date, updated_at = now();

  RETURN jsonb_build_object(
    'current', v_cur, 'best', v_best, 'breaks_no_leave', v_breaks,
    'shields_free_left', v_free,
    'shields_perfect_left', v_perfect,
    'sunday_points_left', v_sunday,
    'shields_reserve_left', v_perfect, -- tuong thich UI cu trong luc deploy
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
REVOKE ALL ON FUNCTION public.v5_recompute_streak(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_recompute_streak(UUID, DATE) TO service_role;

-- ---------- 8. v5_month_money: tran streak theo che do thang ----------
CREATE OR REPLACE FUNCTION public.v5_month_money(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_bank_from DATE := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_month DATE := date_trunc('month', p_month)::date;
  v_n INT; v_rate NUMERIC; v_ticked INT;
  v_budget NUMERIC := (v_cfg->'attendance_v5'->>'budget')::numeric;
  v_sbudget NUMERIC;
  v_soft JSONB := v_cfg->'attendance_v5'->'soft_floor';
  v_attend NUMERIC; v_streak NUMERIC; v_banked JSONB;
BEGIN
  v_sbudget := CASE WHEN v_month < v_bank_from THEN 3000000
                    ELSE (v_cfg->'streak_v5'->>'budget')::numeric END;
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

-- ---------- 9. request_paid_leave: quota theo NAM cho ngay >= bank_from ----------
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
    updated_at = now();

  -- bao chu (auto-nhac lai sau 24h do digest dam nhiem)
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

-- ---------- 10. v5_close_period: legacy bank vao seed; thang moi khong earn ----------
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
  v_n INT; v_miles JSONB; v_fm JSONB;
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
      -- LEGACY: bank full_month (luat cu, hang so dong bang) + earn reserve cu DO VAO SEED lop 2 (1 lan)
      v_n := public.v5_n_chuan(v_prev, v_staff.staff_id);
      v_miles := public.public_v5_effective_milestones('[4,8,13,18,23,"full_month"]'::jsonb,
                   '[300000,500000,600000,600000,500000,500000]'::jsonb, v_n);
      SELECT m INTO v_fm FROM jsonb_array_elements(v_miles) m WHERE m->>'milestone' = 'full_month';
      IF v_sss.breaks_no_leave = 0 AND v_fm IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sss.milestones_banked) b WHERE b->>'milestone' = 'full_month') THEN
        UPDATE public.salary_streak_state
        SET milestones_banked = milestones_banked || jsonb_build_array(jsonb_build_object(
              'milestone','full_month','delta',(v_fm->>'delta')::numeric,'banked_at', now())),
            updated_at = now()
        WHERE user_id = v_staff.staff_id AND period_month = v_prev;
      END IF;
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

COMMIT;
