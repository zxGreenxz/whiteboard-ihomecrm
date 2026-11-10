-- Điểm danh GPS, bản sửa sau buổi chạy thật đầu tiên (10/11/2026): luật chấm, tình trạng máy, chẩn đoán.
--
-- 1. LUẬT CHẤM (`app_private.gps_checkin_day_v1`). Dấu `stale` — vị trí máy đã có sẵn chứ không phải
--    điểm vừa đo trong lượt — trước đây chỉ được tính khi máy nằm yên (`ok_stationary`); máy đang đi
--    mà vị trí có sẵn còn rất mới vẫn bị chấm «mất tín hiệu». Thêm đúng một nhánh: `stale` mà tuổi
--    vị trí ≤ 120 000 ms (ngưỡng «mới» của chính app) thì là `ok`. Không đòi còn toạ độ: lần dọn
--    hết hạn lưu xoá toạ độ, mốc đã chấm không được lật. Trạng thái tính lúc đọc nên mốc cũ cũng
--    theo luật mới. JSON trả về giữ nguyên từng khoá.
--
-- 2. TÌNH TRẠNG MÁY (`public.gps_checkin_ingest_v1`). Hàm ghép đặt `last_state_at = now` trong khi
--    `state` mới chỉ có hãng/model/SDK/bản app. Báo cáo `device.state` đầy đủ đầu tiên tới ngay sau
--    đó rơi vào bộ hãm 60 giây và bị bỏ, nên tình trạng của máy vừa ghép (quyền vị trí, tối ưu
--    pin…) trống cho tới lần máy báo kế tiếp. Bộ hãm nay nhường khi `state` chưa có
--    `locationPermission` — khoá mà mọi báo cáo đầy đủ đều mang, còn khối gửi lúc ghép thì không.
--
-- 3. CHẨN ĐOÁN (`app_private.gps_checkin_pings.capture_diag`). App từ 1.0.1 gửi kèm mỗi dấu một khối
--    `diag`: báo thức trễ bao lâu, lượt lấy vị trí chạy đường nào, từng nguồn trả mấy điểm. Không
--    toạ độ, không chữ tự do; edge `gps-checkin-ingest` kiểm đúng 13 khoá trước khi gọi xuống đây.
--    Hàm nhận chỉ lưu khi khối là object ≤ 4096 byte; sai thì bỏ khối, không từ chối dấu. Không hàm
--    đọc nào trả cột này ra màn; chỉ để tra khi mốc bị thiếu.
--
-- Hai hàm chép nguyên thân ở 20261109042309, chỉ đổi đúng các chỗ nêu trên. Chữ ký, kiểu trả về,
-- STABLE/VOLATILE, SECURITY DEFINER, search_path và quyền gọi giữ nguyên.
--
-- Không DROP. Idempotent: ADD COLUMN IF NOT EXISTS, ràng buộc chỉ thêm khi chưa có,
-- CREATE OR REPLACE, ACL khẳng định lại.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.gps_checkin_pings') IS NULL
    OR to_regclass('app_private.gps_checkin_devices') IS NULL
    OR to_regclass('app_private.gps_checkin_settings') IS NULL
    OR to_regprocedure('app_private.gps_checkin_day_v1(uuid,uuid,date)') IS NULL
    OR to_regprocedure('public.gps_checkin_ingest_v1(text,jsonb,text)') IS NULL
    OR to_regprocedure('app_private.gps_checkin_expected_slots_v1(uuid,uuid,date)') IS NULL
    OR to_regprocedure('app_private.gps_checkin_device_settings_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.gps_checkin_purge_v1(uuid)') IS NULL
    OR to_regprocedure('public.v5_distance_m(double precision,double precision,double precision,double precision)') IS NULL
    OR to_regprocedure('public.vn_local_date(timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'gps_checkin_capture_diag_requires_missing';
  END IF;
END $requires$;

-- ---------------------------------------------------------------------------
-- 1. Cột chẩn đoán của từng dấu.
-- ---------------------------------------------------------------------------
ALTER TABLE app_private.gps_checkin_pings
  ADD COLUMN IF NOT EXISTS capture_diag jsonb;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'app_private.gps_checkin_pings'::regclass
      AND c.conname = 'gps_checkin_pings_capture_diag_check'
  ) THEN
    ALTER TABLE app_private.gps_checkin_pings
      ADD CONSTRAINT gps_checkin_pings_capture_diag_check CHECK (
        capture_diag IS NULL
        OR (jsonb_typeof(capture_diag) = 'object' AND octet_length(capture_diag::text) <= 4096)
      );
  END IF;
