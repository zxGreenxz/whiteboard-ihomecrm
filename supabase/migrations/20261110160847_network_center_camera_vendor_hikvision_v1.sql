-- network_center_camera_vendor_hikvision_v1: nhận vendor thứ ba HIKVISION cho đầu ghi và báo vendor cho worker (10/11/2026).
--
-- VẤN ĐỀ. Giám sát đầu ghi (20261022145352) chỉ nhận vendor KBVISION/DAHUA: CHECK trên camera_recorders.vendor từ chối mọi
-- giá trị khác, và network_center_worker_camera_connections_v1 không trả vendor nên worker coi mọi đầu ghi là giao thức
-- Dahua. Đầu ghi Hikvision nói ISAPI (XML qua HTTP/HTTPS, HTTP Digest), một giao thức khác hẳn.
--
-- THAY ĐỔI. (1) CHECK vendor nhận thêm 'HIKVISION'. (2) Mỗi item của network_center_worker_camera_connections_v1 có thêm
-- khoá 'vendor' = camera_recorders.vendor. Worker chọn client theo khoá này; thiếu khoá (database cũ) thì vẫn là Dahua.
--
-- VÌ SAO AN TOÀN.
--   · Nới CHECK không làm dòng nào đang có thành sai. Đăng ký đầu ghi vẫn chỉ qua network_center_admin_enroll_camera_v1
--     (service_role); hàm đó dựa vào chính CHECK này nên không cần sửa.
--   · Thêm một khoá vào JSON trả về: Edge network-center-worker chuyển nguyên data của RPC này, worker đang chạy đọc bằng
--     schema không strict nên bỏ qua khoá lạ. Không route, quyền hay bảng nào khác đổi.
--   · Ingest (network_center_worker_camera_ingest_v1) không phụ thuộc vendor: trạng thái kênh/ổ, mã issue, mã event giữ nguyên.
--   · camera_building_snapshot_v1 vốn đã trả vendor dạng text; giao diện đọc nó như chuỗi tự do.
--
-- PHẠM VI. Một CHECK và thân một hàm. Thân hàm chép nguyên từng dòng từ 20261022145352, khác đúng một chỗ: thêm
-- 'vendor',r.vendor vào jsonb_build_object. Giữ nguyên chữ ký, kiểu trả về, VOLATILE, SECURITY DEFINER, search_path, chủ
-- và ACL (chỉ service_role); chữ ký không đổi nên không cần NOTIFY pgrst. Không DROP bảng/hàm, không đổi dữ liệu.
-- Ghim md5 thân đang chạy (lượt hai chấp nhận md5 thân mới) và ghim đúng MỘT CHECK trên cột vendor với hai tập giá trị đã
-- biết: thân hoặc CHECK bị phiên khác đổi thì DỪNG thay vì ghi đè.
--
-- THỨ TỰ PHÁT HÀNH. Worker bản mới phải chạy TRƯỚC khi đăng ký đầu ghi HIKVISION: worker cũ bỏ qua khoá vendor và sẽ nói
-- giao thức Dahua với đầu ghi đó.
--
-- LÙI. CREATE OR REPLACE lại đúng thân 20261022145352 (bỏ khoá vendor). CHECK chỉ thu hẹp lại được khi không còn dòng
-- HIKVISION; để nguyên CHECK rộng không ảnh hưởng worker cũ.
--
-- Chạy được hai lượt liên tiếp. Không đòi dữ liệu.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(20261110160847::bigint);

DO $requires$
DECLARE v_md5 text; v_count integer; v_name text; v_def text; v_values text[];
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_md5 FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('public.network_center_worker_camera_connections_v1(text,integer)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('77a9adb72a5c623650a8f74cb7f19c46','833068e9abde4d97787ef9facb0ec3de') THEN
    RAISE EXCEPTION 'network_center_worker_camera_connections_v1_body_drift: %',COALESCE(v_md5,'missing') USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.camera_recorders') IS NULL THEN
    RAISE EXCEPTION 'camera_recorders_missing' USING ERRCODE='55000';
  END IF;
  SELECT count(*),min(c.conname),min(pg_catalog.pg_get_constraintdef(c.oid)) INTO v_count,v_name,v_def
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.camera_recorders'::regclass AND c.contype='c'
      AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='vendor')];
  SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") INTO v_values FROM regexp_matches(COALESCE(v_def,''),'''([A-Z_]+)''','g') m;
  IF v_count<>1 OR v_name<>'camera_recorders_vendor_check' OR v_values IS NULL
    OR NOT (v_values=ARRAY['DAHUA','KBVISION'] OR v_values=ARRAY['DAHUA','HIKVISION','KBVISION']) THEN
    RAISE EXCEPTION 'camera_recorders_vendor_check_drift: %',COALESCE(v_def,'missing') USING ERRCODE='55000';
  END IF;
