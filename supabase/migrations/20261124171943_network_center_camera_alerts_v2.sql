-- =============================================================================
-- Cảnh báo camera v2 — lọc nhiễu, chọn loại sự cố, gửi nhóm Zalo.
-- Spec: docs/superpowers/plans/2026-11-24-canh-bao-camera-v2.md (chủ duyệt 24/11).
-- Thay hẳn 20261102072602_network_center_camera_alerts_v1.sql của PR #384 (chưa
-- merge, chưa từng áp production). Phần còn đúng của plan 01/11 (bẫy B1–B7,
-- khuôn sự cố watchdog, đóng có trễ 2 lượt, loại trừ B2) giữ nguyên.
--
-- Một cron */2 gọi app_private.camera_alert_evaluate_v1(now). Mỗi lượt, mỗi org
-- đang bật:
--   1. đọc camera_recorder_current (KHÔNG quét lịch sử, trừ đếm chập chờn lúc
--      bản tin 08:00), tính điều kiện xấu theo (đầu ghi, chủ thể);
--   2. mở / RECOVERING / đóng network_incidents CAMERA_* (bỏ kênh IGNORE/SNOOZE);
--   3. quyết định từng mục: chặn lặp 24 giờ, đêm, KNOWN_BROKEN, hiện trạng, cách
--      báo theo loại (ZALO / DIGEST / BELL / OFF);
--   4. gộp theo toà và nguyên nhân ⇒ tối đa MỘT tin Zalo cho nhóm và MỘT chuông
--      mỗi người mỗi lượt; trần tin Zalo mỗi ngày;
--   5. đến giờ thì bản tin 07:00 (dồn đêm + vượt trần) và 08:00 (nhắc);
--   6. SHADOW chỉ ghi sổ "lẽ ra" kèm nguyên văn tin.
--
-- An toàn khi phát hành:
--   * Không có dòng camera_alert_settings (hoặc enabled=false) ⇒ không làm gì.
--     Bật mặc định là SHADOW. Migration KHÔNG ghi id org, nhóm Zalo hay dữ liệu
--     thật nào: chủ tự chọn trên UI.
--   * Bảng/hàm nội bộ ở app_private, không cấp cho vai nào. RPC public kiểm
--     quyền trong thân: xem = network_center.view ở toà (khuôn
--     camera_share_actor_can_v1), sửa = chủ công ty (ie_actor_is_company_owner_v1)
--     hoặc super admin là thành viên org (khuôn gps_checkin_v1).
--   * Tin Zalo theo khuôn zalo_enqueue_broadcast_v1 nhưng KHÔNG có khoá tu_dong
--     (khoá đó thuộc bot đăng phòng: trần phòng trống, STALE_SALE_CONTENT, dừng
--     khẩn cấp). Worker gửi job văn bản này như tin gửi tay (bằng chứng trong PR).
--   * Push điện thoại tắt mặc định (push_enabled=false); bật thì chuông được xếp
--     push_state='QUEUED' cho lane drain hiện hành, không gọi pg_net trực tiếp.
--   * DDL chỉ phụ thuộc bảng camera/network_center (chạy được trên cụm dùng một
--     lần của Network Center). Bảng Zalo/notifications chỉ được đọc lúc chạy,
--     trong thân plpgsql.
-- Tắt khẩn: UPDATE app_private.camera_alert_settings SET enabled=false; hoặc
--           SELECT cron.unschedule('camera-alert-evaluate');
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(20261124171943::bigint);

DO $requires$
BEGIN
  IF to_regclass('public.camera_recorders') IS NULL
     OR to_regclass('public.camera_recorder_current') IS NULL
     OR to_regclass('public.camera_events') IS NULL
     OR to_regclass('app_private.camera_recorder_connections') IS NULL
     OR to_regclass('public.network_incidents') IS NULL
     OR to_regprocedure('app_private.camera_share_actor_can_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply network_center_camera_monitoring_v1, network_center_camera_share_v1 and the Network Center operations migrations first'
      USING ERRCODE = '55000';
  END IF;
END
$requires$;

-- -----------------------------------------------------------------------------
-- 1. Bảng. Chỉ hàm SECURITY DEFINER dưới đây đụng tới.
-- -----------------------------------------------------------------------------
-- Mặc định các loại sự cố (spec §2). Ngưỡng tính bằng giây; chập chờn tính bằng
-- số lần rớt trong 24 giờ.
CREATE OR REPLACE FUNCTION app_private.camera_alert_default_types_v1()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT jsonb_build_object(
    'CAMERA_STORAGE_ERROR',        jsonb_build_object('enabled', true, 'delivery', 'ZALO',   'threshold_seconds', 0),
    'CAMERA_RECORDER_OFFLINE',     jsonb_build_object('enabled', true, 'delivery', 'ZALO',   'threshold_seconds', 600),
    'CAMERA_RECORDER_AUTH_DENIED', jsonb_build_object('enabled', true, 'delivery', 'ZALO',   'threshold_seconds', 600),
    'CAMERA_MONITOR_STALE',        jsonb_build_object('enabled', true, 'delivery', 'ZALO',   'threshold_seconds', 600),
    'CAMERA_CHANNEL_LOST',         jsonb_build_object('enabled', true, 'delivery', 'ZALO',   'threshold_seconds', 900),
    'CAMERA_CHANNEL_FLAPPING',     jsonb_build_object('enabled', true, 'delivery', 'DIGEST', 'threshold_count', 5),
    'CAMERA_RECORDER_UNKNOWN',     jsonb_build_object('enabled', true, 'delivery', 'BELL',   'threshold_seconds', 1800)
  )
$fn$;

CREATE TABLE IF NOT EXISTS app_private.camera_alert_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'LIVE')),
  -- Không khoá ngoại sang bảng Zalo (vắng trên cụm dùng một lần); RPC lưu và
  -- hàm xếp hàng kiểm lại hội thoại/nick ở mỗi lần dùng.
  zalo_account_id uuid,
  zalo_conversation_id uuid,
  types jsonb NOT NULL DEFAULT app_private.camera_alert_default_types_v1() CHECK (jsonb_typeof(types) = 'object'),
  night_start time NOT NULL DEFAULT '22:00',
  night_end time NOT NULL DEFAULT '07:00',
  digest_at time NOT NULL DEFAULT '08:00',
  daily_zalo_cap integer NOT NULL DEFAULT 6 CHECK (daily_zalo_cap BETWEEN 1 AND 20),
  push_enabled boolean NOT NULL DEFAULT false,
  live_since timestamptz,
  -- Lượt đánh giá kế tiếp là lượt "hiện trạng" (spec §3.2).
  baseline_pending boolean NOT NULL DEFAULT false,
  last_evaluated_at timestamptz,
  last_night_digest_on date,
  last_digest_on date,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (night_start <> night_end),
  CHECK (zalo_conversation_id IS NULL OR zalo_account_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS app_private.camera_alert_conditions (
  recorder_id uuid NOT NULL REFERENCES public.camera_recorders(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject ~ '^(monitor|recorder:(offline|auth|unknown)|storage:[0-9]{1,2}|channel:[0-9]{1,3})$'),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  condition_code text NOT NULL CHECK (condition_code IN (
    'CAMERA_STORAGE_ERROR', 'CAMERA_RECORDER_OFFLINE', 'CAMERA_RECORDER_AUTH_DENIED',
    'CAMERA_MONITOR_STALE', 'CAMERA_CHANNEL_LOST', 'CAMERA_RECORDER_UNKNOWN')),
  severity text NOT NULL CHECK (severity IN ('WARNING', 'CRITICAL')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  clear_streak integer NOT NULL DEFAULT 0 CHECK (clear_streak >= 0),
  -- Lượt tốt đầu tiên của chuỗi khôi phục (giờ "đã có lại" trong tin).
  recovering_at timestamptz,
  -- Đã vượt ngưỡng. LIVE: sự cố đã mở (incident_id); SHADOW: sự cố dự kiến.
  opened_at timestamptz,
  incident_id uuid REFERENCES public.network_incidents(id) ON DELETE SET NULL,
  -- Tin mở đã (hoặc sẽ, khi dồn) tới người nhận. Sai ⇒ không gửi tin khôi phục.
  announced boolean NOT NULL DEFAULT false,
  open_route text CHECK (open_route IS NULL OR open_route IN ('ZALO', 'DIGEST', 'BELL', 'OFF')),
  baseline boolean NOT NULL DEFAULT false,
  observed jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(observed) = 'object'),
  PRIMARY KEY (recorder_id, subject),
  CHECK (first_seen_at <= last_seen_at)
);
CREATE INDEX IF NOT EXISTS camera_alert_conditions_org_idx
  ON app_private.camera_alert_conditions (organization_id, building_id);

-- Tắt báo theo kênh (spec §3.1).
CREATE TABLE IF NOT EXISTS app_private.camera_alert_channel_mutes (
  recorder_id uuid NOT NULL REFERENCES public.camera_recorders(id) ON DELETE CASCADE,
  channel integer NOT NULL CHECK (channel BETWEEN 1 AND 256),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('IGNORE', 'SNOOZE', 'KNOWN_BROKEN')),
  until_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (recorder_id, channel),
  CHECK ((kind = 'SNOOZE') = (until_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS camera_alert_channel_mutes_org_idx
  ON app_private.camera_alert_channel_mutes (organization_id, building_id);

-- Sổ từng mục (một sự kiện của một sự cố trong một lượt) và quyết định cho nó.
CREATE TABLE IF NOT EXISTS app_private.camera_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id uuid NOT NULL,
  recorder_id uuid,
  subject text,
  fingerprint text,
  incident_id uuid,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  kind text NOT NULL CHECK (kind IN ('OPENED', 'RESOLVED', 'ESCALATED', 'FIXED')),
  route text NOT NULL CHECK (route IN ('ZALO', 'DIGEST', 'BELL', 'OFF')),
  decision text NOT NULL CHECK (decision IN (
    'ZALO', 'NIGHT', 'DIGEST', 'BELL', 'BASELINE', 'REPEAT_24H', 'KNOWN_BROKEN', 'MAINTENANCE', 'OFF', 'SILENT')),
  shadow boolean NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  occurred_at timestamptz NOT NULL,
  -- Tin mang mục này (tin của lượt, hoặc dòng dồn đêm / vượt trần).
  delivery_id uuid,
  -- Mục chờ bản tin 08:00: PENDING → DONE (đã vào bản tin) hoặc EXPIRED.
  digest_state text CHECK (digest_state IS NULL OR digest_state IN ('PENDING', 'DONE', 'EXPIRED')),
  digest_delivery_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS camera_alert_events_fingerprint_idx
  ON app_private.camera_alert_events (organization_id, fingerprint, occurred_at DESC)
  WHERE kind = 'OPENED';
CREATE INDEX IF NOT EXISTS camera_alert_events_digest_idx
  ON app_private.camera_alert_events (organization_id, occurred_at)
  WHERE digest_state = 'PENDING';
CREATE INDEX IF NOT EXISTS camera_alert_events_delivery_idx
  ON app_private.camera_alert_events (delivery_id)
  WHERE delivery_id IS NOT NULL;

-- Sổ tin (một dòng mỗi tin Zalo, mỗi lô chuông, mỗi mục bị chặn).
CREATE TABLE IF NOT EXISTS app_private.camera_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('OPENED', 'RESOLVED', 'BASELINE', 'NIGHT_DIGEST', 'DIGEST', 'TEST')),
  channel text NOT NULL CHECK (channel IN ('ZALO', 'IN_APP')),
  shadow boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('SHADOW', 'QUEUED', 'SENT', 'FAILED', 'SUPPRESSED', 'DEFERRED')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 300),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 6000),
  building_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  dedup_key text NOT NULL UNIQUE CHECK (char_length(dedup_key) BETWEEN 8 AND 300),
  local_date date NOT NULL,
  -- Tin đã (SHADOW: lẽ ra đã) xếp hàng gửi Zalo thật ⇒ tính vào trần ngày.
  counts_toward_cap boolean NOT NULL DEFAULT false,
  -- Nội dung chờ bản tin kế tiếp (dồn đêm, vượt trần).
  pending_release boolean NOT NULL DEFAULT false,
  released_at timestamptz,
  released_in uuid,
  zalo_account_id uuid,
  zalo_conversation_id uuid,
  zalo_message_id uuid,
  zalo_job_id uuid,
  recipients integer CHECK (recipients IS NULL OR recipients >= 0),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  CHECK ((status = 'SHADOW') = shadow)
);
CREATE INDEX IF NOT EXISTS camera_alert_deliveries_org_time_idx
  ON app_private.camera_alert_deliveries (organization_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS camera_alert_deliveries_cap_idx
  ON app_private.camera_alert_deliveries (organization_id, local_date)
  WHERE channel = 'ZALO' AND counts_toward_cap;
CREATE INDEX IF NOT EXISTS camera_alert_deliveries_pending_idx
  ON app_private.camera_alert_deliveries (organization_id, created_at)
  WHERE pending_release AND released_at IS NULL;

-- Nhật ký thao tác của người (đổi chế độ, bật tắt, tắt kênh, tin thử).
CREATE TABLE IF NOT EXISTS app_private.camera_alert_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id uuid,
  action text NOT NULL CHECK (action ~ '^[A-Z][A-Z_]{2,39}$'),
  target jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(target) = 'object'),
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS camera_alert_audit_org_idx
  ON app_private.camera_alert_audit (organization_id, created_at DESC);

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['camera_alert_settings', 'camera_alert_conditions', 'camera_alert_channel_mutes',
                           'camera_alert_events', 'camera_alert_deliveries', 'camera_alert_audit'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END
$tables$;

COMMENT ON TABLE app_private.camera_alert_settings IS
  'Cảnh báo camera theo org (spec 2026-11-24 §5). Không có dòng hoặc enabled=false ⇒ bộ đánh giá bỏ qua (kill switch). SHADOW chỉ ghi sổ "lẽ ra". version dùng CAS (PT409).';
COMMENT ON TABLE app_private.camera_alert_conditions IS
  'Điều kiện xấu đang theo dõi, một dòng mỗi (đầu ghi, chủ thể). Xoá khi hết lỗi; lịch sử ở network_incidents, camera_alert_events, camera_alert_deliveries.';
COMMENT ON TABLE app_private.camera_alert_channel_mutes IS
  'Tắt báo theo kênh: IGNORE (không theo dõi), SNOOZE (tới until_at), KNOWN_BROKEN (giữ sự cố, chỉ nhắc thứ Hai, có lại thì tự xoá).';
COMMENT ON TABLE app_private.camera_alert_events IS
  'Từng mục của mỗi lượt và quyết định (gửi Zalo, dồn đêm, bản tin, chuông, hiện trạng, chặn lặp 24 giờ, đã biết hỏng, bảo trì, tắt).';
COMMENT ON TABLE app_private.camera_alert_deliveries IS
  'Sổ tin cảnh báo camera: nguyên văn tin, kênh, trạng thái (SHADOW/QUEUED/SENT/FAILED/SUPPRESSED/DEFERRED) và lý do. dedup_key chống gửi trùng.';

-- -----------------------------------------------------------------------------
-- 2. Hàm phụ thuần.
-- -----------------------------------------------------------------------------
-- Cài đặt loại sự cố hiệu lực = mặc định, đè từng khoá bằng giá trị đã lưu.
CREATE OR REPLACE FUNCTION app_private.camera_alert_types_v1(p_types jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
DECLARE
  v_defaults jsonb := app_private.camera_alert_default_types_v1();
  v_out jsonb := '{}'::jsonb;
  v_code text;
BEGIN
  FOR v_code IN SELECT jsonb_object_keys(v_defaults) LOOP
    v_out := v_out || jsonb_build_object(v_code, (v_defaults -> v_code)
      || CASE WHEN jsonb_typeof(p_types -> v_code) = 'object' THEN p_types -> v_code ELSE '{}'::jsonb END);
  END LOOP;
  RETURN v_out;
END
$fn$;

-- Cách báo hiệu lực của một loại: 'DISABLED' khi loại bị tắt.
CREATE OR REPLACE FUNCTION app_private.camera_alert_route_v1(p_types jsonb, p_code text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF jsonb_typeof(p_types -> p_code) IS DISTINCT FROM 'object'
     OR (p_types -> p_code ->> 'enabled') IS DISTINCT FROM 'true' THEN
    RETURN 'DISABLED';
  END IF;
  IF p_types -> p_code ->> 'delivery' IN ('ZALO', 'DIGEST', 'BELL', 'OFF') THEN
    RETURN p_types -> p_code ->> 'delivery';
  END IF;
  RETURN 'OFF';
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.camera_alert_threshold_v1(p_types jsonb, p_code text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_key text := CASE WHEN p_code = 'CAMERA_CHANNEL_FLAPPING' THEN 'threshold_count' ELSE 'threshold_seconds' END;
  v_default integer := CASE p_code
    WHEN 'CAMERA_STORAGE_ERROR' THEN 0
    WHEN 'CAMERA_CHANNEL_LOST' THEN 900
    WHEN 'CAMERA_RECORDER_UNKNOWN' THEN 1800
    WHEN 'CAMERA_CHANNEL_FLAPPING' THEN 5
    ELSE 600 END;
BEGIN
  IF jsonb_typeof(p_types -> p_code -> v_key) = 'number'
     AND (p_types -> p_code ->> v_key)::numeric BETWEEN 0 AND 86400 THEN
    RETURN round((p_types -> p_code ->> v_key)::numeric)::integer;
  END IF;
  RETURN v_default;
END
$fn$;

-- Giờ theo múi org: cùng ngày với p_now thì HH:MM, khác ngày thì DD/MM HH:MM.
CREATE OR REPLACE FUNCTION app_private.camera_alert_clock_v1(p_at timestamptz, p_tz text, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_at IS NULL THEN RETURN '?'; END IF;
  IF (p_at AT TIME ZONE p_tz)::date = (p_now AT TIME ZONE p_tz)::date THEN
    RETURN to_char(p_at AT TIME ZONE p_tz, 'HH24:MI');
  END IF;
  RETURN to_char(p_at AT TIME ZONE p_tz, 'DD/MM HH24:MI');
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.camera_alert_duration_v1(p_seconds numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_min bigint := greatest(1, round(coalesce(p_seconds, 0) / 60.0))::bigint;
BEGIN
  IF v_min < 60 THEN RETURN v_min || ' phút'; END IF;
  IF v_min < 1440 THEN
    RETURN (v_min / 60) || ' giờ' || CASE WHEN v_min % 60 > 0 THEN ' ' || (v_min % 60) || ' phút' ELSE '' END;
  END IF;
  RETURN (v_min / 1440) || ' ngày';
END
$fn$;

-- "đầu ghi" / 'đầu ghi "X"' / "2 đầu ghi" cho một nhóm mục cùng toà.
CREATE OR REPLACE FUNCTION app_private.camera_alert_recorder_label_v1(p_items jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_n integer;
  v_name text;
  v_in_building integer;
BEGIN
  SELECT count(DISTINCT x.value ->> 'recorderId'), min(x.value ->> 'recorderName'),
         max(coalesce((x.value ->> 'recordersInBuilding')::integer, 1))
    INTO v_n, v_name, v_in_building
    FROM jsonb_array_elements(p_items) x;
  IF v_n > 1 THEN RETURN v_n || ' đầu ghi'; END IF;
  IF v_in_building > 1 THEN RETURN 'đầu ghi "' || coalesce(v_name, '?') || '"'; END IF;
  RETURN 'đầu ghi';
END
$fn$;

-- 'kênh 3 "Ham 2"' (thêm tên đầu ghi khi toà có nhiều đầu ghi).
CREATE OR REPLACE FUNCTION app_private.camera_alert_channel_label_v1(p_item jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_name text := nullif(btrim(coalesce(p_item ->> 'channelName', '')), '');
BEGIN
  RETURN 'kênh ' || coalesce(p_item ->> 'channel', '?')
    || CASE WHEN v_name IS NULL THEN '' ELSE ' "' || v_name || '"' END
    || CASE WHEN coalesce((p_item ->> 'recordersInBuilding')::integer, 1) > 1
            THEN ' (đầu ghi "' || coalesce(p_item ->> 'recorderName', '?') || '")' ELSE '' END;
END
$fn$;

-- Một dòng tin cho MỘT nhóm mục cùng (toà, loại sự kiện, mã). p_style:
--   EVENT    tin của lượt / tin dồn;   REMIND bản tin nhắc (kèm "từ … (N ngày)").
CREATE OR REPLACE FUNCTION app_private.camera_alert_line_v1(
  p_kind text, p_code text, p_building text, p_items jsonb, p_tz text, p_now timestamptz, p_style text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
DECLARE
  v_n integer := jsonb_array_length(p_items);
  v_first timestamptz;
  v_last_at timestamptz;
  v_rec text := app_private.camera_alert_recorder_label_v1(p_items);
  v_channels text;
  v_slots text;
  v_cause text;
  v_cause_at timestamptz;
  v_data_at timestamptz;
  v_text text;
BEGIN
  SELECT min((x.value ->> 'firstSeenAt')::timestamptz), max((x.value ->> 'at')::timestamptz),
         string_agg(app_private.camera_alert_channel_label_v1(x.value), ', '
           ORDER BY x.value ->> 'recorderName', (x.value ->> 'channel')::integer),
         string_agg(coalesce(x.value ->> 'slot', '?')
           || CASE WHEN coalesce((x.value ->> 'recordersInBuilding')::integer, 1) > 1
                   THEN ' (đầu ghi "' || coalesce(x.value ->> 'recorderName', '?') || '")' ELSE '' END, ', '
           ORDER BY x.value ->> 'recorderName', (x.value ->> 'slot')::integer),
         CASE WHEN bool_or(x.value ->> 'cause' = 'ROUTER_DOWN') THEN 'ROUTER_DOWN'
              WHEN bool_and(x.value ->> 'cause' = 'ROUTER_UP') THEN 'ROUTER_UP'
              ELSE 'UNKNOWN' END,
         max((x.value ->> 'causeAt')::timestamptz),
         min(coalesce((x.value ->> 'lastDataAt')::timestamptz, (x.value ->> 'firstSeenAt')::timestamptz))
    INTO v_first, v_last_at, v_channels, v_slots, v_cause, v_cause_at, v_data_at
    FROM jsonb_array_elements(p_items) x;

  IF p_style = 'REMIND' THEN
    v_text := p_building || ': ' || CASE p_code
      WHEN 'CAMERA_STORAGE_ERROR' THEN 'ổ cứng ' || v_slots || ' báo lỗi'
      WHEN 'CAMERA_RECORDER_OFFLINE' THEN 'không gọi tới được ' || v_rec
      WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN v_rec || ' từ chối mật khẩu giám sát'
      WHEN 'CAMERA_MONITOR_STALE' THEN 'mất dữ liệu giám sát ' || v_rec
      WHEN 'CAMERA_CHANNEL_LOST' THEN v_channels || ' mất'
      WHEN 'CAMERA_RECORDER_UNKNOWN' THEN v_rec || ' trả lời lạ'
      ELSE lower(p_code) END
      || ' từ ' || app_private.camera_alert_clock_v1(v_first, p_tz, p_now)
      || ' (' || app_private.camera_alert_duration_v1(extract(epoch FROM p_now - v_first)) || ').';
    RETURN v_text;
  END IF;

  IF p_kind = 'OPENED' THEN
    v_text := CASE p_code
      WHEN 'CAMERA_STORAGE_ERROR' THEN
        p_building || ': ' || CASE WHEN v_n = 1 THEN 'Ổ cứng ' || v_slots ELSE v_n || ' ổ cứng (' || v_slots || ')' END
          || ' báo LỖI (' || app_private.camera_alert_clock_v1(v_first, p_tz, p_now) || '). Đầu ghi có thể không lưu được video.'
      WHEN 'CAMERA_RECORDER_OFFLINE' THEN
        CASE v_cause
          WHEN 'ROUTER_DOWN' THEN p_building || ' mất mạng từ ' || app_private.camera_alert_clock_v1(v_first, p_tz, p_now)
            || ' — router và ' || CASE WHEN v_n > 1 THEN v_n || ' đầu ghi' ELSE 'đầu ghi' END || ' đều không gọi tới được.'
          WHEN 'ROUTER_UP' THEN p_building || ': không gọi tới được ' || v_rec || ' từ '
            || app_private.camera_alert_clock_v1(v_first, p_tz, p_now) || '; router vẫn kết nối lúc '
            || app_private.camera_alert_clock_v1(v_cause_at, p_tz, p_now) || ' ⇒ nhiều khả năng đầu ghi tắt, treo hoặc tuột dây.'
          ELSE p_building || ': không gọi tới được ' || v_rec || ' từ '
            || app_private.camera_alert_clock_v1(v_first, p_tz, p_now) || ' (router: chưa rõ).'
        END
      WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN
        p_building || ': ' || v_rec || ' từ chối mật khẩu giám sát từ '
          || app_private.camera_alert_clock_v1(v_first, p_tz, p_now) || ' (có thể đã đổi mật khẩu).'
      WHEN 'CAMERA_MONITOR_STALE' THEN
        p_building || ': mất dữ liệu giám sát ' || v_rec || ' từ '
          || app_private.camera_alert_clock_v1(v_data_at, p_tz, p_now) || ' — kiểm tra VPS/collector.'
      WHEN 'CAMERA_CHANNEL_LOST' THEN
        -- Thời lượng tính tới lúc phát hiện (mục dồn được ráp lại sau đó); tin
        -- dồn đêm không ghi thời lượng, chỉ ghi giờ bắt đầu và giờ có lại.
        p_building || ': ' || CASE WHEN v_n = 1 THEN upper(left(v_channels, 1)) || substr(v_channels, 2) || ' mất hình'
            || CASE WHEN p_style = 'NIGHT' THEN '' ELSE ' ' || app_private.camera_alert_duration_v1(extract(epoch FROM coalesce(v_last_at, p_now) - v_first)) END
          ELSE v_n || ' kênh mất hình — ' || v_channels END
          || ' (từ ' || app_private.camera_alert_clock_v1(v_first, p_tz, p_now) || ').'
      WHEN 'CAMERA_RECORDER_UNKNOWN' THEN
        p_building || ': ' || v_rec || ' trả lời lạ (không đọc được ổ hoặc kênh) từ '
          || app_private.camera_alert_clock_v1(v_first, p_tz, p_now) || '.'
      ELSE p_building || ': ' || lower(p_code)
    END;
  ELSIF p_kind = 'ESCALATED' THEN
    v_text := p_building || ': từ 50 % kênh của ' || v_rec || ' trở lên đang mất hình — ' || v_channels || '.';
  ELSIF p_kind = 'FIXED' THEN
    v_text := p_building || ': ' || v_channels || ' đã sửa — có hình lại lúc '
      || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now) || '.';
  ELSE
    v_text := p_building || ': ' || CASE p_code
      WHEN 'CAMERA_STORAGE_ERROR' THEN 'ổ cứng ' || v_slots || ' hết báo lỗi lúc ' || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now)
      WHEN 'CAMERA_RECORDER_OFFLINE' THEN CASE WHEN v_rec = 'đầu ghi' THEN '' ELSE v_rec || ' ' END
        || 'có kết nối lại lúc ' || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now)
        || ' (mất ' || app_private.camera_alert_duration_v1(extract(epoch FROM v_last_at - v_first)) || ')'
      WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN v_rec || ' đăng nhập lại được lúc ' || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now)
      WHEN 'CAMERA_MONITOR_STALE' THEN 'có lại dữ liệu giám sát ' || v_rec || ' lúc ' || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now)
        || ' (mất ' || app_private.camera_alert_duration_v1(extract(epoch FROM v_last_at - v_data_at)) || ')'
      WHEN 'CAMERA_CHANNEL_LOST' THEN v_channels || ' có hình lại lúc ' || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now)
        || ' (mất ' || app_private.camera_alert_duration_v1(extract(epoch FROM v_last_at - v_first)) || ')'
      WHEN 'CAMERA_RECORDER_UNKNOWN' THEN v_rec || ' trả lời bình thường lại lúc ' || app_private.camera_alert_clock_v1(v_last_at, p_tz, p_now)
      ELSE lower(p_code)
    END || '.';
  END IF;
  RETURN v_text;
END
$fn$;

-- Gộp mục thành các dòng: theo toà, theo loại sự kiện, theo mã; mất dữ liệu giám
-- sát ở ≥ 2 toà (hoặc mọi đầu ghi đang theo dõi) thành MỘT dòng (spec §3.3).
-- Trả mảng {text, kind, buildingIds}.
CREATE OR REPLACE FUNCTION app_private.camera_alert_lines_v1(
  p_items jsonb, p_tz text, p_now timestamptz, p_style text, p_monitored integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
DECLARE
  v_lines jsonb := '[]'::jsonb;
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_kind text;
  v_suffix text;
  v_buildings integer;
  v_recorders integer;
  v_ids jsonb;
  v_at timestamptz;
  g record;
  v_text text;
BEGIN
  IF p_style IN ('EVENT', 'BASELINE') THEN
    FOREACH v_kind IN ARRAY ARRAY['OPENED', 'RESOLVED'] LOOP
      SELECT count(DISTINCT x.value ->> 'buildingId'), count(DISTINCT x.value ->> 'recorderId'),
             coalesce(jsonb_agg(DISTINCT x.value -> 'buildingId'), '[]'::jsonb), max((x.value ->> 'at')::timestamptz)
        INTO v_buildings, v_recorders, v_ids, v_at
        FROM jsonb_array_elements(v_items) x
       WHERE x.value ->> 'kind' = v_kind AND x.value ->> 'code' = 'CAMERA_MONITOR_STALE';
      IF v_buildings >= 2 OR (v_kind = 'OPENED' AND v_recorders > 0 AND v_recorders >= coalesce(p_monitored, 0)) THEN
        -- anyBuilding: dòng chỉ ghi số toà, người nhận của một toà bất kỳ được thấy.
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'kind', v_kind, 'buildingIds', v_ids, 'anyBuilding', true,
          'text', CASE WHEN v_kind = 'OPENED'
            THEN 'Hệ thống giám sát camera ngừng gửi dữ liệu (' || v_buildings || ' toà) — kiểm tra VPS/collector.'
            ELSE 'Hệ thống giám sát camera gửi dữ liệu lại (' || v_buildings || ' toà) lúc '
              || app_private.camera_alert_clock_v1(v_at, p_tz, p_now) || '.' END));
        SELECT coalesce(jsonb_agg(x.value), '[]'::jsonb) INTO v_items
          FROM jsonb_array_elements(v_items) x
         WHERE NOT (x.value ->> 'kind' = v_kind AND x.value ->> 'code' = 'CAMERA_MONITOR_STALE');
      END IF;
    END LOOP;
  END IF;

  FOR g IN
    SELECT x.value ->> 'buildingId' AS building_id, min(x.value ->> 'buildingName') AS building_name,
           x.value ->> 'kind' AS kind, x.value ->> 'code' AS code, jsonb_agg(x.value) AS items
      FROM jsonb_array_elements(v_items) x
     GROUP BY 1, 3, 4
     ORDER BY CASE x.value ->> 'kind' WHEN 'OPENED' THEN 0 WHEN 'ESCALATED' THEN 1 WHEN 'RESOLVED' THEN 2 ELSE 3 END,
              min(x.value ->> 'buildingName'), 1,
              CASE x.value ->> 'code' WHEN 'CAMERA_STORAGE_ERROR' THEN 0 WHEN 'CAMERA_RECORDER_OFFLINE' THEN 1
                WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN 2 WHEN 'CAMERA_MONITOR_STALE' THEN 3
                WHEN 'CAMERA_CHANNEL_LOST' THEN 4 ELSE 5 END
  LOOP
    v_text := app_private.camera_alert_line_v1(g.kind, g.code, coalesce(g.building_name, '?'), g.items, p_tz, p_now,
      CASE WHEN p_style IN ('REMIND', 'NIGHT') THEN p_style ELSE 'EVENT' END);
    -- Tin dồn: ghi rõ còn mất hay đã có lại (spec §3.6).
    IF p_style = 'NIGHT' AND g.kind = 'OPENED' THEN
      SELECT CASE WHEN bool_and(x.value ->> 'resolvedAt' IS NOT NULL)
               THEN ' Đã có lại lúc ' || app_private.camera_alert_clock_v1(max((x.value ->> 'resolvedAt')::timestamptz), p_tz, p_now) || '.'
               ELSE ' Vẫn còn lỗi.' END
        INTO STRICT v_suffix
        FROM jsonb_array_elements(g.items) x;
      v_text := v_text || v_suffix;
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'kind', g.kind, 'buildingIds', jsonb_build_array(g.building_id), 'text', v_text));
  END LOOP;
  RETURN v_lines;
