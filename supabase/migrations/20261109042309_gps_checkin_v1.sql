-- Điểm danh GPS tự động (plan 2026-11-09, Đợt G) và cổng quyền chung của các màn «xem theo người».
--
-- MÔ HÌNH. App Android «iHome Điểm danh» cài trên máy quản lý tự ghi vị trí theo mốc (15/30/60 phút)
-- trong các KHUNG GIỜ chủ đặt. Ngoài khung app không ghi; dấu có mặt lúc đó lấy từ việc đã xong,
-- check nhà, thu tiền như cũ. GPS chỉ là dấu giám sát: file này KHÔNG đụng ngày công hay lương.
--
-- BỐ TRÍ BẢNG. Năm bảng trong `app_private`, bật RLS, không policy, thu hết quyền — cùng tiền lệ
-- `bank_event_*`. Mọi đọc/ghi đi qua hàm dưới đây, hàm nào cũng tự kiểm quyền.
--
-- THIẾT BỊ. Máy ghép nối bằng mã dùng một lần do chính quản lý tạo trong CRM (hạn 10 phút, chỉ
-- lưu SHA-256). Sau đó máy gửi bearer do app tự sinh; máy chủ chỉ giữ SHA-256 của nó. Mỗi người
-- một máy đang hoạt động; ghép máy mới thì máy cũ bị thu hồi và chủ nhìn thấy.
--
-- ĐỒNG Ý. Chủ chốt 09/11/2026: app nội bộ, mặc định coi như đã đồng ý — không có cột/hàm đồng ý.
--
-- HẠN LƯU. Không thêm cron. Toạ độ quá hạn không màn nào đọc được nữa (lọc ngay ở hàm đọc);
-- xoá hẳn ở lần kế tiếp một máy bất kỳ của tổ chức báo về hoặc chủ lưu cài đặt (tối đa 500
-- dòng/lần), giữ lại dòng để còn đếm được số mốc có dấu theo ngày.
--
-- Không DROP. Idempotent: IF NOT EXISTS, CREATE OR REPLACE, ACL khẳng định lại.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.v5_salary_org_of_user_v1(uuid)') IS NULL
    OR to_regprocedure('public.my_org_ids()') IS NULL
    OR to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regprocedure('public.v5_distance_m(double precision,double precision,double precision,double precision)') IS NULL
    OR to_regprocedure('public.vn_local_date(timestamp with time zone)') IS NULL
    OR to_regclass('public.manager_salary_config') IS NULL
    OR to_regclass('public.salary_attendance_day') IS NULL
    OR to_regclass('public.salary_holidays') IS NULL THEN
    RAISE EXCEPTION 'gps_checkin_requires_missing';
  END IF;
END $requires$;

-- ---------------------------------------------------------------------------
-- 1. Cổng quyền chung.
-- ---------------------------------------------------------------------------
-- Được xem: chính mình; HOẶC vai Chủ công ty của ĐÚNG tổ chức mà dữ liệu sẽ được đọc ra (tổ chức
-- lương của người được xem); HOẶC super admin cùng là thành viên tổ chức ấy.
-- Không cho qua theo «bất kỳ tổ chức chung nào»: một người ở cả công ty thật và DEMO thì chủ DEMO
-- sẽ đọc được dữ liệu công ty thật, vì các hàm đọc lấy dữ liệu theo tổ chức lương.
-- Neo theo VAI, không neo theo quyền ở scope ORGANIZATION: vai «Quản Lý Tòa» của org DEMO cũng
-- có scope đó. Không có nhánh service_role, không mở theo session_user.
CREATE OR REPLACE FUNCTION app_private.staff_day_can_view_v1(p_target uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF p_target IS NULL OR v_uid IS NULL THEN
    RETURN false;
  END IF;
  IF p_target = v_uid THEN
    RETURN true;
  END IF;

  -- Người thuộc nhiều tổ chức cùng có luật lương thì hàm này báo lỗi kèm UUID và số tổ chức.
  -- Người ngoài phải nhận 42501 như mọi ca khác, không được đọc thông tin đó.
  BEGIN
    v_org := app_private.v5_salary_org_of_user_v1(p_target);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN false;
  END;

  RETURN v_org IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = p_target AND m.organization_id = v_org AND m.status = 'ACTIVE'
    )
    AND (
      app_private.ie_actor_is_company_owner_v1(v_org, v_uid)
      OR (public.is_super_admin() AND COALESCE(v_org = ANY (public.my_org_ids()), false))
    );
