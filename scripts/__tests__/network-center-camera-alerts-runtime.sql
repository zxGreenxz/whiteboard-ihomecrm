-- Cảnh báo camera v2 — proof trên PostgreSQL dùng một lần.
-- Spec: docs/superpowers/plans/2026-11-24-canh-bao-camera-v2.md §8 (16 mục).
--
-- Mốc giờ tính TƯƠNG ĐỐI theo giờ Việt Nam, neo vào thứ Hai của tuần cách đây
-- hai tuần (ngày 0 = thứ Hai, ngày 7 = thứ Hai kế), không ghim ngày lịch: bộ
-- đánh giá nhận p_now giả lập, còn quyền/thành viên đọc giờ thật, nên mọi mốc
-- giả lập nằm trong quá khứ ở mọi ngày chạy. Ca cần sổ 7 ngày (list_deliveries)
-- dùng mốc ngay trước giờ thật.
--
-- Phần chung ở trên dòng "-- @@case" đầu tiên; mỗi ca chạy trong transaction
-- riêng rồi ROLLBACK về fixture gốc. Runner chọn được từng ca để kiểm đột biến.
-- Dữ liệu chỉ là DEMO trung tính: không id, tên toà hay số điện thoại thật.

-- ---------------------------------------------------------------------------
-- Fixture gốc.
-- ---------------------------------------------------------------------------
UPDATE public.buildings SET name = 'TOA-A' WHERE id = 'dddd1000-0000-4000-8000-000000000001';
UPDATE public.buildings SET name = 'TOA-B' WHERE id = 'dddd1000-0000-4000-8000-000000000002';
UPDATE public.buildings SET name = 'TOA-X' WHERE id = 'aaaa1000-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, aud, role, email) VALUES
  ('dddd2000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'camera.inactive@example.invalid'),
  ('dddd2000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'camera.superadmin@example.invalid'),
  ('dddd2000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'camera.outside-admin@example.invalid');
INSERT INTO public.organization_memberships (id, organization_id, user_id, member_type, status, activated_at) VALUES
  ('dddd5000-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'dddd2000-0000-4000-8000-0000000000a1', 'STAFF', 'SUSPENDED', clock_timestamp()),
  ('dddd5000-0000-4000-8000-0000000000a2', 'dddd0000-0000-4000-8000-000000000001', 'dddd2000-0000-4000-8000-0000000000a2', 'STAFF', 'ACTIVE', clock_timestamp());
-- a2: super admin là thành viên org DEMO; a3: super admin KHÔNG là thành viên.
INSERT INTO public.super_admins (user_id) VALUES
  ('dddd2000-0000-4000-8000-0000000000a2'), ('dddd2000-0000-4000-8000-0000000000a3');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('de6f33f3-349f-4bec-bd3d-106192f6715e', '  Chủ Thử  ', 'owner@example.test')
ON CONFLICT (id) DO NOTHING;

-- Chủ công ty của mỗi org: vai TENANT_OWNER, KHÔNG có quyền network_center nào
-- ⇒ chỉ lọt qua nhánh chủ công ty.
INSERT INTO public.organization_roles (id, organization_id, name, is_system, system_key) VALUES
  ('dddd6100-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'Chủ công ty', true, 'TENANT_OWNER'),
  ('aaaa6100-0000-4000-8000-0000000000a1', 'aaaa0000-0000-4000-8000-000000000001', 'Chủ công ty', true, 'TENANT_OWNER');
INSERT INTO public.role_bindings (id, organization_id, membership_id, role_id) VALUES
  ('dddd6200-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000001', 'dddd6100-0000-4000-8000-0000000000a1'),
  ('aaaa6200-0000-4000-8000-0000000000a1', 'aaaa0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-00000000000a', 'aaaa6100-0000-4000-8000-0000000000a1');

-- Quản lý M xem toà A; kế toán K xem + thao tác toà B; thành viên ngừng hoạt động
-- và super admin a2 xem cả org.
INSERT INTO public.member_permission_overrides (id, organization_id, membership_id, permission_key, effect, scope_mode) VALUES
  ('dddd6000-0000-4000-8000-0000000000a3', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000003', 'network_center.view', 'ALLOW', 'SCOPED'),
  ('dddd6000-0000-4000-8000-0000000000a2', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000002', 'network_center.view', 'ALLOW', 'SCOPED'),
  ('dddd6000-0000-4000-8000-0000000000e2', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-000000000002', 'network_center.execute', 'ALLOW', 'SCOPED'),
  ('dddd6000-0000-4000-8000-0000000000b1', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-0000000000a1', 'network_center.view', 'ALLOW', 'ORGANIZATION'),
  ('dddd6000-0000-4000-8000-0000000000b2', 'dddd0000-0000-4000-8000-000000000001', 'dddd5000-0000-4000-8000-0000000000a2', 'network_center.view', 'ALLOW', 'ORGANIZATION');
INSERT INTO public.member_override_scopes (organization_id, override_id, scope_id)
SELECT s.organization_id, o.override_id, s.id
  FROM (VALUES
    ('dddd6000-0000-4000-8000-0000000000a3'::uuid, 'BUILDING', 'dddd1000-0000-4000-8000-000000000001'::uuid),
    ('dddd6000-0000-4000-8000-0000000000a2'::uuid, 'BUILDING', 'dddd1000-0000-4000-8000-000000000002'::uuid),
    ('dddd6000-0000-4000-8000-0000000000e2'::uuid, 'BUILDING', 'dddd1000-0000-4000-8000-000000000002'::uuid),
    ('dddd6000-0000-4000-8000-0000000000b1'::uuid, 'ORGANIZATION', NULL::uuid),
    ('dddd6000-0000-4000-8000-0000000000b2'::uuid, 'ORGANIZATION', NULL::uuid)
  ) o(override_id, scope_type, building_id)
  JOIN public.authorization_scopes s
    ON s.organization_id = 'dddd0000-0000-4000-8000-000000000001'
   AND s.scope_type = o.scope_type
   AND s.building_id IS NOT DISTINCT FROM o.building_id;

-- Router cho toà X của org khác (seed chỉ có router cho A và B).
INSERT INTO public.network_devices (organization_id, building_id, device_kind, external_key, display_name, vendor, lifecycle_status, write_capability, is_active)
VALUES ('aaaa0000-0000-4000-8000-000000000001', 'aaaa1000-0000-4000-8000-000000000001', 'MIKROTIK', 'slot:primary', 'Router X', 'MikroTik', 'UNPROVISIONED', true, true);
INSERT INTO public.network_device_connections (id, organization_id, building_id, device_id, transport, management_ip, management_port, credential_ref, host_key_fingerprint, is_enabled)
SELECT x.conn, d.organization_id, d.building_id, d.id, 'ROUTEROS_SSH', x.ip::inet, 22, x.cred, 'SHA256:' || repeat('d', 43), true
  FROM (VALUES
    ('dddd9000-0000-4000-8000-0000000000a1'::uuid, 'dddd1000-0000-4000-8000-000000000001'::uuid, '10.91.0.1', 'router/camera-alert-a'),
    ('dddd9000-0000-4000-8000-0000000000a2'::uuid, 'dddd1000-0000-4000-8000-000000000002'::uuid, '10.91.0.2', 'router/camera-alert-b'),
    ('aaaa9000-0000-4000-8000-0000000000a1'::uuid, 'aaaa1000-0000-4000-8000-000000000001'::uuid, '10.91.0.9', 'router/camera-alert-x')
  ) x(conn, building, ip, cred)
  JOIN public.network_devices d ON d.building_id = x.building AND d.device_kind = 'MIKROTIK';

-- R1, R2: toà A (16 kênh); R3: toà B (8 kênh); R9: toà X của org khác.
SELECT public.network_center_admin_enroll_camera_v1(x.id, x.org, x.building, x.conn, x.name, x.vendor, NULL, x.channels, x.endpoint, x.cred, true)
  FROM (VALUES
    ('dddd8000-0000-4000-8000-0000000000a1'::uuid, 'dddd0000-0000-4000-8000-000000000001'::uuid, 'dddd1000-0000-4000-8000-000000000001'::uuid, 'dddd9000-0000-4000-8000-0000000000a1'::uuid, 'NVR-1', 'KBVISION', 16, 'http://10.91.0.11:80', 'camera/alert-1'),
    ('dddd8000-0000-4000-8000-0000000000a2'::uuid, 'dddd0000-0000-4000-8000-000000000001'::uuid, 'dddd1000-0000-4000-8000-000000000001'::uuid, 'dddd9000-0000-4000-8000-0000000000a1'::uuid, 'NVR-2', 'HIKVISION', 16, 'http://10.91.0.12:80', 'camera/alert-2'),
    ('dddd8000-0000-4000-8000-0000000000a3'::uuid, 'dddd0000-0000-4000-8000-000000000001'::uuid, 'dddd1000-0000-4000-8000-000000000002'::uuid, 'dddd9000-0000-4000-8000-0000000000a2'::uuid, 'NVR-3', 'KBVISION', 8, 'http://10.91.0.13:80', 'camera/alert-3'),
    ('aaaa8000-0000-4000-8000-0000000000a9'::uuid, 'aaaa0000-0000-4000-8000-000000000001'::uuid, 'aaaa1000-0000-4000-8000-000000000001'::uuid, 'aaaa9000-0000-4000-8000-0000000000a1'::uuid, 'NVR-X', 'KBVISION', 4, 'http://10.91.0.19:80', 'camera/alert-x')
  ) x(id, org, building, conn, name, vendor, channels, endpoint, cred);

-- Zalo: nick cá nhân đang kết nối + nhóm của org DEMO; hội thoại 1-1; nick đã
-- ngắt; nhóm của org khác.
INSERT INTO public.zalo_accounts (id, user_id, organization_id, kind, name, status) VALUES
  ('dddd3000-0000-4000-8000-0000000000a1', 'de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd0000-0000-4000-8000-000000000001', 'personal', 'Nick thử', 'connected'),
  ('dddd3000-0000-4000-8000-0000000000a2', 'de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd0000-0000-4000-8000-000000000001', 'personal', 'Nick đã ngắt', 'disconnected'),
  ('aaaa3000-0000-4000-8000-0000000000a1', '90450d5f-29b6-4897-bdef-cdb5fb53f339', 'aaaa0000-0000-4000-8000-000000000001', 'personal', 'Nick org khác', 'connected');
INSERT INTO public.zalo_conversations (id, user_id, account_id, organization_id, thread_id, thread_type, peer_name, last_message_at) VALUES
  ('dddd4000-0000-4000-8000-0000000000a1', 'de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd3000-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'g-thu-1', 'group', 'Nhóm kỹ thuật thử', now() - interval '1 hour'),
  ('dddd4000-0000-4000-8000-0000000000a2', 'de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd3000-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'u-thu-1', 'user', 'Khách thử', now()),
  ('dddd4000-0000-4000-8000-0000000000a3', 'de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd3000-0000-4000-8000-0000000000a2', 'dddd0000-0000-4000-8000-000000000001', 'g-thu-2', 'group', 'Nhóm của nick đã ngắt', now()),
  ('dddd4000-0000-4000-8000-0000000000a4', 'de6f33f3-349f-4bec-bd3d-106192f6715e', 'dddd3000-0000-4000-8000-0000000000a1', 'dddd0000-0000-4000-8000-000000000001', 'g-thu-3', 'group', 'Nhóm 100%_vui', now() - interval '2 hours'),
  ('aaaa4000-0000-4000-8000-0000000000a1', '90450d5f-29b6-4897-bdef-cdb5fb53f339', 'aaaa3000-0000-4000-8000-0000000000a1', 'aaaa0000-0000-4000-8000-000000000001', 'g-x-1', 'group', 'Nhóm org khác', now());

-- ---------------------------------------------------------------------------
-- Công cụ cho các ca (dùng dưới vai postgres).
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.expect(p_ok boolean, p_message text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'camera alert proof: %', p_message; END IF;
END $fn$;
-- Giờ Việt Nam: ngày (thứ Hai cách đây hai tuần + p_day), giờ p_time.
CREATE FUNCTION pg_temp.at(p_day integer, p_time time) RETURNS timestamptz LANGUAGE sql AS $fn$
  SELECT ((date_trunc('week', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 14 + p_day) + p_time) AT TIME ZONE 'Asia/Ho_Chi_Minh'
$fn$;
CREATE FUNCTION pg_temp.rec(p_n integer) RETURNS uuid LANGUAGE sql AS $fn$
  SELECT ('dddd8000-0000-4000-8000-0000000000a' || p_n)::uuid
$fn$;
-- Chỉ các đầu ghi này của org DEMO đang theo dõi.
CREATE FUNCTION pg_temp.only(p_recs integer[]) RETURNS void LANGUAGE sql AS $fn$
  UPDATE public.camera_recorders SET enabled = (id = ANY (SELECT pg_temp.rec(n) FROM unnest(p_recs) n))
   WHERE organization_id = 'dddd0000-0000-4000-8000-000000000001'
$fn$;
-- Bật cảnh báo cho org DEMO, nơi nhận là nhóm thử; p_types đè từng loại.
CREATE FUNCTION pg_temp.live(p_mode text DEFAULT 'LIVE', p_types jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO app_private.camera_alert_settings (organization_id, enabled, mode, zalo_account_id, zalo_conversation_id, types)
  VALUES ('dddd0000-0000-4000-8000-000000000001', true, p_mode, 'dddd3000-0000-4000-8000-0000000000a1',
    'dddd4000-0000-4000-8000-0000000000a1', app_private.camera_alert_types_v1(p_types))
$fn$;
CREATE FUNCTION pg_temp.disks(p_slots integer, p_error integer[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_agg(jsonb_build_object('slot', s, 'state', CASE WHEN s = ANY(p_error) THEN 'ERROR' ELSE 'NORMAL' END,
    'totalBytes', 100, 'usedBytes', 50) ORDER BY s) FROM generate_series(1, p_slots) s
$fn$;
-- Ghi thẳng snapshot. Đầu ghi khác ONLINE thì kênh/ổ thành UNKNOWN như server
-- chuẩn hoá (B2), trừ khi p_raw.
CREATE FUNCTION pg_temp.snapx(p_n integer, p_at timestamptz, p_status text, p_lost integer[], p_storage jsonb, p_raw boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.camera_recorder_current (recorder_id, organization_id, building_id, status, checked_at, received_at, channels, storage, event_coverage, issues)
  SELECT r.id, r.organization_id, r.building_id, p_status, p_at, p_at,
    (SELECT jsonb_agg(jsonb_build_object('channel', i, 'name', 'Cam ' || i,
       'state', CASE WHEN p_status <> 'ONLINE' AND NOT p_raw THEN 'UNKNOWN' WHEN i = ANY(p_lost) THEN 'DISCONNECTED' ELSE 'CONNECTED' END) ORDER BY i)
       FROM generate_series(1, r.channel_count) i),
    (SELECT jsonb_agg(CASE WHEN p_status <> 'ONLINE' AND NOT p_raw THEN d.value || jsonb_build_object('state', 'UNKNOWN') ELSE d.value END)
       FROM jsonb_array_elements(p_storage) d),
    'STATE_POLLING_ONLY', '{}'
    FROM public.camera_recorders r WHERE r.id = pg_temp.rec(p_n)
  ON CONFLICT (recorder_id) DO UPDATE SET status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
    received_at = EXCLUDED.received_at, channels = EXCLUDED.channels, storage = EXCLUDED.storage
$fn$;
CREATE FUNCTION pg_temp.snap(p_n integer, p_at timestamptz, p_status text, p_lost integer[] DEFAULT '{}', p_disk text DEFAULT 'NORMAL', p_raw boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $fn$
  SELECT pg_temp.snapx(p_n, p_at, p_status, p_lost,
    pg_temp.disks(1, CASE WHEN p_disk = 'ERROR' THEN ARRAY[1] ELSE '{}'::integer[] END), p_raw)
$fn$;
-- Một lượt. Bộ đánh giá nuốt lỗi từng org để org khác vẫn chạy; ở đây lỗi phải
-- làm ca đỏ, không thì "không có tin" sẽ xanh rỗng.
CREATE FUNCTION pg_temp.tick(p_at timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE r jsonb := app_private.camera_alert_evaluate_v1(p_at);
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r -> 'organizations', '[]'::jsonb)) o WHERE o.value ? 'error') THEN
    RAISE EXCEPTION 'camera alert proof: lượt đánh giá lỗi %', r;
  END IF;
  RETURN r;
END $fn$;
-- Các lượt từ p_from tới p_to (gồm), mỗi lượt ghi snapshot 30 giây trước.
CREATE FUNCTION pg_temp.sim(p_from timestamptz, p_to timestamptz, p_step interval, p_recs integer[],
  p_status text DEFAULT 'ONLINE', p_lost integer[] DEFAULT '{}', p_disk text DEFAULT 'NORMAL', p_raw boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE t timestamptz := p_from; n integer;
BEGIN
  WHILE t <= p_to LOOP
    FOREACH n IN ARRAY p_recs LOOP
      PERFORM pg_temp.snap(n, t - interval '30 seconds', p_status, p_lost, p_disk, p_raw);
    END LOOP;
    PERFORM pg_temp.tick(t);
    t := t + p_step;
  END LOOP;
END $fn$;
CREATE FUNCTION pg_temp.n_jobs() RETURNS bigint LANGUAGE sql AS $fn$ SELECT count(*) FROM public.zalo_send_queue $fn$;
CREATE FUNCTION pg_temp.n_bell() RETURNS bigint LANGUAGE sql AS $fn$ SELECT count(*) FROM public.notifications $fn$;
CREATE FUNCTION pg_temp.n_inc(p_type text DEFAULT NULL, p_status text DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $fn$
  SELECT count(*) FROM public.network_incidents
   WHERE left(incident_type, 7) = 'CAMERA_' AND (p_type IS NULL OR incident_type = p_type) AND (p_status IS NULL OR status = p_status)
$fn$;
CREATE FUNCTION pg_temp.n_dl(p_kind text, p_status text DEFAULT NULL, p_channel text DEFAULT 'ZALO') RETURNS bigint LANGUAGE sql AS $fn$
  SELECT count(*) FROM app_private.camera_alert_deliveries
   WHERE (p_kind IS NULL OR kind = p_kind) AND (p_status IS NULL OR status = p_status) AND channel = p_channel
$fn$;
-- Nguyên văn các tin Zalo đã xếp hàng (theo thứ tự).
CREATE FUNCTION pg_temp.sent(p_kind text DEFAULT NULL) RETURNS text LANGUAGE sql AS $fn$
  SELECT coalesce(string_agg(body, E'\n---\n' ORDER BY created_at, id), '')
    FROM app_private.camera_alert_deliveries
   WHERE channel = 'ZALO' AND status = 'QUEUED' AND (p_kind IS NULL OR kind = p_kind)
$fn$;

-- @@case cron
-- Lịch pg_cron: đúng một job */2 (migration đã chạy hai lượt), lệnh có trần thời
-- gian; chạy lệnh khi không org nào bật thì không làm gì.
BEGIN;
DO $cron$
DECLARE v_command text; v_before bigint;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'camera-alert-evaluate' AND schedule = '*/2 * * * *' AND active;
  PERFORM pg_temp.expect((SELECT count(*) FROM cron.job) = 1 AND v_command IS NOT NULL, 'phải có đúng một job */2 camera-alert-evaluate');
  PERFORM pg_temp.expect(v_command = 'SET statement_timeout = ''10s''; SELECT app_private.camera_alert_evaluate_v1();', 'lệnh của job phải tự mang statement_timeout');
  PERFORM pg_temp.snap(3, clock_timestamp() - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  SELECT count(*) INTO v_before FROM app_private.camera_alert_conditions;
  EXECUTE v_command;
  RESET statement_timeout;
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_conditions) = v_before AND pg_temp.n_inc() = 0
    AND pg_temp.n_bell() = 0 AND pg_temp.n_jobs() = 0, 'không org nào bật thì lệnh lịch không được làm gì');
END $cron$;
ROLLBACK;

-- @@case c01
-- Mục 1 — ngưỡng từng loại và trễ đóng 2 lượt.
BEGIN;
DO $c01a$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_STORAGE_ERROR', 'OPEN') = 1, 'ổ lỗi phải mở ngay ở lượt đầu thấy lỗi');
  PERFORM pg_temp.expect((SELECT severity FROM public.network_incidents) = 'CRITICAL', 'ổ lỗi là CRITICAL');
  PERFORM pg_temp.snap(3, t + interval '90 seconds', 'ONLINE', '{}', 'NORMAL');
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_STORAGE_ERROR', 'RECOVERING') = 1, 'lượt tốt đầu tiên chỉ được RECOVERING');
  PERFORM pg_temp.snap(3, t + interval '210 seconds', 'ONLINE', '{}', 'NORMAL');
  PERFORM pg_temp.tick(t + interval '4 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_STORAGE_ERROR', 'RESOLVED') = 1, 'hai lượt tốt liên tiếp mới đóng');
END $c01a$;
ROLLBACK;
BEGIN;
DO $c01b$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t, t + interval '14 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[2]);
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'kênh mất chưa đủ 15 phút không được mở sự cố');
  PERFORM pg_temp.sim(t + interval '16 minutes', t + interval '16 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[2]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1
    AND (SELECT severity FROM public.network_incidents) = 'WARNING', 'kênh mất ≥ 15 phút mở WARNING (1/8 kênh)');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1, 'kênh mất ban ngày gửi một tin Zalo');
  PERFORM pg_temp.sim(t + interval '18 minutes', t + interval '18 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'RECOVERING') = 1, 'kênh có lại một lượt chỉ RECOVERING');
  PERFORM pg_temp.sim(t + interval '20 minutes', t + interval '20 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[2]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1 AND pg_temp.n_inc() = 1 AND pg_temp.n_jobs() = 1,
    'tái phát khi RECOVERING mở lại lặng lẽ, không tin mới');
  PERFORM pg_temp.sim(t + interval '22 minutes', t + interval '24 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'RESOLVED') = 1, 'hai lượt tốt mới đóng kênh');
  PERFORM pg_temp.expect((SELECT array_agg(event_kind ORDER BY event_seq) FROM public.network_incident_events)
    = ARRAY['OPENED', 'RECOVERED', 'OBSERVED', 'RECOVERED', 'RESOLVED'], 'chuỗi sự kiện của sự cố sai');
END $c01b$;
ROLLBACK;
BEGIN;
DO $c01c$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); v_status text := 'OFFLINE';
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t, t + interval '8 minutes', interval '2 minutes', ARRAY[3], v_status);
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, v_status || ' chưa đủ 10 phút không được mở');
  PERFORM pg_temp.sim(t + interval '10 minutes', t + interval '10 minutes', interval '2 minutes', ARRAY[3], v_status);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_OFFLINE', 'OPEN') = 1 AND pg_temp.n_inc() = 1,
    v_status || ' đủ 10 phút phải mở đúng một sự cố');
END $c01c$;
ROLLBACK;
BEGIN;
DO $c01c$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); v_status text := 'AUTH_DENIED';
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t, t + interval '8 minutes', interval '2 minutes', ARRAY[3], v_status);
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, v_status || ' chưa đủ 10 phút không được mở');
  PERFORM pg_temp.sim(t + interval '10 minutes', t + interval '10 minutes', interval '2 minutes', ARRAY[3], v_status);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_AUTH_DENIED', 'OPEN') = 1 AND pg_temp.n_inc() = 1,
    v_status || ' đủ 10 phút phải mở đúng một sự cố');
END $c01c$;
ROLLBACK;
BEGIN;
DO $c01d$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t, t + interval '28 minutes', interval '2 minutes', ARRAY[3], 'UNKNOWN');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'trả lời lạ chưa đủ 30 phút không được mở');
  PERFORM pg_temp.sim(t + interval '30 minutes', t + interval '30 minutes', interval '2 minutes', ARRAY[3], 'UNKNOWN');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_UNKNOWN', 'OPEN') = 1, 'trả lời lạ đủ 30 phút phải mở');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 0 AND pg_temp.n_bell() = 2, 'trả lời lạ mặc định chỉ báo chuông (chủ + người xem toà B)');
END $c01d$;
ROLLBACK;
BEGIN;
DO $c01e$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); i integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE');
  FOR i IN 0..4 LOOP PERFORM pg_temp.tick(t + i * interval '2 minutes'); END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'mất dữ liệu chưa đủ 10 phút không được mở');
  PERFORM pg_temp.tick(t + interval '10 minutes');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_MONITOR_STALE', 'OPEN') = 1, 'mất dữ liệu đủ 10 phút phải mở');
END $c01e$;
ROLLBACK;
BEGIN;
DO $c01f$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]);
  PERFORM pg_temp.live('LIVE', '{"CAMERA_RECORDER_OFFLINE": {"threshold_seconds": 1200}}'::jsonb);
  PERFORM pg_temp.sim(t, t + interval '18 minutes', interval '2 minutes', ARRAY[3], 'OFFLINE');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0, 'ngưỡng sửa thành 20 phút thì 18 phút chưa mở');
  PERFORM pg_temp.sim(t + interval '20 minutes', t + interval '20 minutes', interval '2 minutes', ARRAY[3], 'OFFLINE');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_OFFLINE') = 1, 'ngưỡng sửa được phải có hiệu lực');
END $c01f$;
ROLLBACK;

-- @@case c02
-- Mục 2 — B2: đầu ghi OFFLINE thì không mở (và đóng lặng) sự cố kênh hay ổ.
BEGIN;
DO $c02a$
DECLARE t timestamptz := pg_temp.at(1, '11:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_STORAGE_ERROR', 'OPEN') = 1 AND pg_temp.n_jobs() = 1, 'fixture: ổ lỗi đang mở');
  PERFORM pg_temp.sim(t + interval '2 minutes', t + interval '12 minutes', interval '2 minutes', ARRAY[3], 'OFFLINE');
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_RECORDER_OFFLINE', 'OPEN') = 1, 'đầu ghi OFFLINE phải mở');
  PERFORM pg_temp.expect((SELECT status FROM public.network_incidents WHERE incident_type = 'CAMERA_STORAGE_ERROR') = 'RESOLVED'
    AND EXISTS (SELECT 1 FROM public.network_incident_events WHERE event_kind = 'RESOLVED' AND details ->> 'reason' = 'SUPERSEDED'),
    'ổ lỗi phải đóng SUPERSEDED khi đầu ghi OFFLINE');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_events
    WHERE code = 'CAMERA_STORAGE_ERROR' AND kind = 'RESOLVED'), 'ổ bị che không phải là khôi phục');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2, 'chỉ thêm đúng tin đầu ghi mất');
