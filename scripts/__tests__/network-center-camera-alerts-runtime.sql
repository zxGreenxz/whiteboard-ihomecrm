-- Camera alert proof — plan docs/superpowers/plans/2026-11-01-canh-bao-camera-o-cung-kenh.md §6.1.
--
-- Mọi mốc giờ tính TƯƠNG ĐỐI từ hôm nay theo giờ Việt Nam (lùi 3 ngày), không
-- ghim ngày: bộ đánh giá nhận p_now giả lập, còn quyền/thành viên đọc giờ thật,
-- nên mọi mốc giả lập phải nằm trong quá khứ và hợp lệ ở mọi ngày chạy.
-- Mỗi ca chạy trong một transaction riêng rồi ROLLBACK về fixture gốc.

-- ---------------------------------------------------------------------------
-- Fixture gốc (cụm dùng một lần).
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, aud, role, email) VALUES
  ('dddd2000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'camera.inactive@example.invalid'),
  ('dddd2000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'camera.superadmin@example.invalid');
INSERT INTO public.organization_memberships (id, organization_id, user_id, member_type, status, activated_at) VALUES
  ('dddd5000-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'dddd2000-0000-4000-8000-0000000000a1', 'STAFF', 'SUSPENDED', clock_timestamp()),
  ('dddd5000-0000-4000-8000-0000000000a2', 'dddd0000-0000-4000-8000-000000000001', 'dddd2000-0000-4000-8000-0000000000a2', 'STAFF', 'ACTIVE', clock_timestamp());
INSERT INTO public.super_admins (user_id) VALUES ('dddd2000-0000-4000-8000-0000000000a2');

-- Chủ công ty: vai TENANT_OWNER, KHÔNG có quyền network_center.view nào ⇒ chỉ
-- lọt người nhận qua nhánh chủ công ty.
INSERT INTO public.organization_roles (id, organization_id, name, is_system, system_key)
VALUES ('dddd6100-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'Chủ công ty', true, 'TENANT_OWNER');
INSERT INTO public.role_bindings (id, organization_id, membership_id, role_id)
VALUES ('dddd6200-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000001', 'dddd6100-0000-4000-8000-0000000000a1');

-- Quản lý toà A, kế toán chỉ toà B, thành viên ngừng hoạt động và super admin cả org.
INSERT INTO public.member_permission_overrides (id, organization_id, membership_id, permission_key, effect, scope_mode) VALUES
  ('dddd6000-0000-4000-8000-0000000000a3', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000003', 'network_center.view', 'ALLOW', 'SCOPED'),
  ('dddd6000-0000-4000-8000-0000000000a2', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000002', 'network_center.view', 'ALLOW', 'SCOPED'),
  ('dddd6000-0000-4000-8000-0000000000b1', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-0000000000a1', 'network_center.view', 'ALLOW', 'ORGANIZATION'),
  ('dddd6000-0000-4000-8000-0000000000b2', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-0000000000a2', 'network_center.view', 'ALLOW', 'ORGANIZATION');
INSERT INTO public.member_override_scopes (organization_id, override_id, scope_id)
SELECT s.organization_id, o.override_id, s.id
  FROM (VALUES
    ('dddd6000-0000-4000-8000-0000000000a3'::uuid, 'BUILDING', 'dddd1000-0000-4000-8000-000000000001'::uuid),
    ('dddd6000-0000-4000-8000-0000000000a2'::uuid, 'BUILDING', 'dddd1000-0000-4000-8000-000000000002'::uuid),
    ('dddd6000-0000-4000-8000-0000000000b1'::uuid, 'ORGANIZATION', NULL::uuid),
    ('dddd6000-0000-4000-8000-0000000000b2'::uuid, 'ORGANIZATION', NULL::uuid)
  ) o(override_id, scope_type, building_id)
  JOIN public.authorization_scopes s
    ON s.organization_id = 'dddd0000-0000-4000-8000-000000000001'
   AND s.scope_type = o.scope_type
   AND s.building_id IS NOT DISTINCT FROM o.building_id;

-- Router connection + bốn đầu ghi 8 kênh ở toà A; worker cho đường ingest thật.
INSERT INTO public.network_device_connections (id, organization_id, building_id, device_id, transport, management_ip, management_port, credential_ref, host_key_fingerprint, is_enabled)
SELECT 'dddd9000-0000-4000-8000-0000000000a0', organization_id, building_id, id, 'ROUTEROS_SSH', '10.90.0.1', 22, 'router/camera-alert-proof', 'SHA256:ddddddddddddddddddddddddddddddddddddddddddd', true
  FROM public.network_devices WHERE building_id = 'dddd1000-0000-4000-8000-000000000001' AND device_kind = 'MIKROTIK';
SELECT public.network_center_admin_enroll_camera_v1(('dddd8000-0000-4000-8000-0000000000a' || n)::uuid,
  'dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000001', 'dddd9000-0000-4000-8000-0000000000a0',
  'NVR-R' || n, 'KBVISION', NULL, 8, 'http://10.90.0.' || (10 + n) || ':80', 'camera/alert-proof-' || n, true)
  FROM generate_series(1, 4) n;
INSERT INTO public.network_workers (id, worker_key, display_name, status, capabilities)
VALUES ('dddd7000-0000-4000-8000-0000000000a0', 'camera-alert-proof', 'Camera alert proof', 'ACTIVE', ARRAY['POLL', 'TELEMETRY']);
INSERT INTO public.network_worker_credentials (worker_id, secret_digest, fingerprint, not_before, expires_at)
VALUES ('dddd7000-0000-4000-8000-0000000000a0', repeat('d', 64), 'sha256:' || repeat('d', 24), now() - interval '1 minute', now() + interval '1 day');
INSERT INTO public.network_worker_assignments (worker_id, organization_id, building_id, device_id, can_poll, active_from)
SELECT 'dddd7000-0000-4000-8000-0000000000a0', organization_id, building_id, id, true, now() - interval '1 minute'
  FROM public.network_devices WHERE building_id = 'dddd1000-0000-4000-8000-000000000001' AND device_kind = 'MIKROTIK';

-- Token Vault có cấu trúc JWT, không ký, dựng lúc chạy (không có chuỗi giống bí mật trong repo).
INSERT INTO vault.decrypted_secrets (name, decrypted_secret)
VALUES ('lifecycle_reminders_service_jwt',
  translate(encode(convert_to('{"alg":"none"}', 'UTF8'), 'base64'), '+/=', '-_')
  || '.' || translate(encode(convert_to(json_build_object('role', 'service_role', 'ref', 'tryymsxyyckgbrmmvozx')::text, 'UTF8'), 'base64'), E'+/=\n', '-_')
  || '.camera-alert-proof');

-- Super admin cũng là thành viên có quyền xem ở org thật (ca dương) và ở org sandbox (phải bị loại).
INSERT INTO public.organizations (id, slug, name, status, is_demo, created_by)
VALUES ('cccc0000-0000-4000-8000-000000000001', 'camera-sandbox', 'Sandbox', 'ACTIVE', false, '90450d5f-29b6-4897-bdef-cdb5fb53f339');
INSERT INTO public.buildings (id, user_id, organization_id, name, code, province, district, ward, total_floors, total_rooms, is_virtual)
VALUES ('cccc1000-0000-4000-8000-000000000001', '90450d5f-29b6-4897-bdef-cdb5fb53f339', 'cccc0000-0000-4000-8000-000000000001', 'SANDBOX-A', 'SB-A', 'Local', 'Local', 'Local', 1, 1, false);
INSERT INTO public.authorization_scopes (organization_id, scope_type) VALUES ('cccc0000-0000-4000-8000-000000000001', 'ORGANIZATION');
INSERT INTO public.organization_memberships (id, organization_id, user_id, member_type, status, activated_at) VALUES
  ('aaaa5000-0000-4000-8000-0000000000a2', 'aaaa0000-0000-4000-8000-000000000001', 'dddd2000-0000-4000-8000-0000000000a2', 'STAFF', 'ACTIVE', clock_timestamp()),
  ('cccc5000-0000-4000-8000-0000000000a2', 'cccc0000-0000-4000-8000-000000000001', 'dddd2000-0000-4000-8000-0000000000a2', 'STAFF', 'ACTIVE', clock_timestamp());
INSERT INTO public.member_permission_overrides (id, organization_id, membership_id, permission_key, effect, scope_mode) VALUES
  ('aaaa6000-0000-4000-8000-0000000000b2', 'aaaa0000-0000-4000-8000-000000000001', 'aaaa5000-0000-4000-8000-0000000000a2', 'network_center.view', 'ALLOW', 'ORGANIZATION'),
  ('cccc6000-0000-4000-8000-0000000000b2', 'cccc0000-0000-4000-8000-000000000001', 'cccc5000-0000-4000-8000-0000000000a2', 'network_center.view', 'ALLOW', 'ORGANIZATION');
INSERT INTO public.member_override_scopes (organization_id, override_id, scope_id)
SELECT s.organization_id, o.override_id, s.id
  FROM (VALUES ('aaaa6000-0000-4000-8000-0000000000b2'::uuid, 'aaaa0000-0000-4000-8000-000000000001'::uuid),
               ('cccc6000-0000-4000-8000-0000000000b2'::uuid, 'cccc0000-0000-4000-8000-000000000001'::uuid)) o(override_id, org_id)
  JOIN public.authorization_scopes s ON s.organization_id = o.org_id AND s.scope_type = 'ORGANIZATION';

INSERT INTO app_private.camera_alert_settings (organization_id, enabled, mode)
VALUES ('dddd0000-0000-4000-8000-000000000001', true, 'LIVE');

-- ---------------------------------------------------------------------------
-- Công cụ cho các ca.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.expect(p_ok boolean, p_message text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'camera alert proof: %', p_message; END IF;
END $fn$;
-- Mốc giờ Việt Nam: ngày (hôm nay - 3 + p_day), giờ p_time.
CREATE FUNCTION pg_temp.at(p_day integer, p_time time) RETURNS timestamptz LANGUAGE sql AS $fn$
  SELECT (((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 3 + p_day) + p_time) AT TIME ZONE 'Asia/Ho_Chi_Minh'
$fn$;
CREATE FUNCTION pg_temp.rec(p_n integer) RETURNS uuid LANGUAGE sql AS $fn$
  SELECT ('dddd8000-0000-4000-8000-0000000000a' || p_n)::uuid
$fn$;
CREATE FUNCTION pg_temp.ch(p_lost integer[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_agg(jsonb_build_object('channel', i, 'name', 'Cam ' || i,
    'state', CASE WHEN i = ANY(p_lost) THEN 'DISCONNECTED' ELSE 'CONNECTED' END) ORDER BY i)
  FROM generate_series(1, 8) i
$fn$;
CREATE FUNCTION pg_temp.disk(p_state text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('slot', 1, 'state', p_state, 'totalBytes', 100, 'usedBytes', 50))
$fn$;
-- Ghi thẳng snapshot (đường ingest thật được dùng ở ca 3).
CREATE FUNCTION pg_temp.snap(p_n integer, p_at timestamptz, p_status text, p_channels jsonb, p_storage jsonb)
RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.camera_recorder_current (recorder_id, organization_id, building_id, status, checked_at, received_at, channels, storage, event_coverage, issues)
  SELECT r.id, r.organization_id, r.building_id, p_status, p_at, p_at, p_channels, p_storage, 'STATE_POLLING_ONLY', '{}'
    FROM public.camera_recorders r WHERE r.id = pg_temp.rec(p_n)
  ON CONFLICT (recorder_id) DO UPDATE SET status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
    received_at = EXCLUDED.received_at, channels = EXCLUDED.channels, storage = EXCLUDED.storage
$fn$;
CREATE FUNCTION pg_temp.tick(p_at timestamptz) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT app_private.camera_alert_evaluate_v1(p_at)
$fn$;
CREATE FUNCTION pg_temp.n_notif() RETURNS bigint LANGUAGE sql AS $fn$ SELECT count(*) FROM public.notifications $fn$;
CREATE FUNCTION pg_temp.n_push() RETURNS bigint LANGUAGE sql AS $fn$ SELECT count(*) FROM net.camera_proof_requests $fn$;
CREATE FUNCTION pg_temp.n_inc(p_type text DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $fn$
  SELECT count(*) FROM public.network_incidents WHERE p_type IS NULL OR incident_type = p_type
$fn$;

-- ---------------------------------------------------------------------------
-- T4 — lịch cron: đúng một job */2 (migration đã chạy hai lần), lệnh có trần
-- thời gian; chạy lệnh của job khi không org nào bật thì không làm gì.
-- ---------------------------------------------------------------------------
BEGIN;
DO $cron$
DECLARE v_command text; v_before bigint;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'camera-alert-evaluate' AND schedule = '*/2 * * * *' AND active;
  PERFORM pg_temp.expect((SELECT count(*) FROM cron.job) = 1 AND v_command IS NOT NULL, 'exactly one active */2 camera-alert-evaluate job');
  PERFORM pg_temp.expect(v_command LIKE 'SET statement_timeout = ''5s''; SELECT app_private.camera_alert_evaluate_v1();', 'job command must carry its own statement_timeout');
  UPDATE app_private.camera_alert_settings SET enabled = false;
  PERFORM pg_temp.snap(1, clock_timestamp() - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  SELECT count(*) INTO v_before FROM app_private.camera_alert_conditions;
  EXECUTE v_command;
  RESET statement_timeout;
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_conditions) = v_before AND pg_temp.n_inc() = 0 AND pg_temp.n_notif() = 0,
    'the scheduled command must do nothing while no organization is enabled');
END $cron$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 7 — người nhận (chạy trước vì mọi ca sau dựa vào đúng tập này).
-- ---------------------------------------------------------------------------
BEGIN;
DO $c7$
DECLARE
  a uuid[] := app_private.network_center_alert_recipient_ids_v1('dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000001');
  b uuid[] := app_private.network_center_alert_recipient_ids_v1('dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000002');
BEGIN
  -- Như pg_cron: không có claim JWT nào.
  PERFORM pg_temp.expect(coalesce(current_setting('request.jwt.claim.sub', true), '') = '', 'recipient check must run without JWT claims');
  PERFORM pg_temp.expect(a = ARRAY['dddd2000-0000-4000-8000-000000000002', 'de6f33f3-349f-4bec-bd3d-106192f6715e']::uuid[],
    'building A recipients must be exactly manager + owner, got ' || a::text);
  PERFORM pg_temp.expect(b = ARRAY['dddd2000-0000-4000-8000-000000000001', 'de6f33f3-349f-4bec-bd3d-106192f6715e']::uuid[],
    'building B recipients must be exactly accountant + owner, got ' || b::text);
  -- Loại trừ đúng vì luật, không vì thiếu quyền trong fixture:
  PERFORM pg_temp.expect((SELECT allowed FROM app_private.authorize_tenant_action_v3('dddd2000-0000-4000-8000-0000000000a2', 'dddd0000-0000-4000-8000-000000000001', 'network_center.view', 'dddd1000-0000-4000-8000-000000000001', NULL)),
    'fixture: super admin must hold network_center.view, so only the sandbox/demo rule excludes them');
  PERFORM pg_temp.expect(NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3('de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd0000-0000-4000-8000-000000000001', 'network_center.view', 'dddd1000-0000-4000-8000-000000000001', NULL)),
    'fixture: owner must lack network_center.view, so only the company-owner branch includes them');
  PERFORM pg_temp.expect(cardinality(app_private.network_center_alert_recipient_ids_v1('dddd0000-0000-4000-8000-000000000001', 'aaaa1000-0000-4000-8000-000000000001')) = 0,
    'a building of another organization must have no recipients');
  -- Super admin có quyền ở toà thật (không demo, không sandbox) vẫn nhận; ở org sandbox thì không.
  PERFORM pg_temp.expect(app_private.network_center_alert_recipient_ids_v1('aaaa0000-0000-4000-8000-000000000001', 'aaaa1000-0000-4000-8000-000000000001')
    = ARRAY['dddd2000-0000-4000-8000-0000000000a2']::uuid[], 'a super admin with view on a real organization building must be a recipient');
  PERFORM pg_temp.expect((SELECT allowed FROM app_private.authorize_tenant_action_v3('dddd2000-0000-4000-8000-0000000000a2', 'cccc0000-0000-4000-8000-000000000001', 'network_center.view', 'cccc1000-0000-4000-8000-000000000001', NULL)),
    'fixture: super admin must hold view in the sandbox organization');
  PERFORM pg_temp.expect(cardinality(app_private.network_center_alert_recipient_ids_v1('cccc0000-0000-4000-8000-000000000001', 'cccc1000-0000-4000-8000-000000000001')) = 0,
    'a super admin must not receive sandbox organization alerts');
END $c7$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 1 — ổ ERROR trên đầu ghi ONLINE: đúng MỘT C1, chạy lại không mở/gửi thêm.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c1$
DECLARE t timestamptz := pg_temp.at(0, '10:00');
BEGIN
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_STORAGE_ERROR') = 1, 'C1 must open exactly once');
  PERFORM pg_temp.expect((SELECT severity = 'CRITICAL' AND status = 'OPEN' AND fingerprint = 'camera:' || pg_temp.rec(1) || ':storage:1'
                            FROM public.network_incidents), 'C1 must be CRITICAL/OPEN with the camera fingerprint');
  PERFORM pg_temp.expect(pg_temp.n_notif() = 2 AND pg_temp.n_push() = 2, 'C1 must notify owner + manager once each (bell + push)');
  PERFORM pg_temp.expect((SELECT array_agg(user_id ORDER BY user_id) FROM public.notifications)
    = ARRAY['dddd2000-0000-4000-8000-000000000002', 'de6f33f3-349f-4bec-bd3d-106192f6715e']::uuid[], 'C1 bell went to the wrong people');
  PERFORM pg_temp.expect((SELECT bool_and(type = 'CUSTOM' AND channel = 'IN_APP'
      AND metadata ->> 'url' = '/network-center/buildings/dddd1000-0000-4000-8000-000000000001?tab=cameras'
      AND metadata ->> 'v5' = 'camera_alert' AND content LIKE '%NVR-R1: ổ cứng 1 báo lỗi%')
    FROM public.notifications), 'C1 bell shape/url/content is wrong');
  PERFORM pg_temp.expect((SELECT bool_and(body ->> 'tag' = 'camera-alert' AND body ->> 'url' LIKE '/network-center/buildings/%?tab=cameras'
      AND url LIKE '%/functions/v1/send-push') FROM net.camera_proof_requests)
    AND (SELECT count(DISTINCT body ->> 'idempotencyKey') FROM net.camera_proof_requests) = 2, 'push payload/idempotency key is wrong');

  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.snap(1, t + interval '90 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.snap(1, t + interval '210 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(t + interval '4 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND pg_temp.n_notif() = 2 AND pg_temp.n_push() = 2, 'rerunning the evaluation duplicated an incident or a message');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_incident_events WHERE event_kind = 'OPENED') = 1, 'OPENED event duplicated');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_audit_events WHERE action = 'system.camera_alert_opened') = 1, 'audit missing or duplicated');
END $c1$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 2 — kênh chập chờn không báo; mất ≥ 10 phút mở C5; hai lượt tốt mới đóng,
-- đúng một tin khôi phục mỗi người; tái phát khi RECOVERING không báo lại.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c2$
DECLARE t timestamptz := pg_temp.at(0, '10:00'); i integer; s timestamptz;
BEGIN
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[2]), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_conditions) = 1, 'a lost channel must be tracked');
  PERFORM pg_temp.snap(1, t + interval '90 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_conditions) = 0 AND pg_temp.n_inc() = 0 AND pg_temp.n_notif() = 0,
    'a few-second channel drop must leave no incident and no message');

  FOR i IN 0..4 LOOP
    s := t + interval '4 minutes' + i * interval '2 minutes';
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[2]), pg_temp.disk('NORMAL'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'C5 opened before 10 minutes');
  PERFORM pg_temp.snap(1, t + interval '14 minutes' - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[2]), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '14 minutes');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_incidents WHERE incident_type = 'CAMERA_CHANNEL_LOST' AND severity = 'WARNING' AND status = 'OPEN') = 1,
    'C5 must open as WARNING after 10 minutes (1/8 channels lost)');
  PERFORM pg_temp.expect(pg_temp.n_notif() = 2, 'C5 opening must notify once per recipient');

  PERFORM pg_temp.snap(1, t + interval '16 minutes' - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '16 minutes');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents) = 'RECOVERING', 'first good round must only mark RECOVERING');
  PERFORM pg_temp.snap(1, t + interval '18 minutes' - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[2]), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '18 minutes');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents) = 'OPEN' AND pg_temp.n_inc() = 1 AND pg_temp.n_notif() = 2,
    'a relapse while RECOVERING must reopen silently');

  PERFORM pg_temp.snap(1, t + interval '20 minutes' - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '20 minutes');
  PERFORM pg_temp.snap(1, t + interval '22 minutes' - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '22 minutes');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents) = 'RESOLVED', 'two good rounds must resolve');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.notifications WHERE content LIKE '%Đã khôi phục: NVR-R1: camera "Cam 2" (kênh 2) mất kết nối%') = 2
    AND pg_temp.n_notif() = 4, 'exactly one recovery message per recipient');
  PERFORM pg_temp.snap(1, t + interval '24 minutes' - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '24 minutes');
  PERFORM pg_temp.expect(pg_temp.n_notif() = 4 AND (SELECT count(*) FROM app_private.camera_alert_conditions) = 0, 'recovery repeated');
  PERFORM pg_temp.expect((SELECT array_agg(event_kind ORDER BY event_seq) FROM public.network_incident_events)
    = ARRAY['OPENED', 'RECOVERED', 'OBSERVED', 'RECOVERED', 'RESOLVED'], 'incident event trail is wrong');