END
$fn$;

-- Ráp tin hoàn chỉnh. p_lines: mảng {text, kind}. Tối đa 20 dòng, 3 500 ký tự.
CREATE OR REPLACE FUNCTION app_private.camera_alert_compose_v1(p_header text, p_lines jsonb, p_single_icon text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  c_footer constant text := 'Xem: CRM › Trung tâm mạng › Camera';
  v_n integer := jsonb_array_length(coalesce(p_lines, '[]'::jsonb));
  v_body text;
BEGIN
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF p_single_icon IS NOT NULL AND v_n = 1 THEN
    v_body := p_single_icon || ' ' || (p_lines -> 0 ->> 'text');
  ELSE
    SELECT p_header || E'\n' || string_agg(
             CASE WHEN x.value ->> 'kind' = 'RESOLVED' THEN '✅ ' WHEN x.value ->> 'kind' = 'SECTION' THEN '' ELSE '• ' END
             || (x.value ->> 'text'), E'\n' ORDER BY x.ordinality)
      INTO v_body
      FROM jsonb_array_elements(p_lines) WITH ORDINALITY x
     WHERE x.ordinality <= 20;
    IF v_n > 20 THEN v_body := v_body || E'\n… và ' || (v_n - 20) || ' mục khác.'; END IF;
  END IF;
  IF char_length(v_body) > 3500 THEN v_body := left(v_body, 3490) || '…'; END IF;
  RETURN v_body || E'\n' || c_footer;
END
$fn$;

-- -----------------------------------------------------------------------------
-- 3. Quyền của người gọi (auth.uid()). Chỉ RPC public gọi; cron không gọi.
-- -----------------------------------------------------------------------------
-- Sửa: chủ công ty, hoặc super admin là thành viên ACTIVE của org
-- (khuôn app_private.staff_day_viewer_org_v1, 20261109042309).
CREATE OR REPLACE FUNCTION app_private.camera_alert_actor_can_edit_v1(p_org uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL OR p_org IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.status = 'ACTIVE') THEN
    RETURN false;
  END IF;
  RETURN coalesce(app_private.ie_actor_is_company_owner_v1(p_org, v_uid), false)
    OR (coalesce(public.is_super_admin(), false)
        AND EXISTS (
          SELECT 1 FROM public.organization_memberships m
           WHERE m.organization_id = p_org AND m.user_id = v_uid AND m.status = 'ACTIVE'
             AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())));
END
$fn$;

-- Xem: network_center.view ở ít nhất một toà của org, hoặc quyền sửa.
CREATE OR REPLACE FUNCTION app_private.camera_alert_actor_can_view_v1(p_org uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR p_org IS NULL THEN RETURN false; END IF;
  RETURN app_private.camera_alert_actor_can_edit_v1(p_org)
    OR EXISTS (
      SELECT 1 FROM public.buildings b
       WHERE b.organization_id = p_org AND b.deleted_at IS NULL
         AND app_private.camera_share_actor_can_v1(p_org, b.id));
END
$fn$;

-- -----------------------------------------------------------------------------
-- 4. Người nhận chuông (D9). Chạy dưới cron (không JWT) nên KHÔNG đọc auth.uid().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.network_center_alert_recipient_ids_v1(
  p_org uuid, p_building uuid)
RETURNS uuid[]
LANGUAGE plpgsql
-- authorize_tenant_action_v3 lấy FOR SHARE trên organizations ⇒ VOLATILE.
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v uuid[];
BEGIN
  IF p_org IS NULL OR p_building IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.status = 'ACTIVE')
     OR NOT EXISTS (
       SELECT 1 FROM public.buildings b
        WHERE b.id = p_building AND b.organization_id = p_org AND b.deleted_at IS NULL) THEN
    RETURN '{}'::uuid[];
  END IF;

  SELECT coalesce(array_agg(DISTINCT m.user_id ORDER BY m.user_id), '{}'::uuid[]) INTO v
    FROM public.organization_memberships m
    JOIN public.buildings b ON b.id = p_building
   WHERE m.organization_id = p_org
     AND m.user_id IS NOT NULL
     AND m.status = 'ACTIVE'
     AND coalesce(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
     -- Super admin chỉ là thành viên kỹ thuật ở org sandbox/demo: không nhận
     -- cảnh báo của dữ liệu thử (khuôn lifecycle_recipient_allowed_v1).
     AND NOT (
       EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = m.user_id)
       AND (coalesce(p_org = ANY(public.sandbox_org_ids()), false)
            OR coalesce(b.user_id = ANY(public.demo_user_ids()), false))
     )
     AND (
       app_private.ie_actor_is_company_owner_v1(p_org, m.user_id)
       OR coalesce((
         SELECT a.allowed
           FROM app_private.authorize_tenant_action_v3(
             m.user_id, p_org, 'network_center.view', p_building, NULL) a
       ), false)
     );
  RETURN v;
END
$fn$;

COMMENT ON FUNCTION app_private.network_center_alert_recipient_ids_v1(uuid, uuid) IS
  'Người nhận cảnh báo Network Center của một toà: chủ công ty (ie_actor_is_company_owner_v1) cộng thành viên ACTIVE có network_center.view ở đúng toà. Loại super admin ở org sandbox/demo. Không đọc auth.uid() nên chạy được dưới cron.';

-- Nguyên nhân khi đầu ghi không gọi tới được (spec §3.3): router của toà.
CREATE OR REPLACE FUNCTION app_private.camera_alert_router_cause_v1(
  p_org uuid, p_building uuid, p_device uuid, p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_reachable boolean;
  v_observed timestamptz;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.network_incidents i
     WHERE i.organization_id = p_org AND i.building_id = p_building
       AND i.incident_type = 'ROUTER_UNREACHABLE' AND i.status <> 'RESOLVED') THEN
    RETURN jsonb_build_object('cause', 'ROUTER_DOWN');
  END IF;
  SELECT d.reachable, d.observed_at INTO v_reachable, v_observed
    FROM public.network_device_current d
   WHERE d.device_id = p_device AND d.organization_id = p_org AND d.building_id = p_building;
  IF FOUND AND v_reachable IS FALSE THEN
    RETURN jsonb_build_object('cause', 'ROUTER_DOWN', 'causeAt', v_observed);
  END IF;
  -- Chỉ tin "router còn kết nối" khi số đo MỚI HƠN lúc đầu ghi mất; router được
  -- poll thưa hơn camera nên không chờ số đo mới.
  IF FOUND AND v_reachable AND v_observed >= p_since THEN
    RETURN jsonb_build_object('cause', 'ROUTER_UP', 'causeAt', v_observed);
  END IF;
  RETURN jsonb_build_object('cause', 'UNKNOWN');
END
$fn$;

-- -----------------------------------------------------------------------------
-- 5. Sự cố: chuyển trạng thái, mở (khuôn watchdog), đóng lặng.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.camera_alert_transition_v1(
  p_incident_id uuid, p_action text, p_now timestamptz, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_actor constant text := 'camera-alert';
  inc public.network_incidents%ROWTYPE;
  v_kind text;
  v_severity text;
  v_at timestamptz;
BEGIN
  SELECT * INTO inc FROM public.network_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND OR inc.status = 'RESOLVED' THEN
    RETURN false;
  END IF;
  -- Ràng buộc thời gian của network_incidents đòi mọi mốc ≥ opened_at.
  v_at := greatest(p_now, inc.opened_at);

  IF p_action = 'RECOVERING' THEN
    IF inc.status = 'RECOVERING' THEN RETURN false; END IF;
    UPDATE public.network_incidents
       SET status = 'RECOVERING', recovered_at = v_at,
           last_observed_at = greatest(last_observed_at, v_at), version = version + 1
     WHERE id = inc.id;
    v_kind := 'RECOVERED'; v_severity := 'INFO';
  ELSIF p_action = 'RELAPSE' THEN
    IF inc.status <> 'RECOVERING' THEN RETURN false; END IF;
    UPDATE public.network_incidents
       SET status = CASE WHEN acknowledged_at IS NOT NULL THEN 'ACKNOWLEDGED' ELSE 'OPEN' END,
           recovered_at = NULL,
           last_observed_at = greatest(last_observed_at, v_at), version = version + 1
     WHERE id = inc.id;
    v_kind := 'OBSERVED'; v_severity := inc.severity;
  ELSIF p_action = 'ESCALATE' THEN
    IF inc.severity = 'CRITICAL' THEN RETURN false; END IF;
    UPDATE public.network_incidents
       SET severity = 'CRITICAL', last_observed_at = greatest(last_observed_at, v_at), version = version + 1
     WHERE id = inc.id;
    v_kind := 'ESCALATED'; v_severity := 'CRITICAL';
  ELSIF p_action = 'RESOLVED' THEN
    UPDATE public.network_incidents
       SET status = 'RESOLVED', resolved_at = v_at,
           recovered_at = coalesce(recovered_at, v_at),
           last_observed_at = greatest(last_observed_at, v_at), version = version + 1
     WHERE id = inc.id;
    v_kind := 'RESOLVED'; v_severity := 'INFO';
  ELSE
    RAISE EXCEPTION 'Unknown camera alert transition %', p_action USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.network_incident_events (
    organization_id, building_id, incident_id, event_seq, event_kind,
    severity, occurred_at, worker_id, details
  ) VALUES (
    inc.organization_id, inc.building_id, inc.id,
    coalesce((SELECT max(e.event_seq) + 1 FROM public.network_incident_events e WHERE e.incident_id = inc.id), 1),
    v_kind, v_severity, v_at, c_actor,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('detectedBy', 'camera-alert')
  );

  IF p_action = 'RESOLVED' THEN
    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type, target_id,
      target_display, reason, validation, result, outcome, occurred_at
    ) VALUES (
      inc.organization_id, inc.building_id, 'SYSTEM',
      'system.camera_alert_resolved', 'camera_recorder',
      nullif(inc.observed_values ->> 'recorderId', '')::uuid,
      jsonb_build_object('incidentType', inc.incident_type, 'title', inc.title),
      'Bộ cảnh báo camera đóng sự cố',
      coalesce(p_details, '{}'::jsonb), jsonb_build_object('incidentId', inc.id),
      'OBSERVED', v_at
    );
    INSERT INTO public.network_outbox_events (
      organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
    ) VALUES (
      inc.organization_id, inc.building_id, 'network.camera.incident_resolved', 'incident', inc.id,
      jsonb_build_object('incidentId', inc.id, 'incidentType', inc.incident_type,
        'reason', coalesce(p_details ->> 'reason', 'RECOVERED')),
      v_at
    );
  END IF;
  RETURN true;
END
$fn$;