END $c02a$;
ROLLBACK;
BEGIN;
DO $c02b$
DECLARE t timestamptz := pg_temp.at(1, '11:00'); i integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  FOR i IN 0..7 LOOP
    PERFORM pg_temp.snap(3, t + i * interval '2 minutes' - interval '30 seconds', 'OFFLINE', ARRAY[2], 'ERROR', true);
    PERFORM pg_temp.tick(t + i * interval '2 minutes');
    PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE subject <> 'recorder:offline'),
      'kênh/ổ của đầu ghi không ONLINE không được theo dõi (B2)');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc() = 1 AND pg_temp.n_inc('CAMERA_RECORDER_OFFLINE') = 1, 'đầu ghi OFFLINE chỉ có sự cố cấp đầu ghi');
END $c02b$;
ROLLBACK;

-- @@case c03
-- Mục 3 — IGNORE, SNOOZE (hết hạn thì theo dõi lại), KNOWN_BROKEN.
BEGIN;
DO $c03a$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t, t + interval '16 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[5]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1 AND pg_temp.n_jobs() = 1, 'fixture: kênh 5 đang mở');
END $c03a$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
DO $c03a_owner$
DECLARE r jsonb;
BEGIN
  r := public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a3', 2, 'IGNORE', NULL, '  chưa lắp  ');
  IF r ->> 'kind' <> 'IGNORE' OR r ->> 'note' <> 'chưa lắp' THEN RAISE EXCEPTION 'camera alert proof: tắt kênh trả sai %', r; END IF;
  PERFORM public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a3', 5, 'IGNORE', NULL, NULL);
