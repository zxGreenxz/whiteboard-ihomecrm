BEGIN;

-- Phase 1: checklist chỉ sinh tầng thực sự tồn tại trong rooms/floors.
CREATE OR REPLACE FUNCTION public.v5_checklist_for_building(
  p_building UUID,
  p_date DATE,
  p_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_vacant INT;
  v_seed BIGINT;
  v_pool TEXT[] := ARRAY['san_thuong','may_bom','khu_rac','hanh_lang_khac'];
  v_rand TEXT;
  v_rand_label TEXT;
  v_floor_candidates INT[];
  v_floor INT;
  v_items JSONB;
BEGIN
  IF p_type = 'QUICK' THEN
    RETURN jsonb_build_array(
      jsonb_build_object('key','pccc','label','PCCC — bình + lối thoát','required',true,'done',false),
      jsonb_build_object('key','tu_dien','label','Tủ điện tổng','required',true,'done',false)
    );
  END IF;

  SELECT COUNT(*) FILTER (WHERE r.status = 'AVAILABLE')
  INTO v_vacant
  FROM public.rooms r
  WHERE r.building_id = p_building
    AND r.deleted_at IS NULL;

  SELECT array_agg(floor_number ORDER BY floor_number)
  INTO v_floor_candidates
  FROM (
    SELECT DISTINCT r.floor AS floor_number
    FROM public.rooms r
    WHERE r.building_id = p_building
      AND r.deleted_at IS NULL
      AND r.floor > 0
    UNION
    SELECT DISTINCT f.floor_number
    FROM public.floors f
    WHERE f.building_id = p_building
      AND COALESCE(f.status, 'active') = 'active'
      AND f.floor_number > 0
  ) actual_floors;

  v_seed := ('x' || substr(md5(p_building::text || p_date::text), 1, 8))::bit(32)::bigint;
  v_rand := v_pool[1 + (v_seed % cardinality(v_pool))::int];
  v_rand_label := CASE v_rand
    WHEN 'san_thuong' THEN 'Sân thượng / mái'
    WHEN 'may_bom' THEN 'Máy bơm và khu kỹ thuật nước'
    WHEN 'khu_rac' THEN 'Khu rác và vệ sinh chung'
    ELSE 'Một hành lang khác'
  END;
  IF cardinality(v_floor_candidates) > 0 THEN
    v_floor := v_floor_candidates[
      1 + ((v_seed / 7) % cardinality(v_floor_candidates))::int
    ];
  END IF;

  v_items := jsonb_build_array(
    jsonb_build_object('key','tu_dien','label','Tủ điện tổng / CB','required',true,'done',false),
    jsonb_build_object('key','pccc','label','PCCC — bình (tem/kim) + lối thoát','required',true,'done',false)
  );

  v_items := v_items || jsonb_build_array(
    CASE
      WHEN v_floor IS NULL THEN
        jsonb_build_object('key','hanh_lang','label','Hành lang / lối đi chung','required',true,'done',false)
      ELSE
        jsonb_build_object('key','hanh_lang','label','Hành lang tầng ' || v_floor,'required',true,'done',false,'floor',v_floor)
    END,
    jsonb_build_object('key','nuoc','label','Nước — bơm/bồn/đồng hồ tổng','required',true,'done',false),
    jsonb_build_object('key','random_' || v_rand,'label','Mục sâu hôm nay: ' || v_rand_label,'required',true,'done',false,'random',true)
  );

  IF v_vacant > 0 THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key','phong_trong',
      'label','PHÒNG TRỐNG — mở cửa vào trong (' || v_vacant || ' phòng đang chào)',
      'required',true,
      'done',false
    ));
  END IF;

  RETURN v_items;
END;
$function$;

