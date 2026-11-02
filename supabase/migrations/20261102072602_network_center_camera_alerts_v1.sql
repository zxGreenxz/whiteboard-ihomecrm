-- =============================================================================
-- Cảnh báo ổ cứng và kênh camera của đầu ghi — Đợt 1.
-- Plan: docs/superpowers/plans/2026-11-01-canh-bao-camera-o-cung-kenh.md (§4).
--
-- Hiện trạng trước file này: collector ghi camera_recorder_current mỗi 60 s và
-- DB sinh camera_events khi trạng thái đổi, nhưng KHÔNG có gì phản ứng. Ổ cứng
-- 512TT lỗi gần 20 ngày mà không ai biết.
--
-- File này thêm một bộ đánh giá chạy bằng pg_cron (lịch ở §11, cùng file):
--   1. đọc camera_recorder_current (KHÔNG quét lịch sử camera_events);
--   2. ghi điều kiện xấu theo (đầu ghi, chủ thể) vào camera_alert_conditions;
--   3. đủ ngưỡng thì mở network_incidents CAMERA_* theo đúng khuôn watchdog
--      (20260729139000), hết lỗi hai lượt liên tiếp mới RECOVERING → RESOLVED;
--   4. gom tin theo người nhận: chuông CRM (notifications CUSTOM/IN_APP) và web
--      push qua pg_net → send-push, chống trùng bằng sổ camera_alert_deliveries.
--
-- An toàn khi phát hành:
--   * camera_alert_settings KHÔNG có dòng nào ⇒ không org nào được đánh giá.
--     Bật = chèn dòng enabled=true, mode='SHADOW' (chạy thử, không mở sự cố,
--     không gửi gì) rồi mới 'LIVE'. Tắt khẩn: enabled=false hoặc unschedule.
--   * Mọi bảng/hàm mới nằm trong app_private, không cấp quyền cho ai; chỉ owner
--     (pg_cron) chạy được. RPC đọc duy nhất cho trình duyệt là
--     public.camera_building_incidents_v1, có kiểm network_center.view theo toà.
--   * Không tham chiếu hàm chỉ có trên production (notify_push_allowed_now_v1
--     của PR #275): giờ yên ban đêm tự làm theo cấu hình của org.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(20261102072602::bigint);

-- Chỉ chặn trên phụ thuộc DDL (khoá ngoại). Bảng chỉ đọc lúc chạy (bảo trì,
-- notifications, pg_net, Vault) nằm trong thân plpgsql nên không chặn ở đây.
DO $requires$
BEGIN
  IF to_regclass('public.camera_recorders') IS NULL
     OR to_regclass('public.camera_recorder_current') IS NULL
     OR to_regclass('public.network_incidents') IS NULL THEN
    RAISE EXCEPTION 'Apply network_center_camera_monitoring_v1 and the Network Center operations migrations first'
      USING ERRCODE = '55000';
  END IF;
END
$requires$;

-- -----------------------------------------------------------------------------
-- 1. Bảng (§4.3). Chỉ hàm SECURITY DEFINER dưới đây đụng tới.
-- -----------------------------------------------------------------------------
-- Khoá ngoại tới organizations là CASCADE: bảng cấu hình/sổ của tính năng này
-- không được trở thành vật cản mới khi dọn một org thử.
CREATE TABLE IF NOT EXISTS app_private.camera_alert_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'LIVE')),
  night_start time NOT NULL DEFAULT '22:00',
  night_end time NOT NULL DEFAULT '07:00',
  digest_at time NOT NULL DEFAULT '08:00',
  thresholds jsonb NOT NULL DEFAULT jsonb_build_object(
    'storageErrorSeconds', 0,
    'recorderOfflineSeconds', 300,
    'authDeniedSeconds', 300,
    'monitorStaleSeconds', 300,
    'monitorGraceSeconds', 120,
    'neverReportedSeconds', 600,
    'channelLostSeconds', 600,
    'recorderUnknownSeconds', 1800,
    'digestMinOpenSeconds', 43200
  ) CHECK (jsonb_typeof(thresholds) = 'object'),
  -- Đợt 1b (Zalo) — chưa dùng.
  zalo_target jsonb CHECK (zalo_target IS NULL OR jsonb_typeof(zalo_target) = 'object'),
  last_digest_on date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (night_start <> night_end)
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
  -- Đã vượt ngưỡng. LIVE: sự cố đã mở (incident_id); SHADOW: sự cố dự kiến.
  opened_at timestamptz,
  incident_id uuid REFERENCES public.network_incidents(id) ON DELETE SET NULL,
  observed jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(observed) = 'object'),
  PRIMARY KEY (recorder_id, subject),
  CHECK (first_seen_at <= last_seen_at)
);
CREATE INDEX IF NOT EXISTS camera_alert_conditions_org_idx
  ON app_private.camera_alert_conditions (organization_id, building_id);