END;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_can_view_v1(uuid) IS
  'Duoc xem Hom nay cua nguoi nay: chinh minh, Chu cong ty cua dung to chuc luong cua nguoi do, hoac super admin la thanh vien to chuc do.';

CREATE OR REPLACE FUNCTION app_private.staff_day_viewer_org_v1(p_org uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := COALESCE(p_org, app_private.v5_salary_org_of_user_v1(v_uid));

  IF v_org IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = v_uid AND m.organization_id = v_org AND m.status = 'ACTIVE'
    )
    OR NOT (app_private.ie_actor_is_company_owner_v1(v_org, v_uid) OR public.is_super_admin())
  THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  RETURN v_org;
END;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_viewer_org_v1(uuid) IS
  'To chuc nguoi goi dang xem ca doi; 42501 neu khong phai Chu cong ty/super admin thanh vien.';

CREATE OR REPLACE FUNCTION app_private.staff_day_user_v1(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT jsonb_build_object(
    'id', p_user,
    'name', COALESCE(NULLIF(btrim(p.full_name), ''), c.alias, 'Nhân viên'),
    'role_title', c.role_title
  )
  FROM (SELECT p_user AS id) one
  LEFT JOIN public.profiles p ON p.id = one.id
  LEFT JOIN LATERAL (
    SELECT cfg.alias, cfg.role_title
    FROM public.manager_salary_config cfg
    WHERE cfg.staff_id = one.id AND cfg.is_active
    ORDER BY cfg.effective_from DESC
    LIMIT 1
  ) c ON true;
$fn$;

COMMENT ON FUNCTION app_private.staff_day_user_v1(uuid) IS
  'Ten va chuc danh hien thi cua mot nguoi; nguoi goi da kiem quyen.';

-- Danh sách người của màn «cả đội» và của điểm danh: có cấu hình lương quản lý đang hiệu lực,
-- hoặc có ngày công v5 trong 30 ngày, và còn là thành viên tổ chức.
CREATE OR REPLACE FUNCTION app_private.staff_day_member_ids_v1(p_org uuid, p_date date)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT x.user_id
  FROM (
    SELECT c.staff_id AS user_id
    FROM public.manager_salary_config c
    WHERE c.organization_id = p_org
      AND c.is_active
      AND c.effective_from <= p_date
      AND (c.effective_to IS NULL OR c.effective_to >= p_date)
    UNION
    SELECT s.user_id
    FROM public.salary_attendance_day s
    WHERE s.organization_id = p_org
      AND s.work_date > p_date - 30
      AND s.work_date <= p_date
  ) x
  WHERE EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = x.user_id AND m.organization_id = p_org AND m.status = 'ACTIVE'
  );
$fn$;

COMMENT ON FUNCTION app_private.staff_day_member_ids_v1(uuid, date) IS
  'Quan ly thuoc pham vi xem theo nguoi cua mot to chuc tai mot ngay; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 2. Bảng.
-- ---------------------------------------------------------------------------
-- Cài đặt chỉ thêm, không sửa: mỗi lần chủ lưu là một phiên bản mới, nhờ đó mốc của các ngày
-- trước vẫn tính theo cài đặt lúc đó.
CREATE TABLE IF NOT EXISTS app_private.gps_checkin_settings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  enabled boolean NOT NULL,
  interval_min integer NOT NULL CHECK (interval_min IN (15, 30, 60)),
  late_tolerance_min integer NOT NULL CHECK (late_tolerance_min IN (5, 10, 15)),
  windows jsonb NOT NULL CHECK (jsonb_typeof(windows) = 'array'),
  skip_sunday boolean NOT NULL DEFAULT true,
  skip_holidays boolean NOT NULL DEFAULT true,
  skip_approved_leave boolean NOT NULL DEFAULT true,
  retention_days integer NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 730),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gps_checkin_settings_version_uq UNIQUE (organization_id, version)
);

-- Bật/tắt theo người cũng chỉ thêm: tắt một người hôm nay không làm mất mốc của các ngày trước.
-- Chưa có dòng nào nghĩa là đang áp dụng.
CREATE TABLE IF NOT EXISTS app_private.gps_checkin_members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  applies boolean NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL
);