END $c03a_owner$;
RESET ROLE;
DO $c03a_after$
DECLARE t timestamptz := pg_temp.at(1, '10:20');
BEGIN
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'RESOLVED') = 1
    AND EXISTS (SELECT 1 FROM public.network_incident_events WHERE event_kind = 'RESOLVED' AND details ->> 'reason' = 'MUTED'),
    'tắt báo kênh đang có sự cố phải đóng sự cố với lý do MUTED');
  PERFORM pg_temp.sim(t, t + interval '30 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[2, 5]);
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE subject IN ('channel:2', 'channel:5'))
    AND pg_temp.n_inc() = 1 AND pg_temp.n_jobs() = 1, 'kênh IGNORE không được theo dõi, không mở, không gửi');
END $c03a_after$;
ROLLBACK;
BEGIN;
DO $c03b$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  INSERT INTO app_private.camera_alert_channel_mutes (recorder_id, channel, organization_id, building_id, kind, until_at, set_by)
  VALUES (pg_temp.rec(3), 3, 'dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000002', 'SNOOZE',
    t + interval '20 minutes', 'de6f33f3-349f-4bec-bd3d-106192f6715e');
  PERFORM pg_temp.sim(t, t + interval '18 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[3]);
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions) AND pg_temp.n_inc() = 0,
    'kênh tạm ẩn không được theo dõi');
  PERFORM pg_temp.sim(t + interval '20 minutes', t + interval '34 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[3]);
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_channel_mutes) AND pg_temp.n_inc() = 0
    AND EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE subject = 'channel:3'),
    'hết hạn tạm ẩn thì xoá dấu và theo dõi lại từ đầu');
  PERFORM pg_temp.sim(t + interval '36 minutes', t + interval '36 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1, 'sau tạm ẩn, kênh mất đủ 15 phút phải mở');
END $c03b$;
ROLLBACK;
BEGIN;
DO $c03c$
DECLARE t timestamptz := pg_temp.at(0, '10:00'); d integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  INSERT INTO app_private.camera_alert_channel_mutes (recorder_id, channel, organization_id, building_id, kind, set_by)
  VALUES (pg_temp.rec(3), 4, 'dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000002', 'KNOWN_BROKEN',
    'de6f33f3-349f-4bec-bd3d-106192f6715e');
  PERFORM pg_temp.sim(t, t + interval '16 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[4]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1, 'kênh đã biết hỏng vẫn mở và giữ sự cố');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 0 AND pg_temp.n_bell() = 0, 'kênh đã biết hỏng không gửi tin mở riêng');
  FOR d IN 1..7 LOOP
    PERFORM pg_temp.sim(pg_temp.at(d, '08:05'), pg_temp.at(d, '08:05'), interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[4]);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 1 AND pg_temp.n_jobs() = 1, 'kênh đã biết hỏng chỉ được nhắc vào thứ Hai');
  PERFORM pg_temp.expect((SELECT extract(isodow FROM local_date) = 1 AND body LIKE '%Đã biết hỏng (nhắc thứ Hai): TOA-B kênh 4.%'
    FROM app_private.camera_alert_deliveries WHERE kind = 'DIGEST' AND channel = 'ZALO'), 'bản tin thứ Hai phải liệt kê kênh đã biết hỏng');
  PERFORM pg_temp.sim(pg_temp.at(7, '09:00'), pg_temp.at(7, '09:02'), interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'RESOLVED') = 1 AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_channel_mutes),
    'kênh có lại thì tự xoá dấu đã biết hỏng');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1, 'kênh đã biết hỏng có lại không gửi tin khôi phục riêng');
  PERFORM pg_temp.sim(pg_temp.at(8, '08:05'), pg_temp.at(8, '08:05'), interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2 AND pg_temp.sent('DIGEST') LIKE '%kênh 4 "Cam 4" đã sửa — có hình lại lúc%',
    'bản tin sáng phải ghi kênh đã sửa');
END $c03c$;
ROLLBACK;

-- @@case c04
-- Mục 4 — kịch bản 1392QT: 2 đầu ghi, 8 kênh mất thường trực, đầu ghi rớt và có
-- lại 5 lần trong 13 ngày; 2 kênh IGNORE, 6 kênh KNOWN_BROKEN.
BEGIN;
DO $c04_setup$
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 2]);
  INSERT INTO app_private.camera_alert_channel_mutes (recorder_id, channel, organization_id, building_id, kind, set_by)
  SELECT pg_temp.rec(x.n), x.ch, 'dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000001', x.kind,
         'de6f33f3-349f-4bec-bd3d-106192f6715e'
    FROM (VALUES (1, 12, 'IGNORE'), (1, 13, 'IGNORE'), (1, 5, 'KNOWN_BROKEN'), (1, 11, 'KNOWN_BROKEN'), (1, 14, 'KNOWN_BROKEN'),
                 (1, 15, 'KNOWN_BROKEN'), (1, 16, 'KNOWN_BROKEN'), (2, 10, 'KNOWN_BROKEN')) x(n, ch, kind);
  PERFORM pg_temp.snap(1, pg_temp.at(0, '08:59'), 'ONLINE', ARRAY[5, 11, 12, 13, 14, 15, 16]);
  PERFORM pg_temp.snap(2, pg_temp.at(0, '08:59'), 'ONLINE', ARRAY[10]);
END $c04_setup$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
DO $c04_enable$
DECLARE r jsonb;
BEGIN
  r := public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 0, jsonb_build_object(
    'enabled', true, 'mode', 'LIVE', 'zaloAccountId', 'dddd3000-0000-4000-8000-0000000000a1',
    'zaloConversationId', 'dddd4000-0000-4000-8000-0000000000a1'));
  IF r #>> '{settings,mode}' <> 'LIVE' OR (r #>> '{settings,version}')::integer <> 1 THEN
    RAISE EXCEPTION 'camera alert proof: chủ bật gửi thật không thành %', r;
  END IF;
END $c04_enable$;
RESET ROLE;
DO $c04$
DECLARE
  t timestamptz := pg_temp.at(0, '09:00');
  v_end timestamptz := pg_temp.at(13, '09:00');
  v_drops tstzrange[] := ARRAY[
    tstzrange(pg_temp.at(1, '10:00'), pg_temp.at(1, '10:40')),
    tstzrange(pg_temp.at(1, '15:00'), pg_temp.at(1, '15:30')),
    tstzrange(pg_temp.at(4, '02:00'), pg_temp.at(4, '02:30')),
    tstzrange(pg_temp.at(7, '09:00'), pg_temp.at(7, '09:05')),
    tstzrange(pg_temp.at(10, '18:00'), pg_temp.at(10, '18:40'))];
  v_status text;