END $c2$;
ROLLBACK;

-- Ca 2b — ≥ 50 % kênh cùng mất: nâng CRITICAL, kênh mở trước được ESCALATED.
BEGIN;
DO $c2b$
DECLARE t timestamptz := pg_temp.at(0, '13:00'); i integer; s timestamptz;
BEGIN
  FOR i IN 0..5 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[1]), pg_temp.disk('NORMAL'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect((SELECT severity FROM public.network_incidents) = 'WARNING', 'one lost channel of eight is WARNING');
  FOR i IN 6..11 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[1, 2, 3, 4]), pg_temp.disk('NORMAL'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_incidents WHERE incident_type = 'CAMERA_CHANNEL_LOST' AND severity = 'CRITICAL') = 4,
    'four of eight channels lost must all be CRITICAL');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_incident_events WHERE event_kind = 'ESCALATED') = 1, 'the first channel must be escalated once');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.notifications WHERE subject = 'Camera: 4 sự cố mới') = 2, 'escalation batch must be one message per recipient');
END $c2b$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 3 — đầu ghi OFFLINE (qua RPC ingest thật): chỉ mở C2 dù kênh/ổ thành UNKNOWN.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c3$
DECLARE t timestamptz := pg_temp.at(0, '11:00'); i integer; s timestamptz;
  base jsonb := jsonb_build_object('recorderId', pg_temp.rec(3), 'connectionId', 'dddd9000-0000-4000-8000-0000000000a0',
    'eventCoverage', 'STATE_POLLING_ONLY', 'events', '[]'::jsonb);
