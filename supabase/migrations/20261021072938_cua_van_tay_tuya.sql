-- Cửa vân tay SmartLife/Tuya — chủ chốt 21/10/2026 (tám điểm, docs/he-thong/26-cua-van-tay.md).
--  (1) Bốn quyền mới theo tòa: door_access.view / temp_password / remote_unlock / manage_devices.
--      Chỉ vai Chủ sở hữu tổ chức có sẵn; vai khác chủ tự bật ở Phân quyền.
--  (2) door_devices: máy Tuya đã gắn tòa. Một máy Tuya chỉ thuộc một công ty (unique toàn hệ thống).
--  (3) door_key_links: số vân tay/thẻ/mật khẩu trên máy ↔ khách (hoặc nhãn). Liên kết vân tay mở là
--      nguồn của customers.fingerprint_code (ô "Mã vân tay cửa ra vào", in trên hợp đồng).
--  (4) door_action_logs: nhật ký thao tác. Lệnh gửi xuống máy ghi PENDING TRƯỚC khi gọi Tuya, hàm
--      Edge door-access chốt OK/FAILED/UNKNOWN bằng service_role — người dùng không tự sửa kết quả.
-- Ba bảng bật RLS, không cấp quyền bảng cho ai; trình duyệt và hàm Edge chỉ đi qua RPC dưới đây.
-- Ghi: lock_org_for_decision_v1 rồi authorize_tenant_action_v3 (giao thức ghi chuẩn). Đọc: can_v3
-- theo tòa của máy (hàm STABLE không khoá dòng). Không đổi hàm cũ nào.
-- Production chưa có dữ liệu nào cho ba bảng mới khi viết migration này; customers.fingerprint_code
-- đang trống ở mọi khách (đo 21/10/2026).

-- ── 1. Quyền ────────────────────────────────────────────────────────
-- authorize_tenant_action_v3 fail-closed với khoá lạ ⇒ khoá phải có trước writer (cùng giao dịch).
INSERT INTO public.permission_definitions (key, resource, action, sensitivity, permission_domain, scope_kinds, is_active,
  scope_match_mode, requires_cashbook_possession, accepted_possession_kinds, required_dimensions)
VALUES
  ('door_access.view', 'door_access', 'view', 'VIEW', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING']::text[], true,
    'ANY_MATCH', false, ARRAY[]::text[], ARRAY['BUILDING']::text[]),
  ('door_access.temp_password', 'door_access', 'temp_password', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING']::text[], true,
    'ANY_MATCH', false, ARRAY[]::text[], ARRAY['BUILDING']::text[]),
  ('door_access.remote_unlock', 'door_access', 'remote_unlock', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING']::text[], true,
    'ANY_MATCH', false, ARRAY[]::text[], ARRAY['BUILDING']::text[]),
  ('door_access.manage_devices', 'door_access', 'manage_devices', 'MANAGE', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING']::text[], true,
    'ANY_MATCH', false, ARRAY[]::text[], ARRAY['BUILDING']::text[])
ON CONFLICT (key) DO UPDATE SET
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  sensitivity = EXCLUDED.sensitivity,
  permission_domain = EXCLUDED.permission_domain,
  scope_kinds = EXCLUDED.scope_kinds,
  is_active = EXCLUDED.is_active,
  scope_match_mode = EXCLUDED.scope_match_mode,
  requires_cashbook_possession = EXCLUDED.requires_cashbook_possession,
  accepted_possession_kinds = EXCLUDED.accepted_possession_kinds,
  required_dimensions = EXCLUDED.required_dimensions;

-- Vai chủ công ty có sẵn cả bốn quyền; vai khác chủ tự gán ở Phân quyền. "Chủ công ty" theo đúng định nghĩa của
-- app_private.ie_actor_is_company_owner_v1: system_key TENANT_OWNER, hoặc vai tự tạo tên "Chủ sở hữu tổ chức"/"Chủ
-- công ty". Chỉ gieo vai TENANT_OWNER là thiếu: ở org thật, chủ nhận quyền qua vai tự tạo "Chủ công ty" (phạm vi
-- ORGANIZATION), còn binding TENANT_OWNER của họ không có phạm vi nào nên không cấp được quyền theo tòa (đo 21/10/2026).
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT r.organization_id, r.id, k.key, 'ALLOW'
FROM public.organization_roles r
CROSS JOIN (VALUES ('door_access.view'), ('door_access.temp_password'), ('door_access.remote_unlock'),
  ('door_access.manage_devices')) AS k(key)
WHERE r.system_key = 'TENANT_OWNER' OR (r.system_key IS NULL AND r.name IN ('Chủ sở hữu tổ chức', 'Chủ công ty'))
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

-- ── 2. Bảng ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.door_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL,
  tuya_device_id text NOT NULL CHECK (tuya_device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  device_kind text NOT NULL CHECK (device_kind IN ('access_control', 'wifi_lock')),
  tuya_category text CHECK (tuya_category IS NULL OR char_length(tuya_category) <= 32),
  tuya_product_name text CHECK (tuya_product_name IS NULL OR char_length(tuya_product_name) <= 120),
  channel_id integer NOT NULL DEFAULT 1 CHECK (channel_id BETWEEN 1 AND 64),
  password_length integer NOT NULL DEFAULT 7 CHECK (password_length BETWEEN 6 AND 10),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid REFERENCES auth.users(id),
  CONSTRAINT door_devices_building_fk FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT
);
-- Một máy Tuya chỉ thuộc một công ty: lưu lại sau khi tắt thì dựng lại đúng dòng cũ.
CREATE UNIQUE INDEX IF NOT EXISTS door_devices_tuya_uidx ON public.door_devices (tuya_device_id);
CREATE UNIQUE INDEX IF NOT EXISTS door_devices_org_id_uidx ON public.door_devices (organization_id, id);
CREATE INDEX IF NOT EXISTS door_devices_org_building_idx ON public.door_devices (organization_id, building_id);
COMMENT ON TABLE public.door_devices IS
  'Máy cửa SmartLife/Tuya đã gắn tòa (trang /cua-van-tay). Chỉ đọc/ghi qua RPC door_access_*; khoá Tuya nằm ở biến môi trường của hàm Edge door-access, không ở database.';