BEGIN
  WHILE t <= v_end LOOP
    v_status := CASE WHEN EXISTS (SELECT 1 FROM unnest(v_drops) d WHERE d @> t) THEN 'OFFLINE' ELSE 'ONLINE' END;
    PERFORM pg_temp.snap(1, t - interval '30 seconds', v_status, ARRAY[5, 11, 12, 13, 14, 15, 16]);
    PERFORM pg_temp.snap(2, t - interval '30 seconds', v_status, ARRAY[10]);
    PERFORM pg_temp.tick(t);
    t := t + interval '10 minutes';
  END LOOP;

  PERFORM pg_temp.expect(pg_temp.n_dl('BASELINE', 'QUEUED') = 1, 'phải có đúng một tin hiện trạng');
  PERFORM pg_temp.expect((SELECT body LIKE '%Hiện trạng camera lúc bật cảnh báo%'
      AND body LIKE '%Đã biết hỏng (nhắc thứ Hai): TOA-A đầu ghi "NVR-1" kênh 5, 11, 14, 15, 16; đầu ghi "NVR-2" kênh 10.%'
      AND body NOT LIKE '%kênh 12%' AND body NOT LIKE '%kênh 13%'
    FROM app_private.camera_alert_deliveries WHERE kind = 'BASELINE' AND channel = 'ZALO'), 'tin hiện trạng sai: ' || pg_temp.sent('BASELINE'));
  PERFORM pg_temp.expect((SELECT building_ids FROM app_private.camera_alert_deliveries WHERE kind = 'BASELINE' AND channel = 'ZALO')
    = ARRAY['dddd1000-0000-4000-8000-000000000001'::uuid], 'tin hiện trạng nêu toà A thì sổ phải gắn toà A (lọc người xem)');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_events
    WHERE code = 'CAMERA_CHANNEL_LOST' AND decision NOT IN ('KNOWN_BROKEN', 'SILENT')),
    'không được có tin mở hay đóng kênh nào');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries
    WHERE kind IN ('OPENED', 'RESOLVED') AND status IN ('QUEUED', 'DEFERRED') AND body LIKE '%kênh%'),
    'tin của lượt không được nhắc kênh nào');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_events WHERE subject IN ('channel:12', 'channel:13'))
    AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_conditions WHERE subject IN ('channel:12', 'channel:13')),
    'kênh IGNORE không bao giờ được theo dõi');
  -- Đầu ghi rớt ≥ 10 phút: 4 lần (lần 09:00–09:05 ngắn). Lần thứ hai trong 24
  -- giờ bị chặn ⇒ 3 tin mở + 3 tin khôi phục, gộp 2 đầu ghi thành một dòng.
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE kind IN ('OPENED', 'RESOLVED') AND status = 'QUEUED') = 6,
    'số tin đầu ghi rớt/có lại sai: ' || pg_temp.sent('OPENED') || ' || ' || pg_temp.sent('RESOLVED'));
  PERFORM pg_temp.expect(pg_temp.sent('OPENED') LIKE '%TOA-A: không gọi tới được 2 đầu ghi từ%', 'hai đầu ghi cùng toà phải gộp một dòng');
  PERFORM pg_temp.expect(pg_temp.n_dl('OPENED', 'SUPPRESSED') = 2, 'lần rớt thứ hai trong 24 giờ phải bị chặn (2 đầu ghi)');
  PERFORM pg_temp.expect(EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries WHERE kind = 'DIGEST' AND channel = 'ZALO' AND body LIKE '%Đã biết hỏng%')
    AND NOT EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries WHERE kind = 'DIGEST' AND body LIKE '%Đã biết hỏng%'
                     AND extract(isodow FROM local_date) <> 1), 'nhắc kênh đã biết hỏng chỉ vào thứ Hai');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = (SELECT count(*) FROM app_private.camera_alert_deliveries WHERE channel = 'ZALO' AND status = 'QUEUED'),
    'mỗi tin QUEUED đúng một job Zalo');
END $c04$;
ROLLBACK;

-- @@case c05
-- Mục 5 — gộp theo toà; router mất / router còn kết nối / chưa rõ.
BEGIN;
DO $c05a$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 2]); PERFORM pg_temp.live();
  INSERT INTO public.network_incidents (organization_id, building_id, device_id, fingerprint, incident_type, severity, status,
    title, summary, opened_at, last_observed_at)
  SELECT d.organization_id, d.building_id, d.id, 'router-unreachable-proof-a', 'ROUTER_UNREACHABLE', 'CRITICAL', 'OPEN',
    'MikroTik mất kết nối quản trị', 'Worker không đọc được router', t - interval '5 minutes', t - interval '5 minutes'
    FROM public.network_devices d WHERE d.building_id = 'dddd1000-0000-4000-8000-000000000001' AND d.device_kind = 'MIKROTIK';
  PERFORM pg_temp.sim(t, t + interval '10 minutes', interval '2 minutes', ARRAY[1, 2], 'OFFLINE');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1, 'hai đầu ghi cùng mất trong một lượt chỉ một tin');
  PERFORM pg_temp.expect(pg_temp.sent() LIKE '⚠ TOA-A mất mạng từ 10:00 — router và 2 đầu ghi đều không gọi tới được.%',
    'router mất phải ghi toà mất mạng: ' || pg_temp.sent());
END $c05a$;
ROLLBACK;
BEGIN;
DO $c05b$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); i integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 2]); PERFORM pg_temp.live();
  INSERT INTO public.network_device_current (device_id, organization_id, building_id, observed_at, reachable)
  SELECT d.id, d.organization_id, d.building_id, t + interval '5 minutes', true
    FROM public.network_devices d WHERE d.building_id = 'dddd1000-0000-4000-8000-000000000001' AND d.device_kind = 'MIKROTIK';
  FOR i IN 0..5 LOOP
    PERFORM pg_temp.snap(1, t + i * interval '2 minutes' - interval '30 seconds', 'OFFLINE');
    PERFORM pg_temp.snap(2, t + i * interval '2 minutes' - interval '30 seconds', 'ONLINE');
    PERFORM pg_temp.tick(t + i * interval '2 minutes');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.sent() LIKE '⚠ TOA-A: không gọi tới được đầu ghi "NVR-1" từ 10:00; router vẫn kết nối lúc 10:05 ⇒ nhiều khả năng đầu ghi tắt, treo hoặc tuột dây.%',
    'router còn kết nối phải ghi giờ đo router: ' || pg_temp.sent());
END $c05b$;
ROLLBACK;
BEGIN;
DO $c05c$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  -- Số đo router cũ hơn lúc đầu ghi mất: không đủ bằng chứng.
  INSERT INTO public.network_device_current (device_id, organization_id, building_id, observed_at, reachable)
  SELECT d.id, d.organization_id, d.building_id, t - interval '1 hour', true
    FROM public.network_devices d WHERE d.building_id = 'dddd1000-0000-4000-8000-000000000002' AND d.device_kind = 'MIKROTIK';
  PERFORM pg_temp.sim(t, t + interval '10 minutes', interval '2 minutes', ARRAY[3], 'OFFLINE');
  PERFORM pg_temp.expect(pg_temp.sent() LIKE '⚠ TOA-B: không gọi tới được đầu ghi từ 10:00 (router: chưa rõ).%',
    'không có số đo router mới hơn thì ghi chưa rõ: ' || pg_temp.sent());
END $c05c$;
ROLLBACK;
BEGIN;
DO $c05d$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND pg_temp.sent() LIKE E'⚠ Camera — 2 sự cố mới\n• TOA-A: Ổ cứng 1 báo LỖI (10:00). Đầu ghi có thể không lưu được video.\n• TOA-B: Ổ cứng 1 báo LỖI (10:00). Đầu ghi có thể không lưu được video.\nXem: CRM › Trung tâm mạng › Camera',
    'hai toà cùng lượt phải là một tin, mỗi toà một dòng: ' || pg_temp.sent());
  -- Chuông: một thông báo mỗi người; người chỉ xem một toà chỉ thấy dòng toà đó.
  PERFORM pg_temp.expect(pg_temp.n_bell() = 3, 'chuông phải tới chủ + quản lý A + kế toán B, mỗi người một thông báo');
  PERFORM pg_temp.expect((SELECT content NOT LIKE '%TOA-B%' AND metadata ->> 'url' = '/network-center/buildings/dddd1000-0000-4000-8000-000000000001?tab=cameras'
    FROM public.notifications WHERE user_id = 'dddd2000-0000-4000-8000-000000000002'), 'quản lý toà A không được thấy dòng toà B');
  PERFORM pg_temp.expect((SELECT content LIKE '%TOA-A%' AND content LIKE '%TOA-B%' AND type = 'CUSTOM' AND channel = 'IN_APP'
      AND metadata ->> 'v5' = 'camera_alert' AND push_state IS NULL
    FROM public.notifications WHERE user_id = 'de6f33f3-349f-4bec-bd3d-106192f6715e'), 'chủ công ty phải thấy cả hai toà, không đẩy push');
END $c05d$;
ROLLBACK;

-- @@case c06
-- Mục 6 — mất dữ liệu giám sát ở ≥ 2 toà ra MỘT tin.
BEGIN;
DO $c06a$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); i integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 2, 3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(1, t - interval '30 seconds', 'ONLINE');
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE');
  FOR i IN 0..5 LOOP
    PERFORM pg_temp.snap(2, t + i * interval '2 minutes' - interval '30 seconds', 'ONLINE');
    PERFORM pg_temp.tick(t + i * interval '2 minutes');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_MONITOR_STALE') = 2 AND pg_temp.n_jobs() = 1, 'hai toà mất dữ liệu: hai sự cố, một tin');
  PERFORM pg_temp.expect(pg_temp.sent() LIKE '⚠ Hệ thống giám sát camera ngừng gửi dữ liệu (2 toà) — kiểm tra VPS/collector.%'
    AND pg_temp.sent() NOT LIKE '%NVR%', 'tin gộp không liệt kê lỗi từng đầu ghi: ' || pg_temp.sent());
END $c06a$;
ROLLBACK;
BEGIN;
DO $c06b$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); i integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 2, 3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE');
  FOR i IN 0..5 LOOP
    PERFORM pg_temp.snap(1, t + i * interval '2 minutes' - interval '30 seconds', 'ONLINE');
    PERFORM pg_temp.snap(2, t + i * interval '2 minutes' - interval '30 seconds', 'ONLINE');
    PERFORM pg_temp.tick(t + i * interval '2 minutes');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.sent() LIKE '⚠ TOA-B: mất dữ liệu giám sát đầu ghi từ 09:59 — kiểm tra VPS/collector.%',
    'một toà mất dữ liệu thì ghi theo toà: ' || pg_temp.sent());
END $c06b$;
ROLLBACK;

-- @@case c07
-- Mục 7 — chặn lặp 24 giờ.
BEGIN;
DO $c07$
DECLARE t1 timestamptz := pg_temp.at(1, '10:00'); t2 timestamptz := pg_temp.at(1, '14:00'); t3 timestamptz := pg_temp.at(2, '11:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t1, t1, interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.sim(t1 + interval '2 minutes', t1 + interval '4 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2, 'lần đầu: tin mở + tin khôi phục (CRITICAL)');
  PERFORM pg_temp.sim(t2, t2, interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2 AND pg_temp.n_dl('OPENED', 'SUPPRESSED') = 1
    AND (SELECT reason FROM app_private.camera_alert_deliveries WHERE status = 'SUPPRESSED') = 'REPEAT_24H',
    'mở lại trong 24 giờ phải bị chặn (SUPPRESSED, REPEAT_24H)');
  PERFORM pg_temp.expect((SELECT occurrence_count FROM public.network_incidents WHERE status <> 'RESOLVED') = 2,
    'sự cố vẫn mở, occurrence_count tăng');
  PERFORM pg_temp.sim(t2 + interval '2 minutes', t2 + interval '4 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2 AND pg_temp.n_inc('CAMERA_STORAGE_ERROR', 'RESOLVED') = 2,
    'tin khôi phục của lần mở bị chặn cũng không gửi');
  PERFORM pg_temp.sim(pg_temp.at(2, '08:05'), pg_temp.at(2, '08:05'), interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 3 AND pg_temp.sent('DIGEST') LIKE '%tái diễn 1 lần trong 24 giờ qua%',
    'bản tin sáng phải ghi số lần tái diễn bị chặn: ' || pg_temp.sent('DIGEST'));
  PERFORM pg_temp.sim(t3, t3, interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 4, 'quá 24 giờ kể từ tin mở trước thì gửi lại');