-- Một mục để quyết định và gom tin cuối lượt. p_ctx: {recorderName,
-- buildingName, recordersInBuilding, maintenance, knownBroken, baseline, cause, causeAt}.
CREATE OR REPLACE FUNCTION app_private.camera_alert_event_v1(
  p_kind text, p_cond app_private.camera_alert_conditions, p_incident_id uuid, p_ctx jsonb, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
BEGIN
  RETURN coalesce(p_ctx, '{}'::jsonb) || jsonb_build_object(
    'kind', p_kind,
    'incidentId', p_incident_id,
    'organizationId', p_cond.organization_id,
    'buildingId', p_cond.building_id,
    'recorderId', p_cond.recorder_id,
    'subject', p_cond.subject,
    'fingerprint', 'camera:' || p_cond.recorder_id::text || ':' || p_cond.subject,
    'code', p_cond.condition_code,
    'severity', p_cond.severity,
    'channel', p_cond.observed -> 'channel',
    'channelName', p_cond.observed -> 'channelName',
    'slot', p_cond.observed -> 'slot',
    'lastDataAt', p_cond.observed -> 'checkedAt',
    'firstSeenAt', p_cond.first_seen_at,
    'openedAt', p_cond.opened_at,
    'at', CASE WHEN p_kind IN ('RESOLVED', 'FIXED') THEN coalesce(p_cond.recovering_at, p_now) ELSE p_now END,
    'announced', p_cond.announced,
    'openRoute', p_cond.open_route,
    'conditionBaseline', p_cond.baseline
  );
END
$fn$;

-- Vượt ngưỡng: LIVE mở/nhận lại sự cố, SHADOW chỉ đánh dấu "sự cố dự kiến".
-- Trả mục OPENED, hoặc NULL khi không có gì mới.
CREATE OR REPLACE FUNCTION app_private.camera_alert_open_v1(
  p_cond app_private.camera_alert_conditions, p_severity text, p_live boolean,
  p_device_id uuid, p_ctx jsonb, p_threshold_seconds integer, p_tz text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_actor constant text := 'camera-alert';
  cond app_private.camera_alert_conditions;
  v_recorder text := coalesce(p_ctx ->> 'recorderName', '?');
  v_building text := coalesce(p_ctx ->> 'buildingName', '?');
  v_baseline boolean := coalesce((p_ctx ->> 'baseline')::boolean, false);
  v_since text;
  v_channel text;
  v_name text;
  v_title text;
  v_summary text;
  v_values jsonb;
  v_fingerprint text;
  v_id uuid;
  v_new boolean;
  v_repeats integer;
BEGIN
  UPDATE app_private.camera_alert_conditions c
     SET opened_at = coalesce(c.opened_at, p_now), severity = p_severity,
         baseline = c.baseline OR v_baseline
   WHERE c.recorder_id = p_cond.recorder_id AND c.subject = p_cond.subject
  RETURNING * INTO cond;

  IF NOT p_live THEN
    RETURN app_private.camera_alert_event_v1('OPENED', cond, NULL, p_ctx, p_now);
  END IF;

  v_since := to_char(cond.first_seen_at AT TIME ZONE p_tz, 'HH24:MI DD/MM');
  v_channel := coalesce(cond.observed ->> 'channel', '?');
  v_name := coalesce(nullif(btrim(coalesce(cond.observed ->> 'channelName', '')), ''), 'kênh ' || v_channel);
  v_fingerprint := 'camera:' || cond.recorder_id::text || ':' || cond.subject;

  CASE cond.condition_code
    WHEN 'CAMERA_STORAGE_ERROR' THEN
      v_title := 'Ổ cứng đầu ghi ' || v_recorder || ' báo lỗi';
      v_summary := 'Ổ ' || coalesce(cond.observed ->> 'slot', '?') || ' của đầu ghi ' || v_recorder || ' (' || v_building
        || ') báo lỗi từ ' || v_since || ' — đầu ghi có thể không lưu được video. Cần kiểm tra hoặc thay ổ.';
    WHEN 'CAMERA_RECORDER_OFFLINE' THEN
      v_title := 'Không gọi tới được đầu ghi ' || v_recorder;
      v_summary := 'Bộ giám sát không kết nối được đầu ghi ' || v_recorder || ' (' || v_building
        || ') từ ' || v_since || '. Đầu ghi tắt, treo, tuột dây hoặc toà mất mạng.';
    WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN
      v_title := 'Đầu ghi ' || v_recorder || ' từ chối mật khẩu giám sát';
      v_summary := 'Đầu ghi ' || v_recorder || ' (' || v_building
        || ') từ chối tài khoản giám sát từ ' || v_since || ' (có thể đã đổi mật khẩu). Hệ thống đang không theo dõi được ổ cứng và kênh.';
    WHEN 'CAMERA_MONITOR_STALE' THEN
      v_title := 'Mất dữ liệu giám sát đầu ghi ' || v_recorder;
      v_summary := 'Không nhận được trạng thái mới của đầu ghi ' || v_recorder || ' (' || v_building || ') '
        || CASE WHEN cond.observed ->> 'checkedAt' IS NULL THEN 'kể từ khi đăng ký theo dõi'
                ELSE 'từ ' || to_char((cond.observed ->> 'checkedAt')::timestamptz AT TIME ZONE p_tz, 'HH24:MI DD/MM') END
        || '. Có thể do VPS hoặc bộ thu thập, chưa chắc do đầu ghi.';
    WHEN 'CAMERA_CHANNEL_LOST' THEN
      v_title := 'Camera ' || v_name || ' của đầu ghi ' || v_recorder || ' mất hình';
      v_summary := 'Kênh ' || v_channel || ' (' || v_name || ') của đầu ghi ' || v_recorder || ' (' || v_building
        || ') mất kết nối từ ' || v_since || '.';
    ELSE
      v_title := 'Đầu ghi ' || v_recorder || ' trả lời lạ';
      v_summary := 'Đầu ghi ' || v_recorder || ' (' || v_building
        || ') trả trạng thái không xác định từ ' || v_since || ' (ổ cứng hoặc kênh không đọc được).';
  END CASE;

  v_values := cond.observed || jsonb_build_object(
    'recorderId', cond.recorder_id,
    'recorderName', v_recorder,
    'subject', cond.subject,
    'firstSeenAt', cond.first_seen_at,
    'thresholdSeconds', p_threshold_seconds,
    'maintenance', coalesce((p_ctx ->> 'maintenance')::boolean, false),
    'baseline', v_baseline,
    'knownBroken', coalesce((p_ctx ->> 'knownBroken')::boolean, false),
    'detectedBy', 'camera-alert'
  );
  -- Tái diễn: số lần cùng fingerprint mở trong 24 giờ, kể cả lần này (spec §3.4).
  SELECT count(*) + 1 INTO v_repeats
    FROM public.network_incidents i
   WHERE i.organization_id = cond.organization_id AND i.building_id = cond.building_id
     AND i.fingerprint = v_fingerprint AND i.opened_at > p_now - interval '24 hours';

  INSERT INTO public.network_incidents (
    organization_id, building_id, device_id, interface_id, fingerprint,
    incident_type, severity, status, title, summary, availability_impact,
    opened_at, last_observed_at, occurrence_count, observed_values
  ) VALUES (
    cond.organization_id, cond.building_id, p_device_id, NULL, v_fingerprint,
    cond.condition_code, p_severity, 'OPEN', left(v_title, 200), left(v_summary, 2000), false,
    p_now, p_now, v_repeats, v_values
  )
  ON CONFLICT (organization_id, building_id, fingerprint) WHERE status <> 'RESOLVED'
  DO UPDATE SET
    last_observed_at = greatest(public.network_incidents.last_observed_at, EXCLUDED.last_observed_at)
  RETURNING id, (xmax = 0) INTO v_id, v_new;

  UPDATE app_private.camera_alert_conditions c
     SET incident_id = v_id
   WHERE c.recorder_id = cond.recorder_id AND c.subject = cond.subject
  RETURNING * INTO cond;

  IF NOT v_new THEN
    -- Sự cố cùng fingerprint đang mở từ trước: nhận lại, không báo lần hai.
    RETURN NULL;
  END IF;

  INSERT INTO public.network_incident_events (
    organization_id, building_id, incident_id, event_seq, event_kind,
    severity, occurred_at, worker_id, details
  ) VALUES (
    cond.organization_id, cond.building_id, v_id, 1, 'OPENED', p_severity, p_now, c_actor,
    jsonb_build_object('thresholdSeconds', p_threshold_seconds, 'firstSeenAt', cond.first_seen_at,
      'baseline', v_baseline, 'detectedBy', 'camera-alert')
  );
  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, action, target_type, target_id,
    target_display, reason, validation, result, outcome, occurred_at
  ) VALUES (
    cond.organization_id, cond.building_id, 'SYSTEM',
    'system.camera_alert_opened', 'camera_recorder', cond.recorder_id,
    jsonb_build_object('recorderName', v_recorder, 'subject', cond.subject),
    'Bộ cảnh báo camera mở sự cố',
    jsonb_build_object('thresholdSeconds', p_threshold_seconds, 'baseline', v_baseline),
    jsonb_build_object('incidentId', v_id),
    'OBSERVED', p_now
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    cond.organization_id, cond.building_id, 'network.camera.incident_opened', 'incident', v_id,
    jsonb_build_object('incidentId', v_id, 'incidentType', cond.condition_code,
      'recorderId', cond.recorder_id, 'subject', cond.subject),
    p_now
  );

  RETURN app_private.camera_alert_event_v1('OPENED', cond, v_id, p_ctx, p_now);
END
$fn$;

-- Bỏ theo dõi một điều kiện KHÔNG vì hết lỗi (tắt theo dõi, loại bị tắt, kênh
-- bị tắt báo, lỗi cấp đầu ghi che mất — B2). Đóng lặng, không có tin khôi phục.
CREATE OR REPLACE FUNCTION app_private.camera_alert_retire_v1(
  p_cond app_private.camera_alert_conditions, p_reason text, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_closed boolean := false;
BEGIN
  IF p_cond.incident_id IS NOT NULL THEN
    v_closed := app_private.camera_alert_transition_v1(
      p_cond.incident_id, 'RESOLVED', p_now, jsonb_build_object('reason', p_reason));
  END IF;
  DELETE FROM app_private.camera_alert_conditions c
   WHERE c.recorder_id = p_cond.recorder_id AND c.subject = p_cond.subject;
  RETURN v_closed;
END
$fn$;

-- -----------------------------------------------------------------------------
-- 6. Gửi.
-- -----------------------------------------------------------------------------
-- Xếp MỘT tin văn bản vào hội thoại nhóm (khuôn zalo_enqueue_broadcast_v1,
-- 20261011052259:314-356). Payload KHÔNG có tu_dong. Chỉ bộ gửi dưới gọi.
CREATE OR REPLACE FUNCTION app_private.camera_alert_zalo_enqueue_v1(
  p_org uuid, p_account uuid, p_conversation uuid, p_body text, p_dedup text, p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  c record;
  a record;
  v_key text := 'camera_alert:' || p_dedup;
  v_msg uuid;
  v_job uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_account IS NULL OR p_conversation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Chưa chọn nhóm Zalo nhận cảnh báo');
  END IF;
  IF btrim(coalesce(p_body, '')) = '' OR length(p_body) > 6000 THEN
    RAISE EXCEPTION 'Nội dung cảnh báo camera không hợp lệ' USING ERRCODE = '22023';
  END IF;
  SELECT x.id, x.user_id, x.organization_id, x.account_id, x.thread_type INTO c
    FROM public.zalo_conversations x WHERE x.id = p_conversation FOR SHARE;
  IF NOT FOUND OR c.organization_id IS DISTINCT FROM p_org THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Nhóm Zalo không còn');
  END IF;
  IF c.thread_type IS DISTINCT FROM 'group' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Hội thoại đã chọn không phải nhóm Zalo');
  END IF;
  IF c.account_id IS DISTINCT FROM p_account THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Nhóm không thuộc nick Zalo đã chọn');
  END IF;
  SELECT x.id, x.kind, x.status INTO a
    FROM public.zalo_accounts x WHERE x.id = p_account AND x.organization_id = p_org;
  IF NOT FOUND OR a.kind IS DISTINCT FROM 'personal' OR a.status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Nick Zalo chưa kết nối');
  END IF;

  SELECT m.id INTO v_msg FROM public.zalo_messages m WHERE m.conversation_id = c.id AND m.client_dedup_key = v_key;
  IF FOUND THEN
    SELECT q.id INTO v_job FROM public.zalo_send_queue q WHERE q.message_id = v_msg ORDER BY q.created_at, q.id LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'reused', true, 'messageId', v_msg, 'jobId', v_job);
  END IF;

  INSERT INTO public.zalo_messages(user_id, organization_id, conversation_id, account_id, direction, msg_type, body, status, sent_at, client_dedup_key)
    VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'out', 'text', p_body, 'pending', v_now, v_key)
    RETURNING id INTO v_msg;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, message_id, channel, payload, status)
    VALUES (c.user_id, c.organization_id, c.id, c.account_id, v_msg, 'personal',
      jsonb_build_object('body', p_body, 'camera_alert', true, 'camera_alert_delivery_id', p_delivery_id), 'queued')
    RETURNING id INTO v_job;
  UPDATE public.zalo_conversations
     SET last_message_text = p_body, last_message_at = v_now, last_message_dir = 'out'
   WHERE id = c.id;
  RETURN jsonb_build_object('ok', true, 'reused', false, 'messageId', v_msg, 'jobId', v_job,
    'conversationId', c.id, 'accountId', c.account_id);
END
$fn$;

COMMENT ON FUNCTION app_private.camera_alert_zalo_enqueue_v1(uuid, uuid, uuid, text, text, uuid) IS
  'Xếp một tin văn bản cảnh báo camera vào nhóm Zalo đã chọn: zalo_messages pending + zalo_send_queue queued, payload {body, camera_alert, camera_alert_delivery_id}. Không có khoá tu_dong ⇒ không dính trần phòng trống, kiểm STALE_SALE_CONTENT hay dừng khẩn cấp của bot đăng phòng.';

-- Ghi sổ và gửi MỘT tin Zalo của org: chống trùng theo dedup, trần ngày, SHADOW.
-- Trả {deliveryId, status, reason, reused}.
CREATE OR REPLACE FUNCTION app_private.camera_alert_send_zalo_v1(
  p_settings app_private.camera_alert_settings, p_shadow boolean, p_kind text, p_body text,
  p_building_ids uuid[], p_dedup text, p_counts_cap boolean, p_now timestamptz, p_result jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid := p_settings.organization_id;
  v_date date := (p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id))::date;
  v_key text := CASE WHEN p_shadow THEN 'SHADOW:' ELSE '' END || p_dedup;
  c_footer constant text := 'Xem: CRM › Trung tâm mạng › Camera';
  v_id uuid := gen_random_uuid();
  v_existing record;
  v_count integer := 0;
  v_body text := p_body;
  v_q jsonb;
BEGIN
  SELECT d.id, d.status, d.reason INTO v_existing FROM app_private.camera_alert_deliveries d WHERE d.dedup_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('deliveryId', v_existing.id, 'status', v_existing.status, 'reason', v_existing.reason, 'reused', true);
  END IF;

  IF p_counts_cap THEN
    SELECT count(*) INTO v_count FROM app_private.camera_alert_deliveries d
     WHERE d.organization_id = v_org AND d.channel = 'ZALO' AND d.local_date = v_date
       AND d.counts_toward_cap AND d.shadow = p_shadow;
    IF v_count >= p_settings.daily_zalo_cap THEN
      -- Vượt trần (spec §3.5): dồn vào bản tin kế tiếp; tin thử thì bỏ.
      INSERT INTO app_private.camera_alert_deliveries (
        id, organization_id, kind, channel, shadow, status, reason, body, building_ids, dedup_key, local_date,
        counts_toward_cap, pending_release, zalo_account_id, zalo_conversation_id, result, created_at)
      VALUES (v_id, v_org, p_kind, 'ZALO', p_shadow,
        CASE WHEN p_shadow THEN 'SHADOW' WHEN p_kind = 'TEST' THEN 'SUPPRESSED' ELSE 'DEFERRED' END,
        'DAILY_CAP', v_body, coalesce(p_building_ids, '{}'), v_key, v_date,
        false, p_kind NOT IN ('TEST', 'NIGHT_DIGEST', 'DIGEST'),
        p_settings.zalo_account_id, p_settings.zalo_conversation_id,
        coalesce(p_result, '{}'::jsonb) || jsonb_build_object('capCount', v_count, 'cap', p_settings.daily_zalo_cap), p_now);
      RETURN jsonb_build_object('deliveryId', v_id, 'status', CASE WHEN p_shadow THEN 'SHADOW' WHEN p_kind = 'TEST' THEN 'SUPPRESSED' ELSE 'DEFERRED' END,
        'reason', 'DAILY_CAP', 'capped', true);
    END IF;
    IF v_count + 1 = p_settings.daily_zalo_cap THEN
      -- Câu báo trần đứng trước dòng "Xem:" cuối tin.
      v_body := CASE WHEN right(v_body, length(c_footer) + 1) = E'\n' || c_footer
                     THEN left(v_body, length(v_body) - length(c_footer) - 1) ELSE v_body END
        || E'\nĐã chạm trần ' || p_settings.daily_zalo_cap
        || ' tin hôm nay — sự cố tiếp theo xem trong CRM và bản tin sáng.'
        || CASE WHEN right(v_body, length(c_footer) + 1) = E'\n' || c_footer THEN E'\n' || c_footer ELSE '' END;
    END IF;
  END IF;

  IF p_shadow THEN
    INSERT INTO app_private.camera_alert_deliveries (
      id, organization_id, kind, channel, shadow, status, reason, body, building_ids, dedup_key, local_date,
      counts_toward_cap, zalo_account_id, zalo_conversation_id, result, created_at)
    VALUES (v_id, v_org, p_kind, 'ZALO', true, 'SHADOW', 'WOULD_QUEUE', v_body, coalesce(p_building_ids, '{}'), v_key, v_date,
      p_counts_cap, p_settings.zalo_account_id, p_settings.zalo_conversation_id, coalesce(p_result, '{}'::jsonb), p_now);
    RETURN jsonb_build_object('deliveryId', v_id, 'status', 'SHADOW', 'reason', 'WOULD_QUEUE');
  END IF;

  v_q := app_private.camera_alert_zalo_enqueue_v1(v_org, p_settings.zalo_account_id, p_settings.zalo_conversation_id,
    v_body, v_key, v_id);
  INSERT INTO app_private.camera_alert_deliveries (
    id, organization_id, kind, channel, shadow, status, reason, body, building_ids, dedup_key, local_date,
    counts_toward_cap, zalo_account_id, zalo_conversation_id, zalo_message_id, zalo_job_id, result, created_at, sent_at)
  VALUES (v_id, v_org, p_kind, 'ZALO', false,
    CASE WHEN (v_q ->> 'ok')::boolean THEN 'QUEUED' ELSE 'FAILED' END,
    CASE WHEN (v_q ->> 'ok')::boolean THEN NULL ELSE left(v_q ->> 'reason', 300) END,
    v_body, coalesce(p_building_ids, '{}'), v_key, v_date,
    p_counts_cap AND (v_q ->> 'ok')::boolean,
    p_settings.zalo_account_id, p_settings.zalo_conversation_id,
    nullif(v_q ->> 'messageId', '')::uuid, nullif(v_q ->> 'jobId', '')::uuid,
    coalesce(p_result, '{}'::jsonb), p_now,
    CASE WHEN (v_q ->> 'ok')::boolean THEN p_now END);
  RETURN jsonb_build_object('deliveryId', v_id,
    'status', CASE WHEN (v_q ->> 'ok')::boolean THEN 'QUEUED' ELSE 'FAILED' END,
    'reason', v_q ->> 'reason', 'jobId', v_q ->> 'jobId');
END
$fn$;

-- Chuông: MỘT thông báo mỗi người mỗi lô, chỉ dòng của toà người đó nhận
-- (D9). Sổ ghi MỘT dòng IN_APP cho cả lô. p_lines: mảng {text, kind, buildingIds}.
CREATE OR REPLACE FUNCTION app_private.camera_alert_send_bell_v1(
  p_settings app_private.camera_alert_settings, p_shadow boolean, p_kind text, p_lines jsonb,
  p_dedup text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid := p_settings.organization_id;
  v_date date := (p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id))::date;
  v_key text := CASE WHEN p_shadow THEN 'SHADOW:' ELSE '' END || p_dedup;
  v_id uuid := gen_random_uuid();
  v_recipients jsonb := '{}'::jsonb;
  v_building text;
  v_users uuid[] := '{}'::uuid[];
  v_user uuid;
  v_mine jsonb;
  v_first text;
  v_opened integer;
  v_resolved integer;
  v_subject text;
  v_content text;
  v_notifications jsonb := '[]'::jsonb;
  v_notification uuid;
  v_body text;
  v_building_ids uuid[];