END $requires$;

-- Một lệnh, một lần lấy khoá bảng: không có khoảnh khắc nào cột vendor thiếu CHECK.
ALTER TABLE public.camera_recorders
  DROP CONSTRAINT camera_recorders_vendor_check,
  ADD CONSTRAINT camera_recorders_vendor_check CHECK (vendor IN ('KBVISION','DAHUA','HIKVISION'));

-- Thân 20261022145352 giữ nguyên từng dòng; khác đúng một chỗ: 'vendor',r.vendor trong jsonb_build_object.
CREATE OR REPLACE FUNCTION public.network_center_worker_camera_connections_v1(p_credential_digest text,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $fn$
DECLARE worker_id uuid; items jsonb;
BEGIN
  SELECT a.worker_id INTO worker_id FROM app_private.network_center_authenticate_worker_v2(p_credential_digest) a;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid limit' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(q.item ORDER BY q.id),'[]'::jsonb) INTO items FROM (
    SELECT r.id,jsonb_build_object('recorderId',r.id,'connectionId',n.id,'organizationId',r.organization_id,'buildingId',r.building_id,
      'displayName',r.display_name,'endpoint',c.endpoint,'credentialRef',c.credential_ref,'channelCount',r.channel_count,
      'pollIntervalSeconds',c.poll_interval_seconds,'connectTimeoutMs',c.connect_timeout_ms,'vendor',r.vendor) item
    FROM public.camera_recorders r JOIN app_private.camera_recorder_connections c ON c.recorder_id=r.id
    JOIN public.network_device_connections n ON n.id=c.router_connection_id AND n.organization_id=r.organization_id AND n.building_id=r.building_id
    JOIN public.network_devices d ON d.id=n.device_id AND d.is_active AND d.device_kind='MIKROTIK'
    LEFT JOIN public.network_site_settings s ON s.organization_id=r.organization_id AND s.building_id=r.building_id
    WHERE r.enabled AND n.is_enabled AND coalesce(s.monitoring_enabled,true)
      AND app_private.network_center_worker_can_access_device_v2(worker_id,r.organization_id,r.building_id,n.device_id,'POLL')
    ORDER BY r.id LIMIT p_limit
  ) q;
  RETURN jsonb_build_object('items',items);
END;
$fn$;
REVOKE ALL ON FUNCTION public.network_center_worker_camera_connections_v1(text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_camera_connections_v1(text,integer) TO service_role;

DO $check$
DECLARE p record; v_values text[];
BEGIN
  SELECT x.prosecdef,x.provolatile,x.proconfig,md5(replace(x.prosrc,chr(13),'')) AS md5,pg_catalog.pg_get_function_result(x.oid) AS result
    INTO p FROM pg_catalog.pg_proc x WHERE x.oid='public.network_center_worker_camera_connections_v1(text,integer)'::regprocedure;
  SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") INTO v_values FROM regexp_matches(
    (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
      WHERE c.conrelid='public.camera_recorders'::regclass AND c.conname='camera_recorders_vendor_check' AND c.contype='c' AND c.convalidated),
    '''([A-Z_]+)''','g') m;
  IF NOT p.prosecdef OR p.provolatile<>'v' OR p.result<>'jsonb'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
    OR p.md5<>'833068e9abde4d97787ef9facb0ec3de'
    OR v_values IS DISTINCT FROM ARRAY['DAHUA','HIKVISION','KBVISION']
    OR NOT pg_catalog.has_function_privilege('service_role','public.network_center_worker_camera_connections_v1(text,integer)'::regprocedure,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated')
      AND pg_catalog.has_function_privilege(r.oid,'public.network_center_worker_camera_connections_v1(text,integer)'::regprocedure,'EXECUTE')) THEN
    RAISE EXCEPTION 'network_center_camera_vendor_hikvision_check_failed';
  END IF;
END $check$;

COMMIT;