END $constraint$;

COMMENT ON COLUMN app_private.gps_checkin_pings.capture_diag IS
  'Chan doan luot lay vi tri cua app (thoi gian, nguon, trang thai may); khong toa do, khong chu tu do.';

-- ---------------------------------------------------------------------------
-- 2. Trạng thái từng mốc của một ngày: thêm nhánh `stale` còn mới.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.gps_checkin_day_v1(p_org uuid, p_user uuid, p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  WITH cfg AS (
    SELECT s.*
    FROM app_private.gps_checkin_settings s
    WHERE s.organization_id = p_org
    ORDER BY s.version DESC
    LIMIT 1
  ),
  -- Chỉ tính mốc mà đúng lúc đó người này có máy đang ghép: mốc trước khi ghép, hoặc trong
  -- khoảng máy đã thu hồi mà chưa ghép máy mới, không vào mẫu số (Phụ lục B mục 3).
  expected AS (
    SELECT e.slot_at, e.late_tolerance_min
    FROM app_private.gps_checkin_expected_slots_v1(p_org, p_user, p_date) e
    WHERE EXISTS (
      SELECT 1
      FROM app_private.gps_checkin_devices d
      WHERE d.organization_id = p_org
        AND d.user_id = p_user
        AND d.paired_at <= e.slot_at
        AND (d.revoked_at IS NULL OR d.revoked_at > e.slot_at)
    )
  ),
  resolved AS (
    SELECT e.slot_at, e.late_tolerance_min, ping.*,
      CASE
        WHEN ping.fix_status = 'fresh' THEN 'ok'
        -- Vị trí có sẵn trong máy mà chưa quá 2 phút là dấu thật dù máy đang đi. Không đòi còn toạ độ:
        -- lần dọn hết hạn lưu xoá toạ độ, mốc đã chấm không được lật thành thiếu.
        WHEN ping.fix_status = 'stale' AND COALESCE(ping.fix_age_ms, 9007199254740991) <= 120000 THEN 'ok'
        WHEN ping.fix_status = 'stale' AND ping.device_idle IS TRUE
             AND COALESCE(ping.fix_age_ms, 9007199254740991) <= 3600000 THEN 'ok_stationary'
        WHEN ping.reason = 'paused' THEN 'paused'
        WHEN ping.fix_status IS NOT NULL THEN 'missing'
        WHEN now() < e.slot_at THEN 'future'
        WHEN now() <= e.slot_at + make_interval(mins => e.late_tolerance_min + 5) THEN 'pending'
        ELSE 'missing'
      END AS st
    FROM expected e
    LEFT JOIN LATERAL (
      SELECT p.recorded_at, p.fix_status, p.fix_age_ms, p.reason, p.lat, p.lng, p.accuracy_m,
             p.is_mock, p.battery_pct, p.device_idle, p.nearest_building_id, p.nearest_distance_m
      FROM app_private.gps_checkin_pings p
      WHERE p.organization_id = p_org
        AND p.user_id = p_user
        AND p.slot_at = e.slot_at
      ORDER BY CASE p.fix_status WHEN 'fresh' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
               p.recorded_at
      LIMIT 1
    ) ping ON true
  ),
  -- Chỉ mốc có dấu hợp lệ mới có chỗ trên bản đồ, và toạ độ quá hạn lưu thì không trả ra nữa
  -- dù chưa tới lần dọn.
  shown AS (
    SELECT r.*,
           r.st IN ('ok', 'ok_stationary')
           AND r.slot_at >= now() - make_interval(days => COALESCE((SELECT c.retention_days FROM cfg c), 180)) AS has_place
    FROM resolved r
  )
  SELECT jsonb_build_object(
    'enabled', COALESCE((SELECT c.enabled FROM cfg c), false),
    'interval_min', (SELECT c.interval_min FROM cfg c),
    'late_tolerance_min', (SELECT c.late_tolerance_min FROM cfg c),
    'windows', COALESCE((SELECT c.windows FROM cfg c), '[]'::jsonb),
    'paired', EXISTS (
        SELECT 1 FROM app_private.gps_checkin_devices d
        WHERE d.organization_id = p_org AND d.user_id = p_user AND d.revoked_at IS NULL
      ) OR EXISTS (SELECT 1 FROM expected),
    'slots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'at', r.slot_at,
        'status', r.st,
        'reason', COALESCE(r.reason, CASE WHEN r.st = 'missing' AND r.fix_status = 'stale' THEN 'timeout' END),
        'recorded_at', r.recorded_at,
        'lat', CASE WHEN r.has_place THEN r.lat END,
        'lng', CASE WHEN r.has_place THEN r.lng END,
        'accuracy_m', CASE WHEN r.has_place THEN r.accuracy_m END,
        'is_mock', COALESCE(r.is_mock, false),
        'battery_pct', r.battery_pct,
        'nearest_building_id', CASE WHEN r.has_place THEN r.nearest_building_id END,
        'nearest_building_name', CASE WHEN r.has_place
                                      THEN (SELECT b.name FROM public.buildings b WHERE b.id = r.nearest_building_id) END,
        'nearest_distance_m', CASE WHEN r.has_place THEN r.nearest_distance_m END
      ) ORDER BY r.slot_at)
      FROM shown r
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'ok', (SELECT count(*) FROM resolved r WHERE r.st = 'ok'),
      'stationary', (SELECT count(*) FROM resolved r WHERE r.st = 'ok_stationary'),
      'missing', (SELECT count(*) FROM resolved r WHERE r.st = 'missing'),
      'paused', (SELECT count(*) FROM resolved r WHERE r.st = 'paused'),
      'pending', (SELECT count(*) FROM resolved r WHERE r.st = 'pending'),
      'future', (SELECT count(*) FROM resolved r WHERE r.st = 'future'),
      'mock', (SELECT count(*) FROM resolved r WHERE r.st IN ('ok', 'ok_stationary') AND r.is_mock)
    )
  );
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_day_v1(uuid, uuid, date) IS
  'Trang thai tung moc diem danh cua mot nguoi trong mot ngay; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 3. Cổng nhận từ máy: lưu khối chẩn đoán, không bỏ báo cáo tình trạng đầu tiên sau khi ghép.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gps_checkin_ingest_v1(p_digest text, p_event jsonb, p_payload_hash text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_dev app_private.gps_checkin_devices%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_type text := p_event->>'event';
  v_ext text := p_event->>'id';
  v_device jsonb := COALESCE(p_event->'device', '{}'::jsonb);
  v_fix jsonb := COALESCE(p_event->'fix', '{}'::jsonb);
  v_slot timestamptz;
  v_recorded timestamptz;
  v_date date;
  v_fix_status text;
  v_lat double precision;
  v_lng double precision;
  v_near_id uuid;
  v_near_m integer;
  v_has_slots boolean;
  v_in_window boolean;
  v_outcome text;
  v_stored_hash text;
  v_inserted bigint;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_dev
  FROM app_private.gps_checkin_devices d
  WHERE d.credential_digest = p_digest
  FOR UPDATE;

  IF NOT FOUND OR v_dev.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
  END IF;
  IF (p_event->>'deviceId')::uuid IS DISTINCT FROM v_dev.device_id THEN
    RAISE EXCEPTION 'device_mismatch' USING ERRCODE = 'PT409';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = v_dev.user_id AND m.organization_id = v_dev.organization_id AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Mọi sự kiện đều dọn, để tính năng tắt rồi thì máy vẫn báo tình trạng và toạ độ cũ vẫn được xoá.
  PERFORM app_private.gps_checkin_purge_v1(v_dev.organization_id);

  IF v_type = 'device.state' THEN
    -- Hàm ghép đặt `last_state_at` trong khi `state` mới chỉ có hãng/model/SDK/bản app, nên báo cáo
    -- đầy đủ đầu tiên tới ngay sau khi ghép từng bị bộ hãm 60 giây bỏ. Mọi báo cáo đầy đủ đều mang
    -- `locationPermission`: chưa có khoá này nghĩa là chưa lưu được báo cáo nào.
    IF v_dev.last_state_at IS NULL
      OR v_dev.last_state_at < v_now - INTERVAL '60 seconds'
      OR (v_dev.state->'locationPermission') IS NULL THEN
      UPDATE app_private.gps_checkin_devices
      SET state = state || v_device, last_state_at = v_now, last_seen_at = v_now
      WHERE id = v_dev.id;
    END IF;
    v_outcome := 'state';
  ELSIF v_type = 'location.ping' THEN
    v_slot := (p_event->>'slotAt')::timestamptz;
    v_recorded := (p_event->>'recordedAt')::timestamptz;
    IF v_slot IS NULL OR v_recorded IS NULL
      OR v_recorded > v_now + INTERVAL '5 minutes'
      OR v_recorded < v_now - INTERVAL '14 days' THEN
      RAISE EXCEPTION 'gps_ping_invalid_time' USING ERRCODE = '22023';
    END IF;

    v_fix_status := v_fix->>'status';
    IF v_fix_status IS NULL OR v_fix_status NOT IN ('fresh', 'stale', 'none') THEN
      RAISE EXCEPTION 'gps_ping_invalid_fix' USING ERRCODE = '22023';
    END IF;
    IF v_fix_status <> 'none' THEN
      v_lat := (v_fix->>'lat')::double precision;
      v_lng := (v_fix->>'lng')::double precision;
      IF v_lat IS NULL OR v_lng IS NULL THEN
        RAISE EXCEPTION 'gps_ping_invalid_fix' USING ERRCODE = '22023';
      END IF;
    END IF;

    v_date := public.vn_local_date(v_slot);

    -- `slotAt` phải đúng là một mốc mong đợi và giờ ghi nằm trong hạn của chính mốc đó.
    SELECT count(*) > 0,
           COALESCE(bool_or(e.slot_at = v_slot
                            AND v_recorded >= e.slot_at - INTERVAL '2 minutes'
                            AND v_recorded <= e.slot_at + make_interval(mins => e.late_tolerance_min)), false)
    INTO v_has_slots, v_in_window
    FROM app_private.gps_checkin_expected_slots_v1(v_dev.organization_id, v_dev.user_id, v_date) e;

    IF NOT v_has_slots THEN
      v_outcome := 'ignored_off_day';
    ELSIF NOT v_in_window THEN
      v_outcome := 'ignored_out_of_window';
    ELSE
      -- Bình thường mỗi máy một dấu/15 phút; trần này chỉ chắn máy lỗi lặp hoặc token bị lộ,
      -- vẫn đủ rộng cho app gửi bù hàng đợi sau khi mất mạng.
      IF (SELECT count(*) FROM app_private.gps_checkin_pings p
          WHERE p.device_ref = v_dev.id AND p.received_at > v_now - INTERVAL '1 minute') >= 120 THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'PT429';
      END IF;

      IF v_lat IS NOT NULL THEN
        SELECT b.id, public.v5_distance_m(v_lat, v_lng, b.latitude, b.longitude)
        INTO v_near_id, v_near_m
        FROM public.buildings b
        WHERE b.organization_id = v_dev.organization_id
          AND b.deleted_at IS NULL
          AND COALESCE(b.is_virtual, false) = false
          AND b.latitude IS NOT NULL
          AND b.longitude IS NOT NULL
        ORDER BY public.v5_distance_m(v_lat, v_lng, b.latitude, b.longitude)
        LIMIT 1;
      END IF;

      INSERT INTO app_private.gps_checkin_pings (
        organization_id, user_id, device_ref, external_id, payload_hash, slot_at, recorded_at,
        received_at, fix_status, lat, lng, accuracy_m, provider, fix_age_ms, is_mock, reason,
        battery_pct, device_idle, settings_version, nearest_building_id, nearest_distance_m,
        capture_diag
      ) VALUES (
        v_dev.organization_id, v_dev.user_id, v_dev.id, v_ext, p_payload_hash, v_slot, v_recorded,
        v_now, v_fix_status, v_lat, v_lng,
        (v_fix->>'accuracyM')::real,
        v_fix->>'provider',
        (v_fix->>'ageMs')::bigint,
        COALESCE((v_fix->>'mock')::boolean, false),
        p_event->>'reason',
        (v_device->>'batteryPct')::smallint,
        (v_device->>'idle')::boolean,
        (p_event->>'settingsVersion')::integer,
        v_near_id, v_near_m,
        -- Edge đã kiểm hợp đồng của `diag`; ở đây chỉ giữ khối là object vừa cỡ. Sai thì bỏ khối,
        -- không bỏ dấu.
        CASE WHEN jsonb_typeof(p_event->'diag') = 'object' AND octet_length((p_event->'diag')::text) <= 4096
             THEN p_event->'diag' END
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_inserted;

      IF v_inserted IS NOT NULL THEN
        v_outcome := 'accepted';
      ELSE
        -- Không thấy id này nghĩa là đụng ràng buộc một dấu/mốc: máy đã có dấu khác cho mốc đó.
        SELECT p.payload_hash INTO v_stored_hash
        FROM app_private.gps_checkin_pings p
        WHERE p.device_ref = v_dev.id AND p.external_id = v_ext;
        IF v_stored_hash IS DISTINCT FROM p_payload_hash THEN
          RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'PT409';
        END IF;
        v_outcome := 'duplicate';
      END IF;
    END IF;

    -- Gộp, không thay: dấu vị trí không mang model và hãng máy đã báo lúc ghép.
    UPDATE app_private.gps_checkin_devices
    SET last_seen_at = v_now,
        state = state || v_device
    WHERE id = v_dev.id;
  ELSE
    RAISE EXCEPTION 'invalid_event_type' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'status', v_outcome,
    'externalId', v_ext,
    'acceptedAt', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'settings', app_private.gps_checkin_device_settings_v1(v_dev.organization_id, v_dev.user_id)
  );
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_ingest_v1(text, jsonb, text) IS
  'Nhan dau vi tri va tinh trang may. Chi service_role (edge gps-checkin-ingest).';

