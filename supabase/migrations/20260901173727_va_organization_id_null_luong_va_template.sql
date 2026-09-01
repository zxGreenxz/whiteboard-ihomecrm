-- =============================================================================
-- VÁ organization_id NULL: salary_streak_state (4 dòng tháng 9) + document_templates (1 dòng)
--
-- Bằng chứng (security-gates đỏ 01/09, đo lại trực tiếp trên prod 02/09):
--   • v5_recompute_streak (bản 20260826120000) và v5_recompute_streak_legacy
--     (bản 20260826150000) INSERT vào salary_streak_state KHÔNG có cột
--     organization_id → mỗi lần chạm THÁNG MỚI là đẻ dòng NULL. 4 dòng tháng
--     2026-09 đều NULL trong khi tháng 07/08 có org (v5_close_period từng backfill).
--   • v5_close_period (bản 20260826150000, dòng INSERT seed tháng mới) cũng
--     thiếu organization_id — chính nó seed 2 dòng NULL lúc 00:28 ngày 01/09.
--   • document_templates: client insert không mang org, bảng KHÔNG có
--     trg_autofill_org → 1 dòng NULL tạo 31/08 (user 90450d5f, đúng-1-org).
--   • Công thức biên giới RLS có nhánh `organization_id IS NULL` ⇒ các dòng này
--     hiển thị cho MỌI tổ chức. Đây là NHÃN BỊ QUÊN, không phải dữ liệu toàn hệ
--     — KHÔNG khai vào app_private.org_null_is_global.
--
-- Sửa 4 tầng, tầng nào cũng idempotent và no-op trên database rỗng (bản dựng
-- lại diễn tập): backfill → vá 3 hàm writer → trigger autofill chặn writer cũ
-- → nghiệm thu 0-NULL (0 dòng thì 0 NULL, DB rỗng vẫn qua).
-- =============================================================================

BEGIN;

-- ---------- 1. Backfill dòng NULL đang có ----------
-- Lượt 1: user thuộc đúng MỘT tổ chức trong organization_memberships (mọi
-- status — người đã nghỉ vẫn suy được; user đa-tổ-chức thì KHÔNG đoán, xuống
-- lượt 2). Cùng triết lý LƯỢT 2 của 20260809020000.
UPDATE public.salary_streak_state x
   SET organization_id = nguon.org_id
  FROM (SELECT m.user_id, min(m.organization_id::text)::uuid AS org_id
          FROM public.organization_memberships m
         GROUP BY m.user_id
        HAVING count(DISTINCT m.organization_id) = 1) nguon
 WHERE x.organization_id IS NULL AND nguon.user_id = x.user_id;

UPDATE public.document_templates x
   SET organization_id = nguon.org_id
  FROM (SELECT m.user_id, min(m.organization_id::text)::uuid AS org_id
          FROM public.organization_memberships m
         GROUP BY m.user_id
        HAVING count(DISTINCT m.organization_id) = 1) nguon
 WHERE x.organization_id IS NULL AND nguon.user_id = x.user_id;

-- Lượt 2: rơi về profiles.organization_id (đã đo: cả 4 user đều có, cùng khớp
-- membership — hai nguồn chéo nhau ra cùng org aaaa0000-…-0001).
UPDATE public.salary_streak_state x
   SET organization_id = p.organization_id
  FROM public.profiles p
 WHERE x.organization_id IS NULL AND p.id = x.user_id AND p.organization_id IS NOT NULL;

UPDATE public.document_templates x
   SET organization_id = p.organization_id
  FROM public.profiles p
 WHERE x.organization_id IS NULL AND p.id = x.user_id AND p.organization_id IS NOT NULL;

-- ---------- 2. v5_recompute_streak: INSERT mang organization_id ----------
-- Chép nguyên bản 20260826120000 (V5.1 khiên 3 lớp), chỉ đổi: thêm v_org vào
-- DECLARE, thêm cột organization_id vào INSERT, và ON CONFLICT chỉ điền khi
-- dòng cũ đang NULL (không giẫm nhãn đã có).
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
  -- Org của nhân viên: membership duy-nhất-một-org (ACTIVE), rơi về profiles.
  -- User đa-tổ-chức không suy được thì để NULL — đoán bừa tệ hơn để trống.
  v_org UUID := COALESCE(
    (SELECT CASE WHEN count(DISTINCT m.organization_id) = 1
                 THEN min(m.organization_id::text)::uuid END
       FROM public.organization_memberships m
      WHERE m.user_id = p_user AND m.status = 'ACTIVE'),
    (SELECT p.organization_id FROM public.profiles p WHERE p.id = p_user));
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
     shields_perfect, sunday_points, last_active_date, reset_from_date, updated_at, organization_id)
  VALUES (p_user, v_start, v_cur, v_best, v_banked, v_breaks,
          v_free, 0, 0, '{}'::jsonb,
          v_perfect, v_sunday, v_last_active, v_reset, now(), v_org)
  ON CONFLICT (user_id, period_month) DO UPDATE SET
    current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak,
    milestones_banked = EXCLUDED.milestones_banked, breaks_no_leave = EXCLUDED.breaks_no_leave,
    shields_free_left = EXCLUDED.shields_free_left,
    shields_perfect = EXCLUDED.shields_perfect, sunday_points = EXCLUDED.sunday_points,
    sim_cap2 = EXCLUDED.sim_cap2, last_active_date = EXCLUDED.last_active_date, updated_at = now(),
    organization_id = COALESCE(s.organization_id, EXCLUDED.organization_id);

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