BEGIN
  PERFORM public.network_center_worker_camera_ingest_v1(repeat('d', 64), base || jsonb_build_object(
    'observedAt', t - interval '30 seconds', 'status', 'ONLINE', 'issues', '[]'::jsonb,
    'channels', pg_temp.ch(ARRAY[5]), 'storage', pg_temp.disk('ERROR')));
  FOR i IN 1..6 LOOP
    s := t + i * interval '2 minutes';
    PERFORM public.network_center_worker_camera_ingest_v1(repeat('d', 64), base || jsonb_build_object(
      'observedAt', s - interval '30 seconds', 'status', 'OFFLINE', 'issues', '["NETWORK_UNREACHABLE"]'::jsonb,
      'channels', '[]'::jsonb, 'storage', '[]'::jsonb));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect((SELECT bool_and(c.value ->> 'state' = 'UNKNOWN') FROM public.camera_recorder_current cur, jsonb_array_elements(cur.channels || cur.storage) c
                            WHERE cur.recorder_id = pg_temp.rec(3)), 'fixture: server must force channels and disks to UNKNOWN (B2)');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND pg_temp.n_inc('CAMERA_RECORDER_OFFLINE') = 1, 'OFFLINE must open only C2');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE condition_code IN ('CAMERA_STORAGE_ERROR', 'CAMERA_CHANNEL_LOST', 'CAMERA_RECORDER_UNKNOWN')),
    'UNKNOWN channels/disks under an OFFLINE recorder must not be tracked');