END $c07$;
ROLLBACK;
-- Loại chỉ báo chuông (trả lời lạ) bị chặn lặp thì cũng không lọt vào bản tin Zalo.
BEGIN;
DO $c07b$
DECLARE t1 timestamptz := pg_temp.at(1, '10:00'); t2 timestamptz := pg_temp.at(1, '14:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t1, t1 + interval '30 minutes', interval '2 minutes', ARRAY[3], 'UNKNOWN');
  PERFORM pg_temp.sim(t1 + interval '32 minutes', t1 + interval '34 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.sim(t2, t2 + interval '30 minutes', interval '2 minutes', ARRAY[3], 'UNKNOWN');
  PERFORM pg_temp.expect(pg_temp.n_dl('OPENED', 'SUPPRESSED', 'IN_APP') = 1 AND pg_temp.n_jobs() = 0,
    'fixture: lần mở lại trong 24 giờ bị chặn, không có tin Zalo');
  PERFORM pg_temp.sim(pg_temp.at(2, '08:05'), pg_temp.at(2, '08:05'), interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 0 AND pg_temp.n_jobs() = 0,
    'tái diễn của loại chỉ báo chuông không được vào bản tin Zalo: ' || pg_temp.sent('DIGEST'));
END $c07b$;
ROLLBACK;

-- @@case c08
-- Mục 8 — đêm: kênh mất lúc 23:00 vào tin 07:00; ổ lỗi lúc 23:00 gửi ngay.
BEGIN;
DO $c08$
DECLARE t timestamptz := pg_temp.at(1, '23:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  WHILE t <= pg_temp.at(2, '07:05') LOOP
    PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE',
      CASE WHEN t < pg_temp.at(2, '03:00') THEN ARRAY[2] ELSE '{}'::integer[] END, 'ERROR');
    PERFORM pg_temp.tick(t);
    IF t = pg_temp.at(1, '23:20') THEN
      PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1 AND pg_temp.n_jobs() = 1,
        'đêm: ổ lỗi gửi ngay, kênh mất (WARNING) không gửi ngay');
      PERFORM pg_temp.expect(pg_temp.n_dl('OPENED', 'DEFERRED') = 1
        AND (SELECT reason FROM app_private.camera_alert_deliveries WHERE status = 'DEFERRED') = 'NIGHT', 'kênh mất ban đêm phải dồn');
      PERFORM pg_temp.expect(pg_temp.n_bell() = 4, 'chuông vẫn tới ngay cho cả hai mục (2 người × 2 lượt)');
    END IF;
    t := t + interval '5 minutes';
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2 AND pg_temp.n_dl('NIGHT_DIGEST', 'QUEUED') = 1, 'tin 07:00 phải được gửi');
  PERFORM pg_temp.expect(pg_temp.sent('NIGHT_DIGEST') LIKE '%TOA-B: Kênh 2 "Cam 2" mất hình (từ % 23:00). Đã có lại lúc 03:00.%',
    'tin 07:00 phải ghi rõ đã có lại: ' || pg_temp.sent('NIGHT_DIGEST'));
  PERFORM pg_temp.sim(pg_temp.at(2, '08:05'), pg_temp.at(2, '08:05'), interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 0 AND pg_temp.n_jobs() = 2, 'bản tin 08:00 không lặp mục đã có trong tin 07:00');
END $c08$;
ROLLBACK;

-- @@case c09
-- Mục 9 — nhắc: ngày 1–3 có, ngày 4–6 không, thứ Hai có; "Đã biết" thì hết nhắc.
BEGIN;
DO $c09$
DECLARE d integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(pg_temp.at(0, '10:00'), pg_temp.at(0, '10:00'), interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  FOR d IN 1..7 LOOP
    PERFORM pg_temp.sim(pg_temp.at(d, '08:05'), pg_temp.at(d, '08:05'), interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  END LOOP;
  PERFORM pg_temp.expect((SELECT array_agg(extract(isodow FROM local_date)::integer ORDER BY local_date)
    FROM app_private.camera_alert_deliveries WHERE kind = 'DIGEST' AND channel = 'ZALO') = ARRAY[2, 3, 4, 1],
    'nhắc phải đúng ngày 1, 2, 3 và thứ Hai (không ngày 4–6)');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_deliveries WHERE kind = 'DIGEST' AND channel = 'ZALO'
    AND (body NOT LIKE E'%Đang mở, chưa ai bấm "Đã biết":\n• TOA-B: ổ cứng 1 báo lỗi từ % 10:00 (%).%')), 'nội dung nhắc sai: ' || pg_temp.sent('DIGEST'));
END $c09$;
ROLLBACK;
-- Sau "Đã biết" thì hết nhắc: nhắc ngày 1, bấm "Đã biết", ngày 2 (vốn có nhắc) không còn.
BEGIN;
DO $c09b$
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(pg_temp.at(0, '10:00'), pg_temp.at(0, '10:00'), interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.sim(pg_temp.at(1, '08:05'), pg_temp.at(1, '08:05'), interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 1, 'fixture: ngày 1 có nhắc');
END $c09b$;
-- Kế toán K có network_center.execute ở toà B: bấm "Đã biết" (toà READ_ONLY).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-000000000001', true);
DO $c09_ack$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT (i ->> 'id')::uuid INTO v_id FROM jsonb_array_elements(public.camera_building_incidents_v1('dddd1000-0000-4000-8000-000000000002') -> 'items') i;
  r := public.camera_alert_acknowledge_incident_v1(v_id);
  IF r ->> 'status' <> 'ACKNOWLEDGED' OR r ->> 'acknowledgedBy' <> 'dddd2000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'camera alert proof: Đã biết không thành %', r;
  END IF;
  r := public.camera_alert_acknowledge_incident_v1(v_id);
  IF r ->> 'status' <> 'ACKNOWLEDGED' THEN RAISE EXCEPTION 'camera alert proof: Đã biết lần hai phải giữ nguyên'; END IF;
END $c09_ack$;
RESET ROLE;
DO $c09_after$
BEGIN
  PERFORM pg_temp.expect((SELECT count(*) FROM public.network_incident_events WHERE event_kind = 'ACKNOWLEDGED') = 1, 'Đã biết ghi đúng một sự kiện');
  PERFORM pg_temp.sim(pg_temp.at(2, '08:05'), pg_temp.at(2, '08:05'), interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 1, 'sau "Đã biết" thì hết nhắc');
END $c09_after$;
ROLLBACK;

-- @@case c10
-- Mục 10 — trần 6: tin thứ 6 có câu báo trần, tin thứ 7 DEFERRED và vào bản tin kế tiếp.
BEGIN;
DO $c10$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); k integer;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  FOR k IN 1..7 LOOP
    PERFORM pg_temp.snapx(3, t + k * interval '2 minutes' - interval '30 seconds', 'ONLINE', '{}',
      pg_temp.disks(8, ARRAY(SELECT generate_series(1, k))));
    PERFORM pg_temp.tick(t + k * interval '2 minutes');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 6 AND pg_temp.n_dl('OPENED', 'QUEUED') = 6, 'trần 6: đúng 6 tin được xếp hàng');
  PERFORM pg_temp.expect((SELECT body LIKE E'%Đã chạm trần 6 tin hôm nay — sự cố tiếp theo xem trong CRM và bản tin sáng.\nXem: CRM › Trung tâm mạng › Camera'
    FROM app_private.camera_alert_deliveries WHERE status = 'QUEUED' ORDER BY created_at DESC LIMIT 1), 'tin thứ 6 phải có câu báo trần');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE status = 'QUEUED' AND body LIKE '%Đã chạm trần%') = 1,
    'chỉ tin thứ 6 có câu báo trần');
  PERFORM pg_temp.expect((SELECT status = 'DEFERRED' AND reason = 'DAILY_CAP' AND pending_release AND body LIKE '%Ổ cứng 7 báo LỖI%'
    FROM app_private.camera_alert_deliveries WHERE kind = 'OPENED' AND channel = 'ZALO' ORDER BY created_at DESC LIMIT 1), 'tin thứ 7 phải DEFERRED/DAILY_CAP');
  PERFORM pg_temp.expect(pg_temp.n_dl('OPENED', 'SENT', 'IN_APP') = 7 AND pg_temp.n_bell() = 14, 'chuông vẫn gửi cả 7 lượt');
  PERFORM pg_temp.snapx(3, pg_temp.at(2, '07:05') - interval '30 seconds', 'ONLINE', '{}', pg_temp.disks(8, ARRAY[1, 2, 3, 4, 5, 6, 7]));
  PERFORM pg_temp.tick(pg_temp.at(2, '07:05'));
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 7 AND pg_temp.sent('NIGHT_DIGEST') LIKE '%TOA-B: Ổ cứng 7 báo LỖI%Vẫn còn lỗi.%',
    'mục vượt trần phải vào bản tin kế tiếp: ' || pg_temp.sent('NIGHT_DIGEST'));
  PERFORM pg_temp.expect((SELECT released_at IS NOT NULL FROM app_private.camera_alert_deliveries WHERE status = 'DEFERRED'), 'mục dồn phải được đánh dấu đã đưa vào bản tin');
END $c10$;
ROLLBACK;

-- @@case c11
-- Mục 11 — khôi phục: Zalo chỉ cho CRITICAL; kênh lẻ khôi phục vào bản tin.
BEGIN;
DO $c11$
DECLARE t timestamptz := pg_temp.at(1, '10:00');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.sim(t, t, interval '2 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.sim(t + interval '2 minutes', t + interval '4 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 2 AND pg_temp.sent('RESOLVED') LIKE '✅ TOA-B: ổ cứng 1 hết báo lỗi lúc 10:02.%',
    'CRITICAL khôi phục phải có tin Zalo: ' || pg_temp.sent('RESOLVED'));
  PERFORM pg_temp.expect((SELECT count(*) FROM public.notifications WHERE content LIKE '%hết báo lỗi%') = 2, 'chuông khôi phục CRITICAL');
  PERFORM pg_temp.sim(t + interval '10 minutes', t + interval '26 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 3, 'kênh mất ban ngày có tin mở');
  PERFORM pg_temp.sim(t + interval '28 minutes', t + interval '30 minutes', interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 3 AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE content LIKE '%có hình lại%'),
    'kênh lẻ (WARNING) khôi phục không gửi Zalo hay chuông riêng');
  PERFORM pg_temp.expect((SELECT digest_state FROM app_private.camera_alert_events WHERE kind = 'RESOLVED' AND code = 'CAMERA_CHANNEL_LOST') = 'PENDING',
    'kênh lẻ khôi phục phải chờ bản tin');
  PERFORM pg_temp.sim(pg_temp.at(2, '08:05'), pg_temp.at(2, '08:05'), interval '2 minutes', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 4 AND pg_temp.sent('DIGEST') LIKE E'%Từ bản tin trước:\n✅ TOA-B: kênh 3 "Cam 3" có hình lại lúc % 10:28 (mất 18 phút).%',
    'bản tin sáng phải ghi kênh lẻ đã khôi phục: ' || pg_temp.sent('DIGEST'));
END $c11$;
ROLLBACK;

-- @@case c12
-- Mục 12 — chập chờn: ≥ 5 lần rớt vào bản tin 08:00; dưới 5, kênh IGNORE, rớt do
-- đầu ghi vừa kết nối lại (UNKNOWN→DISCONNECTED), kênh đang có sự cố, hay quá 24
-- giờ thì không.
BEGIN;
DO $c12$
DECLARE d timestamptz := pg_temp.at(2, '08:05');
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  INSERT INTO app_private.camera_alert_channel_mutes (recorder_id, channel, organization_id, building_id, kind, set_by)
  VALUES (pg_temp.rec(3), 8, 'dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000002', 'IGNORE',
    'de6f33f3-349f-4bec-bd3d-106192f6715e');
  INSERT INTO public.camera_events (recorder_id, organization_id, building_id, event_key, kind, channel, previous_state, state, observed_at)
  SELECT pg_temp.rec(3), 'dddd0000-0000-4000-8000-000000000001', 'dddd1000-0000-4000-8000-000000000002',
         'flap:' || x.ch || ':' || g, 'CHANNEL', x.ch, x.prev, 'DISCONNECTED', d - x.back - g * interval '1 hour'
    FROM (VALUES (6, 5, 'CONNECTED', interval '0'), (7, 4, 'CONNECTED', interval '0'), (8, 6, 'CONNECTED', interval '0'),
                 (5, 6, 'UNKNOWN', interval '0'), (3, 6, 'CONNECTED', interval '0'), (2, 6, 'CONNECTED', interval '20 hours')) x(ch, n, prev, back),
         generate_series(1, x.n) g;
  PERFORM pg_temp.sim(pg_temp.at(2, '07:40'), d, interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[3]);
  PERFORM pg_temp.expect(pg_temp.n_inc('CAMERA_CHANNEL_LOST', 'OPEN') = 1, 'fixture: kênh 3 đang có sự cố');
  PERFORM pg_temp.expect(pg_temp.sent('DIGEST') LIKE '%Chập chờn 24 giờ qua: TOA-B kênh 6 (5 lần).%'
    AND pg_temp.sent('DIGEST') NOT LIKE '%kênh 7 (%' AND pg_temp.sent('DIGEST') NOT LIKE '%kênh 8 (%'
    AND pg_temp.sent('DIGEST') NOT LIKE '%kênh 5 (%' AND pg_temp.sent('DIGEST') NOT LIKE '%kênh 3 (%'
    AND pg_temp.sent('DIGEST') NOT LIKE '%kênh 2 (%', 'mục chập chờn sai: ' || pg_temp.sent('DIGEST'));