-- ---------------------------------------------------------------------------
-- 4. Quyền gọi: khẳng định lại đúng như 20261109042309, rồi tự kiểm.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE app_private.gps_checkin_pings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_day_v1(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_ingest_v1(text, jsonb, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.gps_checkin_ingest_v1(text, jsonb, text) TO service_role;

DO $check$
DECLARE
  v_table regclass := 'app_private.gps_checkin_pings'::regclass;
  v_day text := 'app_private.gps_checkin_day_v1(uuid,uuid,date)';
  v_ingest text := 'public.gps_checkin_ingest_v1(text,jsonb,text)';
  v_role text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = v_table
      AND a.attname = 'capture_diag'
      AND NOT a.attisdropped
      AND a.atttypid = 'jsonb'::regtype
      AND NOT a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = v_table
      AND c.conname = 'gps_checkin_pings_capture_diag_check'
      AND c.contype = 'c'
      AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'gps_checkin_capture_diag_column_failed';
  END IF;

  -- Hai hàm vẫn là definer, ghim search_path, và cùng chủ với bảng chúng đọc/ghi.
  IF (
    SELECT count(*)
    FROM pg_proc p
    WHERE p.oid IN (v_day::regprocedure, v_ingest::regprocedure)
      AND p.prosecdef
      AND p.proowner = (SELECT c.relowner FROM pg_class c WHERE c.oid = v_table)
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search_path=pg_catalog,%')
  ) <> 2 THEN
    RAISE EXCEPTION 'gps_checkin_capture_diag_function_failed';
  END IF;

  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_day::regprocedure) <> 's'
    OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_ingest::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'gps_checkin_capture_diag_volatility_failed';
  END IF;

  -- PUBLIC không còn EXECUTE trên cả hai hàm (ACL trống nghĩa là còn quyền mặc định của PUBLIC).
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE p.oid IN (v_day::regprocedure, v_ingest::regprocedure)
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'gps_checkin_capture_diag_acl_public_failed';
  END IF;

  IF NOT has_function_privilege('service_role', v_ingest, 'EXECUTE')
    OR has_function_privilege('authenticated', v_ingest, 'EXECUTE')
    OR has_function_privilege('anon', v_ingest, 'EXECUTE') THEN
    RAISE EXCEPTION 'gps_checkin_capture_diag_acl_ingest_failed';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_day, 'EXECUTE') THEN
      RAISE EXCEPTION 'gps_checkin_capture_diag_acl_day_failed: %', v_role;
    END IF;
    IF has_any_column_privilege(v_role, v_table, 'SELECT')
      OR has_any_column_privilege(v_role, v_table, 'INSERT')
      OR has_any_column_privilege(v_role, v_table, 'UPDATE') THEN
      RAISE EXCEPTION 'gps_checkin_capture_diag_acl_table_failed: %', v_role;
    END IF;
  END LOOP;
END $check$;

COMMIT;
NOTIFY pgrst, 'reload schema';