CREATE INDEX IF NOT EXISTS gps_checkin_members_lookup_idx
  ON app_private.gps_checkin_members (organization_id, user_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS app_private.gps_checkin_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  credential_digest text NOT NULL UNIQUE CHECK (credential_digest ~ '^[0-9a-f]{64}$'),
  fingerprint text NOT NULL,
  paired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid,
  last_seen_at timestamptz,
  last_state_at timestamptz,
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS gps_checkin_devices_one_active_uq
  ON app_private.gps_checkin_devices (organization_id, user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS app_private.gps_checkin_pair_codes (
  code_digest text PRIMARY KEY CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_device_ref uuid REFERENCES app_private.gps_checkin_devices(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS gps_checkin_pair_codes_user_idx
  ON app_private.gps_checkin_pair_codes (organization_id, user_id)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS app_private.gps_checkin_pings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_ref uuid NOT NULL REFERENCES app_private.gps_checkin_devices(id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (external_id ~ '^[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  slot_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fix_status text NOT NULL CHECK (fix_status IN ('fresh', 'stale', 'none')),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  accuracy_m real CHECK (accuracy_m >= 0),
  provider text,
  fix_age_ms bigint CHECK (fix_age_ms >= 0),
  is_mock boolean NOT NULL DEFAULT false,
  reason text CHECK (reason IN ('permission_denied', 'location_off', 'timeout', 'paused')),
  battery_pct smallint CHECK (battery_pct BETWEEN 0 AND 100),
  device_idle boolean,
  settings_version integer,
  nearest_building_id uuid,
  nearest_distance_m integer,
  coords_purged_at timestamptz,
  CONSTRAINT gps_checkin_pings_external_uq UNIQUE (device_ref, external_id),
  -- Mỗi máy một dấu cho một mốc: số dòng bị chặn bởi số mốc mong đợi, dù máy gửi bao nhiêu lần.
  CONSTRAINT gps_checkin_pings_slot_uq UNIQUE (device_ref, slot_at),
  CONSTRAINT gps_checkin_pings_coords_check CHECK (
    fix_status = 'none'
    OR coords_purged_at IS NOT NULL
    OR (lat IS NOT NULL AND lng IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS gps_checkin_pings_user_slot_idx
  ON app_private.gps_checkin_pings (organization_id, user_id, slot_at);

CREATE INDEX IF NOT EXISTS gps_checkin_pings_device_received_idx
  ON app_private.gps_checkin_pings (device_ref, received_at);

CREATE INDEX IF NOT EXISTS gps_checkin_pings_retention_idx
  ON app_private.gps_checkin_pings (organization_id, slot_at)
  WHERE lat IS NOT NULL;

ALTER TABLE app_private.gps_checkin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.gps_checkin_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.gps_checkin_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.gps_checkin_pair_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.gps_checkin_pings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app_private.gps_checkin_settings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.gps_checkin_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.gps_checkin_devices FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.gps_checkin_pair_codes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.gps_checkin_pings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.gps_checkin_settings_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.gps_checkin_members_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.gps_checkin_pings_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Khung giờ và mốc mong đợi.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.gps_checkin_normalize_windows_v1(p_windows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_prev_to time;
  v_row record;
BEGIN
  IF p_windows IS NULL OR jsonb_typeof(p_windows) <> 'array'
    OR jsonb_array_length(p_windows) NOT BETWEEN 1 AND 6 THEN
    RAISE EXCEPTION 'gps_windows_count' USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT w, w->>'from' AS f, w->>'to' AS t
    FROM jsonb_array_elements(p_windows) w
    ORDER BY w->>'from'
  LOOP
    IF jsonb_typeof(v_row.w) <> 'object'
      OR COALESCE(v_row.f, '') !~ '^([01][0-9]|2[0-3]):[0-5][05]$'
      OR COALESCE(v_row.t, '') !~ '^([01][0-9]|2[0-3]):[0-5][05]$' THEN
      RAISE EXCEPTION 'gps_windows_format' USING ERRCODE = '22023';
    END IF;
    IF v_row.f::time >= v_row.t::time THEN
      RAISE EXCEPTION 'gps_windows_order' USING ERRCODE = '22023';
    END IF;
    IF v_prev_to IS NOT NULL AND v_row.f::time <= v_prev_to THEN
      RAISE EXCEPTION 'gps_windows_overlap' USING ERRCODE = '22023';
    END IF;
    v_prev_to := v_row.t::time;
    v_out := v_out || jsonb_build_array(jsonb_build_object('from', v_row.f, 'to', v_row.t));
  END LOOP;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_normalize_windows_v1(jsonb) IS
  'Kiem va sap xep khung gio: 1-6 khung HH:MM boi so 5 phut, from < to, khong cham nhau.';

CREATE OR REPLACE FUNCTION app_private.gps_checkin_applies_v1(p_org uuid, p_user uuid, p_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT COALESCE((
    SELECT m.applies
    FROM app_private.gps_checkin_members m
    WHERE m.organization_id = p_org AND m.user_id = p_user AND m.effective_from <= p_at
    ORDER BY m.effective_from DESC, m.id DESC
    LIMIT 1
  ), true);
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_applies_v1(uuid, uuid, timestamptz) IS
  'Mot nguoi co dang duoc ap dung diem danh tai mot thoi diem; nguoi goi da kiem quyen.';

CREATE OR REPLACE FUNCTION app_private.gps_checkin_expected_slots_v1(p_org uuid, p_user uuid, p_date date)
RETURNS TABLE (slot_at timestamptz, settings_version integer, late_tolerance_min integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  WITH bounds AS (
    SELECT (p_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t0,
           ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t1
  ),
  versions AS (
    SELECT s.*, lead(s.effective_from) OVER (ORDER BY s.version) AS effective_to
    FROM app_private.gps_checkin_settings s
    WHERE s.organization_id = p_org
  ),
  day_flags AS (
    SELECT EXTRACT(dow FROM p_date) = 0 AS is_sunday,
           EXISTS (SELECT 1 FROM public.salary_holidays h
                   WHERE h.organization_id = p_org AND h.holiday_date = p_date) AS is_holiday,
           EXISTS (SELECT 1 FROM public.salary_attendance_day sad
                   WHERE sad.user_id = p_user AND sad.work_date = p_date
                     AND sad.status = 'leave_approved') AS is_leave
  ),
  active AS (
    SELECT v.*
    FROM versions v, bounds b, day_flags f
    WHERE v.enabled
      AND v.effective_from < b.t1
      AND (v.effective_to IS NULL OR v.effective_to > b.t0)
      AND NOT (v.skip_sunday AND f.is_sunday)
      AND NOT (v.skip_holidays AND f.is_holiday)
      AND NOT (v.skip_approved_leave AND f.is_leave)
  )
  SELECT (g.ts AT TIME ZONE 'Asia/Ho_Chi_Minh') AS slot_at,
         a.version AS settings_version,
         a.late_tolerance_min
  FROM active a
  CROSS JOIN LATERAL jsonb_array_elements(a.windows) w
  CROSS JOIN LATERAL generate_series(
    p_date + (w->>'from')::time,
    p_date + (w->>'to')::time,
    make_interval(mins => a.interval_min)
  ) AS g(ts)
  WHERE (g.ts AT TIME ZONE 'Asia/Ho_Chi_Minh') >= a.effective_from
    AND (a.effective_to IS NULL OR (g.ts AT TIME ZONE 'Asia/Ho_Chi_Minh') < a.effective_to)
    AND app_private.gps_checkin_applies_v1(p_org, p_user, g.ts AT TIME ZONE 'Asia/Ho_Chi_Minh')
  ORDER BY 1;
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_expected_slots_v1(uuid, uuid, date) IS
  'Cac moc mong doi cua mot nguoi trong mot ngay gio VN, theo phien ban cai dat dang hieu luc tung luc.';

-- ---------------------------------------------------------------------------
-- 4. Trạng thái từng mốc của một ngày: nguồn chung cho mọi màn.
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

-- Cài đặt gửi xuống máy, kèm giờ máy chủ để app tự chỉnh lệch giờ.
CREATE OR REPLACE FUNCTION app_private.gps_checkin_device_settings_v1(p_org uuid, p_user uuid)
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
  today AS (SELECT public.vn_local_date(now()) AS d)
  SELECT jsonb_build_object(
    'version', COALESCE(c.version, 0),
    'enabled', COALESCE(c.enabled, false),
    'applies', app_private.gps_checkin_applies_v1(p_org, p_user, now()),
    'intervalMin', COALESCE(c.interval_min, 30),
    'toleranceMin', COALESCE(c.late_tolerance_min, 10),
    'windows', COALESCE((SELECT jsonb_agg(jsonb_build_array(w->>'from', w->>'to'))
                         FROM jsonb_array_elements(c.windows) w), '[]'::jsonb),
    'skipSunday', COALESCE(c.skip_sunday, true),
    'offDates', COALESCE((
      SELECT jsonb_agg(off_day ORDER BY off_day)
      FROM (
        SELECT h.holiday_date AS off_day
        FROM public.salary_holidays h, today
        WHERE h.organization_id = p_org
          AND COALESCE(c.skip_holidays, true)
          AND h.holiday_date BETWEEN today.d AND today.d + 14
        UNION
        SELECT sad.work_date
        FROM public.salary_attendance_day sad, today
        WHERE sad.user_id = p_user
          AND sad.status = 'leave_approved'
          AND COALESCE(c.skip_approved_leave, true)
          AND sad.work_date BETWEEN today.d AND today.d + 14
      ) off_days
    ), '[]'::jsonb),
    'tz', 'Asia/Ho_Chi_Minh',
    'serverNow', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM (SELECT 1) one
  LEFT JOIN cfg c ON true;
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_device_settings_v1(uuid, uuid) IS
  'Cai dat gui xuong may theo tung nguoi; nguoi goi da xac thuc thiet bi.';

CREATE OR REPLACE FUNCTION app_private.gps_checkin_device_json_v1(p_org uuid, p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT jsonb_build_object(
    'id', d.id,
    'paired_at', d.paired_at,
    'last_seen_at', d.last_seen_at,
    'last_state_at', d.last_state_at,
    'state', d.state
  )
  FROM app_private.gps_checkin_devices d
  WHERE d.organization_id = p_org AND d.user_id = p_user AND d.revoked_at IS NULL;
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_device_json_v1(uuid, uuid) IS
  'May dang hoat dong cua mot nguoi; nguoi goi da kiem quyen.';

-- Xoá toạ độ quá hạn của một tổ chức, giữ dòng để còn đếm. Gọi từ cổng nhận và lúc chủ lưu cài đặt.
CREATE OR REPLACE FUNCTION app_private.gps_checkin_purge_v1(p_org uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_days integer;
  v_purged integer;
BEGIN
  SELECT s.retention_days INTO v_days
  FROM app_private.gps_checkin_settings s
  WHERE s.organization_id = p_org
  ORDER BY s.version DESC
  LIMIT 1;

  UPDATE app_private.gps_checkin_pings p
  SET lat = NULL, lng = NULL, accuracy_m = NULL, nearest_building_id = NULL,
      nearest_distance_m = NULL, coords_purged_at = v_now
  WHERE p.id IN (
    SELECT x.id
    FROM app_private.gps_checkin_pings x
    WHERE x.organization_id = p_org
      AND x.lat IS NOT NULL
      AND x.slot_at < v_now - make_interval(days => COALESCE(v_days, 180))
    LIMIT 500
  );
  GET DIAGNOSTICS v_purged = ROW_COUNT;
  RETURN v_purged;
END;
$fn$;

COMMENT ON FUNCTION app_private.gps_checkin_purge_v1(uuid) IS
  'Xoa toa do qua han luu cua mot to chuc, toi da 500 dong moi lan; nguoi goi da kiem quyen.';

-- ---------------------------------------------------------------------------
-- 5. Màn cài đặt của chủ.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gps_checkin_settings_get_v1(p_org uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_today date := public.vn_local_date(now());
  v_row app_private.gps_checkin_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  v_org := app_private.staff_day_viewer_org_v1(p_org);

  SELECT * INTO v_row
  FROM app_private.gps_checkin_settings s
  WHERE s.organization_id = v_org
  ORDER BY s.version DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'organization_id', v_org,
    'as_of', now(),
    'configured', FOUND,
    'settings', CASE WHEN v_row.id IS NOT NULL THEN jsonb_build_object(
        'version', v_row.version,
        'effective_from', v_row.effective_from,
        'enabled', v_row.enabled,
        'interval_min', v_row.interval_min,
        'late_tolerance_min', v_row.late_tolerance_min,
        'windows', v_row.windows,
        'skip_sunday', v_row.skip_sunday,
        'skip_holidays', v_row.skip_holidays,
        'skip_approved_leave', v_row.skip_approved_leave,
        'retention_days', v_row.retention_days
      ) ELSE jsonb_build_object(
        'version', 0,
        'effective_from', NULL,
        'enabled', false,
        'interval_min', 30,
        'late_tolerance_min', 10,
        'windows', jsonb_build_array(
          jsonb_build_object('from', '08:00', 'to', '11:30'),
          jsonb_build_object('from', '13:30', 'to', '17:30')
        ),
        'skip_sunday', true,
        'skip_holidays', true,
        'skip_approved_leave', true,
        'retention_days', 180
      ) END,
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user', app_private.staff_day_user_v1(ids.user_id),
        'applies', app_private.gps_checkin_applies_v1(v_org, ids.user_id, now()),
        'device', app_private.gps_checkin_device_json_v1(v_org, ids.user_id),
        'last_ping_at', (SELECT max(p.recorded_at) FROM app_private.gps_checkin_pings p
                         WHERE p.organization_id = v_org AND p.user_id = ids.user_id)
      ) ORDER BY app_private.staff_day_user_v1(ids.user_id) ->> 'name')
      FROM app_private.staff_day_member_ids_v1(v_org, v_today) AS ids(user_id)
    ), '[]'::jsonb)
  );
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_settings_get_v1(uuid) IS
  'Cai dat diem danh GPS va tinh trang may tung nguoi. Chi Chu cong ty/super admin thanh vien.';

CREATE OR REPLACE FUNCTION public.gps_checkin_settings_set_v1(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_windows jsonb;
  v_enabled boolean;
  v_interval integer;
  v_tolerance integer;
  v_sunday boolean;
  v_holidays boolean;
  v_leave boolean;
  v_retention integer;
  v_last app_private.gps_checkin_settings%ROWTYPE;
  v_version integer;
  v_effective timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  v_org := app_private.staff_day_viewer_org_v1(NULL);

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'gps_settings_invalid' USING ERRCODE = '22023';
  END IF;

  v_windows := app_private.gps_checkin_normalize_windows_v1(p_patch->'windows');
  v_enabled := (p_patch->>'enabled')::boolean;
  v_interval := (p_patch->>'interval_min')::integer;
  v_tolerance := (p_patch->>'late_tolerance_min')::integer;
  v_sunday := COALESCE((p_patch->>'skip_sunday')::boolean, true);
  v_holidays := COALESCE((p_patch->>'skip_holidays')::boolean, true);
  v_leave := COALESCE((p_patch->>'skip_approved_leave')::boolean, true);
  v_retention := (p_patch->>'retention_days')::integer;

  IF v_enabled IS NULL OR v_interval IS NULL OR v_interval NOT IN (15, 30, 60)
    OR v_tolerance IS NULL OR v_tolerance NOT IN (5, 10, 15)
    OR (v_retention IS NOT NULL AND v_retention NOT BETWEEN 30 AND 730) THEN
    RAISE EXCEPTION 'gps_settings_invalid' USING ERRCODE = '22023';
  END IF;

  -- Một người lưu một lúc cho mỗi tổ chức, để số phiên bản không chen nhau.
  PERFORM pg_advisory_xact_lock(hashtextextended('gps_checkin_settings:' || v_org::text, 0));

  SELECT * INTO v_last
  FROM app_private.gps_checkin_settings s
  WHERE s.organization_id = v_org
  ORDER BY s.version DESC
  LIMIT 1;

  -- Màn cài đặt không gửi hạn lưu: giữ nguyên giá trị đang có.
  v_retention := COALESCE(v_retention, v_last.retention_days, 180);

  IF v_last.id IS NOT NULL
    AND v_last.enabled = v_enabled
    AND v_last.interval_min = v_interval
    AND v_last.late_tolerance_min = v_tolerance
    AND v_last.windows = v_windows
    AND v_last.skip_sunday = v_sunday
    AND v_last.skip_holidays = v_holidays
    AND v_last.skip_approved_leave = v_leave
    AND v_last.retention_days = v_retention THEN
    RETURN jsonb_build_object('version', v_last.version, 'effective_from', v_last.effective_from, 'unchanged', true);
  END IF;

  v_version := COALESCE(v_last.version, 0) + 1;

  INSERT INTO app_private.gps_checkin_settings (
    organization_id, version, enabled, interval_min, late_tolerance_min, windows,
    skip_sunday, skip_holidays, skip_approved_leave, retention_days, created_by
  ) VALUES (
    v_org, v_version, v_enabled, v_interval, v_tolerance, v_windows,
    v_sunday, v_holidays, v_leave, v_retention, v_uid
  )
  RETURNING effective_from INTO v_effective;

  PERFORM app_private.gps_checkin_purge_v1(v_org);

  RETURN jsonb_build_object('version', v_version, 'effective_from', v_effective, 'unchanged', false);
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_settings_set_v1(jsonb) IS
  'Luu cai dat diem danh GPS thanh mot phien ban moi, hieu luc tu moc ke tiep. Chi Chu cong ty/super admin thanh vien.';

CREATE OR REPLACE FUNCTION public.gps_checkin_member_set_v1(p_user uuid, p_applies boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  v_org := app_private.staff_day_viewer_org_v1(NULL);

  IF p_applies IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = p_user AND m.organization_id = v_org AND m.status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'gps_member_invalid' USING ERRCODE = '22023';
  END IF;

  IF app_private.gps_checkin_applies_v1(v_org, p_user, clock_timestamp()) IS DISTINCT FROM p_applies THEN
    INSERT INTO app_private.gps_checkin_members (organization_id, user_id, applies, created_by)
    VALUES (v_org, p_user, p_applies, v_uid);
  END IF;

  RETURN jsonb_build_object('user_id', p_user, 'applies', p_applies);
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_member_set_v1(uuid, boolean) IS
  'Bat/tat diem danh GPS cho mot nguoi. Chi Chu cong ty/super admin thanh vien.';

-- ---------------------------------------------------------------------------
-- 6. Phía quản lý.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gps_checkin_my_status_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_today date := public.vn_local_date(now());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := app_private.v5_salary_org_of_user_v1(v_uid);
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'as_of', now());
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_uid IN (SELECT app_private.staff_day_member_ids_v1(v_org, v_today)),
    'as_of', now(),
    'date', v_today,
    'settings', app_private.gps_checkin_device_settings_v1(v_org, v_uid),
    'device', app_private.gps_checkin_device_json_v1(v_org, v_uid),
    'today', app_private.gps_checkin_day_v1(v_org, v_uid, v_today)
  );
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_my_status_v1() IS
  'Trang thai diem danh GPS cua chinh nguoi goi.';

CREATE OR REPLACE FUNCTION public.gps_checkin_pair_start_v1()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
  v_today date := public.vn_local_date(now());
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text := '';
  v_index integer;
  v_expires timestamptz := clock_timestamp() + INTERVAL '10 minutes';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := app_private.v5_salary_org_of_user_v1(v_uid);
  IF v_org IS NULL
    OR v_uid NOT IN (SELECT app_private.staff_day_member_ids_v1(v_org, v_today))
    OR NOT app_private.gps_checkin_applies_v1(v_org, v_uid, clock_timestamp()) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Bỏ các byte cố định phiên bản/biến thể của UUID v4; 32 ký tự nên chia dư không lệch phân bố.
  v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  FOREACH v_index IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11] LOOP
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_index) % 32) + 1, 1);
  END LOOP;

  UPDATE app_private.gps_checkin_pair_codes c
  SET expires_at = clock_timestamp()
  WHERE c.organization_id = v_org AND c.user_id = v_uid
    AND c.used_at IS NULL AND c.expires_at > clock_timestamp();

  INSERT INTO app_private.gps_checkin_pair_codes (code_digest, organization_id, user_id, expires_at)
  VALUES (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_org, v_uid, v_expires);

  RETURN jsonb_build_object('code', v_code, 'expires_at', v_expires);
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_pair_start_v1() IS
  'Sinh ma ghep noi mot lan, han 10 phut, cho chinh nguoi goi.';

CREATE OR REPLACE FUNCTION public.gps_checkin_device_revoke_v1(p_device uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_dev app_private.gps_checkin_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dev FROM app_private.gps_checkin_devices d WHERE d.id = p_device FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  -- Chủ máy tự thu hồi được; người khác phải là chủ của đúng tổ chức của máy này.
  IF v_dev.user_id <> v_uid THEN
    PERFORM app_private.staff_day_viewer_org_v1(v_dev.organization_id);
  END IF;

  IF v_dev.revoked_at IS NULL THEN
    UPDATE app_private.gps_checkin_devices
    SET revoked_at = clock_timestamp(), revoked_by = v_uid
    WHERE id = v_dev.id;
  END IF;

  RETURN jsonb_build_object('id', v_dev.id, 'revoked', true);
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_device_revoke_v1(uuid) IS
  'Thu hoi may diem danh: chinh chu may hoac Chu cong ty/super admin thanh vien.';

CREATE OR REPLACE FUNCTION public.gps_checkin_slots_v1(p_user uuid, p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL OR NOT app_private.staff_day_can_view_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := app_private.v5_salary_org_of_user_v1(p_user);
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN app_private.gps_checkin_day_v1(v_org, p_user, COALESCE(p_date, public.vn_local_date(now())));
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_slots_v1(uuid, date) IS
  'Cac moc diem danh cua mot nguoi trong mot ngay. Chinh minh, Chu cong ty hoac super admin thanh vien.';

-- ---------------------------------------------------------------------------
-- 7. Cổng nhận từ máy (chỉ edge function gọi, bằng service_role).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gps_checkin_pair_v1(
  p_code_digest text,
  p_credential_digest text,
  p_fingerprint text,
  p_event jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_code app_private.gps_checkin_pair_codes%ROWTYPE;
  v_device_ref uuid;
  v_digest text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_code_digest IS NULL OR p_code_digest !~ '^[0-9a-f]{64}$'
    OR p_credential_digest IS NULL OR p_credential_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_code
  FROM app_private.gps_checkin_pair_codes c
  WHERE c.code_digest = p_code_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
  END IF;

  IF v_code.used_at IS NOT NULL THEN
    -- Phát lại đúng lần ghép đã thành công (app mất biên nhận rồi gửi lại).
    SELECT d.credential_digest INTO v_digest
    FROM app_private.gps_checkin_devices d
    WHERE d.id = v_code.used_device_ref;

    IF v_digest IS DISTINCT FROM p_credential_digest THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
    END IF;
  ELSE
    IF v_code.expires_at <= v_now THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = v_code.user_id AND m.organization_id = v_code.organization_id AND m.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
    END IF;

    UPDATE app_private.gps_checkin_devices d
    SET revoked_at = v_now, revoked_by = v_code.user_id
    WHERE d.organization_id = v_code.organization_id
      AND d.user_id = v_code.user_id
      AND d.revoked_at IS NULL;

    INSERT INTO app_private.gps_checkin_devices (
      organization_id, user_id, device_id, credential_digest, fingerprint,
      last_seen_at, last_state_at, state
    ) VALUES (
      v_code.organization_id, v_code.user_id, (p_event->>'deviceId')::uuid,
      p_credential_digest, COALESCE(p_fingerprint, ''),
      v_now, v_now, COALESCE(p_event->'device', '{}'::jsonb)
    )
    RETURNING id INTO v_device_ref;

    UPDATE app_private.gps_checkin_pair_codes c
    SET used_at = v_now, used_device_ref = v_device_ref
    WHERE c.code_digest = p_code_digest;
  END IF;

  RETURN jsonb_build_object(
    'status', 'paired',
    'externalId', p_event->>'id',
    'acceptedAt', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'user', app_private.staff_day_user_v1(v_code.user_id),
    'settings', app_private.gps_checkin_device_settings_v1(v_code.organization_id, v_code.user_id)
  );
END;
$fn$;

COMMENT ON FUNCTION public.gps_checkin_pair_v1(text, text, text, jsonb) IS
  'Doi ma ghep noi mot lan lay quyen gui cua may. Chi service_role (edge gps-checkin-ingest).';

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
    IF v_dev.last_state_at IS NULL OR v_dev.last_state_at < v_now - INTERVAL '60 seconds' THEN
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
        battery_pct, device_idle, settings_version, nearest_building_id, nearest_distance_m
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
        v_near_id, v_near_m
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
-- 8. Quyền gọi.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app_private.staff_day_can_view_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_viewer_org_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_user_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.staff_day_member_ids_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_normalize_windows_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_applies_v1(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_expected_slots_v1(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_day_v1(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_device_settings_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_device_json_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.gps_checkin_purge_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.gps_checkin_settings_get_v1(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_settings_set_v1(jsonb) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_member_set_v1(uuid, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_my_status_v1() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_pair_start_v1() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_device_revoke_v1(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_slots_v1(uuid, date) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.gps_checkin_pair_v1(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gps_checkin_ingest_v1(text, jsonb, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.gps_checkin_settings_get_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_settings_set_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_member_set_v1(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_my_status_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_pair_start_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_device_revoke_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_slots_v1(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gps_checkin_pair_v1(text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gps_checkin_ingest_v1(text, jsonb, text) TO service_role;

DO $check$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.gps_checkin_settings_get_v1(uuid)',
    'public.gps_checkin_settings_set_v1(jsonb)',
    'public.gps_checkin_member_set_v1(uuid,boolean)',
    'public.gps_checkin_my_status_v1()',
    'public.gps_checkin_pair_start_v1()',
    'public.gps_checkin_device_revoke_v1(uuid)',
    'public.gps_checkin_slots_v1(uuid,date)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'gps_checkin_acl_public_failed: %', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.gps_checkin_pair_v1(text,text,text,jsonb)',
    'public.gps_checkin_ingest_v1(text,jsonb,text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE')
      OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'gps_checkin_acl_ingest_failed: %', v_sig;
    END IF;
  END LOOP;

  IF has_table_privilege('authenticated', 'app_private.gps_checkin_pings', 'SELECT')
    OR has_table_privilege('service_role', 'app_private.gps_checkin_pings', 'SELECT')
    OR has_table_privilege('authenticated', 'app_private.gps_checkin_devices', 'SELECT') THEN
    RAISE EXCEPTION 'gps_checkin_acl_table_failed';
  END IF;
END $check$;

COMMIT;
NOTIFY pgrst, 'reload schema';