END $c12$;
ROLLBACK;

-- @@case c13
-- Mục 13 — SHADOW: không sự cố, chuông hay hàng đợi Zalo; sổ có nguyên văn tin.
-- Chuyển sang LIVE ra đúng một tin hiện trạng.
BEGIN;
SELECT pg_temp.only(ARRAY[3]);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
SELECT public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 0, jsonb_build_object(
  'enabled', true, 'mode', 'SHADOW', 'zaloAccountId', 'dddd3000-0000-4000-8000-0000000000a1',
  'zaloConversationId', 'dddd4000-0000-4000-8000-0000000000a1')) IS NOT NULL AS saved;
RESET ROLE;
DO $c13$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); u timestamptz;
BEGIN
  u := t;
  WHILE u <= t + interval '40 minutes' LOOP
    PERFORM pg_temp.snap(3, u - interval '30 seconds', 'ONLINE',
      CASE WHEN u >= t + interval '10 minutes' THEN ARRAY[2, 5] ELSE ARRAY[2] END, 'ERROR');
    PERFORM pg_temp.tick(u);
    u := u + interval '2 minutes';
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.n_inc() = 0 AND pg_temp.n_bell() = 0 AND pg_temp.n_jobs() = 0
    AND NOT EXISTS (SELECT 1 FROM public.zalo_messages), 'SHADOW không mở sự cố, không chuông, không xếp Zalo');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE kind = 'BASELINE' AND status = 'SHADOW'
      AND body LIKE '📋 Hiện trạng camera lúc bật cảnh báo%TOA-B: Ổ cứng 1 báo LỖI%TOA-B: Kênh 2 "Cam 2" mất hình%') = 1,
    'SHADOW phải ghi tin hiện trạng dự kiến');
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_deliveries WHERE kind = 'OPENED' AND status = 'SHADOW'
      AND reason = 'WOULD_QUEUE' AND body LIKE '⚠ TOA-B: Kênh 5 "Cam 5" mất hình 16 phút (từ 10:10).%') = 1,
    'SHADOW phải ghi nguyên văn tin lẽ ra đã gửi');
END $c13$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
SELECT public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"mode": "LIVE"}'::jsonb) IS NOT NULL AS saved;
RESET ROLE;
DO $c13_live$
DECLARE t timestamptz := pg_temp.at(1, '10:42');
BEGIN
  PERFORM pg_temp.sim(t, t + interval '10 minutes', interval '2 minutes', ARRAY[3], 'ONLINE', ARRAY[2, 5], 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND pg_temp.n_dl('BASELINE', 'QUEUED') = 1, 'chuyển LIVE ra đúng một tin hiện trạng');
  PERFORM pg_temp.expect(pg_temp.n_inc() = 3 AND pg_temp.n_dl('OPENED', 'QUEUED') = 0 AND pg_temp.n_bell() = 0,
    'sự cố hiện trạng không sinh tin mở riêng');
END $c13_live$;
ROLLBACK;

-- @@case c14
-- Mục 14 — hình dạng job Zalo; nick ngắt / nhóm không hợp lệ thì FAILED, chuông vẫn gửi.
BEGIN;
DO $c14$
DECLARE t timestamptz := date_trunc('minute', now()) - interval '3 hours'; m record; q record; d record; v_bell bigint;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.tick(t);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND (SELECT count(*) FROM public.zalo_messages) = 1, 'một tin = một zalo_messages + một zalo_send_queue');
  SELECT * INTO m FROM public.zalo_messages;
  SELECT * INTO q FROM public.zalo_send_queue;
  SELECT * INTO d FROM app_private.camera_alert_deliveries WHERE channel = 'ZALO';
  PERFORM pg_temp.expect(m.direction = 'out' AND m.status = 'pending' AND m.msg_type = 'text' AND m.body = d.body
    AND m.client_dedup_key = 'camera_alert:' || d.dedup_key AND m.user_id = 'de6f33f3-349f-4bec-bd3d-106192f6715e'
    AND m.conversation_id = 'dddd4000-0000-4000-8000-0000000000a1' AND m.account_id = 'dddd3000-0000-4000-8000-0000000000a1'
    AND m.organization_id = 'dddd0000-0000-4000-8000-000000000001', 'zalo_messages sai hình');
  PERFORM pg_temp.expect(q.channel = 'personal' AND q.status = 'queued' AND q.message_id = m.id AND q.not_before IS NULL
    AND q.conversation_id = m.conversation_id AND q.account_id = m.account_id AND q.organization_id = m.organization_id
    AND q.user_id = m.user_id, 'zalo_send_queue sai hình hoặc lệch hội thoại/nick/org');
  PERFORM pg_temp.expect((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(q.payload) k) = ARRAY['body', 'camera_alert', 'camera_alert_delivery_id']
    AND NOT (q.payload ? 'tu_dong') AND (q.payload ->> 'camera_alert')::boolean AND q.payload ->> 'body' = m.body
    AND (q.payload ->> 'camera_alert_delivery_id')::uuid = d.id, 'payload phải đúng {body, camera_alert, camera_alert_delivery_id}, không có tu_dong');
  PERFORM pg_temp.expect(d.status = 'QUEUED' AND d.zalo_job_id = q.id AND d.zalo_message_id = m.id, 'sổ phải lưu job Zalo');
  PERFORM pg_temp.expect((SELECT last_message_dir = 'out' AND last_message_text = m.body FROM public.zalo_conversations WHERE id = m.conversation_id),
    'hội thoại phải cập nhật tin cuối');
  UPDATE public.zalo_send_queue SET status = 'failed', last_error = 'PROVIDER: lỗi thử' WHERE id = q.id;

  UPDATE public.zalo_accounts SET status = 'disconnected' WHERE id = 'dddd3000-0000-4000-8000-0000000000a1';
  v_bell := pg_temp.n_bell();
  PERFORM pg_temp.snapx(3, t + interval '90 seconds', 'ONLINE', '{}', pg_temp.disks(2, ARRAY[1, 2]));
  PERFORM pg_temp.tick(t + interval '2 minutes');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND pg_temp.n_bell() > v_bell
    AND (SELECT reason FROM app_private.camera_alert_deliveries WHERE channel = 'ZALO' AND status = 'FAILED') = 'Nick Zalo chưa kết nối',
    'nick ngắt kết nối: sổ FAILED, chuông vẫn gửi');
  UPDATE public.zalo_accounts SET status = 'connected' WHERE id = 'dddd3000-0000-4000-8000-0000000000a1';
  UPDATE app_private.camera_alert_settings SET zalo_conversation_id = 'dddd4000-0000-4000-8000-0000000000a2';
  PERFORM pg_temp.snapx(3, t + interval '210 seconds', 'ONLINE', '{}', pg_temp.disks(3, ARRAY[1, 2, 3]));
  PERFORM pg_temp.tick(t + interval '4 minutes');
  UPDATE app_private.camera_alert_settings SET zalo_account_id = 'aaaa3000-0000-4000-8000-0000000000a1',
    zalo_conversation_id = 'aaaa4000-0000-4000-8000-0000000000a1';
  PERFORM pg_temp.snapx(3, t + interval '330 seconds', 'ONLINE', '{}', pg_temp.disks(4, ARRAY[1, 2, 3, 4]));
  PERFORM pg_temp.tick(t + interval '6 minutes');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND (SELECT array_agg(reason ORDER BY created_at) FROM app_private.camera_alert_deliveries
      WHERE channel = 'ZALO' AND status = 'FAILED') = ARRAY['Nick Zalo chưa kết nối', 'Hội thoại đã chọn không phải nhóm Zalo', 'Nhóm Zalo không còn'],
    'nhóm 1-1 hoặc nhóm org khác không được xếp hàng');
END $c14$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
DO $c14_read$
DECLARE r jsonb;
BEGIN
  r := public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 100, NULL);
  IF (SELECT count(*) FROM jsonb_array_elements(r -> 'items') x WHERE x ->> 'channel' = 'ZALO') <> 4
     OR (SELECT x ->> 'status' FROM jsonb_array_elements(r -> 'items') x WHERE x ->> 'zaloJobId' IS NOT NULL) <> 'FAILED'
     OR (SELECT x ->> 'jobError' FROM jsonb_array_elements(r -> 'items') x WHERE x ->> 'zaloJobId' IS NOT NULL) <> 'PROVIDER: lỗi thử'
     OR (SELECT x ->> 'storedStatus' FROM jsonb_array_elements(r -> 'items') x WHERE x ->> 'zaloJobId' IS NOT NULL) <> 'QUEUED' THEN
    RAISE EXCEPTION 'camera alert proof: sổ gửi phải đọc trạng thái job (failed + last_error) %', r;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', 'FAILED', 100, NULL) -> 'items')) <> 4 THEN
    RAISE EXCEPTION 'camera alert proof: lọc FAILED phải gồm job lỗi và 3 tin không xếp được';
  END IF;
  r := public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
  IF r #>> '{zalo,warning}' <> 'GROUP_MISSING' THEN RAISE EXCEPTION 'camera alert proof: cài đặt phải cảnh báo nhóm không còn %', r; END IF;
END $c14_read$;
RESET ROLE;
DO $c14_sent$
BEGIN
  UPDATE public.zalo_send_queue SET status = 'sent', last_error = NULL;