BEGIN
  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('deliveryId', NULL, 'recipients', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries d WHERE d.dedup_key = v_key) THEN
    RETURN jsonb_build_object('reused', true);
  END IF;
  -- Người nhận kiểm lại ở mỗi lô, không cache giữa các lượt.
  FOR v_building IN
    SELECT DISTINCT b.value #>> '{}' FROM jsonb_array_elements(p_lines) l, jsonb_array_elements(l.value -> 'buildingIds') b
  LOOP
    v_recipients := v_recipients || jsonb_build_object(v_building,
      to_jsonb(app_private.network_center_alert_recipient_ids_v1(v_org, v_building::uuid)));
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT u::uuid ORDER BY u::uuid), '{}'::uuid[]) INTO v_users
    FROM jsonb_each(v_recipients) e, jsonb_array_elements_text(e.value) u;
  SELECT array_agg(DISTINCT b.value #>> '{}') INTO v_building_ids
    FROM jsonb_array_elements(p_lines) l, jsonb_array_elements(l.value -> 'buildingIds') b;

  SELECT string_agg(CASE WHEN l.value ->> 'kind' = 'RESOLVED' THEN '✅ ' ELSE '• ' END || (l.value ->> 'text'), E'\n' ORDER BY l.ordinality)
    INTO v_body FROM jsonb_array_elements(p_lines) WITH ORDINALITY l;

  IF NOT p_shadow THEN
    FOREACH v_user IN ARRAY v_users LOOP
      -- Dòng chỉ tới người nhận của MỌI toà nêu trong dòng; dòng gộp mất dữ liệu
      -- giám sát (anyBuilding) chỉ ghi số toà nên người nhận một toà là đủ.
      SELECT coalesce(jsonb_agg(l.value ORDER BY l.ordinality), '[]'::jsonb) INTO v_mine
        FROM jsonb_array_elements(p_lines) WITH ORDINALITY l
       WHERE jsonb_array_length(l.value -> 'buildingIds') > 0
         AND CASE WHEN coalesce((l.value ->> 'anyBuilding')::boolean, false)
               THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(l.value -> 'buildingIds') b(id)
                             WHERE (v_recipients -> b.id) ? v_user::text)
               ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(l.value -> 'buildingIds') b(id)
                                 WHERE NOT coalesce((v_recipients -> b.id) ? v_user::text, false)) END;
      CONTINUE WHEN jsonb_array_length(v_mine) = 0;
      SELECT count(*) FILTER (WHERE x.value ->> 'kind' <> 'RESOLVED'), count(*) FILTER (WHERE x.value ->> 'kind' = 'RESOLVED'),
             (SELECT b.id FROM jsonb_array_elements_text(v_mine -> 0 -> 'buildingIds') b(id)
               WHERE (v_recipients -> b.id) ? v_user::text LIMIT 1)
        INTO v_opened, v_resolved, v_first
        FROM jsonb_array_elements(v_mine) x;
      v_subject := CASE p_kind
        WHEN 'DIGEST' THEN 'Camera: bản tin sáng'
        WHEN 'NIGHT_DIGEST' THEN 'Camera: tin dồn đêm qua'
        ELSE CASE
          WHEN v_opened > 0 AND v_resolved > 0 THEN 'Camera: ' || v_opened || ' sự cố mới, ' || v_resolved || ' đã khôi phục'
          WHEN v_opened > 0 THEN 'Camera: ' || v_opened || ' sự cố mới'
          ELSE 'Camera: ' || v_resolved || ' sự cố đã khôi phục' END
      END;
      SELECT left(string_agg(CASE WHEN x.value ->> 'kind' = 'RESOLVED' THEN '✅ ' WHEN x.value ->> 'kind' = 'SECTION' THEN '' ELSE '• ' END
               || (x.value ->> 'text'), E'\n' ORDER BY x.ordinality), 2000)
        INTO v_content FROM jsonb_array_elements(v_mine) WITH ORDINALITY x;
      INSERT INTO public.notifications (organization_id, user_id, type, channel, status, subject, content, metadata, push_state)
      VALUES (v_org, v_user, 'CUSTOM', 'IN_APP', 'PENDING', v_subject, v_content,
        jsonb_build_object('v5', 'camera_alert', 'kind', p_kind, 'deliveryId', v_id,
          'url', '/network-center/buildings/' || v_first || '?tab=cameras'),
        CASE WHEN p_settings.push_enabled THEN 'QUEUED' END)
      RETURNING id INTO v_notification;
      v_notifications := v_notifications || jsonb_build_array(v_notification);
    END LOOP;
  END IF;

  INSERT INTO app_private.camera_alert_deliveries (
    id, organization_id, kind, channel, shadow, status, reason, body, building_ids, dedup_key, local_date,
    recipients, result, created_at, sent_at)
  VALUES (v_id, v_org, p_kind, 'IN_APP', p_shadow,
    CASE WHEN p_shadow THEN 'SHADOW' WHEN jsonb_array_length(v_notifications) > 0 THEN 'SENT' ELSE 'FAILED' END,
    CASE WHEN p_shadow THEN 'WOULD_NOTIFY' WHEN jsonb_array_length(v_notifications) = 0 THEN 'Không có người nhận' END,
    left(v_body, 6000), coalesce(v_building_ids, '{}'), v_key, v_date,
    CASE WHEN p_shadow THEN cardinality(v_users) ELSE jsonb_array_length(v_notifications) END,
    jsonb_build_object('notificationIds', v_notifications, 'push', p_settings.push_enabled)
      || CASE WHEN p_shadow THEN jsonb_build_object('wouldNotify', to_jsonb(v_users)) ELSE '{}'::jsonb END,
    p_now, CASE WHEN NOT p_shadow THEN p_now END);
  RETURN jsonb_build_object('deliveryId', v_id, 'recipients', jsonb_array_length(v_notifications));
END
$fn$;