CREATE TABLE IF NOT EXISTS app_private.camera_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  incident_id uuid,
  -- NULL: dòng SHADOW/hoãn/không có người nhận, hoặc kênh Zalo (đợt 1b).
  recipient_user_id uuid,
  channel text NOT NULL CHECK (channel IN ('IN_APP', 'PUSH', 'ZALO')),
  kind text NOT NULL CHECK (kind IN ('OPENED', 'RESOLVED', 'ESCALATED', 'DIGEST', 'NIGHT_DIGEST')),
  dedup_key text NOT NULL UNIQUE CHECK (char_length(dedup_key) BETWEEN 8 AND 300),
  status text NOT NULL CHECK (status IN (
    'SHADOW', 'DEFERRED', 'DONE', 'SENT', 'QUEUED', 'FAILED', 'SUPPRESSED', 'NO_RECIPIENT')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS camera_alert_deliveries_deferred_idx
  ON app_private.camera_alert_deliveries (organization_id, created_at)
  WHERE status = 'DEFERRED';
CREATE INDEX IF NOT EXISTS camera_alert_deliveries_incident_idx
  ON app_private.camera_alert_deliveries (incident_id)
  WHERE incident_id IS NOT NULL;

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['camera_alert_settings', 'camera_alert_conditions', 'camera_alert_deliveries'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END
$tables$;

COMMENT ON TABLE app_private.camera_alert_settings IS
  'Cảnh báo camera theo org. Không có dòng hoặc enabled=false ⇒ bộ đánh giá bỏ qua org (kill switch). mode SHADOW chỉ ghi điều kiện và sổ, không mở sự cố, không gửi gì.';
COMMENT ON TABLE app_private.camera_alert_conditions IS
  'Điều kiện xấu đang theo dõi, một dòng mỗi (đầu ghi, chủ thể). Xoá khi hết lỗi; lịch sử nằm ở network_incidents và camera_alert_deliveries.';
COMMENT ON TABLE app_private.camera_alert_deliveries IS
  'Sổ gửi cảnh báo camera. dedup_key = kind:incident:…:recipient:channel[:ngày] chống gửi trùng; SHADOW/DEFERRED/SUPPRESSED/NO_RECIPIENT ghi lại những gì đã KHÔNG gửi và vì sao.';

-- -----------------------------------------------------------------------------
-- 2. Hàm phụ thuần.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.camera_alert_threshold_v1(
  p_thresholds jsonb, p_key text, p_default integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF jsonb_typeof(p_thresholds -> p_key) = 'number'
     AND (p_thresholds ->> p_key)::numeric BETWEEN 0 AND 604800 THEN
    RETURN round((p_thresholds ->> p_key)::numeric)::integer;
  END IF;
  RETURN p_default;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.camera_alert_code_threshold_v1(p_thresholds jsonb, p_code text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
BEGIN
  RETURN CASE p_code
    WHEN 'CAMERA_STORAGE_ERROR' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'storageErrorSeconds', 0)
    WHEN 'CAMERA_RECORDER_OFFLINE' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'recorderOfflineSeconds', 300)
    WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'authDeniedSeconds', 300)
    -- Điều kiện C4 đã gồm độ cũ ≥ 5 phút; thêm một khoảng chờ ngắn tính từ lượt
    -- đầu thấy cũ, để bật lại theo dõi một đầu ghi (snapshot cũ còn nằm đó tới
    -- khi collector nạp lại danh sách và poll, ~90 s) không thành CRITICAL giả.
    -- Collector chết vẫn lộ trong ≤ 10 phút: 5 phút cũ + ≤ 2 phút cron + 2 phút.
    WHEN 'CAMERA_MONITOR_STALE' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'monitorGraceSeconds', 120)
    WHEN 'CAMERA_CHANNEL_LOST' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'channelLostSeconds', 600)
    WHEN 'CAMERA_RECORDER_UNKNOWN' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'recorderUnknownSeconds', 1800)
    ELSE 0
  END;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.camera_alert_label_v1(
  p_code text, p_recorder_name text, p_observed jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_channel text := coalesce(p_observed ->> 'channel', '?');
  v_name text := nullif(btrim(coalesce(p_observed ->> 'channelName', '')), '');
BEGIN
  RETURN p_recorder_name || ': ' || CASE p_code
    WHEN 'CAMERA_STORAGE_ERROR' THEN 'ổ cứng ' || coalesce(p_observed ->> 'slot', '?') || ' báo lỗi'
    WHEN 'CAMERA_RECORDER_OFFLINE' THEN 'mất kết nối đến đầu ghi'
    WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN 'không đăng nhập được đầu ghi'
    WHEN 'CAMERA_MONITOR_STALE' THEN 'mất dữ liệu giám sát'
    WHEN 'CAMERA_CHANNEL_LOST' THEN
      CASE WHEN v_name IS NULL THEN 'kênh ' || v_channel || ' mất kết nối'
           ELSE 'camera "' || v_name || '" (kênh ' || v_channel || ') mất kết nối' END
    WHEN 'CAMERA_RECORDER_UNKNOWN' THEN 'trạng thái không xác định'
    ELSE lower(p_code)
  END;
END
$fn$;

-- -----------------------------------------------------------------------------
-- 3. Người nhận (§4.5). Gọi lại ở mỗi lần gửi, không cache giữa các lượt.
--    Chạy dưới cron (không JWT) nên KHÔNG gọi helper đọc auth.uid().
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

-- -----------------------------------------------------------------------------
-- 4. Sự cố: mở (khuôn watchdog), chuyển trạng thái, đóng.
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

-- Một sự kiện nội bộ để gom tin cuối lượt.
CREATE OR REPLACE FUNCTION app_private.camera_alert_event_v1(
  p_kind text, p_cond app_private.camera_alert_conditions, p_incident_id uuid,
  p_recorder_name text, p_building_name text, p_maintenance boolean, p_tz text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
BEGIN
  RETURN jsonb_build_object(
    'kind', p_kind,
    'incidentId', p_incident_id,
    'organizationId', p_cond.organization_id,
    'buildingId', p_cond.building_id,
    'buildingName', p_building_name,
    'recorderId', p_cond.recorder_id,
    'recorderName', p_recorder_name,
    'subject', p_cond.subject,
    'code', p_cond.condition_code,
    'severity', p_cond.severity,
    'firstSeenAt', p_cond.first_seen_at,
    'firstSeenEpoch', floor(extract(epoch FROM p_cond.first_seen_at))::bigint,
    'firstSeenLocal', to_char(p_cond.first_seen_at AT TIME ZONE p_tz, 'HH24:MI'),
    'at', p_now,
    'atLocal', to_char(p_now AT TIME ZONE p_tz, 'HH24:MI'),
    'label', app_private.camera_alert_label_v1(p_cond.condition_code, p_recorder_name, p_cond.observed),
    'maintenance', coalesce(p_maintenance, false)
  );
END
$fn$;

-- Vượt ngưỡng: LIVE mở/nhận lại sự cố, SHADOW chỉ đánh dấu "sự cố dự kiến".
-- Trả về sự kiện OPENED cần gom tin, hoặc NULL khi không có gì mới để báo.
CREATE OR REPLACE FUNCTION app_private.camera_alert_open_v1(
  p_cond app_private.camera_alert_conditions, p_severity text, p_live boolean,
  p_device_id uuid, p_recorder_name text, p_building_name text,
  p_maintenance boolean, p_tz text, p_threshold_seconds integer, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_actor constant text := 'camera-alert';
  cond app_private.camera_alert_conditions;
  v_since text;
  v_minutes text;
  v_channel text;
  v_slot text;
  v_name text;
  v_title text;
  v_summary text;
  v_values jsonb;
  v_id uuid;
  v_new boolean;
BEGIN
  UPDATE app_private.camera_alert_conditions c
     SET opened_at = coalesce(c.opened_at, p_now), severity = p_severity
   WHERE c.recorder_id = p_cond.recorder_id AND c.subject = p_cond.subject
  RETURNING * INTO cond;

  IF NOT p_live THEN
    RETURN app_private.camera_alert_event_v1('OPENED', cond, NULL, p_recorder_name, p_building_name, p_maintenance, p_tz, p_now);
  END IF;

  v_since := to_char(cond.first_seen_at AT TIME ZONE p_tz, 'HH24:MI DD/MM');
  v_minutes := greatest(1, round(p_threshold_seconds / 60.0))::text;
  v_channel := coalesce(cond.observed ->> 'channel', '?');
  v_slot := coalesce(cond.observed ->> 'slot', '?');
  v_name := coalesce(nullif(btrim(coalesce(cond.observed ->> 'channelName', '')), ''), 'kênh ' || v_channel);

  CASE cond.condition_code
    WHEN 'CAMERA_STORAGE_ERROR' THEN
      v_title := 'Ổ cứng đầu ghi ' || p_recorder_name || ' báo lỗi';
      v_summary := 'Ổ ' || v_slot || ' của đầu ghi ' || p_recorder_name || ' (' || p_building_name
        || ') báo lỗi từ ' || v_since || ' — đầu ghi có thể không lưu được video. Cần kiểm tra hoặc thay ổ.';
    WHEN 'CAMERA_RECORDER_OFFLINE' THEN
      v_title := 'Mất kết nối đến đầu ghi ' || p_recorder_name;
      v_summary := 'Bộ giám sát không kết nối được đầu ghi ' || p_recorder_name || ' (' || p_building_name
        || ') từ ' || v_since || ', đã quá ' || v_minutes || ' phút. Camera có thể vẫn ghi hình nhưng hệ thống không theo dõi được ổ cứng và kênh.';
    WHEN 'CAMERA_RECORDER_AUTH_DENIED' THEN
      v_title := 'Không đăng nhập được đầu ghi ' || p_recorder_name;
      v_summary := 'Đầu ghi ' || p_recorder_name || ' (' || p_building_name
        || ') từ chối tài khoản giám sát từ ' || v_since || ' (có thể đã đổi mật khẩu). Hệ thống đang không theo dõi được ổ cứng và kênh.';
    WHEN 'CAMERA_MONITOR_STALE' THEN
      v_title := 'Mất dữ liệu giám sát đầu ghi ' || p_recorder_name;
      v_summary := 'Không nhận được trạng thái mới của đầu ghi ' || p_recorder_name || ' (' || p_building_name || ') '
        || CASE WHEN cond.observed ->> 'checkedAt' IS NULL THEN 'kể từ khi đăng ký theo dõi'
                ELSE 'từ ' || to_char((cond.observed ->> 'checkedAt')::timestamptz AT TIME ZONE p_tz, 'HH24:MI DD/MM') END
        || '. Có thể do VPS hoặc bộ thu thập, chưa chắc do đầu ghi.';
    WHEN 'CAMERA_CHANNEL_LOST' THEN
      v_title := 'Camera ' || v_name || ' của đầu ghi ' || p_recorder_name || ' mất kết nối';
      v_summary := 'Kênh ' || v_channel || ' (' || v_name || ') của đầu ghi ' || p_recorder_name || ' (' || p_building_name
        || ') mất kết nối từ ' || v_since || ', đã quá ' || v_minutes || ' phút.';
    ELSE
      v_title := 'Đầu ghi ' || p_recorder_name || ' không xác định được trạng thái';
      v_summary := 'Đầu ghi ' || p_recorder_name || ' (' || p_building_name
        || ') trả trạng thái không xác định từ ' || v_since || ' (ổ cứng hoặc kênh không đọc được), đã quá ' || v_minutes || ' phút.';
  END CASE;

  v_values := cond.observed || jsonb_build_object(
    'recorderId', cond.recorder_id,
    'recorderName', p_recorder_name,
    'subject', cond.subject,
    'firstSeenAt', cond.first_seen_at,
    'thresholdSeconds', p_threshold_seconds,
    'maintenance', coalesce(p_maintenance, false),
    'detectedBy', 'camera-alert'
  );

  INSERT INTO public.network_incidents (
    organization_id, building_id, device_id, interface_id, fingerprint,
    incident_type, severity, status, title, summary, availability_impact,
    opened_at, last_observed_at, occurrence_count, observed_values
  ) VALUES (
    cond.organization_id, cond.building_id, p_device_id, NULL,
    'camera:' || cond.recorder_id::text || ':' || cond.subject,
    cond.condition_code, p_severity, 'OPEN', left(v_title, 200), left(v_summary, 2000), false,
    p_now, p_now, 1, v_values
  )
  ON CONFLICT (organization_id, building_id, fingerprint) WHERE status <> 'RESOLVED'
  DO UPDATE SET
    last_observed_at = greatest(public.network_incidents.last_observed_at, EXCLUDED.last_observed_at)
  RETURNING id, (xmax = 0) INTO v_id, v_new;

  UPDATE app_private.camera_alert_conditions c
     SET incident_id = v_id
   WHERE c.recorder_id = cond.recorder_id AND c.subject = cond.subject;

  IF NOT v_new THEN
    -- Sự cố cùng fingerprint đang mở từ trước (ví dụ sổ điều kiện bị dọn):
    -- nhận lại, không báo lần hai.
    RETURN NULL;
  END IF;

  INSERT INTO public.network_incident_events (
    organization_id, building_id, incident_id, event_seq, event_kind,
    severity, occurred_at, worker_id, details
  ) VALUES (
    cond.organization_id, cond.building_id, v_id, 1, 'OPENED', p_severity, p_now, c_actor,
    jsonb_build_object('thresholdSeconds', p_threshold_seconds, 'firstSeenAt', cond.first_seen_at,
      'detectedBy', 'camera-alert')
  );
  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, action, target_type, target_id,
    target_display, reason, validation, result, outcome, occurred_at
  ) VALUES (
    cond.organization_id, cond.building_id, 'SYSTEM',
    'system.camera_alert_opened', 'camera_recorder', cond.recorder_id,
    jsonb_build_object('recorderName', p_recorder_name, 'subject', cond.subject),
    'Bộ cảnh báo camera mở sự cố',
    jsonb_build_object('thresholdSeconds', p_threshold_seconds),
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

  RETURN app_private.camera_alert_event_v1('OPENED', cond, v_id, p_recorder_name, p_building_name, p_maintenance, p_tz, p_now);
END
$fn$;

-- Bỏ theo dõi một điều kiện KHÔNG phải vì hết lỗi (đầu ghi bị tắt theo dõi,
-- hoặc lỗi cấp đầu ghi che mất nó — bẫy B2). Đóng lặng: không có tin "đã khôi
-- phục", vì "thứ đang canh biến mất" không có nghĩa là "nó đã lành".
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
-- 5. Gửi: chuông + push, một tin cho mỗi người nhận mỗi lô (§4.6).
--    p_items: [{kind, dedup, incidentId, buildingId, line}]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.camera_alert_dispatch_v1(
  p_org uuid, p_batch_kind text, p_items jsonb, p_note text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_batch uuid := gen_random_uuid();
  v_recipients jsonb := '{}'::jsonb;
  v_by_user jsonb := '{}'::jsonb;
  v_item jsonb;
  v_users uuid[];
  v_user uuid;
  v_key text;
  v_list jsonb;
  v_id uuid;
  v_jwt text;
  v_jwt_error text;
  v_jwt_loaded boolean := false;
  v_lines text[];
  v_n_new integer;
  v_n_resolved integer;
  v_subject text;
  v_content text;
  v_url text;
  v_incidents jsonb;
  v_notification uuid;
  v_request bigint;
  v_push_status text;
  v_push_result jsonb;
  v_notified integer := 0;
  v_no_recipient integer := 0;
  v_push_failed integer := 0;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('batchId', NULL, 'notified', 0);
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF NOT v_recipients ? (v_item ->> 'buildingId') THEN
      v_recipients := v_recipients || jsonb_build_object(
        v_item ->> 'buildingId',
        to_jsonb(app_private.network_center_alert_recipient_ids_v1(p_org, (v_item ->> 'buildingId')::uuid)));
    END IF;
    SELECT coalesce(array_agg(x::uuid), '{}'::uuid[]) INTO v_users
      FROM jsonb_array_elements_text(v_recipients -> (v_item ->> 'buildingId')) x;

    IF cardinality(v_users) = 0 THEN
      INSERT INTO app_private.camera_alert_deliveries (
        organization_id, batch_id, incident_id, recipient_user_id, channel, kind,
        dedup_key, status, result, created_at)
      VALUES (p_org, v_batch, nullif(v_item ->> 'incidentId', '')::uuid, NULL, 'IN_APP', v_item ->> 'kind',
        (v_item ->> 'dedup') || ':none:IN_APP', 'NO_RECIPIENT',
        jsonb_build_object('line', v_item ->> 'line', 'buildingId', v_item ->> 'buildingId'), p_now)
      ON CONFLICT (dedup_key) DO NOTHING;
      v_no_recipient := v_no_recipient + 1;
      CONTINUE;
    END IF;

    FOREACH v_user IN ARRAY v_users LOOP
      v_id := NULL;
      INSERT INTO app_private.camera_alert_deliveries (
        organization_id, batch_id, incident_id, recipient_user_id, channel, kind,
        dedup_key, status, result, created_at, sent_at)
      VALUES (p_org, v_batch, nullif(v_item ->> 'incidentId', '')::uuid, v_user, 'IN_APP', v_item ->> 'kind',
        (v_item ->> 'dedup') || ':' || v_user::text || ':IN_APP', 'SENT',
        jsonb_build_object('line', v_item ->> 'line'), p_now, p_now)
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NOT NULL THEN
        v_by_user := jsonb_set(v_by_user, ARRAY[v_user::text],
          coalesce(v_by_user -> (v_user::text), '[]'::jsonb) || jsonb_build_array(v_item), true);
      END IF;
    END LOOP;
  END LOOP;

  FOR v_key, v_list IN SELECT key, value FROM jsonb_each(v_by_user) ORDER BY key LOOP
    v_user := v_key::uuid;

    IF NOT v_jwt_loaded THEN
      -- DB TEST đã đánh dấu hoặc khe Vault trống ⇒ hàm ném lỗi. Chuông vẫn ghi,
      -- lý do vào sổ (khuôn zalo_canh_gac_bao_v1), không nuốt im lặng.
      BEGIN
        v_jwt := app_private.lifecycle_reminder_service_jwt_v1();
      EXCEPTION WHEN OTHERS THEN
        v_jwt := NULL;
        v_jwt_error := left(SQLSTATE || ': ' || SQLERRM, 300);
      END;
      v_jwt_loaded := true;
    END IF;

    SELECT array_agg(x.value ->> 'line' ORDER BY x.ordinality) INTO v_lines
      FROM jsonb_array_elements(v_list) WITH ORDINALITY x;
    SELECT count(*) FILTER (WHERE x.value ->> 'kind' IN ('OPENED', 'ESCALATED')),
           count(*) FILTER (WHERE x.value ->> 'kind' = 'RESOLVED')
      INTO v_n_new, v_n_resolved
      FROM jsonb_array_elements(v_list) x;
    SELECT coalesce(jsonb_agg(DISTINCT x.value -> 'incidentId') FILTER (WHERE x.value ->> 'incidentId' IS NOT NULL), '[]'::jsonb)
      INTO v_incidents
      FROM jsonb_array_elements(v_list) x;

    v_subject := CASE p_batch_kind
      WHEN 'DIGEST' THEN 'Camera: ' || cardinality(v_lines) || ' sự cố chưa xử lý quá 12 giờ'
      WHEN 'NIGHT_DIGEST' THEN 'Camera: bản tin đêm qua · ' || cardinality(v_lines) || ' mục'
      ELSE CASE
        WHEN v_n_new > 0 AND v_n_resolved > 0 THEN 'Camera: ' || v_n_new || ' sự cố mới, ' || v_n_resolved || ' đã khôi phục'
        WHEN v_n_new > 0 THEN 'Camera: ' || v_n_new || ' sự cố mới'
        ELSE 'Camera: ' || v_n_resolved || ' sự cố đã khôi phục'
      END
    END;
    v_content := array_to_string(v_lines[1:12], E'\n')
      || CASE WHEN cardinality(v_lines) > 12 THEN E'\n… và ' || (cardinality(v_lines) - 12) || ' mục khác' ELSE '' END
      || CASE WHEN p_note IS NOT NULL THEN E'\n' || p_note ELSE '' END;
    -- Nhiều toà: đường dẫn trỏ toà đầu tiên, nội dung liệt kê đủ.
    v_url := '/network-center/buildings/' || (v_list -> 0 ->> 'buildingId') || '?tab=cameras';

    INSERT INTO public.notifications (
      organization_id, user_id, type, channel, status, subject, content, metadata)
    VALUES (p_org, v_user, 'CUSTOM', 'IN_APP', 'PENDING', v_subject, v_content,
      jsonb_build_object('v5', 'camera_alert', 'kind', p_batch_kind, 'url', v_url,
        'incidentIds', v_incidents, 'batchId', v_batch))
    RETURNING id INTO v_notification;

    UPDATE app_private.camera_alert_deliveries d
       SET result = d.result || jsonb_build_object('notificationId', v_notification)
     WHERE d.batch_id = v_batch AND d.recipient_user_id = v_user AND d.channel = 'IN_APP';

    IF v_jwt IS NOT NULL THEN
      -- pg_net xếp yêu cầu, gửi sau khi giao dịch commit; idempotencyKey chặn gửi lặp.
      v_request := net.http_post(
        url := 'https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/send-push',
        body := jsonb_build_object(
          'userId', v_user, 'title', v_subject, 'body', left(v_content, 600),
          'url', v_url, 'tag', 'camera-alert',
          'idempotencyKey', left('camera-alert:' || v_batch::text || ':' || v_user::text, 128)),
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_jwt, 'Content-Type', 'application/json'),
        timeout_milliseconds := 30000);
      v_push_status := 'QUEUED';
      v_push_result := jsonb_build_object('requestId', v_request, 'batchId', v_batch);
    ELSE
      v_push_status := 'FAILED';
      v_push_result := jsonb_build_object('error', v_jwt_error, 'batchId', v_batch);
      v_push_failed := v_push_failed + 1;
    END IF;

    INSERT INTO app_private.camera_alert_deliveries (
      organization_id, batch_id, incident_id, recipient_user_id, channel, kind,
      dedup_key, status, result, created_at, sent_at)
    SELECT p_org, v_batch, nullif(x.value ->> 'incidentId', '')::uuid, v_user, 'PUSH', x.value ->> 'kind',
      (x.value ->> 'dedup') || ':' || v_user::text || ':PUSH', v_push_status, v_push_result, p_now,
      CASE WHEN v_push_status = 'QUEUED' THEN p_now END
      FROM jsonb_array_elements(v_list) x
    ON CONFLICT (dedup_key) DO NOTHING;

    v_notified := v_notified + 1;
  END LOOP;

  RETURN jsonb_build_object('batchId', v_batch, 'notified', v_notified,
    'noRecipient', v_no_recipient, 'pushFailed', v_push_failed, 'pushError', v_jwt_error);
END
$fn$;

-- -----------------------------------------------------------------------------
-- 6. Một lượt cho một org.
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
  v_org uuid := p_settings.organization_id;
  v_live boolean := p_settings.mode = 'LIVE';
  v_tz text := app_private.org_timezone_v1(p_settings.organization_id);
  v_local timestamp := p_now AT TIME ZONE app_private.org_timezone_v1(p_settings.organization_id);
  v_local_date date;
  v_local_time time;
  v_in_night boolean;
  v_th jsonb := p_settings.thresholds;
  v_never integer;
  v_stale_min integer;
  v_channel_threshold integer;
  rec record;
  obs record;
  cond app_private.camera_alert_conditions;
  inc public.network_incidents%ROWTYPE;
  v_found boolean;
  v_fresh boolean;
  v_stale_limit integer;
  v_maint boolean;
  v_blocked boolean;
  v_due boolean;
  v_ev jsonb;
  v_events jsonb := '[]'::jsonb;
  v_due_subjects text[];
  v_configured integer;
  v_lost integer;
  v_severity text;
  v_immediate jsonb := '[]'::jsonb;
  v_items jsonb;
  v_note text;
  v_result jsonb;
  v_dispatch jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_n_opened integer := 0;
  v_n_recovering integer := 0;
  v_n_resolved integer := 0;
  v_n_retired integer := 0;
  v_n_escalated integer := 0;
  v_n_deferred integer := 0;
  v_n_suppressed integer := 0;
  v_n_shadow integer := 0;
  v_recorders integer := 0;
BEGIN
  v_local_date := v_local::date;
  v_local_time := v_local::time;
  v_in_night := CASE WHEN p_settings.night_start < p_settings.night_end
    THEN v_local_time >= p_settings.night_start AND v_local_time < p_settings.night_end
    ELSE v_local_time >= p_settings.night_start OR v_local_time < p_settings.night_end END;
  v_never := app_private.camera_alert_threshold_v1(v_th, 'neverReportedSeconds', 600);
  v_stale_min := app_private.camera_alert_threshold_v1(v_th, 'monitorStaleSeconds', 300);
  v_channel_threshold := app_private.camera_alert_code_threshold_v1(v_th, 'CAMERA_CHANNEL_LOST');

  FOR rec IN
    SELECT r.id, r.organization_id, r.building_id, r.display_name, r.enabled, r.channel_count,
      r.stale_after_seconds, r.created_at, bl.name AS building_name,
      (r.enabled AND bl.deleted_at IS NULL AND coalesce(s.monitoring_enabled, true)
        AND coalesce(n.is_enabled, true)) AS monitored,
      (d.id IS NOT NULL AND d.is_active AND d.device_kind = 'MIKROTIK'
        AND d.organization_id = r.organization_id AND d.building_id = r.building_id) AS device_ok,
      n.device_id, conn.poll_interval_seconds,
      cur.status, cur.checked_at, cur.received_at, cur.channels, cur.storage
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
    v_recorders := v_recorders + 1;

    -- Đầu ghi bị tắt theo dõi: không xét, đóng mọi sự cố đang mở (DISABLED).
    IF NOT rec.monitored THEN
      FOR cond IN SELECT * FROM app_private.camera_alert_conditions c WHERE c.recorder_id = rec.id FOR UPDATE LOOP
        PERFORM app_private.camera_alert_retire_v1(cond, 'DISABLED', p_now);
        v_n_retired := v_n_retired + 1;
      END LOOP;
      CONTINUE;
    END IF;

    -- Router của connection đã gỡ: network_incidents.device_id NOT NULL nên không
    -- mở được sự cố, và collector cũng thôi poll đầu ghi này. Bỏ qua, không ném
    -- lỗi cả lượt; sự cố cũ đóng lặng như đầu ghi bị tắt theo dõi (không thì
    -- nó mở mãi và bản tin 08:00 nhắc hằng ngày). Log một lần lúc đóng.
    IF NOT rec.device_ok THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('recorderId', rec.id, 'reason', 'ROUTER_UNAVAILABLE'));
      FOR cond IN SELECT * FROM app_private.camera_alert_conditions c WHERE c.recorder_id = rec.id FOR UPDATE LOOP
        RAISE WARNING 'camera alert: recorder % has no usable router device; closing %', rec.id, cond.subject;
        PERFORM app_private.camera_alert_retire_v1(cond, 'ROUTER_UNAVAILABLE', p_now);
        v_n_retired := v_n_retired + 1;
      END LOOP;
      CONTINUE;
    END IF;

    -- Độ cũ tối thiểu 5 phút, và không nhỏ hơn hai chu kỳ poll của chính đầu ghi
    -- (poll dài hơn thì một snapshot đúng hạn không bị coi là mất dữ liệu).
    -- Mốc là lần muộn hơn giữa giờ đo (đồng hồ collector) và giờ CRM nhận:
    -- đồng hồ VPS chậm vài phút không được biến mọi đầu ghi thành C4 giả;
    -- collector chết thì cả hai cùng cũ.
    v_stale_limit := greatest(rec.stale_after_seconds, v_stale_min, 2 * coalesce(rec.poll_interval_seconds, 60));
    v_fresh := rec.checked_at IS NOT NULL
      AND p_now - greatest(rec.checked_at, rec.received_at) < make_interval(secs => v_stale_limit);
    v_maint := EXISTS (
      SELECT 1 FROM public.network_maintenance_windows w
       WHERE w.organization_id = rec.organization_id AND w.building_id = rec.building_id
         AND w.status IN ('SCHEDULED', 'ACTIVE') AND w.starts_at <= p_now AND w.ends_at > p_now);
    v_blocked := NULL;

    FOR obs IN
      SELECT x.ord, x.subject, x.code, x.verdict, x.detail FROM (
        SELECT 1 AS ord, 'monitor'::text AS subject, 'CAMERA_MONITOR_STALE'::text AS code,
          CASE WHEN rec.checked_at IS NULL THEN
                 CASE WHEN p_now - rec.created_at >= make_interval(secs => v_never) THEN 'BAD' ELSE 'HOLD' END
               WHEN v_fresh THEN 'GOOD' ELSE 'BAD' END AS verdict,
          jsonb_build_object('checkedAt', rec.checked_at, 'staleAfterSeconds', v_stale_limit) AS detail
        UNION ALL
        -- C2 hết khi đầu ghi đã kết nối lại được, kể cả khi trả UNKNOWN hay
        -- AUTH_DENIED: giữ C2 lúc đó vừa sai nguyên nhân vừa che mất C3/C6 (B2).
        SELECT 2, 'recorder:offline', 'CAMERA_RECORDER_OFFLINE',
          CASE WHEN NOT v_fresh THEN 'HOLD' WHEN rec.status = 'OFFLINE' THEN 'BAD'
               WHEN rec.status IN ('ONLINE', 'UNKNOWN', 'AUTH_DENIED') THEN 'GOOD' ELSE 'HOLD' END,
          jsonb_build_object('status', rec.status)
        UNION ALL
        -- C3 hết khi đầu ghi nhận tài khoản; OFFLINE thì chưa biết ⇒ HOLD.
        SELECT 3, 'recorder:auth', 'CAMERA_RECORDER_AUTH_DENIED',
          CASE WHEN NOT v_fresh THEN 'HOLD' WHEN rec.status = 'AUTH_DENIED' THEN 'BAD'
               WHEN rec.status IN ('ONLINE', 'UNKNOWN') THEN 'GOOD' ELSE 'HOLD' END,
          jsonb_build_object('status', rec.status)
        UNION ALL
        SELECT 4, 'recorder:unknown', 'CAMERA_RECORDER_UNKNOWN',
          CASE WHEN NOT v_fresh THEN 'HOLD' WHEN rec.status = 'UNKNOWN' THEN 'BAD'
               WHEN rec.status = 'ONLINE' THEN 'GOOD' ELSE 'HOLD' END,
          jsonb_build_object('status', rec.status)
        UNION ALL
        -- B1: ổ lỗi hay kênh mất thì đầu ghi VẪN ONLINE ⇒ đọc từng phần tử.
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
      END IF;
      CONTINUE WHEN obs.ord >= 4 AND v_blocked;

      SELECT * INTO cond FROM app_private.camera_alert_conditions c
       WHERE c.recorder_id = rec.id AND c.subject = obs.subject FOR UPDATE;
      v_found := FOUND;

      IF obs.verdict = 'BAD' THEN
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
                 -- Lượt đánh giá bị gián đoạn (cron dừng, org tắt rồi bật lại):
                 -- chưa vượt ngưỡng thì đếm lại từ đầu, không coi là "liên tục".
                 first_seen_at = CASE WHEN c.opened_at IS NULL AND c.last_seen_at < p_now - interval '15 minutes'
                                      THEN p_now ELSE c.first_seen_at END,
                 clear_streak = 0,
                 observed = obs.detail
           WHERE c.recorder_id = rec.id AND c.subject = obs.subject
          RETURNING * INTO cond;

          IF cond.incident_id IS NOT NULL THEN
            SELECT * INTO inc FROM public.network_incidents i WHERE i.id = cond.incident_id;
            IF NOT FOUND OR inc.status = 'RESOLVED' THEN
              -- Sự cố bị đóng ngoài bộ này mà lỗi vẫn còn: mở lại ở dưới.
              UPDATE app_private.camera_alert_conditions c SET incident_id = NULL
               WHERE c.recorder_id = rec.id AND c.subject = obs.subject
              RETURNING * INTO cond;
            ELSE
              IF inc.status = 'RECOVERING' THEN
                PERFORM app_private.camera_alert_transition_v1(inc.id, 'RELAPSE', p_now, '{}'::jsonb);
              END IF;
              -- Mở trong cửa sổ bảo trì thì chưa báo; hết bảo trì mà lỗi còn
              -- thì báo ngay lượt này (sổ chống trùng giữ cho chỉ một lần).
              IF coalesce((inc.observed_values ->> 'maintenance')::boolean, false) AND NOT v_maint THEN
                UPDATE public.network_incidents i
                   SET observed_values = i.observed_values || jsonb_build_object('maintenance', false),
                       version = i.version + 1
                 WHERE i.id = inc.id;
                v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                  'OPENED', cond, inc.id, rec.display_name, rec.building_name, false, v_tz, p_now));
              END IF;
            END IF;
          END IF;
        END IF;

        -- Kênh mất mở ở bước gom bên dưới để tính mức theo tỷ lệ kênh.
        IF obs.code <> 'CAMERA_CHANNEL_LOST' THEN
          v_due := CASE WHEN v_live
            THEN cond.incident_id IS NULL AND (cond.opened_at IS NOT NULL
              OR p_now - cond.first_seen_at >= make_interval(secs => app_private.camera_alert_code_threshold_v1(v_th, obs.code)))
            ELSE cond.opened_at IS NULL
              AND p_now - cond.first_seen_at >= make_interval(secs => app_private.camera_alert_code_threshold_v1(v_th, obs.code))
          END;
          IF v_due THEN
            v_ev := app_private.camera_alert_open_v1(cond, cond.severity, v_live, rec.device_id,
              rec.display_name, rec.building_name, v_maint, v_tz,
              app_private.camera_alert_code_threshold_v1(v_th, obs.code), p_now);
            IF v_ev IS NOT NULL THEN
              v_events := v_events || jsonb_build_array(v_ev);
              v_n_opened := v_n_opened + 1;
            END IF;
          END IF;
        END IF;

      ELSIF obs.verdict = 'GOOD' THEN
        IF v_found THEN
          IF cond.opened_at IS NULL THEN
            -- Chưa vượt ngưỡng (rớt chập chờn vài giây): bỏ, không báo gì.
            DELETE FROM app_private.camera_alert_conditions c
             WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
          ELSIF cond.clear_streak + 1 >= 2 THEN
            -- Lượt tốt thứ hai liên tiếp: đóng hẳn.
            IF cond.incident_id IS NOT NULL THEN
              IF app_private.camera_alert_transition_v1(cond.incident_id, 'RESOLVED', p_now,
                   jsonb_build_object('reason', 'RECOVERED')) THEN
                v_n_resolved := v_n_resolved + 1;
                -- Chỉ báo khôi phục cho sự cố đã từng được báo mở.
                IF EXISTS (
                  SELECT 1 FROM app_private.camera_alert_deliveries dl
                   WHERE dl.incident_id = cond.incident_id
                     AND dl.kind IN ('OPENED', 'ESCALATED', 'NIGHT_DIGEST')
                     AND dl.status IN ('SENT', 'DEFERRED', 'DONE')) THEN
                  v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                    'RESOLVED', cond, cond.incident_id, rec.display_name, rec.building_name, v_maint, v_tz, p_now));
                END IF;
              END IF;
            ELSIF NOT v_live THEN
              v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                'RESOLVED', cond, NULL, rec.display_name, rec.building_name, v_maint, v_tz, p_now));
            END IF;
            DELETE FROM app_private.camera_alert_conditions c
             WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
          ELSE
            -- Lượt tốt đầu tiên: RECOVERING, chưa báo.
            UPDATE app_private.camera_alert_conditions c SET clear_streak = c.clear_streak + 1
             WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
            IF cond.incident_id IS NOT NULL
               AND app_private.camera_alert_transition_v1(cond.incident_id, 'RECOVERING', p_now, '{}'::jsonb) THEN
              v_n_recovering := v_n_recovering + 1;
            END IF;
          END IF;
        END IF;

      ELSE
        -- HOLD: không có bằng chứng tốt hay xấu ⇒ không đếm lượt khôi phục.
        IF v_found AND cond.clear_streak <> 0 THEN
          UPDATE app_private.camera_alert_conditions c SET clear_streak = 0
           WHERE c.recorder_id = rec.id AND c.subject = obs.subject;
        END IF;
      END IF;
    END LOOP;

    -- C5: mở các kênh vừa đủ ngưỡng, mức theo tỷ lệ kênh cùng mất (≥ 50 % ⇒ CRITICAL).
    IF NOT coalesce(v_blocked, false) THEN
      SELECT coalesce(array_agg(c.subject ORDER BY c.subject), '{}'::text[]) INTO v_due_subjects
        FROM app_private.camera_alert_conditions c
       WHERE c.recorder_id = rec.id AND c.condition_code = 'CAMERA_CHANNEL_LOST'
         AND c.last_seen_at = p_now
         AND CASE WHEN v_live
               THEN c.incident_id IS NULL AND (c.opened_at IS NOT NULL
                 OR p_now - c.first_seen_at >= make_interval(secs => v_channel_threshold))
               ELSE c.opened_at IS NULL AND p_now - c.first_seen_at >= make_interval(secs => v_channel_threshold)
             END;
      SELECT count(*) INTO v_configured
        FROM jsonb_array_elements(coalesce(rec.channels, '[]'::jsonb)) ch
       WHERE ch.value ->> 'state' IN ('CONNECTED', 'DISCONNECTED');
      -- Chỉ đếm kênh đang mất ở CHÍNH lượt này (kênh đang hồi phục hay HOLD
      -- không làm vượt ngưỡng 50 %).
      SELECT count(*) INTO v_lost
        FROM app_private.camera_alert_conditions c
       WHERE c.recorder_id = rec.id AND c.condition_code = 'CAMERA_CHANNEL_LOST'
         AND c.last_seen_at = p_now AND c.clear_streak = 0
         AND (c.opened_at IS NOT NULL OR c.subject = ANY(v_due_subjects));
      v_severity := CASE WHEN v_configured > 0 AND v_lost * 2 >= v_configured THEN 'CRITICAL' ELSE 'WARNING' END;

      FOR cond IN
        SELECT * FROM app_private.camera_alert_conditions c
         WHERE c.recorder_id = rec.id AND c.subject = ANY(v_due_subjects)
         ORDER BY c.subject FOR UPDATE
      LOOP
        v_ev := app_private.camera_alert_open_v1(cond, v_severity, v_live, rec.device_id,
          rec.display_name, rec.building_name, v_maint, v_tz, v_channel_threshold, p_now);
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
             AND NOT (c.subject = ANY(v_due_subjects))
           ORDER BY c.subject FOR UPDATE
        LOOP
          UPDATE app_private.camera_alert_conditions c SET severity = 'CRITICAL'
           WHERE c.recorder_id = cond.recorder_id AND c.subject = cond.subject
          RETURNING * INTO cond;
          IF cond.incident_id IS NOT NULL THEN
            IF app_private.camera_alert_transition_v1(cond.incident_id, 'ESCALATE', p_now, '{}'::jsonb) THEN
              v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
                'ESCALATED', cond, cond.incident_id, rec.display_name, rec.building_name, v_maint, v_tz, p_now));
              v_n_escalated := v_n_escalated + 1;
            END IF;
          ELSIF NOT v_live THEN
            v_events := v_events || jsonb_build_array(app_private.camera_alert_event_v1(
              'ESCALATED', cond, NULL, rec.display_name, rec.building_name, v_maint, v_tz, p_now));
            v_n_escalated := v_n_escalated + 1;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- SHADOW: chỉ ghi sổ "sự cố dự kiến", kèm người lẽ ra nhận. Không mở sự cố,
  -- không chèn chuông, không gọi push.
  -- ---------------------------------------------------------------------------
  IF NOT v_live THEN
    FOR v_ev IN SELECT value FROM jsonb_array_elements(v_events) LOOP
      INSERT INTO app_private.camera_alert_deliveries (
        organization_id, batch_id, incident_id, recipient_user_id, channel, kind,
        dedup_key, status, result, created_at)
      VALUES (v_org, gen_random_uuid(), NULL, NULL, 'IN_APP', v_ev ->> 'kind',
        'SHADOW:' || (v_ev ->> 'kind') || ':' || (v_ev ->> 'recorderId') || ':' || (v_ev ->> 'subject')
          || ':' || (v_ev ->> 'firstSeenEpoch'),
        'SHADOW',
        v_ev || jsonb_build_object(
          'wouldDefer', v_ev ->> 'severity' = 'WARNING' AND v_in_night,
          'wouldNotify', to_jsonb(app_private.network_center_alert_recipient_ids_v1(
            v_org, (v_ev ->> 'buildingId')::uuid))),
        p_now)
      ON CONFLICT (dedup_key) DO NOTHING;
      v_n_shadow := v_n_shadow + 1;
    END LOOP;
    RETURN jsonb_build_object('organizationId', v_org, 'mode', 'SHADOW', 'recorders', v_recorders,
      'opened', v_n_opened, 'recovering', v_n_recovering, 'resolved', v_n_resolved,
      'retired', v_n_retired, 'escalated', v_n_escalated, 'shadowRows', v_n_shadow,
      'skippedRecorders', v_skipped);
  END IF;

  -- ---------------------------------------------------------------------------
  -- LIVE: phân loại sự kiện của lượt này.
  -- ---------------------------------------------------------------------------
  FOR v_ev IN SELECT value FROM jsonb_array_elements(v_events) LOOP
    IF (v_ev ->> 'maintenance')::boolean THEN
      -- Bảo trì đang hiệu lực: vẫn có sự cố, không có tin.
      INSERT INTO app_private.camera_alert_deliveries (
        organization_id, batch_id, incident_id, recipient_user_id, channel, kind,
        dedup_key, status, result, created_at)
      VALUES (v_org, gen_random_uuid(), (v_ev ->> 'incidentId')::uuid, NULL, 'IN_APP', v_ev ->> 'kind',
        (v_ev ->> 'kind') || ':' || (v_ev ->> 'incidentId') || ':maintenance:' || (v_ev ->> 'atLocal'),
        'SUPPRESSED', v_ev, p_now)
      ON CONFLICT (dedup_key) DO NOTHING;
      v_n_suppressed := v_n_suppressed + 1;
    ELSIF v_ev ->> 'severity' = 'WARNING' AND v_in_night THEN
      -- WARNING ban đêm: dồn bản tin lúc night_end (Q6).
      INSERT INTO app_private.camera_alert_deliveries (
        organization_id, batch_id, incident_id, recipient_user_id, channel, kind,
        dedup_key, status, result, created_at)
      VALUES (v_org, gen_random_uuid(), (v_ev ->> 'incidentId')::uuid, NULL, 'IN_APP', 'NIGHT_DIGEST',
        'NIGHT_DIGEST:' || (v_ev ->> 'kind') || ':' || (v_ev ->> 'incidentId') || ':pending',
        'DEFERRED', v_ev, p_now)
      ON CONFLICT (dedup_key) DO NOTHING;
      v_n_deferred := v_n_deferred + 1;
    ELSE
      -- CRITICAL: gửi ngay ở mọi giờ, bỏ qua giờ yên (Q6).
      v_immediate := v_immediate || jsonb_build_array(jsonb_build_object(
        'kind', v_ev ->> 'kind',
        'dedup', (v_ev ->> 'kind') || ':' || (v_ev ->> 'incidentId'),
        'incidentId', v_ev ->> 'incidentId',
        'buildingId', v_ev ->> 'buildingId',
        'line', (v_ev ->> 'buildingName') || ' · ' || CASE v_ev ->> 'kind'
          WHEN 'RESOLVED' THEN 'Đã khôi phục: ' || (v_ev ->> 'label')
          WHEN 'ESCALATED' THEN 'Nhiều kênh cùng mất — ' || (v_ev ->> 'label')
          ELSE (v_ev ->> 'label') || ' (từ ' || (v_ev ->> 'firstSeenLocal') || ')'
        END));
    END IF;
  END LOOP;

  IF jsonb_array_length(v_immediate) > 0 THEN
    -- Nhiều đầu ghi cùng mất dữ liệu trong một lượt: lỗi chung phía thu thập.
    SELECT CASE WHEN count(*) >= 2
      THEN 'Nhiều đầu ghi cùng mất dữ liệu giám sát — có thể do VPS hoặc bộ thu thập, không phải lỗi từng đầu ghi.' END
      INTO v_note
      FROM jsonb_array_elements(v_events) e
     WHERE e.value ->> 'kind' = 'OPENED' AND e.value ->> 'code' = 'CAMERA_MONITOR_STALE';
    v_result := app_private.camera_alert_dispatch_v1(v_org, 'IMMEDIATE', v_immediate, v_note, p_now);
    v_dispatch := v_dispatch || jsonb_build_array(v_result || jsonb_build_object('kind', 'IMMEDIATE'));
  END IF;

  -- Hết khung đêm: gửi gộp những gì đã hoãn. Dòng hoãn quá 24 giờ (org bị tắt
  -- hoặc chuyển SHADOW qua đêm) chỉ đóng sổ, không gửi một bản tin đã cũ.
  IF NOT v_in_night THEN
    UPDATE app_private.camera_alert_deliveries d
       SET status = 'DONE', sent_at = p_now, result = d.result || jsonb_build_object('skipped', 'EXPIRED')
     WHERE d.organization_id = v_org AND d.status = 'DEFERRED' AND d.created_at < p_now - interval '24 hours';
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'NIGHT_DIGEST',
        'dedup', 'NIGHT_DIGEST:' || (d.result ->> 'kind') || ':' || (d.result ->> 'incidentId') || ':' || v_local_date::text,
        'incidentId', d.result ->> 'incidentId',
        'buildingId', d.result ->> 'buildingId',
        'line', (d.result ->> 'buildingName') || ' · ' || CASE d.result ->> 'kind'
          WHEN 'RESOLVED' THEN 'Đã khôi phục: ' || (d.result ->> 'label') || ' (' || (d.result ->> 'atLocal') || ')'
          ELSE (d.result ->> 'label') || ' (từ ' || (d.result ->> 'firstSeenLocal') || ')'
        END) ORDER BY d.created_at, d.id), '[]'::jsonb)
      INTO v_items
      FROM app_private.camera_alert_deliveries d
     WHERE d.organization_id = v_org AND d.status = 'DEFERRED';
    IF jsonb_array_length(v_items) > 0 THEN
      v_result := app_private.camera_alert_dispatch_v1(v_org, 'NIGHT_DIGEST', v_items, NULL, p_now);
      v_dispatch := v_dispatch || jsonb_build_array(v_result || jsonb_build_object('kind', 'NIGHT_DIGEST'));
      UPDATE app_private.camera_alert_deliveries d
         SET status = 'DONE', sent_at = p_now,
             result = d.result || jsonb_build_object('digestBatchId', v_result ->> 'batchId')
       WHERE d.organization_id = v_org AND d.status = 'DEFERRED';
    END IF;
  END IF;

  -- Bản tin hằng ngày: sự cố mở ≥ 12 giờ, chưa ghi nhận, toà không bảo trì.
  IF p_settings.last_digest_on IS DISTINCT FROM v_local_date
     AND v_local >= v_local_date + p_settings.digest_at
     AND v_local < v_local_date + p_settings.digest_at + interval '1 hour' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'DIGEST',
        'dedup', 'DIGEST:' || i.id::text || ':' || v_local_date::text,
        'incidentId', i.id,
        'buildingId', i.building_id,
        'line', bl.name || ' · ' || i.title || ' (từ ' || to_char(i.opened_at AT TIME ZONE v_tz, 'HH24:MI DD/MM') || ')'
      ) ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, i.opened_at, i.id), '[]'::jsonb)
      INTO v_items
      FROM public.network_incidents i
      JOIN public.buildings bl ON bl.id = i.building_id
     WHERE i.organization_id = v_org
       AND left(i.incident_type, 7) = 'CAMERA_'
       AND i.status IN ('OPEN', 'RECOVERING')
       AND i.acknowledged_at IS NULL
       AND i.opened_at <= p_now - make_interval(secs => app_private.camera_alert_threshold_v1(v_th, 'digestMinOpenSeconds', 43200))
       AND NOT EXISTS (
         SELECT 1 FROM public.network_maintenance_windows w
          WHERE w.organization_id = i.organization_id AND w.building_id = i.building_id
            AND w.status IN ('SCHEDULED', 'ACTIVE') AND w.starts_at <= p_now AND w.ends_at > p_now);
    IF jsonb_array_length(v_items) > 0 THEN
      v_result := app_private.camera_alert_dispatch_v1(v_org, 'DIGEST', v_items, NULL, p_now);
      v_dispatch := v_dispatch || jsonb_build_array(v_result || jsonb_build_object('kind', 'DIGEST'));
    END IF;
    UPDATE app_private.camera_alert_settings st
       SET last_digest_on = v_local_date, updated_at = clock_timestamp()
     WHERE st.organization_id = v_org;
  END IF;

  RETURN jsonb_build_object('organizationId', v_org, 'mode', 'LIVE', 'recorders', v_recorders,
    'opened', v_n_opened, 'recovering', v_n_recovering, 'resolved', v_n_resolved,
    'retired', v_n_retired, 'escalated', v_n_escalated, 'deferred', v_n_deferred,
    'suppressed', v_n_suppressed, 'dispatch', v_dispatch, 'skippedRecorders', v_skipped);