END $c3$;
ROLLBACK;

-- Ca 3b — C1 đang mở, đầu ghi OFFLINE: C1 đóng lặng (SUPERSEDED), không có tin khôi phục.
BEGIN;
DO $c3b$
DECLARE t timestamptz := pg_temp.at(0, '11:00'); i integer; s timestamptz;
  unknown_ch jsonb := (SELECT jsonb_agg(jsonb_build_object('channel', g, 'state', 'UNKNOWN')) FROM generate_series(1, 8) g);
BEGIN
  PERFORM pg_temp.snap(4, t - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_STORAGE_ERROR') = 1 AND pg_temp.n_notif() = 2, 'fixture: C1 must be open');
  FOR i IN 1..4 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(4, s - interval '30 seconds', 'OFFLINE', unknown_ch, pg_temp.disk('UNKNOWN'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_OFFLINE') = 1, 'C2 must open');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents WHERE incident_type = 'CAMERA_STORAGE_ERROR') = 'RESOLVED'
    AND EXISTS (SELECT 1 FROM public.network_incident_events WHERE event_kind = 'RESOLVED' AND details ->> 'reason' = 'SUPERSEDED'),
    'C1 must be closed as SUPERSEDED while C2 is open');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM public.notifications WHERE content LIKE '%Đã khôi phục%'), 'a superseded C1 is not a recovery');