-- -----------------------------------------------------------------------------
-- 7. Bản tin 07:00 (dồn đêm + vượt trần) và 08:00 (nhắc).
-- -----------------------------------------------------------------------------
-- Mục chờ của các dòng dồn, kèm trạng thái hiện tại của sự cố.
CREATE OR REPLACE FUNCTION app_private.camera_alert_pending_items_v1(p_org uuid, p_shadow boolean, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(e.payload || jsonb_build_object(
             'eventId', e.id,
             'resolvedAt', (SELECT min((r.payload ->> 'at')::timestamptz) FROM app_private.camera_alert_events r
                             WHERE r.organization_id = e.organization_id AND r.fingerprint = e.fingerprint
                               AND r.kind = 'RESOLVED' AND r.shadow = e.shadow AND r.occurred_at >= e.occurred_at)
           ) ORDER BY e.occurred_at, e.id)
      FROM app_private.camera_alert_deliveries d
      JOIN app_private.camera_alert_events e ON e.delivery_id = d.id
     WHERE d.organization_id = p_org AND d.shadow = p_shadow
       AND d.pending_release AND d.released_at IS NULL
       AND d.created_at > p_now - interval '36 hours'
  ), '[]'::jsonb);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.camera_alert_release_pending_v1(
  p_org uuid, p_shadow boolean, p_now timestamptz, p_digest uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  -- Khôi phục đã được ghi trong tin dồn ("đã có lại lúc …") thì không lặp ở 08:00.
  UPDATE app_private.camera_alert_events r
     SET digest_state = 'DONE', digest_delivery_id = p_digest
   WHERE r.organization_id = p_org AND r.shadow = p_shadow AND r.kind = 'RESOLVED' AND r.digest_state = 'PENDING'
     AND EXISTS (
       SELECT 1 FROM app_private.camera_alert_deliveries d
       JOIN app_private.camera_alert_events e ON e.delivery_id = d.id
        WHERE d.organization_id = p_org AND d.shadow = p_shadow AND d.pending_release AND d.released_at IS NULL
          AND e.fingerprint = r.fingerprint AND e.occurred_at <= r.occurred_at);
  UPDATE app_private.camera_alert_deliveries d
     SET released_at = p_now, released_in = p_digest,
         result = d.result || CASE WHEN d.created_at <= p_now - interval '36 hours'
                                   THEN jsonb_build_object('expired', true) ELSE '{}'::jsonb END
   WHERE d.organization_id = p_org AND d.shadow = p_shadow AND d.pending_release AND d.released_at IS NULL;
END
$fn$;

-- 07:00: các mục dồn từ đêm và các mục vượt trần. Không có nội dung thì không gửi.
CREATE OR REPLACE FUNCTION app_private.camera_alert_night_digest_v1(
  p_settings app_private.camera_alert_settings, p_shadow boolean, p_now timestamptz, p_monitored integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid := p_settings.organization_id;
  v_tz text := app_private.org_timezone_v1(p_settings.organization_id);
  v_date date := (p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id))::date;
  v_items jsonb;
  v_lines jsonb;
  v_body text;
  v_ids uuid[];
  v_sent jsonb;
BEGIN
  v_items := app_private.camera_alert_pending_items_v1(v_org, p_shadow, p_now);
  IF jsonb_array_length(v_items) = 0 THEN
    PERFORM app_private.camera_alert_release_pending_v1(v_org, p_shadow, p_now, NULL);
    RETURN NULL;
  END IF;
  v_lines := app_private.camera_alert_lines_v1(v_items, v_tz, p_now, 'NIGHT', p_monitored);
  v_body := app_private.camera_alert_compose_v1('📋 Camera — tin dồn lại (' || to_char(v_date, 'DD/MM') || ')', v_lines, NULL);
  SELECT array_agg(DISTINCT b.value #>> '{}') INTO v_ids
    FROM jsonb_array_elements(v_lines) l, jsonb_array_elements(l.value -> 'buildingIds') b;
  v_sent := app_private.camera_alert_send_zalo_v1(p_settings, p_shadow, 'NIGHT_DIGEST', v_body, v_ids,
    'NIGHT_DIGEST:' || v_org::text || ':' || v_date::text, true, p_now,
    jsonb_build_object('eventIds', (SELECT jsonb_agg(x.value -> 'eventId') FROM jsonb_array_elements(v_items) x)));
  -- Không có chuông: mọi mục dồn (đêm, vượt trần) đã có chuông ngay lúc xảy ra (D9).
  -- Bị trần thì giữ nguyên các mục chờ cho bản tin kế tiếp.
  IF NOT coalesce((v_sent ->> 'capped')::boolean, false) THEN
    PERFORM app_private.camera_alert_release_pending_v1(v_org, p_shadow, p_now, (v_sent ->> 'deliveryId')::uuid);
  END IF;
  RETURN v_sent;
END
$fn$;

-- 08:00: nhắc D4 + đã biết hỏng (thứ Hai) + chập chờn + tái diễn + mục chờ bản tin.
CREATE OR REPLACE FUNCTION app_private.camera_alert_morning_digest_v1(
  p_settings app_private.camera_alert_settings, p_shadow boolean, p_now timestamptz, p_monitored integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid := p_settings.organization_id;
  v_tz text := app_private.org_timezone_v1(p_settings.organization_id);
  v_date date := (p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id))::date;
  v_monday boolean := extract(isodow FROM (p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id))) = 1;
  v_types jsonb := app_private.camera_alert_types_v1(p_settings.types);
  v_flap_route text := app_private.camera_alert_route_v1(app_private.camera_alert_types_v1(p_settings.types), 'CAMERA_CHANNEL_FLAPPING');
  v_flap_min integer := greatest(2, app_private.camera_alert_threshold_v1(app_private.camera_alert_types_v1(p_settings.types), 'CAMERA_CHANNEL_FLAPPING'));
  v_lines jsonb := '[]'::jsonb;
  v_part jsonb;
  v_text text;
  v_pending jsonb;
  v_bell jsonb;
  v_digest_events uuid[];
  v_body text;
  v_ids uuid[];
  v_sent jsonb;
BEGIN
  -- a) Đang mở, chưa "Đã biết": ngày 1–3 kể từ lúc mở, sau đó chỉ thứ Hai.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'OPENED', 'code', c.condition_code, 'buildingId', c.building_id, 'buildingName', b.name,
           'recorderId', c.recorder_id, 'recorderName', r.display_name,
           'recordersInBuilding', (SELECT count(*) FROM public.camera_recorders r2 WHERE r2.building_id = c.building_id AND r2.enabled),
           'channel', c.observed -> 'channel', 'channelName', c.observed -> 'channelName', 'slot', c.observed -> 'slot',
           'firstSeenAt', c.first_seen_at, 'at', p_now)
           ORDER BY b.name, c.opened_at), '[]'::jsonb)
    INTO v_part
    FROM app_private.camera_alert_conditions c
    JOIN public.camera_recorders r ON r.id = c.recorder_id
    JOIN public.buildings b ON b.id = c.building_id
    LEFT JOIN public.network_incidents i ON i.id = c.incident_id
   WHERE c.organization_id = v_org AND c.opened_at IS NOT NULL
     AND app_private.camera_alert_route_v1(v_types, c.condition_code) IN ('ZALO', 'DIGEST')
     AND (p_shadow OR (i.id IS NOT NULL AND i.status <> 'RESOLVED' AND i.acknowledged_at IS NULL))
     AND NOT EXISTS (
       SELECT 1 FROM app_private.camera_alert_channel_mutes m
        WHERE m.recorder_id = c.recorder_id AND 'channel:' || m.channel = c.subject AND m.kind = 'KNOWN_BROKEN')
     AND NOT EXISTS (
       SELECT 1 FROM public.network_maintenance_windows w
        WHERE w.organization_id = c.organization_id AND w.building_id = c.building_id
          AND w.status IN ('SCHEDULED', 'ACTIVE') AND w.starts_at <= p_now AND w.ends_at > p_now)
     -- Tin mở vừa tới (dồn đêm 07:00, hoặc còn chờ bản tin này) thì chưa nhắc:
     -- mở chưa đủ 12 giờ, hoặc mục mở còn PENDING trong chính bản tin này.
     AND c.opened_at <= p_now - interval '12 hours'
     AND NOT EXISTS (
       SELECT 1 FROM app_private.camera_alert_events e
        WHERE e.organization_id = v_org AND e.shadow = p_shadow AND e.kind = 'OPENED' AND e.digest_state = 'PENDING'
          AND e.fingerprint = 'camera:' || c.recorder_id::text || ':' || c.subject)
     AND ((v_date - (c.opened_at AT TIME ZONE v_tz)::date) BETWEEN 1 AND 3
          OR ((v_date - (c.opened_at AT TIME ZONE v_tz)::date) >= 4 AND v_monday));
  IF jsonb_array_length(v_part) > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'SECTION', 'text', 'Đang mở, chưa ai bấm "Đã biết":', 'buildingIds', '[]'::jsonb))
      || app_private.camera_alert_lines_v1(v_part, v_tz, p_now, 'REMIND', p_monitored);
  END IF;

  -- b) Đã biết hỏng: chỉ thứ Hai, kênh còn mất, chưa "Đã biết"; loại kênh mất
  --    phải đang báo qua Zalo hoặc bản tin (BELL/OFF thì không vào tin Zalo).
  IF v_monday AND app_private.camera_alert_route_v1(v_types, 'CAMERA_CHANNEL_LOST') IN ('ZALO', 'DIGEST') THEN
    SELECT string_agg(y.line, '; ' ORDER BY y.building_name), jsonb_agg(DISTINCT y.building_id)
      INTO v_text, v_part
      FROM (
        SELECT x.building_name, x.building_id,
               x.building_name || ' ' || string_agg(x.part, '; ' ORDER BY x.recorder_name) AS line
          FROM (
            SELECT b.name AS building_name, c.building_id, r.display_name AS recorder_name,
                   CASE WHEN (SELECT count(*) FROM public.camera_recorders r2 WHERE r2.building_id = c.building_id AND r2.enabled) > 1
                        THEN 'đầu ghi "' || r.display_name || '" ' ELSE '' END
                   || 'kênh ' || string_agg(c.observed ->> 'channel', ', ' ORDER BY (c.observed ->> 'channel')::integer) AS part
              FROM app_private.camera_alert_conditions c
              JOIN public.camera_recorders r ON r.id = c.recorder_id
              JOIN public.buildings b ON b.id = c.building_id
              JOIN app_private.camera_alert_channel_mutes m
                ON m.recorder_id = c.recorder_id AND 'channel:' || m.channel = c.subject AND m.kind = 'KNOWN_BROKEN'
              LEFT JOIN public.network_incidents i ON i.id = c.incident_id
             WHERE c.organization_id = v_org AND c.opened_at IS NOT NULL AND c.condition_code = 'CAMERA_CHANNEL_LOST'
               AND (p_shadow OR (i.id IS NOT NULL AND i.status <> 'RESOLVED' AND i.acknowledged_at IS NULL))
               AND (v_date - (c.opened_at AT TIME ZONE v_tz)::date) >= 1
             GROUP BY b.name, c.building_id, r.id, r.display_name
          ) x
         GROUP BY x.building_name, x.building_id
      ) y;
    IF v_text IS NOT NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'SECTION',
        'text', 'Đã biết hỏng (nhắc thứ Hai): ' || v_text || '.', 'buildingIds', v_part));
    END IF;
  END IF;

  -- c) Chập chờn 24 giờ qua: CONNECTED → DISCONNECTED (không tính lần đầu ghi
  --    vừa kết nối lại, B2), đầu ghi đang ONLINE, bỏ kênh tắt báo và kênh đang
  --    có sự cố mất hình.
  IF v_flap_route = 'DIGEST' THEN
    SELECT string_agg(x.line, '; ' ORDER BY x.building_name), jsonb_agg(DISTINCT x.building_id)
      INTO v_text, v_part
      FROM (
        SELECT b.name AS building_name, r.building_id,
               b.name || ' ' || string_agg(
                 CASE WHEN (SELECT count(*) FROM public.camera_recorders r2 WHERE r2.building_id = r.building_id AND r2.enabled) > 1
                      THEN 'đầu ghi "' || r.display_name || '" ' ELSE '' END
                 || 'kênh ' || f.channel || ' (' || f.n || ' lần)', ', ' ORDER BY r.display_name, f.channel) AS line
          FROM (
            SELECT ev.recorder_id, ev.channel, count(*) AS n
              FROM public.camera_events ev
             WHERE ev.organization_id = v_org AND ev.kind = 'CHANNEL'
               AND ev.state = 'DISCONNECTED' AND ev.previous_state = 'CONNECTED'
               AND ev.observed_at > p_now - interval '24 hours' AND ev.observed_at <= p_now
             GROUP BY ev.recorder_id, ev.channel
            HAVING count(*) >= v_flap_min
          ) f
          JOIN public.camera_recorders r ON r.id = f.recorder_id AND r.enabled
          JOIN public.buildings b ON b.id = r.building_id AND b.deleted_at IS NULL
          JOIN public.camera_recorder_current cur ON cur.recorder_id = r.id AND cur.status = 'ONLINE'
         WHERE NOT EXISTS (
                 SELECT 1 FROM app_private.camera_alert_channel_mutes m
                  WHERE m.recorder_id = f.recorder_id AND m.channel = f.channel
                    AND (m.kind = 'IGNORE' OR (m.kind = 'SNOOZE' AND m.until_at > p_now)))
           AND NOT EXISTS (
                 SELECT 1 FROM app_private.camera_alert_conditions c
                  WHERE c.recorder_id = f.recorder_id AND c.subject = 'channel:' || f.channel AND c.opened_at IS NOT NULL)
         GROUP BY b.name, r.building_id
      ) x;
    IF v_text IS NOT NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'SECTION',
        'text', 'Chập chờn 24 giờ qua: ' || v_text || '.', 'buildingIds', v_part));
    END IF;
  END IF;

  -- d) Tái diễn bị chặn 24 giờ.
  SELECT string_agg(x.line, E'\n' ORDER BY x.line), jsonb_agg(DISTINCT x.building_id)
    INTO v_text, v_part
    FROM (
      SELECT e.building_id,
             '• ' || min(e.payload ->> 'buildingName') || ': ' || CASE min(e.code)
               WHEN 'CAMERA_CHANNEL_LOST' THEN app_private.camera_alert_channel_label_v1((array_agg(e.payload ORDER BY e.occurred_at DESC))[1])
               WHEN 'CAMERA_STORAGE_ERROR' THEN 'ổ cứng ' || coalesce((array_agg(e.payload ->> 'slot'))[1], '?')
               ELSE app_private.camera_alert_recorder_label_v1(jsonb_agg(e.payload))
                 || ' ' || CASE min(e.code) WHEN 'CAMERA_RECORDER_OFFLINE' THEN 'không gọi tới được'
                   WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN 'từ chối mật khẩu' WHEN 'CAMERA_MONITOR_STALE' THEN 'mất dữ liệu giám sát'
                   ELSE 'trả lời lạ' END END
               || ' — tái diễn ' || count(*) || ' lần trong 24 giờ qua.' AS line
        FROM app_private.camera_alert_events e
       WHERE e.organization_id = v_org AND e.shadow = p_shadow AND e.kind = 'OPENED' AND e.decision = 'REPEAT_24H'
         AND e.route IN ('ZALO', 'DIGEST')
         AND e.occurred_at > p_now - interval '24 hours' AND e.occurred_at <= p_now
       GROUP BY e.fingerprint, e.building_id
    ) x;
  IF v_text IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'SECTION',
      'text', 'Tái diễn (đã chặn tin lặp):' || E'\n' || v_text, 'buildingIds', v_part));
  END IF;
  -- Dòng SECTION chỉ có tên toà khi chính nó liệt kê toà; tiêu đề trống toà
  -- không tới chuông (lọc bên dưới).

  -- e) Mục chờ bản tin (loại "chỉ bản tin", khôi phục kênh lẻ, kênh đã sửa) và
  --    nội dung vượt trần chưa được gửi.
  SELECT coalesce(jsonb_agg(e.payload ORDER BY e.occurred_at, e.id), '[]'::jsonb), array_agg(e.id)
    INTO v_pending, v_digest_events
    FROM app_private.camera_alert_events e
   WHERE e.organization_id = v_org AND e.shadow = p_shadow AND e.digest_state = 'PENDING'
     AND e.occurred_at > p_now - interval '36 hours' AND e.occurred_at <= p_now;
  v_pending := v_pending || app_private.camera_alert_pending_items_v1(v_org, p_shadow, p_now);
  -- Chuông của bản tin chỉ mang phần a–d: mục chờ (e) đã có chuông lúc xảy ra
  -- hoặc là kênh lẻ không gửi chuông riêng (D9 chống lặp).
  v_bell := (SELECT coalesce(jsonb_agg(l.value), '[]'::jsonb) FROM jsonb_array_elements(v_lines) l
              WHERE jsonb_array_length(l.value -> 'buildingIds') > 0);
  IF jsonb_array_length(v_pending) > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'SECTION', 'text', 'Từ bản tin trước:', 'buildingIds', '[]'::jsonb))
      || app_private.camera_alert_lines_v1(v_pending, v_tz, p_now, 'EVENT', p_monitored);
  END IF;

  IF jsonb_array_length(v_lines) = 0 THEN
    RETURN NULL;
  END IF;
  v_body := app_private.camera_alert_compose_v1('📋 Camera — bản tin sáng ' || to_char(v_date, 'DD/MM'), v_lines, NULL);
  SELECT array_agg(DISTINCT b.value #>> '{}') INTO v_ids
    FROM jsonb_array_elements(v_lines) l, jsonb_array_elements(l.value -> 'buildingIds') b;
  v_sent := app_private.camera_alert_send_zalo_v1(p_settings, p_shadow, 'DIGEST', v_body, v_ids,
    'DIGEST:' || v_org::text || ':' || v_date::text, true, p_now, '{}'::jsonb);
  PERFORM app_private.camera_alert_send_bell_v1(p_settings, p_shadow, 'DIGEST', v_bell,
    'IN_APP:DIGEST:' || v_org::text || ':' || v_date::text, p_now);
  IF NOT coalesce((v_sent ->> 'capped')::boolean, false) THEN
    UPDATE app_private.camera_alert_events e
       SET digest_state = 'DONE', digest_delivery_id = (v_sent ->> 'deliveryId')::uuid
     WHERE e.id = ANY(coalesce(v_digest_events, '{}'::uuid[]));
    PERFORM app_private.camera_alert_release_pending_v1(v_org, p_shadow, p_now, (v_sent ->> 'deliveryId')::uuid);
  END IF;
  RETURN v_sent;
END
$fn$;

-- -----------------------------------------------------------------------------
-- 8. Một lượt cho một org.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.camera_alert_evaluate_org_v1(
  p_settings app_private.camera_alert_settings, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_blocking constant text[] := ARRAY['CAMERA_RECORDER_OFFLINE', 'CAMERA_RECORDER_AUTH_DENIED', 'CAMERA_MONITOR_STALE'];
  c_dependent constant text[] := ARRAY['CAMERA_STORAGE_ERROR', 'CAMERA_CHANNEL_LOST', 'CAMERA_RECORDER_UNKNOWN'];
  c_grace constant integer := 90;
  c_fresh_min constant integer := 300;
  v_org uuid := p_settings.organization_id;
  v_live boolean := p_settings.mode = 'LIVE';
  v_shadow boolean := p_settings.mode <> 'LIVE';
  v_baseline boolean := p_settings.baseline_pending;
  v_types jsonb := app_private.camera_alert_types_v1(p_settings.types);
  v_tz text := app_private.org_timezone_v1(p_settings.organization_id);
  v_local timestamp := p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id);
  v_local_date date;
  v_local_time time;
  v_in_night boolean;
  v_channel_threshold integer;
  rec record;
  obs record;
  cond app_private.camera_alert_conditions;
  inc public.network_incidents%ROWTYPE;
  v_found boolean;
  v_verdict text;
  v_route text;
  v_mute text;
  v_fresh boolean;
  v_stale_limit integer;
  v_age integer;
  v_maint boolean;
  v_blocked boolean;
  v_due boolean;
  v_ctx jsonb;
  v_cause jsonb;
  v_ev jsonb;
  v_events jsonb := '[]'::jsonb;
  v_due_subjects text[];
  v_configured integer;
  v_lost integer;
  v_severity text;
  v_monitored integer := 0;
  v_decision text;
  v_zalo_items jsonb := '[]'::jsonb;
  v_night_items jsonb := '[]'::jsonb;
  v_bell_items jsonb := '[]'::jsonb;
  v_suppressed jsonb := '[]'::jsonb;
  v_lines jsonb;
  v_body text;
  v_ids uuid[];
  v_sent jsonb;
  v_event_ids uuid[];
  v_known_ids jsonb;
  v_round text;
  v_n_opened integer := 0;
  v_n_resolved integer := 0;
  v_n_retired integer := 0;
  v_dispatch jsonb := '[]'::jsonb;
BEGIN
  v_local_date := v_local::date;
  v_local_time := v_local::time;
  v_in_night := CASE WHEN p_settings.night_start < p_settings.night_end
    THEN v_local_time >= p_settings.night_start AND v_local_time < p_settings.night_end
    ELSE v_local_time >= p_settings.night_start OR v_local_time < p_settings.night_end END;
  v_channel_threshold := app_private.camera_alert_threshold_v1(v_types, 'CAMERA_CHANNEL_LOST');
  v_round := v_org::text || ':' || floor(extract(epoch FROM p_now))::bigint::text;

  -- Tạm ẩn hết hạn: tự theo dõi lại (spec §3.1).
  DELETE FROM app_private.camera_alert_channel_mutes m
   WHERE m.organization_id = v_org AND m.kind = 'SNOOZE' AND m.until_at <= p_now;

  FOR rec IN
    SELECT r.id, r.organization_id, r.building_id, r.display_name, r.enabled, r.channel_count,
      r.stale_after_seconds, r.created_at, bl.name AS building_name,
      (r.enabled AND bl.deleted_at IS NULL AND coalesce(s.monitoring_enabled, true)
        AND coalesce(n.is_enabled, true)) AS monitored,
      (d.id IS NOT NULL AND d.is_active AND d.device_kind = 'MIKROTIK'
        AND d.organization_id = r.organization_id AND d.building_id = r.building_id) AS device_ok,
      n.device_id, conn.poll_interval_seconds,
      cur.status, cur.checked_at, cur.received_at, cur.channels, cur.storage,
      (SELECT count(*) FROM public.camera_recorders r2 WHERE r2.building_id = r.building_id AND r2.enabled)::integer AS in_building
    FROM public.camera_recorders r
    JOIN public.buildings bl ON bl.id = r.building_id
    LEFT JOIN app_private.camera_recorder_connections conn ON conn.recorder_id = r.id
    LEFT JOIN public.network_device_connections n ON n.id = conn.router_connection_id
    LEFT JOIN public.network_devices d ON d.id = n.device_id
    LEFT JOIN public.network_site_settings s
      ON s.organization_id = r.organization_id AND s.building_id = r.building_id
    LEFT JOIN public.camera_recorder_current cur ON cur.recorder_id = r.id
    WHERE r.organization_id = v_org
    ORDER BY r.id
  LOOP
    -- Đầu ghi bị tắt theo dõi: không xét, đóng lặng mọi sự cố (DISABLED).
    IF NOT rec.monitored THEN
      FOR cond IN SELECT * FROM app_private.camera_alert_conditions c WHERE c.recorder_id = rec.id FOR UPDATE LOOP
        PERFORM app_private.camera_alert_retire_v1(cond, 'DISABLED', p_now);
        v_n_retired := v_n_retired + 1;
      END LOOP;
      CONTINUE;
    END IF;
    -- Router của connection đã gỡ: device_id NOT NULL nên không mở được sự cố.
    IF NOT rec.device_ok THEN
      FOR cond IN SELECT * FROM app_private.camera_alert_conditions c WHERE c.recorder_id = rec.id FOR UPDATE LOOP
        PERFORM app_private.camera_alert_retire_v1(cond, 'ROUTER_UNAVAILABLE', p_now);
        v_n_retired := v_n_retired + 1;
      END LOOP;
      CONTINUE;
    END IF;
    v_monitored := v_monitored + 1;

    -- Độ mới: lần muộn hơn giữa giờ đo và giờ CRM nhận (đồng hồ VPS chậm không
    -- được biến mọi đầu ghi thành mất dữ liệu); không nhỏ hơn 5 phút, hạn cũ của
    -- đầu ghi và hai chu kỳ poll.
    v_stale_limit := greatest(rec.stale_after_seconds, c_fresh_min, 2 * coalesce(rec.poll_interval_seconds, 60));
    v_age := CASE WHEN rec.checked_at IS NULL THEN floor(extract(epoch FROM p_now - rec.created_at))::integer
                  ELSE floor(extract(epoch FROM p_now - greatest(rec.checked_at, rec.received_at)))::integer END;
    v_fresh := rec.checked_at IS NOT NULL AND v_age < v_stale_limit;
    v_maint := EXISTS (
      SELECT 1 FROM public.network_maintenance_windows w
       WHERE w.organization_id = rec.organization_id AND w.building_id = rec.building_id
         AND w.status IN ('SCHEDULED', 'ACTIVE') AND w.starts_at <= p_now AND w.ends_at > p_now);
    v_blocked := NULL;
    v_ctx := jsonb_build_object('recorderName', rec.display_name, 'buildingName', rec.building_name,
      'recordersInBuilding', greatest(rec.in_building, 1), 'maintenance', v_maint, 'baseline', v_baseline);

    FOR obs IN
      SELECT x.ord, x.subject, x.code, x.verdict, x.detail FROM (
        SELECT 1 AS ord, 'monitor'::text AS subject, 'CAMERA_MONITOR_STALE'::text AS code,
          CASE WHEN rec.checked_at IS NULL THEN
                 CASE WHEN v_age >= v_stale_limit THEN 'BAD' ELSE 'HOLD' END
               WHEN v_fresh THEN 'GOOD' ELSE 'BAD' END AS verdict,
          jsonb_build_object('checkedAt', rec.checked_at, 'staleAfterSeconds', v_stale_limit) AS detail
        UNION ALL
        -- C2 đang MỞ thì hết khi đầu ghi kết nối lại được (kể cả UNKNOWN /
        -- AUTH_DENIED); chưa mở thì chỉ ONLINE mới xoá bộ đếm (plan 01/11 §4.2).
        SELECT 2, 'recorder:offline', 'CAMERA_RECORDER_OFFLINE',
          CASE WHEN NOT v_fresh THEN 'HOLD' WHEN rec.status = 'OFFLINE' THEN 'BAD'
               WHEN rec.status = 'ONLINE' THEN 'GOOD'
               WHEN rec.status IN ('UNKNOWN', 'AUTH_DENIED') THEN 'GOOD_IF_OPEN' ELSE 'HOLD' END,
          jsonb_build_object('status', rec.status)
        UNION ALL
        SELECT 3, 'recorder:auth', 'CAMERA_RECORDER_AUTH_DENIED',
          CASE WHEN NOT v_fresh THEN 'HOLD' WHEN rec.status = 'AUTH_DENIED' THEN 'BAD'
               WHEN rec.status = 'ONLINE' THEN 'GOOD'
               WHEN rec.status = 'UNKNOWN' THEN 'GOOD_IF_OPEN' ELSE 'HOLD' END,
          jsonb_build_object('status', rec.status)
        UNION ALL
        SELECT 4, 'recorder:unknown', 'CAMERA_RECORDER_UNKNOWN',
          CASE WHEN NOT v_fresh THEN 'HOLD' WHEN rec.status = 'UNKNOWN' THEN 'BAD'
               WHEN rec.status = 'ONLINE' THEN 'GOOD' ELSE 'HOLD' END,
          jsonb_build_object('status', rec.status)
        UNION ALL
        -- B1: ổ lỗi / kênh mất thì đầu ghi VẪN ONLINE ⇒ đọc từng phần tử.
        -- B2: đầu ghi khác ONLINE thì server ép kênh/ổ thành UNKNOWN ⇒ HOLD.
        SELECT 5, 'storage:' || (disk.value ->> 'slot'), 'CAMERA_STORAGE_ERROR',
          CASE WHEN NOT v_fresh OR rec.status IS DISTINCT FROM 'ONLINE' THEN 'HOLD'
               WHEN disk.value ->> 'state' = 'ERROR' THEN 'BAD'
               WHEN disk.value ->> 'state' = 'NORMAL' THEN 'GOOD' ELSE 'HOLD' END,
          jsonb_build_object('slot', (disk.value ->> 'slot')::integer, 'state', disk.value ->> 'state')
        FROM jsonb_array_elements(coalesce(rec.storage, '[]'::jsonb)) disk
        UNION ALL
        SELECT 6, 'channel:' || (ch.value ->> 'channel'), 'CAMERA_CHANNEL_LOST',
          CASE WHEN NOT v_fresh OR rec.status IS DISTINCT FROM 'ONLINE' THEN 'HOLD'
               WHEN ch.value ->> 'state' = 'DISCONNECTED' THEN 'BAD'
               WHEN ch.value ->> 'state' IN ('CONNECTED', 'EMPTY') THEN 'GOOD' ELSE 'HOLD' END,
          jsonb_build_object('channel', (ch.value ->> 'channel')::integer,
            'channelName', ch.value ->> 'name', 'state', ch.value ->> 'state')
        FROM jsonb_array_elements(coalesce(rec.channels, '[]'::jsonb)) ch
        UNION ALL
        -- Ổ/kênh đang theo dõi mà không còn trong snapshot.
        SELECT CASE WHEN c.subject LIKE 'storage:%' THEN 5 ELSE 6 END, c.subject, c.condition_code,
          CASE WHEN v_fresh AND rec.status = 'ONLINE' THEN 'GOOD' ELSE 'HOLD' END, c.observed
        FROM app_private.camera_alert_conditions c
        WHERE c.recorder_id = rec.id
          AND (c.subject LIKE 'storage:%' OR c.subject LIKE 'channel:%')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(rec.storage, '[]'::jsonb)) d2
                           WHERE 'storage:' || (d2.value ->> 'slot') = c.subject)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(rec.channels, '[]'::jsonb)) c2
                           WHERE 'channel:' || (c2.value ->> 'channel') = c.subject)
      ) x
      ORDER BY x.ord, x.subject
    LOOP
      SELECT * INTO cond FROM app_private.camera_alert_conditions c
       WHERE c.recorder_id = rec.id AND c.subject = obs.subject FOR UPDATE;
      v_found := FOUND;

      -- Loại bị tắt: không theo dõi, đóng lặng.
      v_route := app_private.camera_alert_route_v1(v_types, obs.code);
      IF v_route = 'DISABLED' THEN
        IF v_found THEN
          PERFORM app_private.camera_alert_retire_v1(cond, 'TYPE_DISABLED', p_now);
          v_n_retired := v_n_retired + 1;
        END IF;
        CONTINUE;
      END IF;
      -- Kênh tắt báo IGNORE/SNOOZE: bỏ hẳn (spec §3.1).
      v_mute := NULL;
      IF obs.code = 'CAMERA_CHANNEL_LOST' THEN
        SELECT m.kind INTO v_mute FROM app_private.camera_alert_channel_mutes m
         WHERE m.recorder_id = rec.id AND 'channel:' || m.channel = obs.subject
           AND (m.kind <> 'SNOOZE' OR m.until_at > p_now);
        IF v_mute IN ('IGNORE', 'SNOOZE') THEN
          IF v_found THEN
            PERFORM app_private.camera_alert_retire_v1(cond, 'MUTED', p_now);
            v_n_retired := v_n_retired + 1;
          END IF;
          CONTINUE;
        END IF;
      END IF;

      -- Loại trừ B2: C2/C3/C4 đang mở thì không mở, không giữ C1/C5/C6.
      IF obs.ord >= 4 AND v_blocked IS NULL THEN
        v_blocked := EXISTS (
          SELECT 1 FROM app_private.camera_alert_conditions c
           WHERE c.recorder_id = rec.id AND c.condition_code = ANY(c_blocking) AND c.opened_at IS NOT NULL);
        IF v_blocked THEN
          FOR cond IN
            SELECT * FROM app_private.camera_alert_conditions c
             WHERE c.recorder_id = rec.id AND c.condition_code = ANY(c_dependent) FOR UPDATE
          LOOP
            PERFORM app_private.camera_alert_retire_v1(cond, 'SUPERSEDED', p_now);
            v_n_retired := v_n_retired + 1;
          END LOOP;
        END IF;
        SELECT * INTO cond FROM app_private.camera_alert_conditions c
         WHERE c.recorder_id = rec.id AND c.subject = obs.subject FOR UPDATE;
        v_found := FOUND;
      END IF;
      CONTINUE WHEN obs.ord >= 4 AND v_blocked;

      v_verdict := CASE WHEN obs.verdict = 'GOOD_IF_OPEN'
        THEN CASE WHEN v_found AND cond.opened_at IS NOT NULL THEN 'GOOD' ELSE 'HOLD' END
        ELSE obs.verdict END;
      v_ctx := v_ctx || jsonb_build_object('knownBroken', coalesce(v_mute = 'KNOWN_BROKEN', false));

      IF v_verdict = 'BAD' THEN
        IF NOT v_found THEN
          INSERT INTO app_private.camera_alert_conditions (
            recorder_id, subject, organization_id, building_id, condition_code, severity,
            first_seen_at, last_seen_at, observed)
          VALUES (rec.id, obs.subject, rec.organization_id, rec.building_id, obs.code,
            CASE WHEN obs.code IN ('CAMERA_CHANNEL_LOST', 'CAMERA_RECORDER_UNKNOWN') THEN 'WARNING' ELSE 'CRITICAL' END,
            p_now, p_now, obs.detail)
          RETURNING * INTO cond;
        ELSE
          UPDATE app_private.camera_alert_conditions c
             SET last_seen_at = greatest(c.last_seen_at, p_now),
                 -- Lượt bị gián đoạn: chưa vượt ngưỡng thì đếm lại, không coi là liên tục.
                 first_seen_at = CASE WHEN c.opened_at IS NULL AND c.last_seen_at < p_now - interval '15 minutes'
                                      THEN p_now ELSE c.first_seen_at END,
                 clear_streak = 0,
                 recovering_at = NULL,
                 observed = obs.detail
           WHERE c.recorder_id = rec.id AND c.subject = obs.subject
          RETURNING * INTO cond;

          IF cond.incident_id IS NOT NULL THEN
            SELECT * INTO inc FROM public.network_incidents i WHERE i.id = cond.incident_id;
            IF NOT FOUND OR inc.status = 'RESOLVED' THEN
              -- Sự cố bị đóng ngoài bộ này mà lỗi vẫn còn: mở lại ở dưới.
              UPDATE app_private.camera_alert_conditions c SET incident_id = NULL, opened_at = NULL
               WHERE c.recorder_id = rec.id AND c.subject = obs.subject
              RETURNING * INTO cond;
            ELSE
              IF inc.status = 'RECOVERING' THEN
                PERFORM app_private.camera_alert_transition_v1(inc.id, 'RELAPSE', p_now, '{}'::jsonb);
              END IF;
              -- Mở trong bảo trì thì chưa báo; hết bảo trì mà lỗi còn thì báo một lần.
              IF coalesce((inc.observed_values ->> 'maintenance')::boolean, false) AND NOT v_maint THEN
                UPDATE public.network_incidents i
                   SET observed_values = i.observed_values || jsonb_build_object('maintenance', false),
                       version = i.version + 1
                 WHERE i.id = inc.id;
                v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                  'OPENED', cond, inc.id, v_ctx || jsonb_build_object('maintenance', false, 'baseline', false), p_now));
              END IF;
            END IF;
          END IF;
        END IF;

        -- Kênh mất mở ở bước gom bên dưới để tính mức theo tỷ lệ kênh.
        IF obs.code <> 'CAMERA_CHANNEL_LOST' THEN
          v_due := CASE WHEN v_live
            THEN cond.incident_id IS NULL AND (cond.opened_at IS NOT NULL OR v_baseline
              OR CASE WHEN obs.code = 'CAMERA_MONITOR_STALE'
                   -- Ngưỡng của mất dữ liệu tính theo tuổi dữ liệu, cộng một
                   -- khoảng chờ 90 s kể từ lượt đầu thấy cũ (bật lại theo dõi
                   -- một đầu ghi còn snapshot cũ không thành CRITICAL giả).
                   THEN v_age >= app_private.camera_alert_threshold_v1(v_types, obs.code)
                        AND p_now - cond.first_seen_at >= make_interval(secs => c_grace)
                   ELSE p_now - cond.first_seen_at >= make_interval(secs => app_private.camera_alert_threshold_v1(v_types, obs.code)) END)
            ELSE cond.opened_at IS NULL AND (v_baseline
              OR CASE WHEN obs.code = 'CAMERA_MONITOR_STALE'
                   THEN v_age >= app_private.camera_alert_threshold_v1(v_types, obs.code)
                        AND p_now - cond.first_seen_at >= make_interval(secs => c_grace)
                   ELSE p_now - cond.first_seen_at >= make_interval(secs => app_private.camera_alert_threshold_v1(v_types, obs.code)) END)
          END;
          IF v_due THEN
            v_cause := '{}'::jsonb;
            IF obs.code = 'CAMERA_RECORDER_OFFLINE' THEN
              v_cause := app_private.camera_alert_router_cause_v1(rec.organization_id, rec.building_id, rec.device_id, cond.first_seen_at);
            END IF;
            v_ev := app_private.camera_alert_open_v1(cond, cond.severity, v_live, rec.device_id,
              v_ctx || v_cause, app_private.camera_alert_threshold_v1(v_types, obs.code), v_tz, p_now);
            IF v_ev IS NOT NULL THEN
              v_events := v_events || jsonb_build_array(v_ev);
              v_n_opened := v_n_opened + 1;
            END IF;
          END IF;
        END IF;

      ELSIF v_verdict = 'GOOD' THEN
        IF v_found THEN
          IF cond.opened_at IS NULL THEN
            -- Chưa vượt ngưỡng (rớt vài giây): bỏ, không báo gì.
            DELETE FROM app_private.camera_alert_conditions c
             WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
          ELSIF cond.clear_streak + 1 >= 2 THEN
            -- Lượt tốt thứ hai liên tiếp: đóng hẳn.
            IF cond.incident_id IS NOT NULL THEN
              IF app_private.camera_alert_transition_v1(cond.incident_id, 'RESOLVED', p_now,
                   jsonb_build_object('reason', 'RECOVERED')) THEN
                v_n_resolved := v_n_resolved + 1;
                v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                  'RESOLVED', cond, cond.incident_id, v_ctx, p_now));
              END IF;
            ELSIF v_shadow THEN
              v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                'RESOLVED', cond, NULL, v_ctx, p_now));
            END IF;
            -- Kênh "đã biết hỏng" có lại: ghi "đã sửa" vào bản tin, tự xoá dấu.
            IF v_mute = 'KNOWN_BROKEN' AND (cond.incident_id IS NOT NULL OR v_shadow) THEN
              v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                'FIXED', cond, cond.incident_id, v_ctx, p_now));
              IF v_live THEN
                DELETE FROM app_private.camera_alert_channel_mutes m
                 WHERE m.recorder_id = rec.id AND 'channel:' || m.channel = obs.subject AND m.kind = 'KNOWN_BROKEN';
              END IF;
            END IF;
            DELETE FROM app_private.camera_alert_conditions c
             WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
          ELSE
            -- Lượt tốt đầu tiên: RECOVERING, chưa báo.
            UPDATE app_private.camera_alert_conditions c
               SET clear_streak = c.clear_streak + 1, recovering_at = coalesce(c.recovering_at, p_now)
             WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
            IF cond.incident_id IS NOT NULL THEN
              PERFORM app_private.camera_alert_transition_v1(cond.incident_id, 'RECOVERING', p_now, '{}'::jsonb);
            END IF;
          END IF;
        END IF;

      ELSE
        -- HOLD: không có bằng chứng tốt hay xấu ⇒ không đếm lượt khôi phục.
        IF v_found AND cond.clear_streak <> 0 THEN
          UPDATE app_private.camera_alert_conditions c SET clear_streak = 0, recovering_at = NULL
           WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
        END IF;
      END IF;
    END LOOP;

    -- C5: mở kênh vừa đủ ngưỡng. Mức theo tỷ lệ kênh cùng mất trên số kênh đang
    -- theo dõi (≥ 50 % ⇒ CRITICAL). Kênh IGNORE/SNOOZE/KNOWN_BROKEN không tính.
    IF NOT coalesce(v_blocked, false) AND app_private.camera_alert_route_v1(v_types, 'CAMERA_CHANNEL_LOST') <> 'DISABLED' THEN
      SELECT coalesce(array_agg(c.subject ORDER BY c.subject), '{}'::text[]) INTO v_due_subjects
        FROM app_private.camera_alert_conditions c
       WHERE c.recorder_id = rec.id AND c.condition_code = 'CAMERA_CHANNEL_LOST'
         AND c.last_seen_at = p_now
         AND CASE WHEN v_live
               THEN c.incident_id IS NULL AND (c.opened_at IS NOT NULL OR v_baseline
                 OR p_now - c.first_seen_at >= make_interval(secs => v_channel_threshold))
               ELSE c.opened_at IS NULL AND (v_baseline OR p_now - c.first_seen_at >= make_interval(secs => v_channel_threshold))
             END;
      SELECT count(*) INTO v_configured
        FROM jsonb_array_elements(coalesce(rec.channels, '[]'::jsonb)) ch
       WHERE ch.value ->> 'state' IN ('CONNECTED', 'DISCONNECTED')
         AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_channel_mutes m
                          WHERE m.recorder_id = rec.id AND m.channel = (ch.value ->> 'channel')::integer
                            AND (m.kind <> 'SNOOZE' OR m.until_at > p_now));
      SELECT count(*) INTO v_lost
        FROM app_private.camera_alert_conditions c
       WHERE c.recorder_id = rec.id AND c.condition_code = 'CAMERA_CHANNEL_LOST'
         AND c.last_seen_at = p_now AND c.clear_streak = 0
         AND (c.opened_at IS NOT NULL OR c.subject = ANY(v_due_subjects))
         AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_channel_mutes m
                          WHERE m.recorder_id = rec.id AND 'channel:' || m.channel = c.subject);
      v_severity := CASE WHEN v_configured > 0 AND v_lost * 2 >= v_configured THEN 'CRITICAL' ELSE 'WARNING' END;

      FOR cond IN
        SELECT * FROM app_private.camera_alert_conditions c
         WHERE c.recorder_id = rec.id AND c.subject = ANY(v_due_subjects)
         ORDER BY c.subject FOR UPDATE
      LOOP
        SELECT m.kind INTO v_mute FROM app_private.camera_alert_channel_mutes m
         WHERE m.recorder_id = rec.id AND 'channel:' || m.channel = cond.subject;
        v_ev := app_private.camera_alert_open_v1(cond,
          CASE WHEN v_mute = 'KNOWN_BROKEN' THEN 'WARNING' ELSE v_severity END, v_live, rec.device_id,
          v_ctx || jsonb_build_object('knownBroken', v_mute IS NOT DISTINCT FROM 'KNOWN_BROKEN'),
          v_channel_threshold, v_tz, p_now);
        IF v_ev IS NOT NULL THEN
          v_events := v_events || jsonb_build_array(v_ev);
          v_n_opened := v_n_opened + 1;
        END IF;
      END LOOP;

      IF v_severity = 'CRITICAL' THEN
        FOR cond IN
          SELECT * FROM app_private.camera_alert_conditions c
           WHERE c.recorder_id = rec.id AND c.condition_code = 'CAMERA_CHANNEL_LOST'
             AND c.opened_at IS NOT NULL AND c.severity = 'WARNING'
             AND c.last_seen_at = p_now AND c.clear_streak = 0
             AND NOT (c.subject = ANY(v_due_subjects))
             AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_channel_mutes m
                              WHERE m.recorder_id = rec.id AND 'channel:' || m.channel = c.subject)
           ORDER BY c.subject FOR UPDATE
        LOOP
          UPDATE app_private.camera_alert_conditions c SET severity = 'CRITICAL'
           WHERE c.recorder_id = cond.recorder_id AND c.subject = cond.subject
          RETURNING * INTO cond;
          IF cond.incident_id IS NOT NULL THEN
            IF app_private.camera_alert_transition_v1(cond.incident_id, 'ESCALATE', p_now, '{}'::jsonb) THEN
              v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                'ESCALATED', cond, cond.incident_id, v_ctx || jsonb_build_object('knownBroken', false), p_now));
            END IF;
          ELSIF v_shadow THEN
            v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
              'ESCALATED', cond, NULL, v_ctx || jsonb_build_object('knownBroken', false), p_now));
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Quyết định từng mục (spec §3.3–§3.5, D3, D6).
  -- ---------------------------------------------------------------------------
  FOR v_ev IN SELECT value FROM jsonb_array_elements(v_events) LOOP
    v_route := CASE WHEN v_ev ->> 'kind' IN ('RESOLVED', 'FIXED')
                    THEN coalesce(v_ev ->> 'openRoute', app_private.camera_alert_route_v1(v_types, v_ev ->> 'code'))
                    ELSE app_private.camera_alert_route_v1(v_types, v_ev ->> 'code') END;
    IF v_route NOT IN ('ZALO', 'DIGEST', 'BELL', 'OFF') THEN v_route := 'OFF'; END IF;
    IF v_ev ->> 'kind' = 'OPENED' THEN
      v_decision := CASE
        WHEN v_route = 'OFF' THEN 'OFF'
        WHEN (v_ev ->> 'maintenance')::boolean THEN 'MAINTENANCE'
        WHEN (v_ev ->> 'knownBroken')::boolean THEN 'KNOWN_BROKEN'
        WHEN (v_ev ->> 'baseline')::boolean THEN 'BASELINE'
        WHEN EXISTS (
          SELECT 1 FROM app_private.camera_alert_events e
           WHERE e.organization_id = v_org AND e.fingerprint = v_ev ->> 'fingerprint' AND e.kind = 'OPENED'
             AND e.shadow = v_shadow AND e.decision IN ('ZALO', 'NIGHT', 'DIGEST', 'BELL', 'BASELINE')
             AND e.occurred_at > p_now - interval '24 hours' AND e.occurred_at < p_now) THEN 'REPEAT_24H'
        WHEN v_route = 'BELL' THEN 'BELL'
        WHEN v_route = 'DIGEST' THEN 'DIGEST'
        WHEN v_ev ->> 'severity' <> 'CRITICAL' AND v_in_night THEN 'NIGHT'
        ELSE 'ZALO' END;
      UPDATE app_private.camera_alert_conditions c
         SET announced = v_decision IN ('ZALO', 'NIGHT', 'DIGEST', 'BELL')
                         OR (v_decision = 'BASELINE' AND v_route IN ('ZALO', 'DIGEST')),
             open_route = v_route
       WHERE c.recorder_id = (v_ev ->> 'recorderId')::uuid AND c.subject = v_ev ->> 'subject';
    ELSIF v_ev ->> 'kind' = 'ESCALATED' THEN
      v_decision := CASE
        WHEN NOT coalesce((v_ev ->> 'announced')::boolean, false) OR (v_ev ->> 'knownBroken')::boolean
          OR (v_ev ->> 'maintenance')::boolean THEN 'SILENT'
        WHEN v_route = 'OFF' THEN 'OFF'
        WHEN v_route = 'ZALO' THEN 'ZALO'
        ELSE 'BELL' END;
    ELSIF v_ev ->> 'kind' = 'FIXED' THEN
      v_decision := CASE WHEN v_route IN ('ZALO', 'DIGEST') THEN 'DIGEST' WHEN v_route = 'OFF' THEN 'OFF' ELSE 'SILENT' END;
    ELSE
      -- Khôi phục: chỉ khi lần mở đã được báo; Zalo chỉ cho CRITICAL (D6), kênh
      -- lẻ khôi phục vào bản tin sáng.
      v_decision := CASE
        WHEN NOT coalesce((v_ev ->> 'announced')::boolean, false) OR (v_ev ->> 'knownBroken')::boolean THEN 'SILENT'
        WHEN (v_ev ->> 'maintenance')::boolean THEN 'MAINTENANCE'
        WHEN v_route = 'OFF' THEN 'OFF'
        WHEN v_ev ->> 'severity' = 'CRITICAL' THEN v_route
        WHEN v_route IN ('ZALO', 'DIGEST') THEN 'DIGEST'
        ELSE 'SILENT' END;
    END IF;
    v_ev := v_ev || jsonb_build_object('decision', v_decision, 'route', v_route,
      'eventId', gen_random_uuid());
    INSERT INTO app_private.camera_alert_events (
      id, organization_id, building_id, recorder_id, subject, fingerprint, incident_id, code, severity,
      kind, route, decision, shadow, payload, occurred_at, digest_state)
    VALUES ((v_ev ->> 'eventId')::uuid, v_org, (v_ev ->> 'buildingId')::uuid, (v_ev ->> 'recorderId')::uuid,
      v_ev ->> 'subject', v_ev ->> 'fingerprint', nullif(v_ev ->> 'incidentId', '')::uuid, v_ev ->> 'code',
      coalesce(v_ev ->> 'severity', 'WARNING'), v_ev ->> 'kind', v_route, v_decision, v_shadow,
      v_ev - 'decision' - 'route' - 'eventId', p_now,
      CASE WHEN v_decision = 'DIGEST' THEN 'PENDING' END);

    IF v_decision = 'ZALO' THEN v_zalo_items := v_zalo_items || jsonb_build_array(v_ev); END IF;
    IF v_decision = 'NIGHT' THEN v_night_items := v_night_items || jsonb_build_array(v_ev); END IF;
    IF v_decision = 'REPEAT_24H' THEN v_suppressed := v_suppressed || jsonb_build_array(v_ev); END IF;
    IF (v_ev ->> 'kind' IN ('OPENED', 'ESCALATED') AND v_decision IN ('ZALO', 'NIGHT', 'DIGEST', 'BELL'))
       OR (v_ev ->> 'kind' = 'RESOLVED' AND v_ev ->> 'severity' = 'CRITICAL' AND v_decision IN ('ZALO', 'DIGEST', 'BELL')) THEN
      v_bell_items := v_bell_items || jsonb_build_array(v_ev);
    END IF;
  END LOOP;

  -- Mục bị chặn lặp: mỗi mục một dòng sổ, không gửi.
  FOR v_ev IN SELECT value FROM jsonb_array_elements(v_suppressed) LOOP
    v_lines := app_private.camera_alert_lines_v1(jsonb_build_array(v_ev), v_tz, p_now, 'EVENT', v_monitored);
    INSERT INTO app_private.camera_alert_deliveries (
      organization_id, kind, channel, shadow, status, reason, body, building_ids, dedup_key, local_date, result, created_at)
    VALUES (v_org, 'OPENED', CASE WHEN v_ev ->> 'route' IN ('ZALO', 'DIGEST') THEN 'ZALO' ELSE 'IN_APP' END, v_shadow,
      CASE WHEN v_shadow THEN 'SHADOW' ELSE 'SUPPRESSED' END, 'REPEAT_24H',
      left(coalesce(v_lines -> 0 ->> 'text', v_ev ->> 'code'), 6000), ARRAY[(v_ev ->> 'buildingId')::uuid],
      CASE WHEN v_shadow THEN 'SHADOW:' ELSE '' END || 'REPEAT:' || (v_ev ->> 'eventId'), v_local_date,
      jsonb_build_object('eventId', v_ev ->> 'eventId', 'fingerprint', v_ev ->> 'fingerprint'), p_now);
  END LOOP;

  -- Tin của lượt: tối đa MỘT tin Zalo cho nhóm (spec §3.3).
  IF jsonb_array_length(v_zalo_items) > 0 THEN
    v_lines := app_private.camera_alert_lines_v1(v_zalo_items, v_tz, p_now, 'EVENT', v_monitored);
    v_body := app_private.camera_alert_compose_v1(
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l.value ->> 'kind' <> 'RESOLVED')
        THEN '⚠ Camera — ' || (SELECT count(*) FROM jsonb_array_elements(v_lines) l WHERE l.value ->> 'kind' <> 'RESOLVED') || ' sự cố mới'
          || CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l.value ->> 'kind' = 'RESOLVED')
               THEN ', ' || (SELECT count(*) FROM jsonb_array_elements(v_lines) l WHERE l.value ->> 'kind' = 'RESOLVED') || ' đã khôi phục' ELSE '' END
        ELSE '✅ Camera — ' || jsonb_array_length(v_lines) || ' sự cố đã khôi phục' END,
      v_lines,
      CASE WHEN v_lines -> 0 ->> 'kind' = 'RESOLVED' THEN '✅' ELSE '⚠' END);
    SELECT array_agg(DISTINCT (x.value ->> 'buildingId')::uuid), array_agg((x.value ->> 'eventId')::uuid)
      INTO v_ids, v_event_ids FROM jsonb_array_elements(v_zalo_items) x;
    v_sent := app_private.camera_alert_send_zalo_v1(p_settings, v_shadow,
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_zalo_items) x WHERE x.value ->> 'kind' <> 'RESOLVED') THEN 'OPENED' ELSE 'RESOLVED' END,
      v_body, v_ids, 'ROUND:' || v_round, true, p_now, jsonb_build_object('eventIds', to_jsonb(v_event_ids)));
    UPDATE app_private.camera_alert_events e SET delivery_id = (v_sent ->> 'deliveryId')::uuid
     WHERE e.id = ANY(v_event_ids);
    v_dispatch := v_dispatch || jsonb_build_array(v_sent || jsonb_build_object('kind', 'ROUND'));
  END IF;

  -- Mục ban đêm: một dòng DEFERRED chờ tin 07:00 (D3).
  IF jsonb_array_length(v_night_items) > 0 THEN
    v_lines := app_private.camera_alert_lines_v1(v_night_items, v_tz, p_now, 'EVENT', v_monitored);
    SELECT array_agg(DISTINCT (x.value ->> 'buildingId')::uuid), array_agg((x.value ->> 'eventId')::uuid)
      INTO v_ids, v_event_ids FROM jsonb_array_elements(v_night_items) x;
    INSERT INTO app_private.camera_alert_deliveries (
      organization_id, kind, channel, shadow, status, reason, body, building_ids, dedup_key, local_date,
      pending_release, zalo_account_id, zalo_conversation_id, result, created_at)
    VALUES (v_org, 'OPENED', 'ZALO', v_shadow, CASE WHEN v_shadow THEN 'SHADOW' ELSE 'DEFERRED' END, 'NIGHT',
      app_private.camera_alert_compose_v1('🌙 Dồn tin 07:00', v_lines, NULL), v_ids,
      CASE WHEN v_shadow THEN 'SHADOW:' ELSE '' END || 'NIGHT:' || v_round, v_local_date, true,
      p_settings.zalo_account_id, p_settings.zalo_conversation_id,
      jsonb_build_object('eventIds', to_jsonb(v_event_ids)), p_now)
    RETURNING jsonb_build_object('deliveryId', id) INTO v_sent;
    UPDATE app_private.camera_alert_events e SET delivery_id = (v_sent ->> 'deliveryId')::uuid
     WHERE e.id = ANY(v_event_ids);
  END IF;

  -- Chuông: một thông báo mỗi người cho cả lượt (D9), không theo giờ đêm/trần.
  IF jsonb_array_length(v_bell_items) > 0 THEN
    PERFORM app_private.camera_alert_send_bell_v1(p_settings, v_shadow,
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_bell_items) x WHERE x.value ->> 'kind' <> 'RESOLVED') THEN 'OPENED' ELSE 'RESOLVED' END,
      app_private.camera_alert_lines_v1(v_bell_items, v_tz, p_now, 'EVENT', v_monitored),
      'IN_APP:ROUND:' || v_round, p_now);
  END IF;

  -- Tin hiện trạng khi bật (spec §3.2): MỘT tin, mọi điều kiện xấu đang có.
  IF v_baseline THEN
    -- Mọi điều kiện đã mở (kể cả từ trước), trừ kênh "đã biết hỏng" (ghi riêng
    -- một dòng bên dưới). Nguyên nhân của "không gọi tới được" lấy từ mục mở.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'kind', 'OPENED', 'code', c.condition_code, 'severity', c.severity,
             'buildingId', c.building_id, 'buildingName', b.name,
             'recorderId', c.recorder_id, 'recorderName', r.display_name,
             'recordersInBuilding', greatest((SELECT count(*) FROM public.camera_recorders r2 WHERE r2.building_id = c.building_id AND r2.enabled), 1),
             'channel', c.observed -> 'channel', 'channelName', c.observed -> 'channelName', 'slot', c.observed -> 'slot',
             'lastDataAt', c.observed -> 'checkedAt', 'firstSeenAt', c.first_seen_at, 'at', p_now,
             'cause', coalesce(ev.payload ->> 'cause', 'UNKNOWN'), 'causeAt', ev.payload -> 'causeAt')
             ORDER BY b.name, c.recorder_id, c.subject), '[]'::jsonb)
      INTO v_zalo_items
      FROM app_private.camera_alert_conditions c
      JOIN public.camera_recorders r ON r.id = c.recorder_id
      JOIN public.buildings b ON b.id = c.building_id
      LEFT JOIN LATERAL (
        SELECT e.payload FROM app_private.camera_alert_events e
         WHERE e.organization_id = v_org AND e.fingerprint = 'camera:' || c.recorder_id::text || ':' || c.subject
           AND e.kind = 'OPENED' AND e.shadow = v_shadow
         ORDER BY e.occurred_at DESC LIMIT 1) ev ON true
     WHERE c.organization_id = v_org AND c.opened_at IS NOT NULL
       AND app_private.camera_alert_route_v1(v_types, c.condition_code) IN ('ZALO', 'DIGEST')
       AND NOT EXISTS (
         SELECT 1 FROM app_private.camera_alert_channel_mutes m
          WHERE m.recorder_id = c.recorder_id AND 'channel:' || m.channel = c.subject AND m.kind = 'KNOWN_BROKEN');
    v_lines := app_private.camera_alert_lines_v1(v_zalo_items, v_tz, p_now, 'BASELINE', v_monitored);
    IF jsonb_array_length(v_lines) = 0 THEN
      v_lines := jsonb_build_array(jsonb_build_object('kind', 'SECTION', 'buildingIds', '[]'::jsonb,
        'text', '• Không có sự cố nào đang mở (' || v_monitored || ' đầu ghi đang theo dõi).'));
    END IF;
    -- Dòng này nêu tên toà ⇒ mang đủ id toà để sổ gửi chỉ hiện cho người xem
    -- được mọi toà đó.
    SELECT string_agg(y.line, '; ' ORDER BY y.line), jsonb_agg(DISTINCT y.building_id)
      INTO v_body, v_known_ids
      FROM (
        SELECT x.building_id, x.building_name || ' ' || string_agg(x.part, '; ' ORDER BY x.recorder_name) AS line
          FROM (
            SELECT b.name AS building_name, m.building_id, r.display_name AS recorder_name,
                   CASE WHEN (SELECT count(*) FROM public.camera_recorders r2 WHERE r2.building_id = m.building_id AND r2.enabled) > 1
                        THEN 'đầu ghi "' || r.display_name || '" ' ELSE '' END
                   || 'kênh ' || string_agg(m.channel::text, ', ' ORDER BY m.channel) AS part
              FROM app_private.camera_alert_channel_mutes m
              JOIN public.camera_recorders r ON r.id = m.recorder_id AND r.enabled
              JOIN public.buildings b ON b.id = m.building_id
             WHERE m.organization_id = v_org AND m.kind = 'KNOWN_BROKEN'
               AND app_private.camera_alert_route_v1(v_types, 'CAMERA_CHANNEL_LOST') IN ('ZALO', 'DIGEST')
             GROUP BY b.name, m.building_id, r.id, r.display_name
          ) x
         GROUP BY x.building_name, x.building_id
      ) y;
    IF v_body IS NOT NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'SECTION', 'buildingIds', v_known_ids,
        'text', 'Đã biết hỏng (nhắc thứ Hai): ' || v_body || '.'));
    END IF;
    SELECT array_agg(DISTINCT b.value #>> '{}') INTO v_ids
      FROM jsonb_array_elements(v_lines) l, jsonb_array_elements(l.value -> 'buildingIds') b;
    v_body := app_private.camera_alert_compose_v1(
      '📋 Hiện trạng camera lúc bật cảnh báo (' || to_char(v_local, 'DD/MM HH24:MI') || ')', v_lines, NULL);
    v_sent := app_private.camera_alert_send_zalo_v1(p_settings, v_shadow, 'BASELINE', v_body, v_ids,
      'BASELINE:' || v_org::text || ':' || floor(extract(epoch FROM coalesce(p_settings.live_since, p_now)))::bigint::text
        || ':' || p_settings.version::text,
      false, p_now, '{}'::jsonb);
    v_dispatch := v_dispatch || jsonb_build_array(v_sent || jsonb_build_object('kind', 'BASELINE'));
  END IF;

  -- Bản tin 07:00 (night_end) và 08:00 (digest_at), mỗi ngày một lần.
  IF p_settings.last_night_digest_on IS DISTINCT FROM v_local_date
     AND v_local >= v_local_date + p_settings.night_end
     AND v_local < v_local_date + p_settings.night_end + interval '1 hour' THEN
    v_sent := app_private.camera_alert_night_digest_v1(p_settings, v_shadow, p_now, v_monitored);
    IF v_sent IS NOT NULL THEN v_dispatch := v_dispatch || jsonb_build_array(v_sent || jsonb_build_object('kind', 'NIGHT_DIGEST')); END IF;
    UPDATE app_private.camera_alert_settings st SET last_night_digest_on = v_local_date WHERE st.organization_id = v_org;
  END IF;
  IF p_settings.last_digest_on IS DISTINCT FROM v_local_date
     AND v_local >= v_local_date + p_settings.digest_at
     AND v_local < v_local_date + p_settings.digest_at + interval '1 hour' THEN
    v_sent := app_private.camera_alert_morning_digest_v1(p_settings, v_shadow, p_now, v_monitored);
    IF v_sent IS NOT NULL THEN v_dispatch := v_dispatch || jsonb_build_array(v_sent || jsonb_build_object('kind', 'DIGEST')); END IF;
    UPDATE app_private.camera_alert_settings st SET last_digest_on = v_local_date WHERE st.organization_id = v_org;
  END IF;

  UPDATE app_private.camera_alert_settings st
     SET baseline_pending = false, last_evaluated_at = p_now
   WHERE st.organization_id = v_org;

  RETURN jsonb_build_object('organizationId', v_org, 'mode', p_settings.mode, 'baseline', v_baseline,
    'recorders', v_monitored, 'events', jsonb_array_length(v_events), 'opened', v_n_opened,
    'resolved', v_n_resolved, 'retired', v_n_retired, 'dispatch', v_dispatch);
END
$fn$;

-- -----------------------------------------------------------------------------
-- 9. Điểm vào của cron. Advisory lock riêng ⇒ không chạy chồng. p_now tiêm được
--    để kiểm thử; hàm không cấp cho vai nào ngoài owner.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.camera_alert_evaluate_v1(p_now timestamptz DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET lock_timeout TO '3s'
AS $fn$
DECLARE
  s app_private.camera_alert_settings;
  v_orgs jsonb := '[]'::jsonb;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'Invalid camera alert evaluation time' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(20261124171950::bigint) THEN
    RETURN jsonb_build_object('schemaVersion', 2, 'at', p_now, 'skipped', true, 'skipReason', 'CONCURRENT_RUN');
  END IF;
  FOR s IN
    SELECT * FROM app_private.camera_alert_settings st WHERE st.enabled ORDER BY st.organization_id FOR UPDATE
  LOOP
    -- Chạy lại cùng (hoặc lùi) mốc giờ: không làm gì (spec §8 mục 16).
    IF s.last_evaluated_at IS NOT NULL AND p_now <= s.last_evaluated_at THEN
      v_orgs := v_orgs || jsonb_build_array(jsonb_build_object('organizationId', s.organization_id, 'skipped', 'ALREADY_EVALUATED'));
      CONTINUE;
    END IF;
    -- Lỗi của một org (dữ liệu lạ, khoá chờ quá lâu) chỉ huỷ phần của org đó;
    -- org khác vẫn được đánh giá. Org lỗi giữ last_evaluated_at cũ ⇒ lượt sau thử lại.
    BEGIN
      v_orgs := v_orgs || jsonb_build_array(app_private.camera_alert_evaluate_org_v1(s, p_now));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'camera alert: organization % failed: % %', s.organization_id, SQLSTATE, SQLERRM;
      v_orgs := v_orgs || jsonb_build_array(jsonb_build_object('organizationId', s.organization_id,
        'error', left(SQLSTATE || ': ' || SQLERRM, 300)));
    END;
  END LOOP;
  RETURN jsonb_build_object('schemaVersion', 2, 'at', p_now, 'skipped', false, 'organizations', v_orgs);
END
$fn$;

COMMENT ON FUNCTION app_private.camera_alert_evaluate_v1(timestamptz) IS
  'Một lượt cảnh báo camera (pg_cron camera-alert-evaluate, */2). Org không có dòng camera_alert_settings enabled thì không làm gì.';

-- -----------------------------------------------------------------------------
-- 10. RPC cho trình duyệt.
-- -----------------------------------------------------------------------------
-- Cài đặt + trạng thái nơi nhận + số tin hôm nay. Không có dòng ⇒ mặc định, version 0.
CREATE OR REPLACE FUNCTION app_private.camera_alert_settings_view_v1(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  s app_private.camera_alert_settings;
  v_found boolean;
  v_date date := (clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(p_org))::date;
  v_account jsonb;
  v_conversation jsonb;
  v_warning text;
  v_sent integer;
  v_would integer;
BEGIN
  SELECT * INTO s FROM app_private.camera_alert_settings st WHERE st.organization_id = p_org;
  v_found := FOUND;
  IF NOT v_found THEN
    s.organization_id := p_org; s.enabled := false; s.mode := 'SHADOW';
    s.types := app_private.camera_alert_default_types_v1();
    s.night_start := '22:00'; s.night_end := '07:00'; s.digest_at := '08:00';
    s.daily_zalo_cap := 6; s.push_enabled := false; s.version := 0;
  END IF;
  IF s.zalo_account_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', x.id, 'name', x.name, 'kind', x.kind, 'status', x.status) INTO v_account
      FROM public.zalo_accounts x WHERE x.id = s.zalo_account_id AND x.organization_id = p_org;
  END IF;
  IF s.zalo_conversation_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', x.id, 'name', x.peer_name, 'threadType', x.thread_type, 'accountId', x.account_id)
      INTO v_conversation
      FROM public.zalo_conversations x WHERE x.id = s.zalo_conversation_id AND x.organization_id = p_org;
  END IF;
  v_warning := CASE
    WHEN s.zalo_conversation_id IS NULL THEN 'NOT_CONFIGURED'
    WHEN v_conversation IS NULL OR v_conversation ->> 'threadType' IS DISTINCT FROM 'group'
      OR v_conversation ->> 'accountId' IS DISTINCT FROM s.zalo_account_id::text THEN 'GROUP_MISSING'
    WHEN v_account IS NULL OR v_account ->> 'kind' IS DISTINCT FROM 'personal'
      OR v_account ->> 'status' IS DISTINCT FROM 'connected' THEN 'ACCOUNT_DISCONNECTED'
  END;
  SELECT count(*) FILTER (WHERE NOT d.shadow), count(*) FILTER (WHERE d.shadow) INTO v_sent, v_would
    FROM app_private.camera_alert_deliveries d
   WHERE d.organization_id = p_org AND d.channel = 'ZALO' AND d.local_date = v_date AND d.counts_toward_cap;
  RETURN jsonb_build_object(
    'organizationId', p_org,
    'exists', v_found,
    'settings', jsonb_build_object(
      'enabled', s.enabled, 'mode', s.mode,
      'zaloAccountId', s.zalo_account_id, 'zaloConversationId', s.zalo_conversation_id,
      'types', app_private.camera_alert_types_v1(s.types),
      'nightStart', to_char(s.night_start, 'HH24:MI'), 'nightEnd', to_char(s.night_end, 'HH24:MI'),
      'digestAt', to_char(s.digest_at, 'HH24:MI'),
      'dailyZaloCap', s.daily_zalo_cap, 'pushEnabled', s.push_enabled,
      'liveSince', s.live_since, 'updatedBy', s.updated_by, 'updatedAt', CASE WHEN v_found THEN s.updated_at END,
      'version', s.version),
    'canEdit', app_private.camera_alert_actor_can_edit_v1(p_org),
    'zalo', jsonb_build_object('account', v_account, 'conversation', v_conversation, 'warning', v_warning),
    'today', jsonb_build_object('date', v_date, 'zaloSent', coalesce(v_sent, 0), 'shadowWouldSend', coalesce(v_would, 0),
      'cap', s.daily_zalo_cap),
    'defaults', app_private.camera_alert_default_types_v1());
END
$fn$;

CREATE OR REPLACE FUNCTION public.camera_alert_get_settings_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
     OR NOT app_private.camera_alert_actor_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Camera alert view permission required' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.camera_alert_settings_view_v1(p_organization_id);
END
$fn$;

-- Lưu cài đặt (D8). p_patch chỉ cần các khoá đổi. CAS theo version ⇒ PT409.
CREATE OR REPLACE FUNCTION public.camera_alert_save_settings_v1(
  p_organization_id uuid, p_expected_version bigint, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  c_codes constant text[] := ARRAY['CAMERA_STORAGE_ERROR', 'CAMERA_RECORDER_OFFLINE', 'CAMERA_RECORDER_AUTH_DENIED',
    'CAMERA_MONITOR_STALE', 'CAMERA_CHANNEL_LOST', 'CAMERA_CHANNEL_FLAPPING', 'CAMERA_RECORDER_UNKNOWN'];
  v_uid uuid := auth.uid();
  s app_private.camera_alert_settings;
  v_old app_private.camera_alert_settings;
  v_found boolean;
  v_key text;
  v_code text;
  v_item jsonb;
  v_field text;
  v_types jsonb;
  v_val jsonb;
  v_was_live boolean;
  v_was_shadow boolean;
  c record;
  a record;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL
     OR NOT app_private.camera_alert_actor_can_edit_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin sửa được cài đặt cảnh báo camera' USING ERRCODE = '42501';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'Cài đặt cảnh báo camera không hợp lệ' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key NOT IN ('enabled', 'mode', 'zaloAccountId', 'zaloConversationId', 'types', 'nightStart', 'nightEnd',
                     'digestAt', 'dailyZaloCap', 'pushEnabled') THEN
      RAISE EXCEPTION 'Trường cài đặt không hợp lệ: %', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('camera_alert_settings:' || p_organization_id::text, 0));
  SELECT * INTO s FROM app_private.camera_alert_settings st WHERE st.organization_id = p_organization_id FOR UPDATE;
  v_found := FOUND;
  IF (v_found AND s.version <> p_expected_version) OR (NOT v_found AND p_expected_version <> 0) THEN
    RAISE EXCEPTION 'Cài đặt cảnh báo camera vừa được người khác thay đổi. Tải lại rồi lưu lại.' USING ERRCODE = 'PT409';
  END IF;
  IF NOT v_found THEN
    s.organization_id := p_organization_id; s.enabled := false; s.mode := 'SHADOW';
    s.types := app_private.camera_alert_default_types_v1();
    s.night_start := '22:00'; s.night_end := '07:00'; s.digest_at := '08:00';
    s.daily_zalo_cap := 6; s.push_enabled := false; s.version := 0; s.baseline_pending := false;
  END IF;
  v_old := s;

  BEGIN
    IF p_patch ? 'enabled' THEN
      IF jsonb_typeof(p_patch -> 'enabled') <> 'boolean' THEN RAISE EXCEPTION 'enabled'; END IF;
      s.enabled := (p_patch ->> 'enabled')::boolean;
    END IF;
    IF p_patch ? 'mode' THEN
      IF jsonb_typeof(p_patch -> 'mode') IS DISTINCT FROM 'string' OR p_patch ->> 'mode' NOT IN ('SHADOW', 'LIVE') THEN
        RAISE EXCEPTION 'mode';
      END IF;
      s.mode := p_patch ->> 'mode';
    END IF;
    IF p_patch ? 'pushEnabled' THEN
      IF jsonb_typeof(p_patch -> 'pushEnabled') <> 'boolean' THEN RAISE EXCEPTION 'pushEnabled'; END IF;
      s.push_enabled := (p_patch ->> 'pushEnabled')::boolean;
    END IF;
    IF p_patch ? 'dailyZaloCap' THEN
      IF jsonb_typeof(p_patch -> 'dailyZaloCap') <> 'number' OR (p_patch ->> 'dailyZaloCap') !~ '^[0-9]+$'
         OR (p_patch ->> 'dailyZaloCap')::integer NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'dailyZaloCap'; END IF;
      s.daily_zalo_cap := (p_patch ->> 'dailyZaloCap')::integer;
    END IF;
    FOREACH v_field IN ARRAY ARRAY['nightStart', 'nightEnd', 'digestAt'] LOOP
      IF p_patch ? v_field THEN
        IF jsonb_typeof(p_patch -> v_field) <> 'string' OR (p_patch ->> v_field) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
          RAISE EXCEPTION '%', v_field;
        END IF;
        CASE v_field
          WHEN 'nightStart' THEN s.night_start := (p_patch ->> v_field)::time;
          WHEN 'nightEnd' THEN s.night_end := (p_patch ->> v_field)::time;
          ELSE s.digest_at := (p_patch ->> v_field)::time;
        END CASE;
      END IF;
    END LOOP;
    IF s.night_start = s.night_end THEN RAISE EXCEPTION 'nightEnd'; END IF;
    IF p_patch ? 'types' THEN
      IF jsonb_typeof(p_patch -> 'types') <> 'object' THEN RAISE EXCEPTION 'types'; END IF;
      v_types := app_private.camera_alert_types_v1(s.types);
      FOR v_code, v_item IN SELECT key, value FROM jsonb_each(p_patch -> 'types') LOOP
        IF NOT v_code = ANY(c_codes) OR jsonb_typeof(v_item) <> 'object' THEN RAISE EXCEPTION 'types.%', v_code; END IF;
        FOR v_field, v_val IN SELECT key, value FROM jsonb_each(v_item) LOOP
          IF v_field = 'enabled' THEN
            IF jsonb_typeof(v_val) <> 'boolean' THEN RAISE EXCEPTION 'types.%.enabled', v_code; END IF;
          ELSIF v_field = 'delivery' THEN
            IF v_val #>> '{}' NOT IN ('ZALO', 'DIGEST', 'BELL', 'OFF')
               OR jsonb_typeof(v_val) <> 'string'
               -- Chập chờn chỉ có trong bản tin 08:00 (không có sự cố để gửi ngay).
               OR (v_code = 'CAMERA_CHANNEL_FLAPPING' AND v_val #>> '{}' NOT IN ('DIGEST', 'OFF')) THEN
              RAISE EXCEPTION 'types.%.delivery', v_code;
            END IF;
          ELSIF v_field = 'threshold_seconds' AND v_code <> 'CAMERA_CHANNEL_FLAPPING' THEN
            -- 60–86 400 giây; riêng ổ lỗi cho 0 (= báo ngay, mặc định).
            IF jsonb_typeof(v_val) <> 'number' OR (v_val #>> '{}') !~ '^[0-9]+$'
               OR (v_val #>> '{}')::integer > 86400
               OR ((v_val #>> '{}')::integer < 60 AND NOT (v_code = 'CAMERA_STORAGE_ERROR' AND (v_val #>> '{}')::integer = 0)) THEN
              RAISE EXCEPTION 'types.%.threshold_seconds', v_code;
            END IF;
          ELSIF v_field = 'threshold_count' AND v_code = 'CAMERA_CHANNEL_FLAPPING' THEN
            IF jsonb_typeof(v_val) <> 'number' OR (v_val #>> '{}') !~ '^[0-9]+$'
               OR (v_val #>> '{}')::integer NOT BETWEEN 2 AND 200 THEN
              RAISE EXCEPTION 'types.%.threshold_count', v_code;
            END IF;
          ELSE
            RAISE EXCEPTION 'types.%.%', v_code, v_field;
          END IF;
        END LOOP;
        v_types := jsonb_set(v_types, ARRAY[v_code], (v_types -> v_code) || v_item);
      END LOOP;
      s.types := v_types;
    END IF;
    IF p_patch ? 'zaloAccountId' THEN
      s.zalo_account_id := nullif(p_patch ->> 'zaloAccountId', '')::uuid;
    END IF;
    IF p_patch ? 'zaloConversationId' THEN
      s.zalo_conversation_id := nullif(p_patch ->> 'zaloConversationId', '')::uuid;
    END IF;
  EXCEPTION
    WHEN raise_exception OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Giá trị cài đặt không hợp lệ: %', SQLERRM USING ERRCODE = '22023';
  END;

  -- Nơi nhận: nhóm thuộc org, đúng nick cá nhân của org (spec §5).
  IF s.zalo_conversation_id IS NOT NULL THEN
    SELECT x.id, x.account_id, x.thread_type INTO c
      FROM public.zalo_conversations x WHERE x.id = s.zalo_conversation_id AND x.organization_id = p_organization_id;
    IF NOT FOUND OR c.thread_type IS DISTINCT FROM 'group' OR c.account_id IS DISTINCT FROM s.zalo_account_id THEN
      RAISE EXCEPTION 'Nhóm Zalo không thuộc nick đã chọn của công ty' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF s.zalo_account_id IS NOT NULL THEN
    SELECT x.id, x.kind INTO a FROM public.zalo_accounts x WHERE x.id = s.zalo_account_id AND x.organization_id = p_organization_id;
    IF NOT FOUND OR a.kind IS DISTINCT FROM 'personal' THEN
      RAISE EXCEPTION 'Nick Zalo không thuộc công ty hoặc không phải nick cá nhân' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Gửi thật mà chưa chọn nhóm thì tin hiện trạng (chỉ gửi một lần) sẽ mất.
  IF s.enabled AND s.mode = 'LIVE' AND s.zalo_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Chọn nhóm Zalo nhận cảnh báo trước khi chuyển sang gửi thật' USING ERRCODE = '22023';
  END IF;

  -- Chuyển sang LIVE (hoặc bật lại SHADOW): lượt kế tiếp là lượt hiện trạng.
  v_was_live := v_old.enabled AND v_old.mode = 'LIVE';
  v_was_shadow := v_old.enabled AND v_old.mode = 'SHADOW';
  IF s.enabled AND s.mode = 'LIVE' AND NOT v_was_live THEN
    s.live_since := clock_timestamp();
    s.baseline_pending := true;
  ELSIF s.enabled AND s.mode = 'SHADOW' AND NOT v_was_shadow THEN
    s.baseline_pending := true;
  ELSIF NOT s.enabled THEN
    s.baseline_pending := false;
  END IF;

  s.version := v_old.version + 1;
  s.updated_by := v_uid;
  s.updated_at := clock_timestamp();
  IF v_found THEN
    UPDATE app_private.camera_alert_settings st
       SET enabled = s.enabled, mode = s.mode, zalo_account_id = s.zalo_account_id,
           zalo_conversation_id = s.zalo_conversation_id, types = s.types, night_start = s.night_start,
           night_end = s.night_end, digest_at = s.digest_at, daily_zalo_cap = s.daily_zalo_cap,
           push_enabled = s.push_enabled, live_since = s.live_since, baseline_pending = s.baseline_pending,
           version = s.version, updated_by = s.updated_by, updated_at = s.updated_at
     WHERE st.organization_id = p_organization_id;
  ELSE
    INSERT INTO app_private.camera_alert_settings (
      organization_id, enabled, mode, zalo_account_id, zalo_conversation_id, types, night_start, night_end,
      digest_at, daily_zalo_cap, push_enabled, live_since, baseline_pending, version, updated_by, updated_at)
    VALUES (s.organization_id, s.enabled, s.mode, s.zalo_account_id, s.zalo_conversation_id, s.types, s.night_start,
      s.night_end, s.digest_at, s.daily_zalo_cap, s.push_enabled, s.live_since, s.baseline_pending, s.version,
      s.updated_by, s.updated_at);
  END IF;

  IF v_old.enabled IS DISTINCT FROM s.enabled OR v_old.mode IS DISTINCT FROM s.mode THEN
    INSERT INTO app_private.camera_alert_audit (organization_id, actor_user_id, action, before, after)
    VALUES (p_organization_id, v_uid, 'MODE_CHANGED',
      jsonb_build_object('enabled', v_old.enabled, 'mode', v_old.mode),
      jsonb_build_object('enabled', s.enabled, 'mode', s.mode));
  END IF;
  INSERT INTO app_private.camera_alert_audit (organization_id, actor_user_id, action, before, after)
  VALUES (p_organization_id, v_uid, 'SETTINGS_SAVED', jsonb_build_object('version', v_old.version), p_patch);

  RETURN app_private.camera_alert_settings_view_v1(p_organization_id);
END
$fn$;

-- Nhóm Zalo chọn được: hội thoại nhóm của nick cá nhân đang kết nối của org.
-- Không trả nội dung tin.
CREATE OR REPLACE FUNCTION public.camera_alert_list_zalo_groups_v1(
  p_organization_id uuid, p_search text DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
     OR NOT app_private.camera_alert_actor_can_edit_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin chọn được nhóm Zalo' USING ERRCODE = '42501';
  END IF;
  IF length(v_search) > 100 THEN
    RAISE EXCEPTION 'Từ khoá tìm quá dài' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', g.id, 'name', g.peer_name, 'accountId', g.account_id, 'accountName', g.account_name,
             'lastMessageAt', g.last_message_at) ORDER BY g.last_message_at DESC NULLS LAST, g.peer_name, g.id)
      FROM (
        SELECT c.id, c.peer_name, c.account_id, a.name AS account_name, c.last_message_at
          FROM public.zalo_conversations c
          JOIN public.zalo_accounts a ON a.id = c.account_id AND a.organization_id = c.organization_id
         WHERE c.organization_id = p_organization_id AND c.thread_type = 'group'
           AND a.kind = 'personal' AND a.status = 'connected'
           AND (v_search IS NULL OR c.peer_name ILIKE '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%')
         ORDER BY c.last_message_at DESC NULLS LAST, c.peer_name, c.id
         LIMIT v_limit
      ) g
  ), '[]'::jsonb));
END
$fn$;

-- Tắt báo một kênh (D8). IGNORE/SNOOZE đóng sự cố đang mở với lý do MUTED.
CREATE OR REPLACE FUNCTION public.camera_alert_set_channel_mute_v1(
  p_recorder_id uuid, p_channel integer, p_kind text, p_until timestamptz DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  r record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_before jsonb;
  cond app_private.camera_alert_conditions;
  v_row app_private.camera_alert_channel_mutes;
BEGIN
  IF v_uid IS NULL OR p_recorder_id IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin tắt báo kênh được' USING ERRCODE = '42501';
  END IF;
  SELECT x.id, x.organization_id, x.building_id, x.channel_count INTO r
    FROM public.camera_recorders x WHERE x.id = p_recorder_id;
  IF NOT FOUND OR NOT app_private.camera_alert_actor_can_edit_v1(r.organization_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin tắt báo kênh được' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('IGNORE', 'SNOOZE', 'KNOWN_BROKEN') THEN
    RAISE EXCEPTION 'Kiểu tắt báo không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF (p_kind = 'SNOOZE') <> (p_until IS NOT NULL)
     OR (p_kind = 'SNOOZE' AND (p_until <= clock_timestamp() OR p_until > clock_timestamp() + interval '90 days')) THEN
    RAISE EXCEPTION 'Tạm ẩn cần ngày kết thúc trong 90 ngày tới' USING ERRCODE = '22023';
  END IF;
  IF length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú quá dài' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.camera_recorder_current cur, jsonb_array_elements(cur.channels) ch
        WHERE cur.recorder_id = r.id AND (ch.value ->> 'channel')::integer = p_channel) THEN
    RAISE EXCEPTION 'Kênh không có trong trạng thái đầu ghi' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(m) INTO v_before FROM app_private.camera_alert_channel_mutes m
   WHERE m.recorder_id = r.id AND m.channel = p_channel FOR UPDATE;
  INSERT INTO app_private.camera_alert_channel_mutes (recorder_id, channel, organization_id, building_id, kind, until_at, note, set_by, set_at)
  VALUES (r.id, p_channel, r.organization_id, r.building_id, p_kind, CASE WHEN p_kind = 'SNOOZE' THEN p_until END, v_note, v_uid, clock_timestamp())
  ON CONFLICT (recorder_id, channel) DO UPDATE
    SET kind = EXCLUDED.kind, until_at = EXCLUDED.until_at, note = EXCLUDED.note,
        set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
  RETURNING * INTO v_row;

  IF p_kind IN ('IGNORE', 'SNOOZE') THEN
    SELECT * INTO cond FROM app_private.camera_alert_conditions c
     WHERE c.recorder_id = r.id AND c.subject = 'channel:' || p_channel FOR UPDATE;
    IF FOUND THEN
      PERFORM app_private.camera_alert_retire_v1(cond, 'MUTED', clock_timestamp());
    END IF;
  END IF;

  INSERT INTO app_private.camera_alert_audit (organization_id, actor_user_id, action, target, before, after)
  VALUES (r.organization_id, v_uid, 'CHANNEL_MUTE_SET',
    jsonb_build_object('recorderId', r.id, 'buildingId', r.building_id, 'channel', p_channel), v_before, to_jsonb(v_row));
  RETURN jsonb_build_object('recorderId', v_row.recorder_id, 'channel', v_row.channel, 'kind', v_row.kind,
    'untilAt', v_row.until_at, 'note', v_row.note, 'setBy', v_row.set_by, 'setAt', v_row.set_at);
END
$fn$;

CREATE OR REPLACE FUNCTION public.camera_alert_clear_channel_mute_v1(p_recorder_id uuid, p_channel integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  r record;
  v_before jsonb;
BEGIN
  IF v_uid IS NULL OR p_recorder_id IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin bật lại báo kênh được' USING ERRCODE = '42501';
  END IF;
  SELECT x.id, x.organization_id, x.building_id INTO r FROM public.camera_recorders x WHERE x.id = p_recorder_id;
  IF NOT FOUND OR NOT app_private.camera_alert_actor_can_edit_v1(r.organization_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin bật lại báo kênh được' USING ERRCODE = '42501';
  END IF;
  DELETE FROM app_private.camera_alert_channel_mutes m
   WHERE m.recorder_id = r.id AND m.channel = p_channel
  RETURNING to_jsonb(m) INTO v_before;
  IF v_before IS NOT NULL THEN
    INSERT INTO app_private.camera_alert_audit (organization_id, actor_user_id, action, target, before)
    VALUES (r.organization_id, v_uid, 'CHANNEL_MUTE_CLEARED',
      jsonb_build_object('recorderId', r.id, 'buildingId', r.building_id, 'channel', p_channel), v_before);
  END IF;
  RETURN jsonb_build_object('recorderId', r.id, 'channel', p_channel, 'cleared', v_before IS NOT NULL);
END
$fn$;

-- Trạng thái tắt báo kênh của một toà, cho tab Camera.
CREATE OR REPLACE FUNCTION public.camera_building_channel_mutes_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_org uuid;
BEGIN
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF auth.uid() IS NULL OR p_building_id IS NULL OR v_org IS NULL
     OR NOT coalesce(public.can_access_building(p_building_id), false)
     OR NOT coalesce(public.can_do_on_building('network_center', 'view', p_building_id), false)
     OR (coalesce(public.is_super_admin(), false) AND coalesce(v_org = ANY (public.sandbox_org_ids()), false)) THEN
    RAISE EXCEPTION 'Camera view permission required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'canEdit', app_private.camera_alert_actor_can_edit_v1(v_org),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'recorderId', m.recorder_id, 'organizationId', m.organization_id, 'buildingId', m.building_id,
               'channel', m.channel, 'kind', m.kind, 'untilAt', m.until_at, 'note', m.note,
               'setBy', m.set_by,
               'setByName', (SELECT nullif(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = m.set_by),
               'setAt', m.set_at) ORDER BY m.recorder_id, m.channel)
        FROM app_private.camera_alert_channel_mutes m
       WHERE m.building_id = p_building_id AND m.organization_id = v_org
         AND (m.kind <> 'SNOOZE' OR m.until_at > clock_timestamp())
    ), '[]'::jsonb));
END
$fn$;

-- Sổ gửi 7 ngày. Người không có quyền sửa chỉ thấy dòng mà họ xem được MỌI toà
-- trong tin (spec §5).
CREATE OR REPLACE FUNCTION public.camera_alert_list_deliveries_v1(
  p_organization_id uuid, p_status text DEFAULT NULL, p_limit integer DEFAULT 100,
  p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 200));
  v_all boolean;
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
     OR NOT app_private.camera_alert_actor_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Camera alert view permission required' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('SHADOW', 'QUEUED', 'SENT', 'FAILED', 'SUPPRESSED', 'DEFERRED') THEN
    RAISE EXCEPTION 'Trạng thái lọc không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_all := app_private.camera_alert_actor_can_edit_v1(p_organization_id);
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT d.id, d.created_at, jsonb_build_object(
               'id', d.id, 'createdAt', d.created_at, 'kind', d.kind, 'channel', d.channel,
               'status', y.status, 'storedStatus', d.status, 'shadow', d.shadow, 'reason', d.reason,
               'body', d.body, 'buildingIds', to_jsonb(d.building_ids), 'recipients', d.recipients,
               'pendingRelease', d.pending_release, 'releasedAt', d.released_at, 'sentAt', d.sent_at,
               'zaloJobId', d.zalo_job_id, 'jobStatus', y.job_status, 'jobError', y.job_error) AS item
        FROM app_private.camera_alert_deliveries d
        LEFT JOIN LATERAL (
          SELECT q.status AS job_status, left(q.last_error, 300) AS job_error,
                 CASE WHEN d.status = 'QUEUED' AND q.status = 'sent' THEN 'SENT'
                      WHEN d.status = 'QUEUED' AND q.status = 'failed' THEN 'FAILED'
                      ELSE d.status END AS status
            FROM (SELECT 1) one
            LEFT JOIN public.zalo_send_queue q ON q.id = d.zalo_job_id AND q.organization_id = d.organization_id
        ) y ON true
       WHERE d.organization_id = p_organization_id
         AND d.created_at > clock_timestamp() - interval '7 days'
         -- Con trỏ (createdAt, id) của dòng cuối trang trước: mọi dòng của một lượt
         -- có cùng created_at nên chỉ so giờ sẽ làm rơi dòng.
         AND (p_before IS NULL OR CASE WHEN p_before_id IS NULL THEN d.created_at < p_before
                                       ELSE (d.created_at, d.id) < (p_before, p_before_id) END)
         AND (p_status IS NULL OR y.status = p_status)
         AND (v_all OR NOT EXISTS (
               SELECT 1 FROM unnest(d.building_ids) b(id)
                WHERE NOT app_private.camera_share_actor_can_v1(p_organization_id, b.id)))
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT v_limit + 1
    ) x;
  RETURN jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(e.value ORDER BY e.ordinality) FROM jsonb_array_elements(v_rows) WITH ORDINALITY e
                        WHERE e.ordinality <= v_limit), '[]'::jsonb),
    'hasMore', jsonb_array_length(v_rows) > v_limit);