-- ---------- 3. v5_recompute_streak_legacy: INSERT mang organization_id ----------
-- Chép nguyên bản 20260826150000, cùng ba chỗ đổi như trên.
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
  v_org UUID := COALESCE(
    (SELECT CASE WHEN count(DISTINCT m.organization_id) = 1
                 THEN min(m.organization_id::text)::uuid END
       FROM public.organization_memberships m
      WHERE m.user_id = p_user AND m.status = 'ACTIVE'),
    (SELECT p.organization_id FROM public.profiles p WHERE p.id = p_user));
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
     shields_free_left, shields_reserve, shields_reserve_used, sim_cap2, last_active_date, reset_from_date, updated_at, organization_id)
  VALUES (p_user, v_start, v_cur, v_best, v_banked, v_breaks,
          v_free, v_reserve, v_res_used,
          jsonb_build_object('best_streak', v_best2, 'reserve_used', v_res_used2),
          v_last_active, v_reset, now(), v_org)
  ON CONFLICT (user_id, period_month) DO UPDATE SET
    current_streak = EXCLUDED.current_streak, best_streak = EXCLUDED.best_streak,
    milestones_banked = EXCLUDED.milestones_banked, breaks_no_leave = EXCLUDED.breaks_no_leave,
    shields_free_left = EXCLUDED.shields_free_left, shields_reserve_used = EXCLUDED.shields_reserve_used,
    sim_cap2 = EXCLUDED.sim_cap2, last_active_date = EXCLUDED.last_active_date, updated_at = now(),
    organization_id = COALESCE(s.organization_id, EXCLUDED.organization_id);
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

-- ---------- 4. v5_close_period: seed tháng mới mang organization_id ----------
-- Chép nguyên bản 20260826150000; chỗ đổi duy nhất là INSERT seed tháng mới
-- (ưu tiên nhãn của dòng tháng trước, rơi về membership rồi profiles).
-- KHÔNG đụng ACL của hàm này — CREATE OR REPLACE giữ nguyên ACL hiện hành.
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
  v_org UUID;
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
    v_org := COALESCE(
      v_sss.organization_id,
      (SELECT CASE WHEN count(DISTINCT m.organization_id) = 1
                   THEN min(m.organization_id::text)::uuid END
         FROM public.organization_memberships m
        WHERE m.user_id = v_staff.staff_id AND m.status = 'ACTIVE'),
      (SELECT p.organization_id FROM public.profiles p WHERE p.id = v_staff.staff_id));
    INSERT INTO public.salary_streak_state (user_id, period_month, shields_free_left, shields_reserve, organization_id)
    VALUES (v_staff.staff_id, v_new, COALESCE((v_cfg->'streak_v5'->>'shields_free')::int, 1), 0, v_org)
    ON CONFLICT (user_id, period_month) DO UPDATE SET updated_at = now(),
      organization_id = COALESCE(salary_streak_state.organization_id, EXCLUDED.organization_id);
    v_processed := v_processed + 1;
  END LOOP;
  RETURN jsonb_build_object('prev_month', v_prev, 'new_month', v_new, 'staff_processed', v_processed);
END; $$;

-- ---------- 5. Trigger autofill chặn mọi writer còn sót ----------
-- _autofill_org (20260713121000) đã generic: suy org từ user_id qua membership
-- ACTIVE. document_templates chưa từng có trigger này (đó là đường sinh dòng
-- NULL 31/08); salary_streak_state gắn thêm làm lưới an toàn thứ hai.
-- Thứ tự BEFORE INSERT theo alphabet: document_templates_set_user_id_audit
-- chạy TRƯỚC trg_autofill_org nên user_id đã có khi suy org.
DROP TRIGGER IF EXISTS trg_autofill_org ON public.document_templates;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org();
DROP TRIGGER IF EXISTS trg_autofill_org ON public.salary_streak_state;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.salary_streak_state
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- ---------- 6. Nghiệm thu: 0 dòng NULL ----------
-- Trên bản dựng lại diễn tập cả hai bảng RỖNG → 0 NULL, phép đo vẫn chạy và
-- qua sạch (không cần entry sổ kỳ vọng). Trên prod mà còn NULL nghĩa là có
-- user đa-tổ-chức không suy được — DỪNG để soi tay thay vì đoán.
DO $nghiemthu$
DECLARE v_sss INT; v_dt INT;
BEGIN
  SELECT count(*) INTO v_sss FROM public.salary_streak_state WHERE organization_id IS NULL;
  SELECT count(*) INTO v_dt  FROM public.document_templates  WHERE organization_id IS NULL;
  IF v_sss > 0 OR v_dt > 0 THEN
    RAISE EXCEPTION 'Sau backfill vẫn còn % dòng salary_streak_state + % dòng document_templates có organization_id NULL — user đa-tổ-chức hoặc thiếu profile. DỪNG — soi tay.', v_sss, v_dt;
  END IF;
END
$nghiemthu$;

COMMIT;