CREATE TABLE IF NOT EXISTS public.door_key_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  door_device_id uuid NOT NULL,
  unlock_type text NOT NULL CHECK (unlock_type IN ('fingerprint', 'card', 'password')),
  unlock_sn integer NOT NULL CHECK (unlock_sn BETWEEN 0 AND 2147483647),
  tuya_user_id text CHECK (tuya_user_id IS NULL OR tuya_user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  device_user_name text CHECK (device_user_name IS NULL OR char_length(device_user_name) <= 80),
  customer_id uuid,
  label text CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 80),
  linked_by uuid NOT NULL REFERENCES auth.users(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unlinked_at timestamptz,
  unlinked_by uuid REFERENCES auth.users(id),
  unlink_reason text CHECK (unlink_reason IN ('MANUAL', 'RELINKED', 'DELETED_ON_DEVICE')),
  CONSTRAINT door_key_links_party CHECK ((customer_id IS NULL) <> (label IS NULL)),
  CONSTRAINT door_key_links_unlink_pair CHECK ((unlinked_at IS NULL) = (unlink_reason IS NULL)),
  CONSTRAINT door_key_links_unlink_after CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at),
  CONSTRAINT door_key_links_device_fk FOREIGN KEY (organization_id, door_device_id)
    REFERENCES public.door_devices(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT door_key_links_customer_fk FOREIGN KEY (organization_id, customer_id)
    REFERENCES public.customers(organization_id, id) ON DELETE RESTRICT
);
-- Một số trên máy chỉ có một liên kết mở.
CREATE UNIQUE INDEX IF NOT EXISTS door_key_links_open_uidx
  ON public.door_key_links (door_device_id, unlock_type, unlock_sn) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS door_key_links_customer_idx
  ON public.door_key_links (organization_id, customer_id) WHERE unlinked_at IS NULL;
COMMENT ON TABLE public.door_key_links IS
  'Số vân tay/thẻ/mật khẩu trên máy cửa ↔ khách (hoặc nhãn nhân viên). Liên kết vân tay mở là nguồn của customers.fingerprint_code. Chỉ ghi qua door_access_link_key_v1/door_access_unlink_key_v1/door_access_finish_action_v1.';

CREATE TABLE IF NOT EXISTS public.door_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  door_device_id uuid NOT NULL,
  building_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL CHECK (action IN ('REMOTE_UNLOCK', 'TEMP_PASSWORD_CREATE', 'TEMP_PASSWORD_DELETE', 'KEY_DELETE',
    'DEVICE_SAVE', 'DEVICE_DISABLE', 'KEY_LINK', 'KEY_UNLINK')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'OK', 'FAILED', 'UNKNOWN')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  tuya_password_id bigint CHECK (tuya_password_id IS NULL OR tuya_password_id >= 0),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT door_action_logs_finish_pair CHECK ((status = 'PENDING') = (finished_at IS NULL)),
  CONSTRAINT door_action_logs_device_fk FOREIGN KEY (organization_id, door_device_id)
    REFERENCES public.door_devices(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS door_action_logs_device_idx ON public.door_action_logs (door_device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS door_action_logs_org_idx ON public.door_action_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS door_action_logs_actor_idx ON public.door_action_logs (actor_id, action, created_at DESC);
COMMENT ON TABLE public.door_action_logs IS
  'Nhật ký thao tác cửa vân tay từ CRM. Lệnh gửi xuống máy ghi PENDING trước khi gọi Tuya; hàm Edge door-access chốt OK/FAILED/UNKNOWN bằng service_role. Không chứa mật khẩu.';

REVOKE ALL ON public.door_devices, public.door_key_links, public.door_action_logs FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.door_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.door_key_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.door_action_logs ENABLE ROW LEVEL SECURITY;

-- ── 3. Hàm phụ (app_private, không cấp cho ai) ──────────────────────
-- Ghi: gọi SAU lock_org_for_decision_v1 (hợp đồng của authorize_tenant_action_v3); VOLATILE vì v3 khoá FOR SHARE.
CREATE OR REPLACE FUNCTION app_private.door_access_authorized_v1(p_org uuid,p_building uuid,p_permission text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF p_permission IS NULL OR p_permission NOT IN ('door_access.view','door_access.temp_password','door_access.remote_unlock','door_access.manage_devices') THEN
    RAISE EXCEPTION 'Unknown door access authority' USING ERRCODE='42501';END IF;
  RETURN auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()),false) AND COALESCE(public.can_access_building(p_building),false)
    AND COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,p_permission,p_building,NULL) a),false);
END;
$function$;

-- Đọc: không khoá dòng (gọi được trong hàm STABLE và giao dịch READ ONLY).
CREATE OR REPLACE FUNCTION app_private.door_access_can_read_v1(p_org uuid,p_building uuid,p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF p_permission IS NULL OR p_permission NOT IN ('door_access.view','door_access.temp_password','door_access.remote_unlock','door_access.manage_devices') THEN
    RAISE EXCEPTION 'Unknown door access authority' USING ERRCODE='42501';END IF;
  RETURN auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()),false) AND COALESCE(public.can_access_building(p_building),false)
    AND COALESCE(app_private.can_v3(p_permission,p_building,NULL),false);
END;
$function$;

-- Tình trạng thuê của một liên kết theo tòa của máy. Hợp đồng "còn ở" = chưa trả phòng, chưa xoá, không
-- phải nháp/đã thanh lý/đã chuyển nhượng (EXPIRED chưa trả phòng vẫn tính là đang ở — gợi ý xoá vân tay
-- phải thận trọng).
CREATE OR REPLACE FUNCTION app_private.door_link_tenancy_v1(p_org uuid,p_building uuid,p_customer uuid)
RETURNS TABLE(tenancy text,room_name text,contract_end_date date)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
  WITH k AS (
    SELECT r.name AS room_name, c.start_date, COALESCE(c.actual_end_date, c.end_date) AS end_on,
      (c.actual_end_date IS NULL AND c.status::text NOT IN ('DRAFT','TERMINATED','TRANSFERRED')) AS still_here
    FROM public.contract_customers cc
    JOIN public.contracts c ON c.id=cc.contract_id AND c.organization_id=p_org AND c.deleted_at IS NULL AND c.status::text<>'DRAFT'
    JOIN public.rooms r ON r.id=c.room_id AND r.building_id=p_building
    WHERE p_customer IS NOT NULL AND cc.customer_id=p_customer
  )
  SELECT
    CASE WHEN p_customer IS NULL THEN 'STAFF'
         WHEN EXISTS(SELECT 1 FROM k WHERE k.still_here) THEN 'CURRENT'
         WHEN EXISTS(SELECT 1 FROM k) THEN 'MOVED_OUT'
         ELSE 'NO_CONTRACT' END,
    (SELECT k.room_name FROM k ORDER BY k.still_here DESC, k.end_on DESC NULLS LAST, k.start_date DESC NULLS LAST LIMIT 1),
    CASE WHEN EXISTS(SELECT 1 FROM k WHERE k.still_here) THEN NULL
         ELSE (SELECT max(k.end_on) FROM k) END