END
$fn$;

-- Tin thử (D8). Gửi thật ở mọi chế độ, tính vào trần. Bấm lại trong 60 giây
-- nhận lại dòng cũ.
CREATE OR REPLACE FUNCTION public.camera_alert_send_test_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  s app_private.camera_alert_settings;
  v_sent jsonb;
  v_recent record;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL
     OR NOT app_private.camera_alert_actor_can_edit_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin gửi tin thử được' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('camera_alert_settings:' || p_organization_id::text, 0));
  SELECT * INTO s FROM app_private.camera_alert_settings st WHERE st.organization_id = p_organization_id;
  IF NOT FOUND OR s.zalo_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn nhóm Zalo nhận cảnh báo' USING ERRCODE = '22023';
  END IF;
  SELECT d.id, d.status, d.reason, d.zalo_job_id INTO v_recent
    FROM app_private.camera_alert_deliveries d
   WHERE d.organization_id = p_organization_id AND d.kind = 'TEST' AND d.created_at > clock_timestamp() - interval '60 seconds'
   ORDER BY d.created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('deliveryId', v_recent.id, 'status', v_recent.status, 'reason', v_recent.reason,
      'jobId', v_recent.zalo_job_id, 'reused', true);
  END IF;
  v_sent := app_private.camera_alert_send_zalo_v1(s, false, 'TEST',
    'Tin thử cảnh báo camera — nếu nhóm nhận được tin này là cấu hình đúng.',
    '{}'::uuid[], 'TEST:' || p_organization_id::text || ':' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text,
    true, clock_timestamp(), jsonb_build_object('requestedBy', v_uid));
  INSERT INTO app_private.camera_alert_audit (organization_id, actor_user_id, action, target, after)
  VALUES (p_organization_id, v_uid, 'TEST_SENT', jsonb_build_object('deliveryId', v_sent ->> 'deliveryId'), v_sent);
  RETURN v_sent;