END
$fn$;

-- -----------------------------------------------------------------------------
-- 7. Điểm vào của cron. Advisory lock riêng ⇒ không chạy chồng. p_now chỉ để
--    kiểm thử; hàm không cấp cho vai nào ngoài owner.
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
  IF NOT pg_try_advisory_xact_lock(20261102072610::bigint) THEN
    RETURN jsonb_build_object('schemaVersion', 1, 'at', p_now, 'skipped', true, 'skipReason', 'CONCURRENT_RUN');
  END IF;
  FOR s IN
    SELECT * FROM app_private.camera_alert_settings st WHERE st.enabled ORDER BY st.organization_id FOR UPDATE
  LOOP
    v_orgs := v_orgs || jsonb_build_array(app_private.camera_alert_evaluate_org_v1(s, p_now));
  END LOOP;
  RETURN jsonb_build_object('schemaVersion', 1, 'at', p_now, 'skipped', false, 'organizations', v_orgs);
END
$fn$;

COMMENT ON FUNCTION app_private.camera_alert_evaluate_v1(timestamptz) IS
  'Một lượt cảnh báo camera (pg_cron camera-alert-evaluate, */2). Chỉ đọc camera_recorder_current; org không có dòng camera_alert_settings enabled thì không làm gì.';

-- -----------------------------------------------------------------------------
-- 8. RPC đọc cho tab Camera: sự cố CAMERA_* đang mở của một toà.
-- -----------------------------------------------------------------------------
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
  'Sự cố camera (CAMERA_*) chưa đóng của một toà, cho tab Camera. SECURITY INVOKER, đòi network_center.view ở đúng toà; RLS của network_incidents vẫn áp.';

