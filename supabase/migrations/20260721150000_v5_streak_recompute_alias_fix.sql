BEGIN;

-- Preserve the latest date-hardening behavior; only disambiguate milestone names.
CREATE OR REPLACE FUNCTION public.v5_recompute_streak(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $function$
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
  v_milestone JSONB;
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
    v_milestone := v_miles->i;
    IF (v_milestone->>'milestone') <> 'full_month' AND (v_milestone->>'milestone')::int <= v_best THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', (v_milestone->>'milestone')::int, 'delta', (v_milestone->>'delta')::numeric,
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE b->>'milestone' = v_milestone->>'milestone' LIMIT 1), now()::text)));
    END IF;
  END LOOP;

  -- TRỌN THÁNG (20260720190000): đánh giá NGAY TẠI ĐÂY thay vì chỉ ở v5_close_period.
  -- Trước đây close_period bank một lần duy nhất sáng mùng 1 và bị idem_key theo
  -- THÁNG chặn chạy lại → duyệt phép / tick bù sự cố thiết bị sau ngày 1 không bao
  -- giờ được tính. Giờ mỗi lần recompute (tick, duyệt phép, admin bấm) đều phản ánh
  -- dữ liệu mới nhất. Gate: tháng đã trôi hết + sạch tuyệt đối + không án gian lận.
  SELECT milestone_item.value
  INTO v_fm
  FROM jsonb_array_elements(v_miles) AS milestone_item(value)
  WHERE milestone_item.value->>'milestone' = 'full_month';
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
END;
$function$;

REVOKE ALL ON FUNCTION public.v5_recompute_streak(UUID, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_recompute_streak(UUID, DATE) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