END
$fn$;

-- "Đã biết" cho sự cố camera. Đường có sẵn network_center_ack_incident_v1 đòi
-- toà ở rollout EXECUTE (đo production 24/11: mọi toà có camera đang READ_ONLY)
-- nên không dùng được. Quyền: chủ công ty / superadmin (D8) hoặc
-- network_center.execute ở đúng toà — cùng quyền của đường có sẵn, bỏ cổng
-- rollout router vì thao tác này không đụng thiết bị.
CREATE OR REPLACE FUNCTION public.camera_alert_acknowledge_incident_v1(p_incident_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  inc record;
BEGIN
  IF v_uid IS NULL OR p_incident_id IS NULL THEN
    RAISE EXCEPTION 'Camera incident acknowledge permission required' USING ERRCODE = '42501';
  END IF;
  SELECT i.id, i.organization_id, i.building_id, i.incident_type, i.severity, i.status, i.acknowledged_at, i.acknowledged_by
    INTO inc
    FROM public.network_incidents i
   WHERE i.id = p_incident_id
   FOR UPDATE;
  IF NOT FOUND OR left(inc.incident_type, 7) <> 'CAMERA_'
     OR NOT (app_private.camera_alert_actor_can_edit_v1(inc.organization_id)
             OR (coalesce(public.can_access_building(inc.building_id), false)
                 AND coalesce(public.can_do_on_building('network_center', 'execute', inc.building_id), false)
                 AND NOT (coalesce(public.is_super_admin(), false)
                          AND coalesce(inc.organization_id = ANY (public.sandbox_org_ids()), false)))) THEN
    RAISE EXCEPTION 'Camera incident acknowledge permission required' USING ERRCODE = '42501';
  END IF;
  IF inc.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'Sự cố đã đóng' USING ERRCODE = 'P0002';
  END IF;
  IF inc.acknowledged_at IS NULL THEN
    UPDATE public.network_incidents
       SET status = CASE WHEN status = 'RECOVERING' THEN status ELSE 'ACKNOWLEDGED' END,
           acknowledged_at = greatest(clock_timestamp(), opened_at), acknowledged_by = v_uid, version = version + 1
     WHERE id = inc.id
    RETURNING status, acknowledged_at, acknowledged_by INTO inc.status, inc.acknowledged_at, inc.acknowledged_by;
    INSERT INTO public.network_incident_events (
      organization_id, building_id, incident_id, event_seq, event_kind, severity, occurred_at, actor_id, details)
    VALUES (inc.organization_id, inc.building_id, inc.id,
      coalesce((SELECT max(e.event_seq) + 1 FROM public.network_incident_events e WHERE e.incident_id = inc.id), 1),
      'ACKNOWLEDGED', inc.severity, inc.acknowledged_at, v_uid,
      jsonb_build_object('via', 'camera_alert_acknowledge_incident_v1'));
  END IF;
  RETURN jsonb_build_object('incidentId', inc.id, 'status', inc.status,
    'acknowledgedAt', inc.acknowledged_at, 'acknowledgedBy', inc.acknowledged_by);
END
$fn$;

-- Sự cố CAMERA_* chưa đóng của một toà, cho tab Camera (giữ từ #384).
CREATE OR REPLACE FUNCTION public.camera_building_incidents_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_building_id IS NULL
     OR NOT coalesce(public.can_access_building(p_building_id), false)
     OR NOT coalesce(public.can_do_on_building('network_center', 'view', p_building_id), false) THEN
    RAISE EXCEPTION 'Camera view permission required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
        'id', i.id,
        'organization_id', i.organization_id,
        'building_id', i.building_id,
        'incident_type', i.incident_type,
        'severity', i.severity,
        'status', i.status,
        'title', i.title,
        'summary', i.summary,
        'opened_at', i.opened_at,
        'acknowledged_at', i.acknowledged_at,
        'recorder_id', i.observed_values ->> 'recorderId',
        'subject', i.observed_values ->> 'subject'
      ) ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, i.opened_at DESC, i.id)
    FROM (
      SELECT * FROM public.network_incidents incident
       WHERE incident.building_id = p_building_id
         AND left(incident.incident_type, 7) = 'CAMERA_'
         AND incident.status <> 'RESOLVED'
       ORDER BY incident.opened_at DESC, incident.id
       LIMIT 200
    ) i
  ), '[]'::jsonb));