END $c3b$;
ROLLBACK;

-- Ca 3c — kể cả snapshot chưa được server chuẩn hoá (OFFLINE mà kênh/ổ vẫn
-- mang trạng thái cũ), kênh/ổ của đầu ghi không ONLINE không được tính là lỗi.
BEGIN;
DO $c3c$
DECLARE t timestamptz := pg_temp.at(0, '11:00'); i integer; s timestamptz;
BEGIN
  FOR i IN 0..6 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(3, s - interval '30 seconds', 'OFFLINE', pg_temp.ch(ARRAY[2]), pg_temp.disk('ERROR'));
    PERFORM pg_temp.tick(s);
    PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE subject <> 'recorder:offline'),
      'disk/channel states of a non-ONLINE recorder must not be tracked');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND pg_temp.n_inc('CAMERA_RECORDER_OFFLINE') = 1, 'only C2 for an OFFLINE recorder');
END $c3c$;
ROLLBACK;

-- Ca 3d — OFFLINE rồi kết nối lại nhưng trả UNKNOWN: C2 đóng (đã kết nối lại),
-- rồi C6 mở sau 30 phút, không bị C2 che mãi.
BEGIN;
DO $c3d$
DECLARE t timestamptz := pg_temp.at(0, '11:00'); i integer; s timestamptz;
  unknown_ch jsonb := (SELECT jsonb_agg(jsonb_build_object('channel', g, 'state', 'UNKNOWN')) FROM generate_series(1, 8) g);