-- Authenticated callers reach this helper only inside start_inspection, after
-- start_inspection has passed its can_access_building guard.
REVOKE ALL ON FUNCTION public.v5_checklist_for_building(UUID, DATE, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_checklist_for_building(UUID, DATE, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.start_inspection(
  p_building UUID,
  p_type TEXT DEFAULT 'FULL',
  p_paired_income_expense_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := public.vn_local_date(now());
  v_sess public.inspection_sessions;
  v_reqs JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;
  IF p_type NOT IN ('FULL','QUICK') THEN RAISE EXCEPTION 'type không hợp lệ'; END IF;
  IF NOT COALESCE(public.can_access_building(p_building), false) THEN
    RAISE EXCEPTION 'Không có quyền truy cập tòa nhà'
      USING ERRCODE = '42501';
  END IF;
  IF p_paired_income_expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.income_expenses ie
    WHERE ie.id = p_paired_income_expense_id
      AND ie.deleted_at IS NULL
      AND ie.building_id = p_building
      AND ie.collect_geofence_status = 'ok'
      AND (ie.user_id = v_uid OR public.is_admin())
  ) THEN
    RAISE EXCEPTION 'Phiếu thu ghép không hợp lệ'
      USING ERRCODE = '42501';
  END IF;

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
END;
$function$;

REVOKE ALL ON FUNCTION public.start_inspection(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_inspection(UUID, TEXT, UUID) TO authenticated;

-- Phase 1–2: một nguồn ứng viên tuyến giàu dữ liệu. Hai đồng hồ được giữ riêng:
-- FULL phục vụ chất lượng kiểm tra, touch phục vụ độ phủ vận hành tổng quát.
CREATE OR REPLACE FUNCTION public.v5_route_candidates(p_user UUID)
RETURNS TABLE (
  building_id UUID,
  building_name TEXT,
  cluster_id TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  street_address TEXT,
  ward TEXT,
  district TEXT,
  province TEXT,
  public_map_url TEXT,
  last_touch_date DATE,
  last_full_date DATE,
  days_since_touch INT,
  days_since_full INT,
  vacant_rooms BIGINT,
  rooms_total BIGINT,
  expiring_contracts BIGINT,
  open_jobs BIGINT,
  score NUMERIC,
  priority_bucket INT,
  priority_label TEXT,
  touch_sla_days INT,
  full_interval_days INT,
  checked_today BOOLEAN,
  last_full_by_name TEXT,
  color TEXT,
  reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_cfg JSONB := public.get_salary_v5_config();
  v_sla INT := COALESCE((v_cfg->'coverage_v5'->>'sla_days')::int, 4);
  v_sla_hot INT := COALESCE((v_cfg->'coverage_v5'->>'sla_hot_days')::int, 3);
  v_full_interval INT := COALESCE((v_cfg->'coverage_v5'->>'full_interval_days')::int, 7);
  v_today DATE := public.vn_local_date(now());
BEGIN
  RETURN QUERY
  WITH scope AS (
    SELECT sa.building_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id = p_user
      AND sa.building_id IS NOT NULL
    UNION
    SELECT ab.building_id
    FROM public.staff_assignments sa
    JOIN public.area_buildings ab ON ab.area_id = sa.area_id
    WHERE sa.staff_id = p_user
      AND sa.area_id IS NOT NULL
    UNION
    SELECT b.id
    FROM public.staff_assignments sa
    JOIN public.buildings b ON b.user_id = sa.user_id
    WHERE sa.staff_id = p_user
      AND sa.building_id IS NULL
      AND sa.area_id IS NULL
  ), base AS (
    SELECT
      bc.building_id,
      bc.building_name,
      bc.cluster_id,
      b.latitude::double precision AS latitude,
      b.longitude::double precision AS longitude,
      b.street_address,
      b.ward,
      b.district,
      b.province,
      b.public_map_url,
      bc.last_touch_date,
      bc.last_full_date,
      bc.days_since_touch::int AS d_touch,
      bc.days_since_full::int AS d_full,
      CASE
        WHEN jsonb_typeof(
          v_cfg->'coverage_v5'->'building_overrides'->bc.building_id::text
        ) = 'object'
        THEN v_cfg->'coverage_v5'->'building_overrides'->bc.building_id::text
        ELSE '{}'::jsonb
      END AS building_override,
      bc.vacant_rooms,
      bc.rooms_total,
      (SELECT COUNT(*)
       FROM public.contracts c
       JOIN public.rooms r ON r.id = c.room_id
       WHERE r.building_id = bc.building_id
         AND r.deleted_at IS NULL
         AND c.status = 'ACTIVE'
         AND c.deleted_at IS NULL
         AND c.end_date BETWEEN v_today AND v_today + 30) AS expiring,
      (SELECT COUNT(*)
       FROM public.jobs j
       WHERE j.building_id = bc.building_id
         AND j.status = 'IN_PROGRESS') AS open_jobs,
      lf.full_by_name
    FROM public.building_coverage bc
    JOIN scope s ON s.building_id = bc.building_id
    JOIN public.buildings b ON b.id = bc.building_id
    LEFT JOIN LATERAL (
      SELECT p.full_name AS full_by_name
      FROM public.inspection_sessions ins
      LEFT JOIN public.profiles p ON p.id = ins.user_id
      WHERE ins.building_id = bc.building_id
        AND ins.type = 'FULL'
        AND ins.status = 'passed'
      ORDER BY ins.session_date DESC, ins.ended_at DESC NULLS LAST,
               ins.started_at DESC, ins.id DESC
      LIMIT 1
    ) lf ON true
    WHERE bc.rooms_total > 0
      AND b.deleted_at IS NULL
      AND COALESCE(b.is_virtual, false) = false
      AND b.status = 'ACTIVE'
  ), resolved AS (
    SELECT
      x.*,
      CASE
        WHEN jsonb_typeof(x.building_override->'is_hot') = 'boolean'
        THEN (x.building_override->>'is_hot')::boolean
        ELSE x.vacant_rooms > 0
      END AS is_hot,
      CASE
        WHEN jsonb_typeof(x.building_override->'sla_days') = 'number' THEN
          CASE
            WHEN (x.building_override->>'sla_days')::numeric >= 1
              AND (x.building_override->>'sla_days')::numeric <= 2147483647
              AND trunc((x.building_override->>'sla_days')::numeric)
                = (x.building_override->>'sla_days')::numeric
            THEN (x.building_override->>'sla_days')::int
          END
      END AS override_sla
    FROM base x
  ), classified AS (
    SELECT
      x.*,
      COALESCE(
        x.override_sla,
        CASE WHEN x.is_hot THEN v_sla_hot ELSE v_sla END
      ) AS effective_sla,
      ROUND(
        LEAST(COALESCE(x.d_touch, 999), 60) * (1 + x.rooms_total / 20.0)
        + CASE WHEN x.is_hot THEN 10 ELSE 0 END
        + LEAST(5 * x.expiring, 10)
        + CASE WHEN x.open_jobs > 0 THEN 15 ELSE 0 END,
        1
      ) AS risk_score
    FROM resolved x
  ), prioritized AS (
    SELECT
      c.*,
      CASE
        WHEN c.last_full_date = v_today THEN 4
        WHEN c.last_full_date IS NULL OR c.d_full >= v_full_interval THEN 0
        WHEN c.last_touch_date IS NULL OR c.d_touch >= c.effective_sla THEN 1
        WHEN c.d_full >= GREATEST(v_full_interval - 1, 0)
          OR c.d_touch >= GREATEST(c.effective_sla - 1, 0) THEN 2
        ELSE 3
      END AS bucket
    FROM classified c
  )
  SELECT
    p.building_id,
    p.building_name,
    p.cluster_id,
    p.latitude,
    p.longitude,
    p.street_address,
    p.ward,
    p.district,
    p.province,
    p.public_map_url,
    p.last_touch_date,
    p.last_full_date,
    p.d_touch,
    p.d_full,
    p.vacant_rooms,
    p.rooms_total,
    p.expiring,
    p.open_jobs,
    p.risk_score,
    p.bucket,
    CASE p.bucket
      WHEN 0 THEN CASE WHEN p.last_full_date IS NULL THEN 'never_full' ELSE 'full_overdue' END
      WHEN 1 THEN 'visit_due'
      WHEN 2 THEN 'due_soon'
      WHEN 4 THEN 'checked_today'
      ELSE 'fresh'
    END,
    p.effective_sla,
    v_full_interval,
    COALESCE(p.last_full_date = v_today, false),
    p.full_by_name,
    CASE WHEN p.bucket IN (0, 1) THEN 'red' WHEN p.bucket = 2 THEN 'yellow' ELSE 'green' END,
    TRIM(BOTH ' ·' FROM CONCAT_WS(' · ',
      CASE WHEN p.last_full_date IS NULL THEN 'Chưa từng kiểm tra FULL'
           ELSE p.d_full || ' ngày chưa kiểm tra FULL' END,
      CASE WHEN p.last_touch_date IS NULL THEN 'Chưa có lần ghé được ghi nhận'
           WHEN p.last_touch_date IS DISTINCT FROM p.last_full_date
             THEN p.d_touch || ' ngày từ lần ghé gần nhất' END,
      CASE WHEN p.vacant_rooms > 0 THEN p.vacant_rooms || ' phòng đang chào khách' END,
      CASE WHEN p.expiring > 0 THEN p.expiring || ' HĐ sắp đáo hạn' END,
      CASE WHEN p.open_jobs > 0 THEN 'có việc đang mở' END
    ))
  FROM prioritized p
  ORDER BY
    p.bucket,
    CASE WHEN p.bucket = 0 THEN p.d_full ELSE p.d_touch END DESC NULLS FIRST,
    p.risk_score DESC,
    p.building_name,
    p.building_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.v5_route_candidates(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_route_candidates(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.v5_route_candidates_self()
RETURNS TABLE (
  building_id UUID,
  building_name TEXT,
  cluster_id TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  street_address TEXT,
  ward TEXT,
  district TEXT,
  province TEXT,
  public_map_url TEXT,
  last_touch_date DATE,
  last_full_date DATE,
  days_since_touch INT,
  days_since_full INT,
  vacant_rooms BIGINT,
  rooms_total BIGINT,
  expiring_contracts BIGINT,
  open_jobs BIGINT,
  score NUMERIC,
  priority_bucket INT,
  priority_label TEXT,
  touch_sla_days INT,
  full_interval_days INT,
  checked_today BOOLEAN,
  last_full_by_name TEXT,
  color TEXT,
  reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT * FROM public.v5_route_candidates(auth.uid());
$function$;

REVOKE ALL ON FUNCTION public.v5_route_candidates_self() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_route_candidates_self() TO authenticated;

-- Giữ contract cũ cho digest/caller hiện hữu nhưng lấy thứ tự và lý do từ core V2.
CREATE OR REPLACE FUNCTION public.v5_daily_missions(p_user UUID)
RETURNS TABLE (
  building_id UUID,
  building_name TEXT,
  cluster_id TEXT,
  days_since_touch INT,
  days_since_full INT,
  vacant_rooms BIGINT,
  score NUMERIC,
  color TEXT,
  reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    c.building_id,
    c.building_name,
    c.cluster_id,
    c.days_since_touch,
    c.days_since_full,
    c.vacant_rooms,
    c.score,
    c.color,
    c.reason
  FROM public.v5_route_candidates(p_user) c
  ORDER BY
    c.priority_bucket,
    CASE WHEN c.priority_bucket = 0 THEN c.days_since_full ELSE c.days_since_touch END DESC NULLS FIRST,
    c.score DESC,
    c.building_name,
    c.building_id;
$function$;

REVOKE ALL ON FUNCTION public.v5_daily_missions(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_daily_missions(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.v5_daily_missions_self()
RETURNS TABLE (
  building_id UUID,
  building_name TEXT,
  cluster_id TEXT,
  days_since_touch INT,
  days_since_full INT,
  vacant_rooms BIGINT,
  score NUMERIC,
  color TEXT,
  reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT * FROM public.v5_daily_missions(auth.uid());
$function$;

REVOKE ALL ON FUNCTION public.v5_daily_missions_self() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_daily_missions_self() TO authenticated;

-- Atomic single-key merge prevents concurrent tabs/devices from overwriting
-- unrelated preferences in profiles.ui_preferences.
CREATE OR REPLACE FUNCTION public.set_my_ui_preference(
  p_key TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_preferences JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF p_key IS NULL OR btrim(p_key) = '' OR length(p_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_UI_PREFERENCE_KEY';
  END IF;

  UPDATE public.profiles p
  SET ui_preferences = jsonb_set(
        COALESCE(p.ui_preferences, '{}'::jsonb),
        ARRAY[p_key],
        COALESCE(p_value, 'null'::jsonb),
        true
      )
  WHERE p.id = auth.uid()
  RETURNING p.ui_preferences INTO v_preferences;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND';
  END IF;

  RETURN v_preferences;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_ui_preference(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_ui_preference(TEXT, JSONB) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
