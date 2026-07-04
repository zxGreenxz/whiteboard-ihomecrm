-- ============================================================
-- V5 INSPECTION — dwell tính TỪ LÚC BẤM "Kiểm tra" + trần 15 phút.
-- Bối cảnh (bug thực địa 04/07):
--   1) dwell cũ = span ảnh-đầu→ảnh-cuối trong phiên → đứng tại toà 30'
--      mà không chụp thêm thì "Ở lại thêm 5 phút" kẹt mãi.
--   2) chuẩn dwell toà lớn 18' > lời hứa "tối đa 15' từ lúc bấm kiểm tra".
--   3) FE cần started_at + số-ảnh-theo-mục để resume phiên dở hiển thị đúng.
-- Thay đổi:
--   - config coverage_v5.dwell_min_minutes: [8,12,18] → [8,12,15]
--   - v5_building_reqs: kẹp dwell_min_seconds ≤ 900 (kể cả override sau này)
--   - complete_inspection: dwell/phiên = GREATEST(span ảnh, now-started_at) cap 900
--   - start_inspection: payload thêm started_at + slot_counts
-- ============================================================

-- 1) Config: trần 15 phút (coverage_v5 = áp NGAY, không phải key 💰)
UPDATE public.salary_bonus_rules
SET rules = jsonb_set(rules, '{coverage_v5,dwell_min_minutes}', '[8,12,15]'::jsonb)
WHERE rules ? 'coverage_v5';

-- 2) v5_building_reqs: kẹp cứng 900s để override per-toà cũng không vượt lời hứa 15'
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
    -- Lời hứa với nhân viên: tối đa 15 phút tại toà kể từ lúc bấm Kiểm tra
    'dwell_min_seconds', LEAST(((v_cfg->'coverage_v5'->'dwell_min_minutes'->>v_idx)::numeric * 60)::int, 900)
  );
END; $$;

-- 3) start_inspection: thêm started_at + slot_counts (số ảnh đã chụp theo mục)
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
    'reqs', v_reqs, 'photos_count', v_sess.photos_count, 'dwell_seconds', v_sess.dwell_seconds,
    'started_at', v_sess.started_at,
    'slot_counts', COALESCE(
      (SELECT jsonb_object_agg(t.slot, t.n)
       FROM (SELECT slot, COUNT(*)::int AS n FROM public.inspection_photos
             WHERE session_id = v_sess.id GROUP BY slot) t),
      '{}'::jsonb)
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, source_id, error_text, payload)
  VALUES (v_uid, 'start_inspection', p_building, SQLERRM, jsonb_build_object('type', p_type));
  RAISE;
END; $$;

-- 4) complete_inspection: dwell = thời-gian-thực từ started_at (cap 15'/phiên),
--    KHÔNG còn phụ thuộc span ảnh — đứng chờ tại toà là đồng hồ vẫn chạy.
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