BEGIN
  FOR i IN 0..3 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'OFFLINE', unknown_ch, pg_temp.disk('UNKNOWN'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_OFFLINE') = 1, 'fixture: C2 open');
  FOR i IN 4..20 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'UNKNOWN', unknown_ch, pg_temp.disk('UNKNOWN'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents WHERE incident_type = 'CAMERA_RECORDER_OFFLINE') = 'RESOLVED',
    'a reconnected recorder that answers UNKNOWN must close C2');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_incidents WHERE incident_type = 'CAMERA_RECORDER_UNKNOWN' AND status = 'OPEN' AND severity = 'WARNING') = 1,
    'C6 must open after 30 minutes of UNKNOWN instead of being hidden by C2');
END $c3d$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 4 — dữ liệu giám sát cũ ≥ 5 phút: C4; ba đầu ghi cùng cũ ⇒ tin ghi lỗi chung.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c4$
DECLARE t timestamptz := pg_temp.at(0, '12:00'); n integer;
BEGIN
  FOR n IN 1..3 LOOP
    PERFORM pg_temp.snap(n, t - interval '6 minutes', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  END LOOP;
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'C4 waits one grace interval after it is first seen');
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_MONITOR_STALE') = 3 AND pg_temp.n_inc() = 3, 'three stale recorders must open three C4');
  PERFORM pg_temp.expect(pg_temp.n_notif() = 2 AND (SELECT bool_and(content LIKE '%có thể do VPS hoặc bộ thu thập%') FROM public.notifications),
    'grouped message must say VPS/collector');
END $c4$;
ROLLBACK;

-- Ca 4b — một đầu ghi cũ không gắn câu lỗi chung; đầu ghi chưa từng báo sau 10 phút cũng là C4.
BEGIN;
DO $c4b$
DECLARE t timestamptz := pg_temp.at(0, '12:00');
BEGIN
  PERFORM pg_temp.snap(1, t - interval '4 minutes', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'four minutes old is not stale yet');
  UPDATE public.camera_recorders SET created_at = t - interval '11 minutes' WHERE id = pg_temp.rec(2);
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.tick(t + interval '4 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_MONITOR_STALE') = 2, 'stale R1 and never-reported R2 must both open C4');
END $c4b$;
ROLLBACK;
BEGIN;
DO $c4c$
DECLARE t timestamptz := pg_temp.at(0, '12:00');
BEGIN
  PERFORM pg_temp.snap(1, t - interval '6 minutes', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_MONITOR_STALE') = 1 AND pg_temp.n_notif() = 2, 'a single stale recorder opens C4');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM public.notifications WHERE content LIKE '%VPS%'), 'a single stale recorder is not a collector-wide message');
END $c4c$;
ROLLBACK;

-- Ca 4d — bật lại theo dõi một đầu ghi có snapshot cũ: collector gửi snapshot
-- mới trong khoảng chờ ⇒ không có C4 giả, không có tin.
BEGIN;
DO $c4d$
DECLARE t timestamptz := pg_temp.at(0, '12:00');
BEGIN
  UPDATE public.camera_recorders SET enabled = false WHERE id = pg_temp.rec(1);
  PERFORM pg_temp.snap(1, t - interval '3 days', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t - interval '2 minutes');
  UPDATE public.camera_recorders SET enabled = true WHERE id = pg_temp.rec(1);
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.snap(1, t + interval '90 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0 AND pg_temp.n_notif() = 0 AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions),
    're-enabling a recorder must not raise a false C4');
END $c4d$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 5 — tắt: org enabled=false không làm gì; đầu ghi enabled=false đóng sự cố.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c5$
DECLARE t timestamptz := pg_temp.at(0, '14:00'); r jsonb;
BEGIN
  UPDATE app_private.camera_alert_settings SET enabled = false;
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  r := pg_temp.tick(t);
  PERFORM pg_temp.expect(jsonb_array_length(r -> 'organizations') = 0 AND pg_temp.n_inc() = 0 AND pg_temp.n_notif() = 0
    AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions), 'a disabled organization must not be evaluated');

  UPDATE app_private.camera_alert_settings SET enabled = true;
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND pg_temp.n_notif() = 2, 'fixture: C1 open after enabling');
  UPDATE public.camera_recorders SET enabled = false WHERE id = pg_temp.rec(1);
  PERFORM pg_temp.tick(t + interval '4 minutes');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents) = 'RESOLVED'
    AND EXISTS (SELECT 1 FROM public.network_incident_events WHERE event_kind = 'RESOLVED' AND details ->> 'reason' = 'DISABLED')
    AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions) AND pg_temp.n_notif() = 2,
    'a disabled recorder must be closed as DISABLED without a recovery message');
