-- ============================================================
-- V5 ENGINE (S2a) — RPC dấu chân: inspection FULL/QUICK, tick core,
-- payment GPS, streak recompute (banked + khiên).
-- Chuẩn RPC ghi: SECURITY DEFINER + search_path + advisory lock +
-- idempotent + lỗi ghi salary_award_errors (KHÔNG nuốt im lặng).
-- REVERT: scripts/v5_rollback_s2.sql
-- ============================================================

-- SSS: mốc reset sau án gian lận (C2 — "tính lại từ ngày kế")
ALTER TABLE public.salary_streak_state
  ADD COLUMN IF NOT EXISTS reset_from_date DATE;

-- Dedup thông báo treo "check nhà sau thu tiền": 1 thông báo/toà/ngày (C14)
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_v5_pending_check
  ON public.notifications (user_id, (metadata->>'building_id'), (metadata->>'date'))
  WHERE (metadata->>'v5') = 'pending_check';

-- ---------- Helper: khoảng cách haversine (m) ----------
CREATE OR REPLACE FUNCTION public.v5_distance_m(lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN NULL
  ELSE ROUND(6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))::int END;
$$;

-- ---------- Helper: cỡ toà + chuẩn ảnh/dwell từ config ----------
CREATE OR REPLACE FUNCTION public.v5_building_reqs(p_building UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_rooms INT;
  v_idx INT;
  v_breaks JSONB := v_cfg->'coverage_v5'->'size_breaks';
BEGIN
  SELECT COUNT(*) INTO v_rooms FROM public.rooms WHERE building_id = p_building;
  v_idx := CASE WHEN v_rooms <= (v_breaks->>0)::int THEN 0
                WHEN v_rooms <= (v_breaks->>1)::int THEN 1
                ELSE 2 END;
  RETURN jsonb_build_object(
    'rooms', v_rooms, 'size_idx', v_idx,
    'photos_min', (v_cfg->'coverage_v5'->'photos_min'->>v_idx)::int,
    'dwell_min_seconds', ((v_cfg->'coverage_v5'->'dwell_min_minutes'->>v_idx)::numeric * 60)::int
  );
END; $$;

-- ---------- Helper: checklist sinh theo toà + mục random seed(ngày+toà) ----------
CREATE OR REPLACE FUNCTION public.v5_checklist_for_building(p_building UUID, p_date DATE, p_type TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vacant INT;
  v_floors INT;
  v_seed BIGINT;
  v_pool TEXT[] := ARRAY['san_thuong','may_bom','khu_rac','hanh_lang_khac'];
  v_rand TEXT;
  v_floor INT;
  v_items JSONB;
BEGIN
  IF p_type = 'QUICK' THEN
    RETURN jsonb_build_array(
      jsonb_build_object('key','pccc','label','PCCC — bình + lối thoát','required',true,'done',false),
      jsonb_build_object('key','tu_dien','label','Tủ điện tổng','required',true,'done',false)
    );
  END IF;
  SELECT COUNT(*) FILTER (WHERE status='AVAILABLE') INTO v_vacant FROM public.rooms WHERE building_id = p_building;
  -- seed xác định theo (ngày, toà) — không đoán trước được giữa các toà/ngày
  v_seed := ('x' || substr(md5(p_building::text || p_date::text), 1, 8))::bit(32)::bigint;
  v_rand := v_pool[1 + (v_seed % 4)::int];
  v_floor := 1 + ((v_seed / 7) % 5)::int; -- tầng chỉ định 1..5 (toà thấp hơn thì FE hiển thị tầng cao nhất có)
  v_items := jsonb_build_array(
    jsonb_build_object('key','tu_dien','label','Tủ điện tổng / CB','required',true,'done',false),
    jsonb_build_object('key','pccc','label','PCCC — bình (tem/kim) + lối thoát','required',true,'done',false),
    jsonb_build_object('key','hanh_lang','label','Hành lang tầng ' || v_floor,'required',true,'done',false,'floor',v_floor),
    jsonb_build_object('key','nuoc','label','Nước — bơm/bồn/đồng hồ tổng','required',true,'done',false),
    jsonb_build_object('key','random_' || v_rand,'label','Mục sâu hôm nay: ' || v_rand,'required',true,'done',false,'random',true)
  );
  IF v_vacant > 0 THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key','phong_trong','label','PHÒNG TRỐNG — mở cửa vào trong (' || v_vacant || ' phòng đang chào)','required',true,'done',false));
  END IF;
  RETURN v_items;
END; $$;

-- ---------- CORE: v5_tick_attendance (B5) — MỌI nguồn tick đi qua đây ----------
-- Idempotent theo UNIQUE(user,date); advisory lock (user,date); binary tuyệt đối.
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

-- ---------- Streak recompute (US-2.6): 100% từ SAD + config ----------
-- Walk từng ngày của tháng tới hôm-nay: ticked → current+1, bank mốc;
-- CN/lễ/phép/pending_leave → bắc cầu; workday lỡ (quá khứ) → tiêu khiên hoặc đứt.
-- breaks_no_leave đếm CẢ ngày lỡ được khiên cứu (trọn-tháng phải sạch tuyệt đối).
CREATE OR REPLACE FUNCTION public.v5_recompute_streak(p_user UUID, p_month DATE)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_today DATE := public.vn_local_date(now());
  v_start DATE := date_trunc('month', p_month)::date;
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

  -- bank mốc theo best (KHÔNG bank full_month ở đây — close_period đánh giá)
  FOR i IN 0 .. jsonb_array_length(v_miles) - 1 LOOP
    m := v_miles->i;
    IF (m->>'milestone') <> 'full_month' AND (m->>'milestone')::int <= v_best THEN
      v_banked := v_banked || jsonb_build_array(jsonb_build_object(
        'milestone', (m->>'milestone')::int, 'delta', (m->>'delta')::numeric,
        'banked_at', COALESCE((SELECT (b->>'banked_at') FROM jsonb_array_elements(v_prev_banked) b
                               WHERE b->>'milestone' = m->>'milestone' LIMIT 1), now()::text)));
    END IF;
  END LOOP;
  -- giữ full_month nếu close_period đã bank trước đó
  v_banked := v_banked || COALESCE(
    (SELECT jsonb_agg(b) FROM jsonb_array_elements(v_prev_banked) b WHERE b->>'milestone' = 'full_month'),
    '[]'::jsonb);

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

-- Helper mốc hiệu-lực (mirror TS effectiveMilestones — C10 tháng ngắn)
CREATE OR REPLACE FUNCTION public.public_v5_effective_milestones(p_miles JSONB, p_deltas JSONB, p_n INT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_out JSONB := '[]'::jsonb;
  v_cut NUMERIC := 0;
  i INT;
  v_m TEXT; v_delta NUMERIC;
BEGIN
  FOR i IN 0 .. jsonb_array_length(p_miles) - 1 LOOP
    v_m := p_miles->>i; v_delta := (p_deltas->>i)::numeric;
    IF v_m = 'full_month' THEN
      CONTINUE;
    ELSIF v_m::int <= p_n THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('milestone', v_m::int, 'delta', v_delta));
    ELSE
      v_cut := v_cut + v_delta;
    END IF;
  END LOOP;
  -- full_month luôn còn, delta dồn phần bị cắt
  FOR i IN 0 .. jsonb_array_length(p_miles) - 1 LOOP
    IF p_miles->>i = 'full_month' THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('milestone', 'full_month',
                                                             'delta', (p_deltas->>i)::numeric + v_cut));
    END IF;
  END LOOP;
  RETURN v_out;
END; $$;

-- ---------- start_inspection: mở/RESUME phiên (C1) ----------
CREATE OR REPLACE FUNCTION public.start_inspection(
  p_building UUID, p_type TEXT DEFAULT 'FULL', p_paired_income_expense_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := public.vn_local_date(now());
  v_sess public.inspection_sessions;
  v_reqs JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;
  IF p_type NOT IN ('FULL','QUICK') THEN RAISE EXCEPTION 'type không hợp lệ'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('v5_insp' || v_uid::text || p_building::text || v_today::text));

  -- RESUME đúng phiên đang dở cùng ngày cùng toà (open/presence) — không tạo phiên mới
  SELECT * INTO v_sess FROM public.inspection_sessions
  WHERE user_id = v_uid AND building_id = p_building AND session_date = v_today
    AND status IN ('open','presence')
    AND (type = p_type OR p_type = 'FULL')  -- "Nâng cấp lên FULL": resume phiên QUICK thành FULL
  ORDER BY started_at DESC LIMIT 1;

  IF FOUND THEN
    IF v_sess.type = 'QUICK' AND p_type = 'FULL' THEN
      UPDATE public.inspection_sessions
      SET type = 'FULL', checklist = public.v5_checklist_for_building(p_building, v_today, 'FULL'),
          paired_income_expense_id = COALESCE(p_paired_income_expense_id, paired_income_expense_id),
          status = 'open', updated_at = now()
      WHERE id = v_sess.id RETURNING * INTO v_sess;
    ELSIF p_paired_income_expense_id IS NOT NULL AND v_sess.paired_income_expense_id IS NULL THEN
      UPDATE public.inspection_sessions SET paired_income_expense_id = p_paired_income_expense_id,
          status = 'open', updated_at = now()
      WHERE id = v_sess.id RETURNING * INTO v_sess;
    ELSIF v_sess.status = 'presence' THEN
      UPDATE public.inspection_sessions SET status = 'open', updated_at = now()
      WHERE id = v_sess.id RETURNING * INTO v_sess;
    END IF;
  ELSE
    INSERT INTO public.inspection_sessions
      (user_id, building_id, type, session_date, checklist, paired_income_expense_id,
       random_item_key)
    VALUES (v_uid, p_building, p_type, v_today,
            public.v5_checklist_for_building(p_building, v_today, p_type),
            p_paired_income_expense_id,
            NULL)
    RETURNING * INTO v_sess;
  END IF;

  v_reqs := public.v5_building_reqs(p_building);
  RETURN jsonb_build_object(
    'session_id', v_sess.id, 'type', v_sess.type, 'status', v_sess.status,
    'session_date', v_sess.session_date, 'checklist', v_sess.checklist,
    'reqs', v_reqs, 'photos_count', v_sess.photos_count, 'dwell_seconds', v_sess.dwell_seconds
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (v_uid, 'start_inspection', p_building, SQLERRM, jsonb_build_object('type', p_type));
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.start_inspection(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_inspection(UUID, TEXT, UUID) TO authenticated;

-- Wrapper mỏng (C15): 1 đường ghi duy nhất
CREATE OR REPLACE FUNCTION public.start_quick_check(p_building UUID, p_paired_income_expense_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.start_inspection(p_building, 'QUICK', p_paired_income_expense_id);
$$;
REVOKE ALL ON FUNCTION public.start_quick_check(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_quick_check(UUID, UUID) TO authenticated;

-- ---------- submit_inspection_photo: idempotent theo (session, hash) ----------
CREATE OR REPLACE FUNCTION public.submit_inspection_photo(
  p_session UUID, p_slot TEXT, p_storage_path TEXT, p_sha256 TEXT,
  p_lat NUMERIC DEFAULT NULL, p_lng NUMERIC DEFAULT NULL, p_exif_time TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_sess public.inspection_sessions;
  v_b public.buildings;
  v_geo JSONB;
  v_dist INT;
  v_status TEXT;
  v_dup_day BOOLEAN;
  v_first TIMESTAMPTZ; v_last TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_sess FROM public.inspection_sessions WHERE id = p_session;
  IF NOT FOUND OR v_sess.user_id <> v_uid THEN RAISE EXCEPTION 'Phiên không hợp lệ'; END IF;
  IF v_sess.status NOT IN ('open','presence') THEN RAISE EXCEPTION 'Phiên đã đóng'; END IF;

  -- ảnh trùng hash trong CÙNG NGÀY của user (mọi phiên) → không tính (chống nộp lại/chụp hộ)
  SELECT EXISTS (
    SELECT 1 FROM public.inspection_photos ph
    JOIN public.inspection_sessions s2 ON s2.id = ph.session_id
    WHERE s2.user_id = v_uid AND s2.session_date = v_sess.session_date AND ph.sha256_hash = p_sha256
  ) INTO v_dup_day;
  IF v_dup_day THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'duplicate_hash',
      'message', 'Ảnh này đã dùng hôm nay — chụp ảnh mới tại chỗ nhé');
  END IF;

  SELECT * INTO v_b FROM public.buildings WHERE id = v_sess.building_id;
  v_geo := public.get_acceptance_geofence_config(); -- 1 nguồn sự thật bán kính (B11)
  IF p_lat IS NULL OR p_lng IS NULL THEN v_status := 'gps_denied'; v_dist := NULL;
  ELSIF v_b.latitude IS NULL OR v_b.longitude IS NULL THEN v_status := 'ok'; v_dist := NULL; -- toà chưa gắn toạ độ: không phạt oan
  ELSE
    v_dist := public.v5_distance_m(p_lat, p_lng, v_b.latitude, v_b.longitude);
    v_status := CASE WHEN v_dist <= COALESCE((v_geo->>'radius_m')::int, 70) THEN 'ok' ELSE 'out_of_range' END;
  END IF;

  INSERT INTO public.inspection_photos (session_id, slot, storage_path, sha256_hash, exif_time, lat, lng, distance_m, geofence_status)
  VALUES (p_session, p_slot, p_storage_path, p_sha256, COALESCE(p_exif_time, now()), p_lat, p_lng, v_dist, v_status)
  ON CONFLICT (session_id, sha256_hash) DO NOTHING;

  -- cập nhật checklist done + dwell (span ảnh đầu→cuối trong phiên) + photos_count
  SELECT MIN(created_at), MAX(created_at) INTO v_first, v_last
  FROM public.inspection_photos WHERE session_id = p_session;
  UPDATE public.inspection_sessions SET
    photos_count = (SELECT COUNT(*) FROM public.inspection_photos WHERE session_id = p_session),
    dwell_seconds = GREATEST(dwell_seconds, COALESCE(EXTRACT(EPOCH FROM (v_last - v_first))::int, 0)),
    checklist = (
      SELECT jsonb_agg(CASE WHEN item->>'key' = p_slot THEN item || '{"done":true}'::jsonb ELSE item END)
      FROM jsonb_array_elements(checklist) item),
    updated_at = now()
  WHERE id = p_session;

  RETURN jsonb_build_object('accepted', true, 'geofence_status', v_status, 'distance_m', v_dist);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (v_uid, 'submit_inspection_photo', p_session, SQLERRM, jsonb_build_object('slot', p_slot));
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.submit_inspection_photo(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_inspection_photo(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ) TO authenticated;

-- ---------- complete_inspection: chấm gate TẠI TOÀ, pass → tick ----------
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
  IF v_sess.session_date <> public.vn_local_date(now()) THEN
    UPDATE public.inspection_sessions SET status='expired', ended_at=now(), updated_at=now() WHERE id = p_session;
    RETURN jsonb_build_object('status','expired','message','Phiên đã qua 23:59 — hôm nay là cơ hội mới');
  END IF;

  v_reqs := public.v5_building_reqs(v_sess.building_id);

  -- Σ dwell các phiên CÙNG NGÀY CÙNG TOÀ (C1 — cộng dồn)
  SELECT COALESCE(SUM(dwell_seconds),0) INTO v_dwell_total
  FROM public.inspection_sessions
  WHERE user_id = v_uid AND building_id = v_sess.building_id AND session_date = v_sess.session_date;

  SELECT COUNT(*) INTO v_photos_ok FROM public.inspection_photos WHERE session_id = p_session;
  -- geofence: ≥1 ảnh ok trong phiên (audit-only từng ảnh; presence yêu cầu ≥1 ok/gps_denied-với-toạ-độ-toà-null)
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

  -- "Tình trạng nhà" ≠ OK → tự sinh job sửa TRONG transaction (spawned_job_id)
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
      -- QUICK pass: KHÔNG tự là ngày-công; nhưng nếu đang nợ check-sau-thu-tiền tại toà này → chốt tick nguồn PAYMENT
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
      status = 'presence',  -- fail chuẩn = presence (reset SLA), KHÔNG tick (B7)
      condition_note = p_condition_note, fail_reasons = v_missing, updated_at = now()
    WHERE id = p_session;
    RETURN jsonb_build_object('status', 'presence', 'missing', to_jsonb(v_missing),
      'message', 'Còn ' || COALESCE(array_length(v_missing,1),0) || ' mục nữa là đủ công hôm nay',
      'dwell_total_seconds', v_dwell_total, 'resume_hint', 'Mở lại phiên này từ Ngày hôm nay của tôi trước 23:59');
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (v_uid, 'complete_inspection', p_session, SQLERRM, NULL);
  RAISE;
END; $$;
REVOKE ALL ON FUNCTION public.complete_inspection(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_inspection(UUID, TEXT) TO authenticated;

-- ---------- v5_tick_from_job: nguồn 1 (job pass) — FE gọi sau hoàn thành việc ----------
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
  IF NOT ( (jsonb_typeof(COALESCE(v_j.completion_attachments,'[]'::jsonb))='array' AND jsonb_array_length(COALESCE(v_j.completion_attachments,'[]'::jsonb))>0)
        OR (jsonb_typeof(COALESCE(v_j.attachments,'[]'::jsonb))='array' AND jsonb_array_length(COALESCE(v_j.attachments,'[]'::jsonb))>0) ) THEN
    RETURN jsonb_build_object('ticked', false, 'reason', 'no_photo_evidence');
  END IF;
  RETURN public.v5_tick_attendance(v_uid, public.vn_local_date(COALESCE(v_j.completion_time, v_j.created_at)), 'JOB', p_job_id, v_j.title);
END; $$;
REVOKE ALL ON FUNCTION public.v5_tick_from_job(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_tick_from_job(UUID) TO authenticated;

-- ---------- record_payment_gps: nguồn 3 — GPS lúc bấm Thu tiền (A1#3) ----------
-- Gọi SAU khi phiếu lưu OK; KHÔNG BAO GIỜ fail phiếu thu (mọi lỗi chỉ log + trả none).
CREATE OR REPLACE FUNCTION public.record_payment_gps(p_income_expense_id UUID, p_lat NUMERIC, p_lng NUMERIC)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_ie public.income_expenses;
  v_bld UUID;
  v_b public.buildings;
  v_geo JSONB;
  v_dist INT; v_status TEXT;
  v_today DATE := public.vn_local_date(now());
  v_checked BOOLEAN;
  v_sad public.salary_attendance_day;
  v_tick JSONB;
BEGIN
  SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_income_expense_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('action','none','reason','ie_not_found'); END IF;
  IF v_ie.user_id <> v_uid AND NOT public.is_admin() THEN
    RETURN jsonb_build_object('action','none','reason','not_owner_of_receipt');
  END IF;
  v_bld := COALESCE(v_ie.building_id, (SELECT building_id FROM public.rooms WHERE id = v_ie.room_id));
  IF v_bld IS NULL THEN RETURN jsonb_build_object('action','none','reason','no_building'); END IF;

  SELECT * INTO v_b FROM public.buildings WHERE id = v_bld;
  v_geo := public.get_acceptance_geofence_config();
  IF p_lat IS NULL OR p_lng IS NULL THEN v_status := 'gps_denied'; v_dist := NULL;
  ELSIF v_b.latitude IS NULL OR v_b.longitude IS NULL THEN v_status := 'ok'; v_dist := NULL;
  ELSE
    v_dist := public.v5_distance_m(p_lat, p_lng, v_b.latitude, v_b.longitude);
    v_status := CASE WHEN v_dist <= COALESCE((v_geo->>'radius_m')::int, 70) THEN 'ok' ELSE 'out_of_range' END;
  END IF;

  UPDATE public.income_expenses SET collect_lat = p_lat, collect_lng = p_lng,
    collect_distance_m = v_dist, collect_geofence_status = v_status
  WHERE id = p_income_expense_id;

  IF v_status <> 'ok' THEN
    -- GPS lệch toà (thu hộ từ xa) / denied: không dấu chân, phiếu vẫn nguyên
    RETURN jsonb_build_object('action','none','geofence_status', v_status, 'distance_m', v_dist);
  END IF;

  -- toà ĐÃ được mình check hôm nay? → tick luôn
  SELECT EXISTS (SELECT 1 FROM public.inspection_sessions
    WHERE user_id = v_uid AND building_id = v_bld AND session_date = v_today
      AND status IN ('passed','quick_done')) INTO v_checked;

  SELECT * INTO v_sad FROM public.salary_attendance_day WHERE user_id = v_uid AND work_date = v_today;

  IF v_checked THEN
    v_tick := public.v5_tick_attendance(v_uid, v_today, 'PAYMENT', p_income_expense_id, 'thu tiền + đã check');
    RETURN jsonb_build_object('action','ticked','geofence_status',v_status,'tick',v_tick);
  END IF;

  IF FOUND AND v_sad.status = 'ticked' THEN
    -- C14: ngày ĐÃ ticked → KHÔNG sinh treo; gợi ý piggyback thay thế
    RETURN jsonb_build_object('action','piggyback_prompt','geofence_status',v_status,'building_id',v_bld);
  END IF;

  -- chưa check + ngày chưa tick → SAD pending_check + thông báo TREO (dedup toà+ngày)
  INSERT INTO public.salary_attendance_day (user_id, work_date, status, evidence)
  VALUES (v_uid, v_today, 'pending_check',
          jsonb_build_array(jsonb_build_object('at', now(), 'kind', 'pending_check',
            'building_id', v_bld, 'ref_id', p_income_expense_id)))
  ON CONFLICT (user_id, work_date) DO UPDATE SET
    status = CASE WHEN salary_attendance_day.status = 'pending' THEN 'pending_check' ELSE salary_attendance_day.status END,
    evidence = salary_attendance_day.evidence || jsonb_build_array(jsonb_build_object(
      'at', now(), 'kind', 'pending_check', 'building_id', v_bld, 'ref_id', p_income_expense_id)),
    updated_at = now();

  BEGIN
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
    VALUES (v_uid, 'CUSTOM', 'IN_APP', 'PENDING',
      'Cần check nhà sau khi thu tiền',
      'Cần check nhà ' || COALESCE(v_b.name,'') || ' sau khi thu tiền — hoàn thành để chốt ngày công hôm nay',
      jsonb_build_object('v5','pending_check','building_id', v_bld, 'date', v_today, 'url', '/my-day'));
  EXCEPTION WHEN unique_violation THEN NULL; -- 1 thông báo/toà/ngày
  END;

  RETURN jsonb_build_object('action','pending_check','geofence_status',v_status,'building_id',v_bld);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (v_uid, 'record_payment_gps', p_income_expense_id, SQLERRM, NULL);
  RETURN jsonb_build_object('action','none','reason','error_logged');
END; $$;
REVOKE ALL ON FUNCTION public.record_payment_gps(UUID, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment_gps(UUID, NUMERIC, NUMERIC) TO authenticated;

-- ---------- Hết hạn phiên/ngày (gọi bởi job close ngày hoặc lazy) ----------
CREATE OR REPLACE FUNCTION public.v5_expire_stale(p_before DATE)
RETURNS INT LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT;
BEGIN
  UPDATE public.inspection_sessions SET status='expired', updated_at=now()
  WHERE status IN ('open','presence') AND session_date < p_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.salary_attendance_day SET status='expired', updated_at=now()
  WHERE status IN ('pending','pending_check') AND work_date < p_before;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.v5_expire_stale(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_expire_stale(DATE) TO service_role;