-- -----------------------------------------------------------------------------
-- 9. Quyền. Baseline không mang GRANT/REVOKE nên tự cắt lại đủ ba vai.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  app_private.camera_alert_threshold_v1(jsonb, text, integer),
  app_private.camera_alert_code_threshold_v1(jsonb, text),
  app_private.camera_alert_label_v1(text, text, jsonb),
  app_private.network_center_alert_recipient_ids_v1(uuid, uuid),
  app_private.camera_alert_transition_v1(uuid, text, timestamptz, jsonb),
  app_private.camera_alert_event_v1(text, app_private.camera_alert_conditions, uuid, text, text, boolean, text, timestamptz),
  app_private.camera_alert_open_v1(app_private.camera_alert_conditions, text, boolean, uuid, text, text, boolean, text, integer, timestamptz),
  app_private.camera_alert_retire_v1(app_private.camera_alert_conditions, text, timestamptz),
  app_private.camera_alert_dispatch_v1(uuid, text, jsonb, text, timestamptz),
  app_private.camera_alert_evaluate_org_v1(app_private.camera_alert_settings, timestamptz),
  app_private.camera_alert_evaluate_v1(timestamptz),
  public.camera_building_incidents_v1(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.camera_building_incidents_v1(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. Tự kiểm trước commit (catalog, chạy được trên database rỗng).
-- -----------------------------------------------------------------------------
DO $kiem$
DECLARE
  v_fn text;
  v_role text;
  v_tbl text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'app_private.camera_alert_threshold_v1(jsonb,text,integer)',
    'app_private.camera_alert_code_threshold_v1(jsonb,text)',
    'app_private.camera_alert_label_v1(text,text,jsonb)',
    'app_private.network_center_alert_recipient_ids_v1(uuid,uuid)',
    'app_private.camera_alert_transition_v1(uuid,text,timestamptz,jsonb)',
    'app_private.camera_alert_event_v1(text,app_private.camera_alert_conditions,uuid,text,text,boolean,text,timestamptz)',
    'app_private.camera_alert_open_v1(app_private.camera_alert_conditions,text,boolean,uuid,text,text,boolean,text,integer,timestamptz)',
    'app_private.camera_alert_retire_v1(app_private.camera_alert_conditions,text,timestamptz)',
    'app_private.camera_alert_dispatch_v1(uuid,text,jsonb,text,timestamptz)',
    'app_private.camera_alert_evaluate_org_v1(app_private.camera_alert_settings,timestamptz)',
    'app_private.camera_alert_evaluate_v1(timestamptz)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'Thiếu hàm %. DỪNG.', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% vẫn gọi được %. DỪNG.', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('anon', 'public.camera_building_incidents_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.camera_building_incidents_v1(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.camera_building_incidents_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL của camera_building_incidents_v1 sai. DỪNG.';
  END IF;

  FOREACH v_tbl IN ARRAY ARRAY[
    'app_private.camera_alert_settings', 'app_private.camera_alert_conditions', 'app_private.camera_alert_deliveries'
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
          OR (n.nspname = 'public' AND p.proname = 'camera_building_incidents_v1')) <> 12 THEN
    RAISE EXCEPTION 'Số hàm cảnh báo camera khác 12 (overload sót?). DỪNG.';
  END IF;
END
$kiem$;

-- -----------------------------------------------------------------------------
-- 11. Lịch pg_cron (§4.8). Cùng file với hàm, không tách migration riêng: cửa
--     idempotent dán TỪNG file lên production rồi ROLLBACK, nên một file lịch
--     đòi hàm của file chưa áp sẽ ngã ở đó. Môi trường không có pg_cron (bản
--     dựng lại từ baseline, cụm thử dùng-một-lần) thì bỏ qua, như zalo-canh-gac.
--
--     statement_timeout đặt ngay trong lệnh của job: GUC đặt trong thân hàm
--     không hẹn giờ lại câu lệnh đang chạy. Không có dòng camera_alert_settings
--     bật thì mỗi lượt chỉ đọc một bảng rỗng. Không gỡ trên DB TEST đã đánh dấu:
--     lượt chạy ở đó chỉ ghi vào chính DB TEST, push bị
--     lifecycle_reminder_service_jwt_v1 chặn trước Vault/HTTP.
--
--     Tắt khẩn: SELECT cron.unschedule('camera-alert-evaluate');
-- -----------------------------------------------------------------------------
DO $cronblock$
DECLARE v_n integer;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron (môi trường diễn tập) — bỏ qua đăng ký lịch cảnh báo camera.';
    RETURN;
  END IF;
  -- cron.schedule theo tên là ghi đè: chạy lại migration không nhân đôi job.
  PERFORM cron.schedule(
    'camera-alert-evaluate',
    '*/2 * * * *',
    $job$SET statement_timeout = '5s'; SELECT app_private.camera_alert_evaluate_v1();$job$
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