END $c5$;
ROLLBACK;

-- Ca 5b — router của đầu ghi bị ngừng: bỏ qua đầu ghi, đóng lặng sự cố cũ, lượt không ném lỗi.
BEGIN;
DO $c5b$
DECLARE t timestamptz := pg_temp.at(0, '14:00'); r jsonb;
BEGIN
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND pg_temp.n_notif() = 2, 'fixture: C1 open');
  UPDATE public.network_devices SET is_active = false
   WHERE building_id = 'dddd1000-0000-4000-8000-000000000001' AND device_kind = 'MIKROTIK';
  r := pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents) = 'RESOLVED'
    AND EXISTS (SELECT 1 FROM public.network_incident_events WHERE event_kind = 'RESOLVED' AND details ->> 'reason' = 'ROUTER_UNAVAILABLE')
    AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions) AND pg_temp.n_notif() = 2,
    'a recorder whose router is gone must be closed quietly, not left open forever');
  PERFORM pg_temp.expect(r #>> '{organizations,0,skippedRecorders,0,reason}' = 'ROUTER_UNAVAILABLE', 'the skip must be reported');
END $c5b$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 6 — cửa sổ bảo trì: có sự cố, không có tin; hết bảo trì mà lỗi còn thì báo.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c6$
DECLARE t timestamptz := pg_temp.at(0, '15:00'); i integer; s timestamptz;
BEGIN
  INSERT INTO public.network_maintenance_windows (organization_id, building_id, status, starts_at, ends_at, reason, created_by, request_hash, idempotency_key)
  VALUES ('dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000001', 'ACTIVE',
    t - interval '10 minutes', t + interval '7 minutes', 'Thay ổ cứng đầu ghi (ca thử)', 'de6f33f3-349f-4bec-bd3d-106192f6715e',
    repeat('a', 64), 'camera-alert-proof-maintenance');
  FOR i IN 0..3 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND (SELECT (observed_values ->> 'maintenance')::boolean FROM public.network_incidents),
    'maintenance must still record the incident');
  PERFORM pg_temp.expect(pg_temp.n_notif() = 0 AND pg_temp.n_push() = 0, 'maintenance must not notify');
  PERFORM pg_temp.expect(EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries WHERE status = 'SUPPRESSED'), 'suppression must be in the ledger');
  FOR i IN 4..5 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_notif() = 2, 'a fault still present after maintenance must be reported once');
END $c6$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 8 — WARNING lúc 23:00 hoãn tới 07:00 rồi gửi gộp; CRITICAL lúc 23:00 gửi ngay.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c8$
DECLARE t timestamptz := pg_temp.at(0, '22:56'); i integer; s timestamptz; morning timestamptz := pg_temp.at(1, '07:00');
BEGIN
  FOR i IN 0..5 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[3]), pg_temp.disk('NORMAL'));
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk(CASE WHEN i = 5 THEN 'ERROR' ELSE 'NORMAL' END));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST') = 1 AND pg_temp.n_inc('CAMERA_STORAGE_ERROR') = 1, 'fixture: both incidents open at 23:06');
  PERFORM pg_temp.expect(pg_temp.n_notif() = 2 AND (SELECT bool_and(content LIKE '%NVR-R2: ổ cứng 1 báo lỗi%' AND content NOT LIKE '%Cam 3%') FROM public.notifications),
    'CRITICAL at night is sent at once, the WARNING is not');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE status = 'DEFERRED' AND kind = 'NIGHT_DIGEST') = 1, 'the WARNING must be deferred');

  FOREACH s IN ARRAY ARRAY[morning - interval '2 minutes', morning, morning + interval '2 minutes'] LOOP
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(ARRAY[3]), pg_temp.disk('NORMAL'));
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
    PERFORM pg_temp.tick(s);
    IF s < morning THEN
      PERFORM pg_temp.expect(pg_temp.n_notif() = 2, 'nothing is sent before night_end');
    END IF;
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_notif() = 4, 'the night digest must be sent exactly once at 07:00');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.notifications WHERE subject LIKE 'Camera: bản tin đêm qua%' AND content LIKE '%camera "Cam 3" (kênh 3) mất kết nối%') = 2,
    'the night digest must list the deferred channel');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries WHERE status = 'DEFERRED'), 'deferred rows must be drained');
END $c8$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 9 — bản tin 08:00: chỉ sự cố mở ≥ 12 giờ và chưa ghi nhận; lần hai không gửi.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c9$
DECLARE s timestamptz; i integer;
  ticks timestamptz[] := ARRAY[pg_temp.at(0, '18:00'), pg_temp.at(0, '19:00'), pg_temp.at(1, '01:00'), pg_temp.at(1, '08:00'), pg_temp.at(1, '08:02')];