END $c14_sent$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
DO $c14_sent_read$
BEGIN
  IF (SELECT x ->> 'status' FROM jsonb_array_elements(public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', 'SENT', 100, NULL) -> 'items') x
      WHERE x ->> 'channel' = 'ZALO') IS DISTINCT FROM 'SENT' THEN
    RAISE EXCEPTION 'camera alert proof: job đã gửi phải hiện SENT';
  END IF;
END $c14_sent_read$;
RESET ROLE;
ROLLBACK;

-- @@case c15
-- Mục 15 — quyền: chủ công ty / superadmin sửa; quản lý chỉ đọc; org khác bị
-- chặn; anon/authenticated không gọi được app_private; CAS lệch ⇒ PT409.
BEGIN;
DO $c15_setup$
DECLARE t timestamptz := date_trunc('minute', now()) - interval '1 hour';
BEGIN
  PERFORM pg_temp.only(ARRAY[1, 3]);
  PERFORM pg_temp.snap(1, t, 'ONLINE', ARRAY[3]);
  PERFORM pg_temp.snap(3, t, 'ONLINE');
  INSERT INTO public.camera_recorder_current (recorder_id, organization_id, building_id, status, checked_at, received_at, channels, storage, event_coverage, issues)
  VALUES ('aaaa8000-0000-4000-8000-0000000000a9', 'aaaa0000-0000-4000-8000-000000000001', 'aaaa1000-0000-4000-8000-000000000001',
    'ONLINE', t, t, '[{"channel": 1, "state": "CONNECTED"}]', '[]', 'STATE_POLLING_ONLY', '{}');
  -- Sổ có dòng theo toà A, toà B, cả hai toà và không toà (tin thử).
  INSERT INTO app_private.camera_alert_deliveries (organization_id, kind, channel, shadow, status, body, building_ids, dedup_key, local_date, created_at)
  VALUES
    ('dddd0000-0000-4000-8000-000000000001', 'OPENED', 'ZALO', false, 'QUEUED', 'tin toà A', ARRAY['dddd1000-0000-4000-8000-000000000001'::uuid], 'proof:only-a', current_date, t),
    ('dddd0000-0000-4000-8000-000000000001', 'OPENED', 'ZALO', false, 'QUEUED', 'tin toà B', ARRAY['dddd1000-0000-4000-8000-000000000002'::uuid], 'proof:only-b', current_date, t),
    ('dddd0000-0000-4000-8000-000000000001', 'OPENED', 'ZALO', false, 'QUEUED', 'tin hai toà', ARRAY['dddd1000-0000-4000-8000-000000000001'::uuid, 'dddd1000-0000-4000-8000-000000000002'::uuid], 'proof:a-and-b', current_date, t),
    ('dddd0000-0000-4000-8000-000000000001', 'TEST', 'ZALO', false, 'QUEUED', 'tin thử', '{}', 'proof:test-row', current_date, t);
  INSERT INTO public.network_incidents (organization_id, building_id, device_id, fingerprint, incident_type, severity, status, title, summary, opened_at, last_observed_at)
  SELECT d.organization_id, d.building_id, d.id, 'camera:proof:' || d.building_id, 'CAMERA_STORAGE_ERROR', 'CRITICAL', 'OPEN', 'Ổ cứng thử', 'Ổ cứng thử báo lỗi', t, t
    FROM public.network_devices d WHERE d.organization_id = 'dddd0000-0000-4000-8000-000000000001' AND d.device_kind = 'MIKROTIK';
END $c15_setup$;
CREATE TEMP TABLE c15_ids AS SELECT id, building_id FROM public.network_incidents;
GRANT SELECT ON c15_ids TO authenticated, anon;

SET LOCAL ROLE authenticated;
-- Chủ công ty: đọc, sửa, chọn nhóm, tắt kênh, tin thử.
SELECT set_config('request.jwt.claim.sub', 'de6f33f3-349f-4bec-bd3d-106192f6715e', true);
DO $owner$
DECLARE r jsonb;
BEGIN
  BEGIN r := public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'camera alert proof: chủ công ty bị từ chối đọc cài đặt'; END;
  IF NOT (r ->> 'canEdit')::boolean OR (r #>> '{settings,version}')::integer <> 0 OR r #>> '{settings,mode}' <> 'SHADOW'
     OR (r #>> '{settings,enabled}')::boolean OR r #>> '{zalo,warning}' <> 'NOT_CONFIGURED' OR (r #>> '{settings,dailyZaloCap}')::integer <> 6
     OR r #>> '{settings,types,CAMERA_RECORDER_UNKNOWN,delivery}' <> 'BELL' OR r #>> '{settings,digestAt}' <> '08:00' THEN
    RAISE EXCEPTION 'camera alert proof: chủ công ty đọc mặc định sai %', r;
  END IF;
  r := public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 0, jsonb_build_object(
    'zaloAccountId', 'dddd3000-0000-4000-8000-0000000000a1', 'zaloConversationId', 'dddd4000-0000-4000-8000-0000000000a1',
    'dailyZaloCap', 4, 'types', jsonb_build_object('CAMERA_CHANNEL_LOST', jsonb_build_object('threshold_seconds', 1800, 'delivery', 'DIGEST'),
      'CAMERA_STORAGE_ERROR', jsonb_build_object('threshold_seconds', 0))));
  IF (r #>> '{settings,version}')::integer <> 1 OR r #>> '{zalo,warning}' IS NOT NULL OR r #>> '{zalo,conversation,name}' <> 'Nhóm kỹ thuật thử'
     OR (r #>> '{settings,types,CAMERA_CHANNEL_LOST,threshold_seconds}')::integer <> 1800 OR r #>> '{settings,types,CAMERA_CHANNEL_LOST,delivery}' <> 'DIGEST'
     OR r #>> '{settings,types,CAMERA_CHANNEL_LOST,enabled}' <> 'true' OR (r #>> '{settings,dailyZaloCap}')::integer <> 4 THEN
    RAISE EXCEPTION 'camera alert proof: chủ công ty lưu sai %', r;
  END IF;
  r := public.camera_alert_list_zalo_groups_v1('dddd0000-0000-4000-8000-000000000001', NULL, 50);
  IF (SELECT array_agg(x ->> 'name' ORDER BY x ->> 'name') FROM jsonb_array_elements(r -> 'items') x) <> ARRAY['Nhóm 100%_vui', 'Nhóm kỹ thuật thử']
     OR r::text LIKE '%last_message_text%' THEN
    RAISE EXCEPTION 'camera alert proof: danh sách nhóm chỉ gồm nhóm của nick đang kết nối của org %', r;
  END IF;
  -- '%' và '_' là chữ thường, không phải ký tự đại diện; không phân biệt hoa thường.
  IF jsonb_array_length(public.camera_alert_list_zalo_groups_v1('dddd0000-0000-4000-8000-000000000001', '%_', 50) -> 'items') <> 1
     OR jsonb_array_length(public.camera_alert_list_zalo_groups_v1('dddd0000-0000-4000-8000-000000000001', 'THU', 50) -> 'items') <> 1
     OR jsonb_array_length(public.camera_alert_list_zalo_groups_v1('dddd0000-0000-4000-8000-000000000001', '1_0', 50) -> 'items') <> 0 THEN
    RAISE EXCEPTION 'camera alert proof: tìm nhóm theo tên sai (ký tự %% và _ phải là chữ thường)';
  END IF;
  r := public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 3, 'KNOWN_BROKEN', NULL, NULL);
  IF r ->> 'kind' <> 'KNOWN_BROKEN' THEN RAISE EXCEPTION 'camera alert proof: đặt đã biết hỏng sai'; END IF;
  r := public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 4, 'SNOOZE', now() + interval '2 days', 'chờ thợ');
  IF r ->> 'kind' <> 'SNOOZE' THEN RAISE EXCEPTION 'camera alert proof: tạm ẩn sai'; END IF;
  IF NOT (public.camera_alert_clear_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 4) ->> 'cleared')::boolean THEN
    RAISE EXCEPTION 'camera alert proof: theo dõi lại sai';
  END IF;
  BEGIN PERFORM public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 4, 'SNOOZE', NULL, NULL);
    RAISE EXCEPTION 'camera alert proof: tạm ẩn không ngày kết thúc được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 40, 'IGNORE', NULL, NULL);
    RAISE EXCEPTION 'camera alert proof: kênh ngoài snapshot được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  r := public.camera_alert_send_test_v1('dddd0000-0000-4000-8000-000000000001');
  IF r ->> 'status' <> 'QUEUED' THEN RAISE EXCEPTION 'camera alert proof: tin thử phải xếp hàng %', r; END IF;
  IF public.camera_alert_send_test_v1('dddd0000-0000-4000-8000-000000000001') ->> 'deliveryId' <> r ->> 'deliveryId' THEN
    RAISE EXCEPTION 'camera alert proof: bấm tin thử lại trong cùng phút phải nhận lại dòng cũ';
  END IF;
  r := public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
  IF (r #>> '{today,zaloSent}')::integer <> 1 THEN RAISE EXCEPTION 'camera alert proof: tin thử phải tính vào trần hôm nay %', r; END IF;
  -- Validation.
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"dailyZaloCap": 21}');
    RAISE EXCEPTION 'camera alert proof: trần 21 được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"types": {"CAMERA_RECORDER_OFFLINE": {"threshold_seconds": 30}}}');
    RAISE EXCEPTION 'camera alert proof: ngưỡng 30 giây được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"types": {"CAMERA_CHANNEL_LOST": {"threshold_seconds": 86401}}}');
    RAISE EXCEPTION 'camera alert proof: ngưỡng quá 1 ngày được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"types": {"CAMERA_CHANNEL_FLAPPING": {"delivery": "ZALO"}}}');
    RAISE EXCEPTION 'camera alert proof: chập chờn gửi Zalo ngay được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"mode": "PUSH"}');
    RAISE EXCEPTION 'camera alert proof: chế độ lạ được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"nightStart": "24:00"}');
    RAISE EXCEPTION 'camera alert proof: giờ sai được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"quietHours": true}');
    RAISE EXCEPTION 'camera alert proof: khoá lạ được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, jsonb_build_object(
      'zaloAccountId', 'aaaa3000-0000-4000-8000-0000000000a1', 'zaloConversationId', 'aaaa4000-0000-4000-8000-0000000000a1'));
    RAISE EXCEPTION 'camera alert proof: nhóm của org khác được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, jsonb_build_object(
      'zaloConversationId', 'dddd4000-0000-4000-8000-0000000000a2'));
    RAISE EXCEPTION 'camera alert proof: hội thoại 1-1 được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- CAS lệch.
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 0, '{"pushEnabled": false}');
    RAISE EXCEPTION 'camera alert proof: CAS lệch được nhận'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  -- Org khác.
  BEGIN PERFORM public.camera_alert_get_settings_v1('aaaa0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: chủ công ty đọc được org khác'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('aaaa0000-0000-4000-8000-000000000001', 0, '{"enabled": true}');
    RAISE EXCEPTION 'camera alert proof: chủ công ty sửa được org khác'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_set_channel_mute_v1('aaaa8000-0000-4000-8000-0000000000a9', 1, 'IGNORE', NULL, NULL);
    RAISE EXCEPTION 'camera alert proof: chủ công ty tắt được kênh của org khác'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM app_private.camera_alert_settings;
    RAISE EXCEPTION 'camera alert proof: trình duyệt đọc được bảng cài đặt'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM app_private.camera_alert_evaluate_v1(now());
    RAISE EXCEPTION 'camera alert proof: authenticated gọi được bộ đánh giá'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM app_private.camera_alert_zalo_enqueue_v1('dddd0000-0000-4000-8000-000000000001', NULL, NULL, 'x', 'x', NULL);
    RAISE EXCEPTION 'camera alert proof: authenticated gọi được hàm xếp Zalo'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF jsonb_array_length(public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 100, NULL) -> 'items') <> 5 THEN
    RAISE EXCEPTION 'camera alert proof: chủ công ty phải thấy mọi dòng sổ';
  END IF;
  -- Phân trang theo (createdAt, id): bốn dòng cùng giờ không được rơi dòng nào.
  DECLARE p1 jsonb; p2 jsonb; p3 jsonb; v_all jsonb;
  BEGIN
    p1 := public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 2, NULL, NULL);
    p2 := public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 2,
      (p1 #>> '{items,1,createdAt}')::timestamptz, (p1 #>> '{items,1,id}')::uuid);
    p3 := public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 2,
      (p2 #>> '{items,1,createdAt}')::timestamptz, (p2 #>> '{items,1,id}')::uuid);
    v_all := (p1 -> 'items') || (p2 -> 'items') || (p3 -> 'items');
    IF NOT (p1 ->> 'hasMore')::boolean OR NOT (p2 ->> 'hasMore')::boolean OR (p3 ->> 'hasMore')::boolean
       OR (SELECT count(DISTINCT x ->> 'id') FROM jsonb_array_elements(v_all) x) <> 5 OR jsonb_array_length(v_all) <> 5 THEN
      RAISE EXCEPTION 'camera alert proof: phân trang sổ gửi rơi hoặc lặp dòng % % %', p1, p2, p3;
    END IF;
  END;
  -- Gửi thật phải có nhóm Zalo (tin hiện trạng chỉ gửi một lần).
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1,
      '{"enabled": true, "mode": "LIVE", "zaloConversationId": null}');
    RAISE EXCEPTION 'camera alert proof: gửi thật không có nhóm được nhận'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $owner$;

-- Super admin là thành viên org: sửa được. Super admin không là thành viên: chỉ xem.
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-0000000000a2', true);
DO $superadmin$
DECLARE r jsonb;
BEGIN
  r := public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 1, '{"enabled": true}');
  IF NOT (r ->> 'canEdit')::boolean OR (r #>> '{settings,version}')::integer <> 2 THEN RAISE EXCEPTION 'camera alert proof: superadmin thành viên phải sửa được %', r; END IF;
END $superadmin$;
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-0000000000a3', true);
DO $outside_admin$
BEGIN
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 2, '{"enabled": false}');
    RAISE EXCEPTION 'camera alert proof: superadmin ngoài org sửa được'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_send_test_v1('dddd0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: superadmin ngoài org gửi được tin thử'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $outside_admin$;

-- Quản lý toà A (network_center.view): chỉ đọc, 42501 khi ghi; sổ chỉ dòng toà A.
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-000000000002', true);
DO $manager$
DECLARE r jsonb; v_b uuid;
BEGIN
  r := public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
  IF (r ->> 'canEdit')::boolean OR (r #>> '{settings,version}')::integer <> 2 THEN RAISE EXCEPTION 'camera alert proof: quản lý đọc sai %', r; END IF;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 2, '{"enabled": false}');
    RAISE EXCEPTION 'camera alert proof: quản lý sửa được cài đặt'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 2, 'IGNORE', NULL, NULL);
    RAISE EXCEPTION 'camera alert proof: quản lý tắt báo kênh được'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_clear_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 3);
    RAISE EXCEPTION 'camera alert proof: quản lý bật lại báo kênh được'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_list_zalo_groups_v1('dddd0000-0000-4000-8000-000000000001', NULL, 50);
    RAISE EXCEPTION 'camera alert proof: quản lý xem được danh sách nhóm Zalo'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_send_test_v1('dddd0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: quản lý gửi được tin thử'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  r := public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 100, NULL);
  IF (SELECT array_agg(x ->> 'body' ORDER BY x ->> 'body') FROM jsonb_array_elements(r -> 'items') x
       WHERE x ->> 'body' IN ('tin toà A', 'tin toà B', 'tin hai toà', 'tin thử')) <> ARRAY['tin thử', 'tin toà A'] THEN
    RAISE EXCEPTION 'camera alert proof: quản lý toà A chỉ được thấy dòng của toà A %', r;
  END IF;
  r := public.camera_building_channel_mutes_v1('dddd1000-0000-4000-8000-000000000001');
  IF (r ->> 'canEdit')::boolean OR jsonb_array_length(r -> 'items') <> 1 OR r #>> '{items,0,kind}' <> 'KNOWN_BROKEN'
     OR r #>> '{items,0,setByName}' <> 'Chủ Thử' THEN
    RAISE EXCEPTION 'camera alert proof: quản lý đọc trạng thái tắt kênh sai %', r;
  END IF;
  IF jsonb_array_length(public.camera_building_incidents_v1('dddd1000-0000-4000-8000-000000000001') -> 'items') <> 1 THEN
    RAISE EXCEPTION 'camera alert proof: quản lý phải đọc được sự cố camera toà A';
  END IF;
  BEGIN PERFORM public.camera_building_channel_mutes_v1('dddd1000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'camera alert proof: quản lý A đọc được tắt kênh toà B'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT id INTO v_b FROM c15_ids WHERE building_id = 'dddd1000-0000-4000-8000-000000000002';
  BEGIN PERFORM public.camera_alert_acknowledge_incident_v1(v_b);
    RAISE EXCEPTION 'camera alert proof: quản lý A bấm Đã biết được sự cố toà B'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT id INTO v_b FROM c15_ids WHERE building_id = 'dddd1000-0000-4000-8000-000000000001';
  BEGIN PERFORM public.camera_alert_acknowledge_incident_v1(v_b);
    RAISE EXCEPTION 'camera alert proof: chỉ có quyền xem mà bấm Đã biết được'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $manager$;

-- Kế toán toà B: sổ chỉ dòng toà B.
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-000000000001', true);
DO $accountant$
DECLARE r jsonb;
BEGIN
  r := public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 100, NULL);
  IF (SELECT array_agg(x ->> 'body' ORDER BY x ->> 'body') FROM jsonb_array_elements(r -> 'items') x
       WHERE x ->> 'body' IN ('tin toà A', 'tin toà B', 'tin hai toà', 'tin thử')) <> ARRAY['tin thử', 'tin toà B'] THEN
    RAISE EXCEPTION 'camera alert proof: kế toán toà B chỉ được thấy dòng của toà B %', r;
  END IF;