$function$;

-- Một khuôn JSON máy cho cả danh sách lẫn kết quả ghi (không để hai bản dựng lệch nhau).
CREATE OR REPLACE FUNCTION app_private.door_device_shape_v1(d public.door_devices,p_building_name text,p_can jsonb)
RETURNS jsonb LANGUAGE sql STABLE
SET search_path=pg_catalog,public,app_private
AS $function$
  SELECT jsonb_build_object('id',d.id,'building_id',d.building_id,'building_name',p_building_name,'display_name',d.display_name,
    'device_kind',d.device_kind,'tuya_device_id',d.tuya_device_id,'tuya_category',d.tuya_category,
    'tuya_product_name',d.tuya_product_name,'channel_id',d.channel_id,'password_length',d.password_length,
    'is_active',d.is_active,'updated_at',d.updated_at,'can',p_can)
$function$;

-- Cờ bốn quyền của người gọi ở một tòa.
CREATE OR REPLACE FUNCTION app_private.door_access_can_json_v1(p_org uuid,p_building uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
  SELECT jsonb_build_object(
    'view',app_private.door_access_can_read_v1(p_org,p_building,'door_access.view'),
    'temp_password',app_private.door_access_can_read_v1(p_org,p_building,'door_access.temp_password'),
    'remote_unlock',app_private.door_access_can_read_v1(p_org,p_building,'door_access.remote_unlock'),
    'manage_devices',app_private.door_access_can_read_v1(p_org,p_building,'door_access.manage_devices'))
$function$;

CREATE OR REPLACE FUNCTION app_private.door_device_json_v1(p_device_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
  SELECT app_private.door_device_shape_v1(d,b.name,app_private.door_access_can_json_v1(d.organization_id,d.building_id))
  FROM public.door_devices d JOIN public.buildings b ON b.id=d.building_id
  WHERE d.id=p_device_id
$function$;

CREATE OR REPLACE FUNCTION app_private.door_link_json_v1(p_link_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
  SELECT jsonb_build_object('id',l.id,'device_id',l.door_device_id,'unlock_type',l.unlock_type,'unlock_sn',l.unlock_sn,
    'tuya_user_id',l.tuya_user_id,'device_user_name',l.device_user_name,'customer_id',l.customer_id,
    'customer_name',c.full_name,'label',l.label,'linked_at',l.linked_at,
    'linked_by_name',COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng'),
    'tenancy',t.tenancy,'room_name',t.room_name,'contract_end_date',t.contract_end_date)
  FROM public.door_key_links l
  JOIN public.door_devices d ON d.id=l.door_device_id
  LEFT JOIN public.customers c ON c.id=l.customer_id
  LEFT JOIN public.profiles p ON p.id=l.linked_by
  CROSS JOIN LATERAL app_private.door_link_tenancy_v1(l.organization_id,d.building_id,l.customer_id) t
  WHERE l.id=p_link_id
$function$;

-- Thao tác chỉ ghi database (lưu/tắt máy, gắn/bỏ gắn) ⇒ một dòng nhật ký đã chốt OK.
CREATE OR REPLACE FUNCTION app_private.door_access_log_done_v1(p_device_id uuid,p_action text,p_detail jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;v_id uuid;v_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id;
  INSERT INTO public.door_action_logs(organization_id,door_device_id,building_id,actor_id,action,status,detail,created_at,finished_at)
  VALUES(d.organization_id,d.id,d.building_id,auth.uid(),p_action,'OK',COALESCE(p_detail,'{}'::jsonb),v_at,v_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- customers.fingerprint_code = các số vân tay đang gắn của khách (tăng dần, ", "); hết liên kết ⇒ NULL.
CREATE OR REPLACE FUNCTION app_private.door_sync_fingerprint_code_v1(p_customer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE v_code text;
BEGIN
  IF p_customer_id IS NULL THEN RETURN;END IF;
  SELECT string_agg(s.sn::text, ', ' ORDER BY s.sn) INTO v_code
  FROM (SELECT DISTINCT l.unlock_sn AS sn FROM public.door_key_links l
        WHERE l.customer_id=p_customer_id AND l.unlock_type='fingerprint' AND l.unlinked_at IS NULL) s;
  UPDATE public.customers SET fingerprint_code=v_code
   WHERE id=p_customer_id AND fingerprint_code IS DISTINCT FROM v_code;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.door_access_authorized_v1(uuid,uuid,text), app_private.door_access_can_read_v1(uuid,uuid,text),
  app_private.door_link_tenancy_v1(uuid,uuid,uuid), app_private.door_device_shape_v1(public.door_devices,text,jsonb),
  app_private.door_access_can_json_v1(uuid,uuid), app_private.door_device_json_v1(uuid), app_private.door_link_json_v1(uuid),
  app_private.door_access_log_done_v1(uuid,text,jsonb), app_private.door_sync_fingerprint_code_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. RPC đọc ──────────────────────────────────────────────────────
-- Máy ở các tòa người gọi có ít nhất một quyền cửa; máy đã tắt chỉ hiện với người có quyền Quản lý.
CREATE OR REPLACE FUNCTION public.door_access_devices_v1(p_organization_id uuid,p_include_inactive boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền xem cửa vân tay trong tổ chức' USING ERRCODE='42501';END IF;
  -- Quyền tính một lần mỗi tòa có máy (không lặp theo từng máy).
  RETURN jsonb_build_object('devices',COALESCE((
    WITH blds AS (
      SELECT b.id, b.name, app_private.door_access_can_json_v1(p_organization_id,b.id) AS can
      FROM public.buildings b
      WHERE b.organization_id=p_organization_id
        AND EXISTS(SELECT 1 FROM public.door_devices x WHERE x.organization_id=p_organization_id AND x.building_id=b.id)
    )
    SELECT jsonb_agg(app_private.door_device_shape_v1(d,bl.name,bl.can) ORDER BY bl.name, d.display_name, d.id)
    FROM public.door_devices d JOIN blds bl ON bl.id=d.building_id
    WHERE d.organization_id=p_organization_id
      AND CASE WHEN d.is_active THEN (bl.can->>'view')::boolean OR (bl.can->>'temp_password')::boolean
                 OR (bl.can->>'remote_unlock')::boolean OR (bl.can->>'manage_devices')::boolean
               ELSE COALESCE(p_include_inactive,false) AND (bl.can->>'manage_devices')::boolean END
  ),'[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.door_access_key_links_v1(p_organization_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id AND organization_id=p_organization_id;
  IF NOT FOUND OR NOT app_private.door_access_can_read_v1(d.organization_id,d.building_id,'door_access.view') THEN
    RAISE EXCEPTION 'Không có quyền xem vân tay của máy này' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('links',COALESCE((
    SELECT jsonb_agg(app_private.door_link_json_v1(l.id) ORDER BY l.unlock_type, l.unlock_sn, l.id)
    FROM public.door_key_links l WHERE l.door_device_id=d.id AND l.unlinked_at IS NULL
  ),'[]'::jsonb));
END;
$function$;

-- Khách đang ở tòa của máy (ô chọn khi gắn vân tay).
CREATE OR REPLACE FUNCTION public.door_access_building_tenants_v1(p_organization_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id AND organization_id=p_organization_id;
  IF NOT FOUND OR NOT app_private.door_access_can_read_v1(d.organization_id,d.building_id,'door_access.manage_devices') THEN
    RAISE EXCEPTION 'Không có quyền gắn vân tay ở máy này' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('tenants',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('customer_id',t.customer_id,'full_name',t.full_name,'room_id',t.room_id,
      'room_name',t.room_name,'contract_id',t.contract_id,'is_representative',t.is_representative)
      ORDER BY t.room_name, NOT t.is_representative, t.full_name, t.customer_id)
    FROM (
      SELECT DISTINCT ON (cu.id) cu.id AS customer_id, cu.full_name, r.id AS room_id, r.name AS room_name,
        c.id AS contract_id, cc.is_representative
      FROM public.contracts c
      JOIN public.rooms r ON r.id=c.room_id AND r.building_id=d.building_id AND r.deleted_at IS NULL
      JOIN public.contract_customers cc ON cc.contract_id=c.id
      JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=d.organization_id AND cu.deleted_at IS NULL
      WHERE c.organization_id=d.organization_id AND c.deleted_at IS NULL AND c.actual_end_date IS NULL
        AND c.status::text NOT IN ('DRAFT','TERMINATED','TRANSFERRED')
      ORDER BY cu.id, c.start_date DESC NULLS LAST, c.id
    ) t
  ),'[]'::jsonb));
END;
$function$;

-- Bản nháp 5 tham số (không có p_before_id) chỉ từng áp lên TEST; bỏ để PostgREST không gặp hai hàm cùng tên.
DROP FUNCTION IF EXISTS public.door_access_action_logs_v1(uuid,uuid,text[],integer,timestamptz);
CREATE OR REPLACE FUNCTION public.door_access_action_logs_v1(p_organization_id uuid,p_device_id uuid DEFAULT NULL,
  p_actions text[] DEFAULT NULL,p_limit integer DEFAULT 100,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE v_limit integer:=LEAST(GREATEST(COALESCE(p_limit,100),1),200);v_rows jsonb;v_count integer;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền xem nhật ký cửa vân tay trong tổ chức' USING ERRCODE='42501';END IF;
  -- Quyền xem tính một lần mỗi tòa (tòa ghi trên nhật ký = tòa của máy lúc thao tác), rồi mới lọc dòng.
  WITH allowed AS (
    SELECT b.id FROM public.buildings b
    WHERE b.organization_id=p_organization_id
      AND EXISTS(SELECT 1 FROM public.door_action_logs x WHERE x.organization_id=p_organization_id AND x.building_id=b.id)
      AND app_private.door_access_can_read_v1(p_organization_id,b.id,'door_access.view')
  ), visible AS (
    SELECT g.*
    FROM public.door_action_logs g JOIN allowed a ON a.id=g.building_id
    WHERE g.organization_id=p_organization_id
      AND (p_device_id IS NULL OR g.door_device_id=p_device_id)
      AND (p_actions IS NULL OR g.action=ANY(p_actions))
      -- Lật trang theo cặp (created_at, id) của dòng cuối trang trước: hai dòng cùng mốc giờ không bị bỏ sót.
      AND (p_before IS NULL OR g.created_at<p_before
           OR (p_before_id IS NOT NULL AND g.created_at=p_before AND g.id<p_before_id))
    ORDER BY g.created_at DESC, g.id DESC
    LIMIT v_limit+1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'device_id',v.door_device_id,'device_name',d.display_name,
      'building_id',v.building_id,'building_name',b.name,'actor_id',v.actor_id,
      'actor_name',COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng'),'action',v.action,'status',v.status,'detail',v.detail,
      'tuya_password_id',v.tuya_password_id,'error_code',v.error_code,'error_message',v.error_message,
      'created_at',v.created_at,'finished_at',v.finished_at) ORDER BY v.created_at DESC, v.id DESC),'[]'::jsonb),
    count(*)
    INTO v_rows, v_count
  FROM visible v
  JOIN public.door_devices d ON d.id=v.door_device_id
  JOIN public.buildings b ON b.id=v.building_id
  LEFT JOIN public.profiles p ON p.id=v.actor_id;
  IF v_count>v_limit THEN
    v_rows:=v_rows-v_limit;
  END IF;
  RETURN jsonb_build_object('logs',v_rows,'has_more',v_count>v_limit);
END;
$function$;

-- ── 5. RPC ghi từ trình duyệt ───────────────────────────────────────
-- Lưu máy (tạo mới hoặc dựng lại dòng cũ theo tuya_device_id). Đổi tòa cần quyền Quản lý ở cả hai tòa.
CREATE OR REPLACE FUNCTION public.door_access_save_device_v1(p_organization_id uuid,p_tuya_device_id text,p_building_id uuid,
  p_display_name text,p_device_kind text,p_tuya_category text DEFAULT NULL,p_tuya_product_name text DEFAULT NULL,
  p_channel_id integer DEFAULT 1,p_password_length integer DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;v_name text:=btrim(COALESCE(p_display_name,''));
  v_category text:=NULLIF(btrim(COALESCE(p_tuya_category,'')),'');v_product text:=NULLIF(btrim(COALESCE(p_tuya_product_name,'')),'');
  v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  IF p_tuya_device_id IS NULL OR p_tuya_device_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'Mã máy SmartLife không hợp lệ' USING ERRCODE='22023';END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Tên máy phải có 1–120 ký tự' USING ERRCODE='22023';END IF;
  IF p_device_kind IS NULL OR p_device_kind NOT IN ('access_control','wifi_lock') THEN
    RAISE EXCEPTION 'Loại máy không hợp lệ' USING ERRCODE='22023';END IF;
  IF p_channel_id IS NULL OR p_channel_id NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'Kênh mở cửa phải từ 1 đến 64' USING ERRCODE='22023';END IF;
  IF p_password_length IS NULL OR p_password_length NOT BETWEEN 6 AND 10 THEN
    RAISE EXCEPTION 'Độ dài mật khẩu tạm phải từ 6 đến 10 số' USING ERRCODE='22023';END IF;
  IF char_length(v_category)>32 OR char_length(v_product)>120 THEN RAISE EXCEPTION 'Thông tin máy quá dài' USING ERRCODE='22023';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=p_building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Không tìm thấy tòa trong tổ chức' USING ERRCODE='42501';END IF;
  -- Thứ tự khoá: dòng máy (nếu có) trước, tổ chức sau — cùng thứ tự với mọi RPC ghi khác của bảng này.
  SELECT * INTO d FROM public.door_devices WHERE tuya_device_id=p_tuya_device_id FOR UPDATE;
  IF FOUND AND d.organization_id<>p_organization_id THEN
    RAISE EXCEPTION 'Máy này đã được gắn ở một công ty khác' USING ERRCODE='23505';END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.door_access_authorized_v1(p_organization_id,p_building_id,'door_access.manage_devices')
     OR (d.id IS NOT NULL AND d.building_id<>p_building_id
         AND NOT app_private.door_access_authorized_v1(p_organization_id,d.building_id,'door_access.manage_devices')) THEN
    RAISE EXCEPTION 'Không có quyền quản lý máy cửa ở tòa này' USING ERRCODE='42501';END IF;
  v_at:=clock_timestamp();
  IF d.id IS NULL THEN
    INSERT INTO public.door_devices(organization_id,building_id,tuya_device_id,display_name,device_kind,tuya_category,
      tuya_product_name,channel_id,password_length,is_active,created_at,created_by,updated_at,updated_by)
    VALUES(p_organization_id,p_building_id,p_tuya_device_id,v_name,p_device_kind,v_category,v_product,p_channel_id,
      p_password_length,true,v_at,auth.uid(),v_at,auth.uid())
    RETURNING * INTO d;
  ELSE
    UPDATE public.door_devices SET building_id=p_building_id,display_name=v_name,device_kind=p_device_kind,
      tuya_category=v_category,tuya_product_name=v_product,channel_id=p_channel_id,password_length=p_password_length,
      is_active=true,updated_at=v_at,updated_by=auth.uid()
    WHERE id=d.id RETURNING * INTO d;
  END IF;
  PERFORM app_private.door_access_log_done_v1(d.id,'DEVICE_SAVE',jsonb_build_object('building_id',d.building_id,
    'display_name',d.display_name,'device_kind',d.device_kind,'channel_id',d.channel_id,'password_length',d.password_length));
  RETURN app_private.door_device_json_v1(d.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.door_access_disable_device_v1(p_organization_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy máy cửa trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.door_access_authorized_v1(p_organization_id,d.building_id,'door_access.manage_devices') THEN
    RAISE EXCEPTION 'Không có quyền quản lý máy cửa ở tòa này' USING ERRCODE='42501';END IF;
  IF d.is_active THEN
    UPDATE public.door_devices SET is_active=false,updated_at=clock_timestamp(),updated_by=auth.uid() WHERE id=d.id;
    PERFORM app_private.door_access_log_done_v1(d.id,'DEVICE_DISABLE','{}'::jsonb);
  END IF;
  RETURN app_private.door_device_json_v1(d.id);
END;
$function$;

-- Gắn một số trên máy với khách (hoặc nhãn). Số đang gắn người khác ⇒ đóng liên kết cũ (RELINKED).
-- Bấm lại đúng nội dung vừa lưu ⇒ trả lại liên kết đó, không đóng/mở lại.
CREATE OR REPLACE FUNCTION public.door_access_link_key_v1(p_organization_id uuid,p_device_id uuid,p_unlock_type text,
  p_unlock_sn integer,p_tuya_user_id text DEFAULT NULL,p_device_user_name text DEFAULT NULL,p_customer_id uuid DEFAULT NULL,
  p_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;old public.door_key_links%ROWTYPE;l public.door_key_links%ROWTYPE;
  v_label text:=NULLIF(btrim(COALESCE(p_label,'')),'');v_user_name text:=NULLIF(btrim(COALESCE(p_device_user_name,'')),'');
  v_tuya_user text:=NULLIF(btrim(COALESCE(p_tuya_user_id,'')),'');v_at timestamptz;v_had_old boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  IF p_unlock_type IS NULL OR p_unlock_type NOT IN ('fingerprint','card','password') THEN
    RAISE EXCEPTION 'Loại khoá phải là vân tay, thẻ hoặc mật khẩu' USING ERRCODE='22023';END IF;
  IF p_unlock_sn IS NULL OR p_unlock_sn<0 THEN RAISE EXCEPTION 'Số trên máy không hợp lệ' USING ERRCODE='22023';END IF;
  IF (p_customer_id IS NULL)=(v_label IS NULL) THEN
    RAISE EXCEPTION 'Chọn đúng một: khách hoặc nhãn' USING ERRCODE='22023';END IF;
  IF char_length(v_label)>80 OR char_length(v_user_name)>80 THEN RAISE EXCEPTION 'Nhãn hoặc tên trên máy tối đa 80 ký tự' USING ERRCODE='22023';END IF;
  IF v_tuya_user IS NOT NULL AND v_tuya_user !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'Mã người dùng trên máy không hợp lệ' USING ERRCODE='22023';END IF;
  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id AND organization_id=p_organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy máy cửa trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.door_access_authorized_v1(p_organization_id,d.building_id,'door_access.manage_devices') THEN
    RAISE EXCEPTION 'Không có quyền gắn vân tay ở máy này' USING ERRCODE='42501';END IF;
  IF NOT d.is_active THEN RAISE EXCEPTION 'Máy đã tắt khỏi CRM' USING ERRCODE='55000';END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers c WHERE c.id=p_customer_id
       AND c.organization_id=p_organization_id AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Không tìm thấy khách trong tổ chức' USING ERRCODE='42501';END IF;
  SELECT * INTO old FROM public.door_key_links WHERE door_device_id=d.id AND unlock_type=p_unlock_type
    AND unlock_sn=p_unlock_sn AND unlinked_at IS NULL FOR UPDATE;
  v_had_old:=FOUND;
  IF v_had_old AND old.customer_id IS NOT DISTINCT FROM p_customer_id AND old.label IS NOT DISTINCT FROM v_label
     AND old.tuya_user_id IS NOT DISTINCT FROM v_tuya_user THEN
    RETURN app_private.door_link_json_v1(old.id);
  END IF;
  v_at:=clock_timestamp();
  IF v_had_old THEN
    UPDATE public.door_key_links SET unlinked_at=v_at,unlinked_by=auth.uid(),unlink_reason='RELINKED' WHERE id=old.id;
  END IF;
  INSERT INTO public.door_key_links(organization_id,door_device_id,unlock_type,unlock_sn,tuya_user_id,device_user_name,
    customer_id,label,linked_by,linked_at)
  VALUES(p_organization_id,d.id,p_unlock_type,p_unlock_sn,v_tuya_user,v_user_name,p_customer_id,v_label,auth.uid(),v_at)
  RETURNING * INTO l;
  IF p_unlock_type='fingerprint' THEN
    PERFORM app_private.door_sync_fingerprint_code_v1(old.customer_id);
    PERFORM app_private.door_sync_fingerprint_code_v1(l.customer_id);
  END IF;
  PERFORM app_private.door_access_log_done_v1(d.id,'KEY_LINK',jsonb_build_object('link_id',l.id,'unlock_type',l.unlock_type,
    'unlock_sn',l.unlock_sn,'customer_id',l.customer_id,'label',l.label,'replaced_link_id',old.id));
  RETURN app_private.door_link_json_v1(l.id);
END;
$function$;

-- Bỏ gắn bằng tay. Liên kết đã đóng ⇒ trả trạng thái hiện tại, không báo lỗi.
CREATE OR REPLACE FUNCTION public.door_access_unlink_key_v1(p_organization_id uuid,p_link_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE l public.door_key_links%ROWTYPE;d public.door_devices%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  SELECT * INTO l FROM public.door_key_links WHERE id=p_link_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy liên kết vân tay trong tổ chức' USING ERRCODE='42501';END IF;
  SELECT * INTO d FROM public.door_devices WHERE id=l.door_device_id FOR NO KEY UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.door_access_authorized_v1(p_organization_id,d.building_id,'door_access.manage_devices') THEN
    RAISE EXCEPTION 'Không có quyền gắn vân tay ở máy này' USING ERRCODE='42501';END IF;
  SELECT * INTO l FROM public.door_key_links WHERE id=p_link_id FOR UPDATE;
  IF l.unlinked_at IS NULL THEN
    UPDATE public.door_key_links SET unlinked_at=clock_timestamp(),unlinked_by=auth.uid(),unlink_reason='MANUAL' WHERE id=l.id;
    IF l.unlock_type='fingerprint' THEN PERFORM app_private.door_sync_fingerprint_code_v1(l.customer_id);END IF;
    PERFORM app_private.door_access_log_done_v1(d.id,'KEY_UNLINK',jsonb_build_object('link_id',l.id,'unlock_type',l.unlock_type,
      'unlock_sn',l.unlock_sn,'customer_id',l.customer_id,'label',l.label));
  END IF;
  RETURN jsonb_build_object('id',l.id,'unlinked',true);
END;
$function$;

-- ── 6. RPC cho hàm Edge door-access ─────────────────────────────────
-- Đọc từ Tuya (lịch sử, danh sách khoá, mật khẩu tạm): máy đang hoạt động + quyền ở tòa ⇒ ngữ cảnh máy.
CREATE OR REPLACE FUNCTION public.door_access_authorize_v1(p_organization_id uuid,p_device_id uuid,p_permission text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  IF p_permission IS NULL OR p_permission NOT IN ('door_access.view','door_access.temp_password','door_access.remote_unlock','door_access.manage_devices') THEN
    RAISE EXCEPTION 'Quyền cửa vân tay không hợp lệ' USING ERRCODE='22023';END IF;
  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy máy cửa trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.door_access_authorized_v1(p_organization_id,d.building_id,p_permission) THEN
    RAISE EXCEPTION 'Không có quyền với máy cửa này' USING ERRCODE='42501';END IF;
  IF NOT d.is_active THEN RAISE EXCEPTION 'Máy đã tắt khỏi CRM' USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('device_id',d.id,'tuya_device_id',d.tuya_device_id,'device_kind',d.device_kind,
    'channel_id',d.channel_id,'password_length',d.password_length,'building_id',d.building_id,'display_name',d.display_name);
END;
$function$;

-- Có quyền ở ít nhất một tòa của công ty (tìm máy trên SmartLife cần quyền Quản lý).
CREATE OR REPLACE FUNCTION public.door_access_can_any_v1(p_organization_id uuid,p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RETURN false;END IF;
  RETURN EXISTS(SELECT 1 FROM public.buildings b WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
    AND app_private.door_access_can_read_v1(p_organization_id,b.id,p_permission));
END;
$function$;

-- Bước 1 của lệnh gửi xuống máy: kiểm quyền theo thao tác, trần tần suất, ghi PENDING. Hàm Edge gọi bằng
-- JWT người dùng NGAY TRƯỚC khi gọi Tuya; chốt bằng door_access_finish_action_v1 (service_role).
CREATE OR REPLACE FUNCTION public.door_access_begin_action_v1(p_organization_id uuid,p_device_id uuid,p_action text,
  p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE d public.door_devices%ROWTYPE;v_permission text;v_detail jsonb:=COALESCE(p_detail,'{}'::jsonb);v_clean jsonb;
  v_window interval;v_max integer;v_recent integer;v_now_sec bigint:=floor(extract(epoch FROM clock_timestamp()))::bigint;
  v_name text;v_eff bigint;v_inv bigint;v_log uuid;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  v_permission:=CASE p_action WHEN 'REMOTE_UNLOCK' THEN 'door_access.remote_unlock'
    WHEN 'TEMP_PASSWORD_CREATE' THEN 'door_access.temp_password' WHEN 'TEMP_PASSWORD_DELETE' THEN 'door_access.temp_password'
    WHEN 'KEY_DELETE' THEN 'door_access.manage_devices' END;
  IF v_permission IS NULL THEN RAISE EXCEPTION 'Thao tác cửa không hợp lệ' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(v_detail)<>'object' THEN RAISE EXCEPTION 'Chi tiết thao tác phải là object' USING ERRCODE='22023';END IF;

  -- Chi tiết theo thao tác: chỉ nhận đúng khoá, đúng kiểu. Không bao giờ có mật khẩu.
  IF p_action='REMOTE_UNLOCK' THEN
    IF v_detail<>'{}'::jsonb THEN RAISE EXCEPTION 'Mở cửa không nhận chi tiết' USING ERRCODE='22023';END IF;
    v_clean:='{}'::jsonb;
  ELSIF p_action='TEMP_PASSWORD_CREATE' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_detail) k WHERE k NOT IN ('name','purpose','effective_sec','invalid_sec'))
       OR jsonb_typeof(v_detail->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(v_detail->'purpose') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_detail->'effective_sec') IS DISTINCT FROM 'number' OR jsonb_typeof(v_detail->'invalid_sec') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Chi tiết mật khẩu tạm sai dạng' USING ERRCODE='22023';END IF;
    v_name:=btrim(v_detail->>'name');
    IF char_length(v_name) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Tên mật khẩu tạm phải có 1–20 ký tự' USING ERRCODE='22023';END IF;
    IF (v_detail->>'purpose') NOT IN ('XEM_PHONG','THO','KHACH','KHAC') THEN RAISE EXCEPTION 'Mục đích mật khẩu tạm không hợp lệ' USING ERRCODE='22023';END IF;
    IF (v_detail->>'effective_sec')!~'^[0-9]{1,12}$' OR (v_detail->>'invalid_sec')!~'^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'Mốc giờ mật khẩu tạm phải là số giây nguyên' USING ERRCODE='22023';END IF;
    v_eff:=(v_detail->>'effective_sec')::bigint;v_inv:=(v_detail->>'invalid_sec')::bigint;
    IF v_inv<=v_eff OR v_inv<=v_now_sec OR v_eff<v_now_sec-300 OR v_inv-v_eff>7*86400 THEN
      RAISE EXCEPTION 'Hiệu lực mật khẩu tạm phải kết thúc sau hiện tại và dài tối đa 7 ngày' USING ERRCODE='22023';END IF;
    v_clean:=jsonb_build_object('name',v_name,'purpose',v_detail->>'purpose','effective_sec',v_eff,'invalid_sec',v_inv);
  ELSIF p_action='TEMP_PASSWORD_DELETE' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_detail) k WHERE k<>'password_id') OR (v_detail->>'password_id') IS NULL
       OR (v_detail->>'password_id')!~'^[0-9]{1,15}$' THEN
      RAISE EXCEPTION 'Mã mật khẩu tạm không hợp lệ' USING ERRCODE='22023';END IF;
    v_clean:=jsonb_build_object('password_id',(v_detail->>'password_id')::bigint);
  ELSE -- KEY_DELETE
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_detail) k WHERE k NOT IN ('unlock_type','unlock_sn','tuya_user_id','user_type'))
       OR (v_detail->>'unlock_type') IS NULL OR (v_detail->>'unlock_type') NOT IN ('fingerprint','card','password')
       OR (v_detail->>'unlock_sn') IS NULL OR (v_detail->>'unlock_sn')!~'^[0-9]{1,9}$'
       OR (v_detail->>'tuya_user_id') IS NULL OR (v_detail->>'tuya_user_id')!~'^[A-Za-z0-9_-]{1,64}$'
       OR COALESCE(v_detail->>'user_type','1') NOT IN ('1','2') THEN
      RAISE EXCEPTION 'Chi tiết xoá khoá trên máy sai dạng' USING ERRCODE='22023';END IF;
    v_clean:=jsonb_build_object('unlock_type',v_detail->>'unlock_type','unlock_sn',(v_detail->>'unlock_sn')::bigint,
      'tuya_user_id',v_detail->>'tuya_user_id','user_type',COALESCE(v_detail->>'user_type','1')::integer);
  END IF;

  SELECT * INTO d FROM public.door_devices WHERE id=p_device_id AND organization_id=p_organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy máy cửa trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.door_access_authorized_v1(p_organization_id,d.building_id,v_permission) THEN
    RAISE EXCEPTION 'Không có quyền với máy cửa này' USING ERRCODE='42501';END IF;
  IF NOT d.is_active THEN RAISE EXCEPTION 'Máy đã tắt khỏi CRM' USING ERRCODE='55000';END IF;

  -- Trần tần suất theo người gọi (mọi máy): chặn bấm dồn/lạm dụng, không phải kiểm soát chính.
  SELECT CASE p_action WHEN 'REMOTE_UNLOCK' THEN interval '10 minutes' ELSE interval '1 hour' END,
         CASE p_action WHEN 'REMOTE_UNLOCK' THEN 10 WHEN 'TEMP_PASSWORD_CREATE' THEN 20 ELSE 30 END
    INTO v_window, v_max;
  SELECT count(*) INTO v_recent FROM public.door_action_logs g
   WHERE g.actor_id=auth.uid() AND g.action=p_action AND g.created_at>clock_timestamp()-v_window;
  IF v_recent>=v_max THEN
    RAISE EXCEPTION 'Thao tác quá nhiều lần trong thời gian ngắn — chờ một lúc rồi thử lại' USING ERRCODE='54000';END IF;

  INSERT INTO public.door_action_logs(organization_id,door_device_id,building_id,actor_id,action,status,detail)
  VALUES(p_organization_id,d.id,d.building_id,auth.uid(),p_action,'PENDING',
    CASE WHEN p_action='REMOTE_UNLOCK' THEN jsonb_build_object('channel_id',d.channel_id) ELSE v_clean END)
  RETURNING id INTO v_log;
  RETURN jsonb_build_object('log_id',v_log,'device_id',d.id,'tuya_device_id',d.tuya_device_id,'device_kind',d.device_kind,
    'channel_id',d.channel_id,'password_length',d.password_length,'building_id',d.building_id,'display_name',d.display_name);
END;
$function$;

-- Bước 2: chốt kết quả đúng một lần (service_role). Gọi lại cùng kết quả ⇒ trả trạng thái, không ghi.
-- KEY_DELETE thành công ⇒ đóng liên kết mở của số đó (DELETED_ON_DEVICE) và đồng bộ fingerprint_code.
CREATE OR REPLACE FUNCTION public.door_access_finish_action_v1(p_log_id uuid,p_status text,p_tuya_password_id bigint DEFAULT NULL,
  p_error_code text DEFAULT NULL,p_error_message text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE g public.door_action_logs%ROWTYPE;l public.door_key_links%ROWTYPE;v_at timestamptz;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('OK','FAILED','UNKNOWN') THEN
    RAISE EXCEPTION 'Kết quả thao tác không hợp lệ' USING ERRCODE='22023';END IF;
  IF p_tuya_password_id IS NOT NULL AND p_tuya_password_id<0 THEN
    RAISE EXCEPTION 'Mã mật khẩu tạm không hợp lệ' USING ERRCODE='22023';END IF;
  SELECT * INTO g FROM public.door_action_logs WHERE id=p_log_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy nhật ký thao tác' USING ERRCODE='22023';END IF;
  IF g.action NOT IN ('REMOTE_UNLOCK','TEMP_PASSWORD_CREATE','TEMP_PASSWORD_DELETE','KEY_DELETE') THEN
    RAISE EXCEPTION 'Nhật ký này không chờ kết quả' USING ERRCODE='22023';END IF;
  IF g.status<>'PENDING' THEN
    IF g.status=p_status THEN RETURN jsonb_build_object('log_id',g.id,'status',g.status);END IF;
    RAISE EXCEPTION 'Nhật ký thao tác đã chốt kết quả khác' USING ERRCODE='55000';
  END IF;
  v_at:=clock_timestamp();
  UPDATE public.door_action_logs SET status=p_status,finished_at=v_at,
    tuya_password_id=CASE WHEN g.action='TEMP_PASSWORD_CREATE' AND p_status='OK' THEN p_tuya_password_id
                          WHEN g.action='TEMP_PASSWORD_DELETE' THEN (g.detail->>'password_id')::bigint ELSE NULL END,
    error_code=CASE WHEN p_status='OK' THEN NULL ELSE left(NULLIF(btrim(COALESCE(p_error_code,'')),''),64) END,
    error_message=CASE WHEN p_status='OK' THEN NULL ELSE left(NULLIF(btrim(COALESCE(p_error_message,'')),''),300) END
  WHERE id=g.id;
  IF g.action='KEY_DELETE' AND p_status='OK' THEN
    FOR l IN SELECT * FROM public.door_key_links WHERE door_device_id=g.door_device_id AND unlinked_at IS NULL
      AND unlock_type=g.detail->>'unlock_type' AND unlock_sn=(g.detail->>'unlock_sn')::integer FOR UPDATE
    LOOP
      UPDATE public.door_key_links SET unlinked_at=v_at,unlinked_by=g.actor_id,unlink_reason='DELETED_ON_DEVICE' WHERE id=l.id;
      IF l.unlock_type='fingerprint' THEN PERFORM app_private.door_sync_fingerprint_code_v1(l.customer_id);END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('log_id',g.id,'status',p_status);
END;
$function$;

-- ── 7. ACL ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.door_access_devices_v1(uuid,boolean), public.door_access_key_links_v1(uuid,uuid),
  public.door_access_building_tenants_v1(uuid,uuid), public.door_access_action_logs_v1(uuid,uuid,text[],integer,timestamptz,uuid),
  public.door_access_save_device_v1(uuid,text,uuid,text,text,text,text,integer,integer), public.door_access_disable_device_v1(uuid,uuid),
  public.door_access_link_key_v1(uuid,uuid,text,integer,text,text,uuid,text), public.door_access_unlink_key_v1(uuid,uuid),
  public.door_access_authorize_v1(uuid,uuid,text), public.door_access_can_any_v1(uuid,text),
  public.door_access_begin_action_v1(uuid,uuid,text,jsonb), public.door_access_finish_action_v1(uuid,text,bigint,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.door_access_devices_v1(uuid,boolean), public.door_access_key_links_v1(uuid,uuid),
  public.door_access_building_tenants_v1(uuid,uuid), public.door_access_action_logs_v1(uuid,uuid,text[],integer,timestamptz,uuid),
  public.door_access_save_device_v1(uuid,text,uuid,text,text,text,text,integer,integer), public.door_access_disable_device_v1(uuid,uuid),
  public.door_access_link_key_v1(uuid,uuid,text,integer,text,text,uuid,text), public.door_access_unlink_key_v1(uuid,uuid),
  public.door_access_authorize_v1(uuid,uuid,text), public.door_access_can_any_v1(uuid,text),
  public.door_access_begin_action_v1(uuid,uuid,text,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.door_access_finish_action_v1(uuid,text,bigint,text,text) TO service_role;

-- ── 8. Tự kiểm trước khi commit ─────────────────────────────────────
DO $assert$
BEGIN
  IF (SELECT count(*) FROM public.permission_definitions WHERE key LIKE 'door_access.%' AND permission_domain='TENANT'
        AND is_active AND required_dimensions=ARRAY['BUILDING']::text[])<>4 THEN
    RAISE EXCEPTION 'Thiếu khoá door_access.* — authorize_tenant_action_v3 sẽ fail-closed';
  END IF;
  IF has_function_privilege('anon','public.door_access_begin_action_v1(uuid,uuid,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.door_access_finish_action_v1(uuid,text,bigint,text,text)','EXECUTE')
    OR has_function_privilege('anon','public.door_access_finish_action_v1(uuid,text,bigint,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.door_access_finish_action_v1(uuid,text,bigint,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.door_access_authorized_v1(uuid,uuid,text)','EXECUTE')
    OR has_table_privilege('authenticated','public.door_action_logs','SELECT')
    OR has_table_privilege('authenticated','public.door_devices','SELECT')
    OR has_table_privilege('authenticated','public.door_key_links','SELECT') THEN
    RAISE EXCEPTION 'ACL cửa vân tay mở quá rộng';
  END IF;
END
$assert$;