BEGIN
  FOR i IN 1..5 LOOP
    s := ticks[i];
    PERFORM pg_temp.snap(2, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk(CASE WHEN i >= 2 THEN 'ERROR' ELSE 'NORMAL' END));
    PERFORM pg_temp.snap(3, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk(CASE WHEN i >= 3 THEN 'ERROR' ELSE 'NORMAL' END));
    PERFORM pg_temp.tick(s);
    IF i = 1 THEN
      UPDATE public.network_incidents SET status = 'ACKNOWLEDGED', acknowledged_at = s,
        acknowledged_by = 'de6f33f3-349f-4bec-bd3d-106192f6715e', version = version + 1;
    END IF;
  END LOOP;
  PERFORM pg_temp.expect((SELECT count(*) FROM public.notifications WHERE metadata ->> 'kind' = 'DIGEST') = 2,
    'the 08:00 digest must be one message per recipient, once a day');
  PERFORM pg_temp.expect((SELECT bool_and(content LIKE '%NVR-R1%' AND content NOT LIKE '%NVR-R2%' AND content NOT LIKE '%NVR-R3%')
    FROM public.notifications WHERE metadata ->> 'kind' = 'DIGEST'), 'the digest must hold only unacknowledged incidents open ≥ 12 h');
END $c9$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 10 — SHADOW: chỉ có điều kiện và sổ, không sự cố, không chuông, không push.
-- ---------------------------------------------------------------------------
BEGIN;
DO $c10$
DECLARE t timestamptz := pg_temp.at(0, '16:00'); i integer; s timestamptz;
BEGIN
  UPDATE app_private.camera_alert_settings SET mode = 'SHADOW';
  FOR i IN 0..1 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect(EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE opened_at IS NOT NULL AND incident_id IS NULL), 'shadow must track the expected incident');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE status = 'SHADOW' AND kind = 'OPENED'
      AND result -> 'wouldNotify' = '["dddd2000-0000-4000-8000-000000000002", "de6f33f3-349f-4bec-bd3d-106192f6715e"]'::jsonb
      AND result ->> 'code' = 'CAMERA_STORAGE_ERROR') = 1, 'shadow ledger must hold one expected incident with its recipients');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0 AND pg_temp.n_notif() = 0 AND pg_temp.n_push() = 0, 'shadow must not open incidents, ring or push');
  FOR i IN 2..3 LOOP
    s := t + i * interval '2 minutes';
    PERFORM pg_temp.snap(1, s - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('NORMAL'));
    PERFORM pg_temp.tick(s);
  END LOOP;
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE status = 'SHADOW' AND kind = 'RESOLVED') = 1
    AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions) AND pg_temp.n_inc() = 0 AND pg_temp.n_notif() = 0,
    'shadow must record the expected recovery only');
END $c10$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ca 11 — DB TEST đã đánh dấu: hàm JWT ném lỗi, chuông vẫn ghi, sổ có lý do.
-- ---------------------------------------------------------------------------
BEGIN;
CREATE SCHEMA test_env;
CREATE TABLE test_env.danh_dau (id integer);
DO $c11$
DECLARE t timestamptz := pg_temp.at(0, '17:00');
BEGIN
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_notif() = 2 AND pg_temp.n_push() = 0, 'the bell must be written even when push credentials are refused');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries
      WHERE channel = 'PUSH' AND status = 'FAILED' AND result ->> 'error' LIKE '55000:%TEST%') = 2, 'the ledger must record why push was not sent');
END $c11$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- RPC đọc của tab Camera và ACL thật qua vai PostgreSQL.
-- ---------------------------------------------------------------------------
BEGIN;
DO $setup$
BEGIN
  PERFORM pg_temp.snap(1, pg_temp.at(0, '09:00') - interval '30 seconds', 'ONLINE', pg_temp.ch(), pg_temp.disk('ERROR'));
  PERFORM pg_temp.tick(pg_temp.at(0, '09:00'));
END $setup$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-000000000002', true);
DO $read$
DECLARE r jsonb := public.camera_building_incidents_v1('dddd1000-0000-4000-8000-000000000001');
BEGIN
  IF jsonb_array_length(r -> 'items') <> 1 OR r #>> '{items,0,incident_type}' <> 'CAMERA_STORAGE_ERROR'
     OR r #>> '{items,0,recorder_id}' <> 'dddd8000-0000-4000-8000-0000000000a1' OR r #>> '{items,0,subject}' <> 'storage:1' THEN
    RAISE EXCEPTION 'camera alert proof: manager cannot read the open camera incident: %', r;
  END IF;
  BEGIN PERFORM app_private.camera_alert_evaluate_v1(); RAISE EXCEPTION 'camera alert proof: evaluator executable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM app_private.camera_alert_deliveries; RAISE EXCEPTION 'camera alert proof: ledger readable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM app_private.network_center_alert_recipient_ids_v1('dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: recipient resolver executable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $read$;
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-000000000001', true);
DO $denied$
BEGIN
  BEGIN PERFORM public.camera_building_incidents_v1('dddd1000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: accountant of building B read building A incidents';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $denied$;
RESET ROLE;
ROLLBACK;

SELECT 'CAMERA_ALERTS_PROOF_OK';