END $accountant$;

-- Thành viên ngừng hoạt động; chủ công ty của org khác.
SELECT set_config('request.jwt.claim.sub', 'dddd2000-0000-4000-8000-0000000000a1', true);
DO $inactive$
BEGIN
  BEGIN PERFORM public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: thành viên ngừng hoạt động đọc được'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $inactive$;
SELECT set_config('request.jwt.claim.sub', '90450d5f-29b6-4897-bdef-cdb5fb53f339', true);
DO $other_org$
BEGIN
  BEGIN PERFORM public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: org khác đọc được cài đặt'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_list_deliveries_v1('dddd0000-0000-4000-8000-000000000001', NULL, 100, NULL);
    RAISE EXCEPTION 'camera alert proof: org khác đọc được sổ gửi'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_save_settings_v1('dddd0000-0000-4000-8000-000000000001', 2, '{"enabled": false}');
    RAISE EXCEPTION 'camera alert proof: org khác sửa được cài đặt'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_set_channel_mute_v1('dddd8000-0000-4000-8000-0000000000a1', 2, 'IGNORE', NULL, NULL);
    RAISE EXCEPTION 'camera alert proof: org khác tắt được kênh'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_acknowledge_incident_v1((SELECT id FROM c15_ids LIMIT 1));
    RAISE EXCEPTION 'camera alert proof: org khác bấm Đã biết được'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- Chính org mình thì được.
  IF NOT (public.camera_alert_get_settings_v1('aaaa0000-0000-4000-8000-000000000001') ->> 'canEdit')::boolean THEN
    RAISE EXCEPTION 'camera alert proof: chủ công ty org khác phải sửa được org của mình';
  END IF;
END $other_org$;
RESET ROLE;

-- anon không gọi được RPC nào.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
DO $anon$
BEGIN
  BEGIN PERFORM public.camera_alert_get_settings_v1('dddd0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: anon gọi được RPC đọc'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_alert_send_test_v1('dddd0000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'camera alert proof: anon gọi được tin thử'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM app_private.camera_alert_evaluate_v1(now());
    RAISE EXCEPTION 'camera alert proof: anon gọi được bộ đánh giá'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $anon$;
RESET ROLE;
DO $c15_audit$
BEGIN
  PERFORM pg_temp.expect((SELECT count(*) FROM app_private.camera_alert_audit WHERE action = 'MODE_CHANGED') = 1
    AND (SELECT actor_user_id FROM app_private.camera_alert_audit WHERE action = 'MODE_CHANGED') = 'dddd2000-0000-4000-8000-0000000000a2',
    'đổi bật/tắt phải ghi audit kèm người làm');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM app_private.camera_alert_channel_mutes WHERE channel = 2),
    'thao tác bị từ chối không được để lại dấu tắt kênh');
  -- ACL từng đối tượng, không dựa vào việc schema app_private đã đóng USAGE.
  PERFORM pg_temp.expect(NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role)
     WHERE n.nspname = 'app_private' AND (p.proname LIKE 'camera\_alert\_%' OR p.proname = 'network_center_alert_recipient_ids_v1')
       AND has_function_privilege(r.role, p.oid, 'EXECUTE')), 'hàm app_private của cảnh báo camera không được cấp cho vai nào');
  PERFORM pg_temp.expect(NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role)
     WHERE n.nspname = 'app_private' AND c.relkind = 'r' AND c.relname LIKE 'camera\_alert\_%'
       AND has_table_privilege(r.role, c.oid, 'SELECT,INSERT,UPDATE,DELETE')), 'bảng app_private của cảnh báo camera không được cấp cho vai nào');
  PERFORM pg_temp.expect((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'camera\_alert\_%' OR p.proname IN ('camera_building_incidents_v1', 'camera_building_channel_mutes_v1'))
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) = 10, 'đúng 10 RPC public chỉ cấp cho authenticated');
END $c15_audit$;
ROLLBACK;

-- @@case c16
-- Mục 16 — idempotent: chạy lại cùng now không sinh tin trùng; bản tin trong
-- ngày không gửi hai lần.
BEGIN;
DO $c16$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); r jsonb; v_bell bigint;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.tick(t);
  v_bell := pg_temp.n_bell();
  r := pg_temp.tick(t);
  PERFORM pg_temp.expect(r #>> '{organizations,0,skipped}' = 'ALREADY_EVALUATED', 'chạy lại cùng now phải bỏ qua');
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND pg_temp.n_inc() = 1 AND pg_temp.n_bell() = v_bell, 'chạy lại cùng now sinh trùng');
  PERFORM pg_temp.sim(pg_temp.at(2, '08:05'), pg_temp.at(2, '08:15'), interval '10 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 1 AND pg_temp.n_jobs() = 2, 'bản tin trong ngày chỉ một lần');
  -- Kể cả khi dấu ngày bị mất, khoá chống trùng của sổ vẫn chặn.
  UPDATE app_private.camera_alert_settings SET last_digest_on = NULL, last_evaluated_at = NULL;
  v_bell := pg_temp.n_bell();
  PERFORM pg_temp.sim(pg_temp.at(2, '08:20'), pg_temp.at(2, '08:20'), interval '10 minutes', ARRAY[3], 'ONLINE', '{}', 'ERROR');
  PERFORM pg_temp.expect(pg_temp.n_dl('DIGEST') = 1 AND pg_temp.n_jobs() = 2 AND pg_temp.n_bell() = v_bell,
    'bản tin không được gửi hai lần trong ngày dù chạy lại');
END $c16$;
ROLLBACK;

-- @@case c17
-- Lỗi của một org chỉ huỷ phần của org đó; org khác vẫn được đánh giá và gửi.
BEGIN;
CREATE FUNCTION public.camera_alert_proof_fail_v1() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.organization_id = 'aaaa0000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'proof: lỗi giả lập của org khác';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER camera_alert_proof_fail BEFORE INSERT ON app_private.camera_alert_events
  FOR EACH ROW EXECUTE FUNCTION public.camera_alert_proof_fail_v1();
DO $c17$
DECLARE t timestamptz := pg_temp.at(1, '10:00'); r jsonb;
BEGIN
  PERFORM pg_temp.only(ARRAY[3]); PERFORM pg_temp.live();
  INSERT INTO app_private.camera_alert_settings (organization_id, enabled, mode)
  VALUES ('aaaa0000-0000-4000-8000-000000000001', true, 'LIVE');
  PERFORM pg_temp.snap(3, t - interval '30 seconds', 'ONLINE', '{}', 'ERROR');
  INSERT INTO public.camera_recorder_current (recorder_id, organization_id, building_id, status, checked_at, received_at, channels, storage, event_coverage, issues)
  VALUES ('aaaa8000-0000-4000-8000-0000000000a9', 'aaaa0000-0000-4000-8000-000000000001', 'aaaa1000-0000-4000-8000-000000000001',
    'ONLINE', t - interval '30 seconds', t - interval '30 seconds', '[{"channel": 1, "state": "CONNECTED"}]',
    '[{"slot": 1, "state": "ERROR"}]', 'STATE_POLLING_ONLY', '{}');
  r := app_private.camera_alert_evaluate_v1(t);
  PERFORM pg_temp.expect((SELECT count(*) FROM jsonb_array_elements(r -> 'organizations') o
    WHERE o.value ->> 'organizationId' = 'aaaa0000-0000-4000-8000-000000000001' AND o.value ->> 'error' LIKE '%lỗi giả lập%') = 1,
    'org lỗi phải được ghi lỗi trong kết quả: ' || r::text);
  PERFORM pg_temp.expect(pg_temp.n_jobs() = 1 AND (SELECT count(*) FROM public.network_incidents
    WHERE organization_id = 'dddd0000-0000-4000-8000-000000000001') = 1, 'org khác vẫn phải được đánh giá và gửi');
  PERFORM pg_temp.expect(NOT EXISTS (SELECT 1 FROM public.network_incidents WHERE organization_id = 'aaaa0000-0000-4000-8000-000000000001')
    AND (SELECT last_evaluated_at FROM app_private.camera_alert_settings WHERE organization_id = 'aaaa0000-0000-4000-8000-000000000001') IS NULL,
    'phần của org lỗi phải được huỷ trọn để lượt sau thử lại');
END $c17$;
ROLLBACK;