END
$fn$;

COMMENT ON FUNCTION public.camera_building_incidents_v1(uuid) IS
  'Sự cố camera (CAMERA_*) chưa đóng của một toà, cho tab Camera. SECURITY INVOKER, đòi network_center.view ở đúng toà; RLS của network_incidents vẫn áp. "Đã biết" đi qua camera_alert_acknowledge_incident_v1.';

-- -----------------------------------------------------------------------------
-- 11. Quyền. Baseline không mang GRANT/REVOKE nên tự cắt lại đủ ba vai.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  app_private.camera_alert_default_types_v1(),
  app_private.camera_alert_types_v1(jsonb),
  app_private.camera_alert_route_v1(jsonb, text),
  app_private.camera_alert_threshold_v1(jsonb, text),
  app_private.camera_alert_clock_v1(timestamptz, text, timestamptz),
  app_private.camera_alert_duration_v1(numeric),
  app_private.camera_alert_recorder_label_v1(jsonb),
  app_private.camera_alert_channel_label_v1(jsonb),
  app_private.camera_alert_line_v1(text, text, text, jsonb, text, timestamptz, text),
  app_private.camera_alert_lines_v1(jsonb, text, timestamptz, text, integer),
  app_private.camera_alert_compose_v1(text, jsonb, text),
  app_private.camera_alert_actor_can_edit_v1(uuid),
  app_private.camera_alert_actor_can_view_v1(uuid),
  app_private.network_center_alert_recipient_ids_v1(uuid, uuid),
  app_private.camera_alert_router_cause_v1(uuid, uuid, uuid, timestamptz),
  app_private.camera_alert_transition_v1(uuid, text, timestamptz, jsonb),
  app_private.camera_alert_event_v1(text, app_private.camera_alert_conditions, uuid, jsonb, timestamptz),
  app_private.camera_alert_open_v1(app_private.camera_alert_conditions, text, boolean, uuid, jsonb, integer, text, timestamptz),
  app_private.camera_alert_retire_v1(app_private.camera_alert_conditions, text, timestamptz),
  app_private.camera_alert_zalo_enqueue_v1(uuid, uuid, uuid, text, text, uuid),
  app_private.camera_alert_send_zalo_v1(app_private.camera_alert_settings, boolean, text, text, uuid[], text, boolean, timestamptz, jsonb),
  app_private.camera_alert_send_bell_v1(app_private.camera_alert_settings, boolean, text, jsonb, text, timestamptz),
  app_private.camera_alert_pending_items_v1(uuid, boolean, timestamptz),
  app_private.camera_alert_release_pending_v1(uuid, boolean, timestamptz, uuid),
  app_private.camera_alert_night_digest_v1(app_private.camera_alert_settings, boolean, timestamptz, integer),
  app_private.camera_alert_morning_digest_v1(app_private.camera_alert_settings, boolean, timestamptz, integer),
  app_private.camera_alert_evaluate_org_v1(app_private.camera_alert_settings, timestamptz),
  app_private.camera_alert_evaluate_v1(timestamptz),
  app_private.camera_alert_settings_view_v1(uuid),
  public.camera_alert_get_settings_v1(uuid),
  public.camera_alert_save_settings_v1(uuid, bigint, jsonb),
  public.camera_alert_list_zalo_groups_v1(uuid, text, integer),
  public.camera_alert_set_channel_mute_v1(uuid, integer, text, timestamptz, text),
  public.camera_alert_clear_channel_mute_v1(uuid, integer),
  public.camera_building_channel_mutes_v1(uuid),
  public.camera_alert_list_deliveries_v1(uuid, text, integer, timestamptz, uuid),
  public.camera_alert_send_test_v1(uuid),
  public.camera_alert_acknowledge_incident_v1(uuid),
  public.camera_building_incidents_v1(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.camera_alert_get_settings_v1(uuid),
  public.camera_alert_save_settings_v1(uuid, bigint, jsonb),
  public.camera_alert_list_zalo_groups_v1(uuid, text, integer),
  public.camera_alert_set_channel_mute_v1(uuid, integer, text, timestamptz, text),
  public.camera_alert_clear_channel_mute_v1(uuid, integer),
  public.camera_building_channel_mutes_v1(uuid),
  public.camera_alert_list_deliveries_v1(uuid, text, integer, timestamptz, uuid),
  public.camera_alert_send_test_v1(uuid),
  public.camera_alert_acknowledge_incident_v1(uuid),
  public.camera_building_incidents_v1(uuid)
TO authenticated;

-- -----------------------------------------------------------------------------
-- 12. Tự kiểm trước commit (catalog, chạy được trên database rỗng).
-- -----------------------------------------------------------------------------
DO $kiem$
DECLARE
  v_fn text;
  v_role text;
  v_tbl text;
  v_public constant text[] := ARRAY[
    'public.camera_alert_get_settings_v1(uuid)',
    'public.camera_alert_save_settings_v1(uuid,bigint,jsonb)',
    'public.camera_alert_list_zalo_groups_v1(uuid,text,integer)',
    'public.camera_alert_set_channel_mute_v1(uuid,integer,text,timestamptz,text)',
    'public.camera_alert_clear_channel_mute_v1(uuid,integer)',
    'public.camera_building_channel_mutes_v1(uuid)',
    'public.camera_alert_list_deliveries_v1(uuid,text,integer,timestamptz,uuid)',
    'public.camera_alert_send_test_v1(uuid)',
    'public.camera_alert_acknowledge_incident_v1(uuid)',
    'public.camera_building_incidents_v1(uuid)'];
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app_private'
       AND (p.proname LIKE 'camera\_alert\_%' OR p.proname = 'network_center_alert_recipient_ids_v1')
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% vẫn gọi được %. DỪNG.', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_fn IN ARRAY v_public LOOP
    IF to_regprocedure(v_fn) IS NULL THEN RAISE EXCEPTION 'Thiếu hàm %. DỪNG.', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'ACL của % sai. DỪNG.', v_fn;
    END IF;
  END LOOP;
  FOREACH v_tbl IN ARRAY ARRAY[
    'app_private.camera_alert_settings', 'app_private.camera_alert_conditions', 'app_private.camera_alert_channel_mutes',
    'app_private.camera_alert_events', 'app_private.camera_alert_deliveries', 'app_private.camera_alert_audit'
  ] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(v_role, v_tbl, 'SELECT') OR has_table_privilege(v_role, v_tbl, 'INSERT')
         OR has_table_privilege(v_role, v_tbl, 'UPDATE') OR has_table_privilege(v_role, v_tbl, 'DELETE') THEN
        RAISE EXCEPTION '% vẫn đọc/ghi được %. DỪNG.', v_role, v_tbl;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE (n.nspname = 'app_private' AND p.proname LIKE 'camera\_alert\_%')
          OR (n.nspname = 'app_private' AND p.proname = 'network_center_alert_recipient_ids_v1')
          OR (n.nspname = 'public' AND (p.proname LIKE 'camera\_alert\_%'
               OR p.proname IN ('camera_building_incidents_v1', 'camera_building_channel_mutes_v1')))) <> 39 THEN
    RAISE EXCEPTION 'Số hàm cảnh báo camera khác 39 (overload sót?). DỪNG.';
  END IF;
END
$kiem$;

-- -----------------------------------------------------------------------------
-- 13. Lịch pg_cron. Cùng file với hàm: cửa idempotent dán TỪNG file rồi
--     ROLLBACK, một file lịch đòi hàm của file chưa áp sẽ ngã. Không có schema
--     cron (bản dựng lại từ baseline, cụm dùng một lần) thì bỏ qua. Không org nào
--     bật thì mỗi lượt chỉ đọc một bảng rỗng.
-- -----------------------------------------------------------------------------
DO $cronblock$
DECLARE v_n integer;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron (môi trường diễn tập) — bỏ qua đăng ký lịch cảnh báo camera.';
    RETURN;
  END IF;
  PERFORM cron.schedule(
    'camera-alert-evaluate',
    '*/2 * * * *',
    $job$SET statement_timeout = '10s'; SELECT app_private.camera_alert_evaluate_v1();$job$
  );
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname = 'camera-alert-evaluate' AND schedule = '*/2 * * * *' AND active;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Lịch camera-alert-evaluate chưa đăng ký đúng (thấy % job). DỪNG.', v_n;
  END IF;
END
$cronblock$;

NOTIFY pgrst, 'reload schema';
COMMIT;
