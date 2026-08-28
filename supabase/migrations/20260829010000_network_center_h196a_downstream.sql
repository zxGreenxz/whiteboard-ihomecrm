-- =============================================================================
-- Network Center: đưa router downstream ZTE H196A vào tầm nhìn, ngang Aruba.
--
-- VÌ SAO
--   Toà 950NK chạy MikroTik + 5 con ZTE H196A. Aruba ở 102LVT đã theo dõi được
--   vì mỗi IAP tự khai báo qua LLDP (đo thật: platform="ArubaOS", MODEL 315, kèm
--   tên người vận hành đặt). H196A không khai báo gì: `/ip/neighbor` trên 950NK
--   rỗng hoàn toàn kể cả sau khi thêm cả hai cổng vật lý vào danh sách quét và
--   chờ 7 phút — gấp 14 lần chu kỳ (đo 28/08/2026). Ba trong năm con nằm sau
--   switch, mà 802.1D không chuyển tiếp khung LLDP, nên phép đo đó chứng minh
--   "router không nhìn thấy", KHÔNG chứng minh "thiết bị câm". Hệ quả với thiết
--   kế thì như nhau: bằng chứng duy nhất là DHCP lease + ARP + bảng bridge host.
--
-- KHÁC ARUBA Ở ĐÂU, VÀ VÌ SAO KHÔNG CHÉP NGUYÊN
--   Aruba có cả bộ máy discovery run / batch / alias / ngưỡng số lần thấy trước
--   khi ghi danh. Bộ đó tồn tại vì bảng neighbor chớp tắt theo từng lượt quét.
--   H196A dựa trên lease TĨNH — một dòng do người vận hành tự đặt — nên nó không
--   chớp tắt, và chép bộ chống-chớp-tắt sang đây là thêm bề mặt lỗi không đổi
--   lấy gì. Cái H196A cần mà Aruba không có là NGƯỢC LẠI: một phán quyết sức
--   khoẻ thật. `ArubaObservation.reachable` gán cứng `true`, chỉ nghĩa là "có
--   thấy trong lượt quét này", nên nó không phân biệt nổi một AP đang sống với
--   một AP đã chết mà lease chưa hết hạn.
--
-- BA THỨ CỐ Ý KHÔNG LÀM
--   1. Không đụng `network_center_worker_inventory_legacy_impl_v1` (13.9k ký tự,
--      đang phục vụ Aruba trên production). Chỉ mở rộng lớp bọc v2 dài 54 dòng.
--   2. Không thêm chặn cho `network_center_execute_action_v1`,
--      `network_center_request_snapshot_v1`,
--      `network_center_admin_provision_connection_v1` — đã kiểm: cả ba vốn lọc
--      `device_kind = 'MIKROTIK'`, nên H196A không lọt. Thêm guard trùng lặp chỉ
--      tạo ảo giác là chỗ đó vừa được siết.
--   3. Không cột `firmware_version`, `model`, `serial_number` cho H196A. Không
--      nguồn nào trên MikroTik cho các giá trị đó, và một cột luôn NULL là lời
--      mời dựng giao diện hứa thứ không tồn tại.
--
-- KHOÁ ĐỊNH DANH
--   `external_key = 'mac:<mac chữ thường>'`. Index duy nhất đã có sẵn
--   `network_devices_external_key_uidx (organization_id, building_id,
--   device_kind, external_key) WHERE device_kind <> 'ARUBA'` phủ đúng kind này,
--   nên không cần cột mới trên `network_devices`. Luật MAC giống hệt
--   `network_devices_aruba_stable_identity_check`: chữ thường, nibble thứ hai
--   thuộc [048c] (globally administered unicast), không zero/broadcast. MAC ngẫu
--   nhiên của điện thoại đổi theo từng mạng nên sẽ ghi danh một thiết bị mới mỗi
--   lượt poll — đó là lý do luật này tồn tại, không phải để cho đẹp.
-- =============================================================================

-- --------------------------------------------------------------------------
-- 1. Cho phép kind mới. Index một-MikroTik-một-toà giữ NGUYÊN.
-- --------------------------------------------------------------------------
ALTER TABLE public.network_devices
  DROP CONSTRAINT IF EXISTS network_devices_kind_check;
ALTER TABLE public.network_devices
  ADD CONSTRAINT network_devices_kind_check
  CHECK (device_kind = ANY (ARRAY['MIKROTIK'::text, 'ARUBA'::text, 'ZTE_H196A'::text]));

-- H196A là thiết bị CHỈ ĐỂ NHÌN. Ràng buộc này là thứ khiến điều đó đúng ở tầng
-- dữ liệu chứ không chỉ đúng trong giao diện: không quyền ghi, không credential,
-- và bắt buộc có cha. Một hàng H196A không cha là một hàng không ai biết nó
-- thuộc router nào, tức không kiểm tra quyền được.
ALTER TABLE public.network_devices
  DROP CONSTRAINT IF EXISTS network_devices_h196a_display_only;
ALTER TABLE public.network_devices
  ADD CONSTRAINT network_devices_h196a_display_only
  CHECK (
    device_kind <> 'ZTE_H196A'::text
    OR (
      write_capability = false
      AND credential_ref IS NULL
      AND parent_device_id IS NOT NULL
      AND external_key ~ '^mac:[0-9a-f][048c](:[0-9a-f]{2}){5}$'
      AND external_key <> ALL (ARRAY['mac:00:00:00:00:00:00'::text, 'mac:ff:ff:ff:ff:ff:ff'::text])
    )
  );

-- Cùng lý do và cùng hình dạng với `network_center_guard_aruba_parent_v1`: cha
-- phải là MikroTik đang hoạt động, CÙNG tổ chức và CÙNG toà. Khác tổ chức là một
-- lỗ biên giới; khác toà là một sơ đồ nói dối.
CREATE OR REPLACE FUNCTION app_private.network_center_guard_h196a_parent_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $$
BEGIN
  IF NEW.device_kind = 'ZTE_H196A' AND NOT EXISTS (
    SELECT 1
    FROM public.network_devices parent
    WHERE parent.organization_id = NEW.organization_id
      AND parent.building_id = NEW.building_id
      AND parent.id = NEW.parent_device_id
      AND parent.device_kind = 'MIKROTIK'
      AND parent.is_active
  ) THEN
    RAISE EXCEPTION 'H196A parent must be an active MikroTik in the same building'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.network_center_guard_h196a_parent_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS network_devices_guard_h196a_parent ON public.network_devices;
CREATE TRIGGER network_devices_guard_h196a_parent
  BEFORE INSERT OR UPDATE ON public.network_devices
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_guard_h196a_parent_v1();

CREATE INDEX IF NOT EXISTS network_devices_h196a_cursor_idx
  ON public.network_devices (organization_id, building_id, sort_order, id)
  WHERE device_kind = 'ZTE_H196A' AND is_active;

-- --------------------------------------------------------------------------
-- 2. Bằng chứng gián tiếp, một dòng một thiết bị.
--
-- Nằm ở `app_private` như mọi bảng Aruba: trình duyệt không đọc thẳng, nó đi qua
-- RPC SECURITY DEFINER có kiểm `can_do_on_building`, nên bảng này không cần và
-- không nên lộ ra PostgREST.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.network_h196a_profiles (
  device_id uuid PRIMARY KEY REFERENCES public.network_devices(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  gateway_device_id uuid NOT NULL REFERENCES public.network_devices(id) ON DELETE CASCADE,
  stable_key text NOT NULL,
  -- Luôn là HARDWARE_MAC. Cột vẫn tồn tại để nếu sau này H196A chịu khai serial
  -- thì chỗ ghi đã có sẵn, nhưng CHECK dưới đây không cho ghi giá trị nào khác
  -- trong khi điều đó chưa đúng.
  identity_source text NOT NULL DEFAULT 'HARDWARE_MAC',
  mac_address macaddr NOT NULL,
  observed_ip inet,
  observed_ip_at timestamp with time zone,
  hostname text,
  -- Cổng vật lý khung tin đi vào. NULL nghĩa là vắng mặt trong bảng bridge host.
  bridge_port text,
  arp_status text,
  -- Chu kỳ già hoá của bridge, ĐỌC TỪ ROUTER. Nó chính là độ nhạy của tín hiệu
  -- sống: vắng bảng host nghĩa là "không có khung tin nào trong chừng ấy giây".
  -- Đặt cứng 5 phút là biến việc ai đó chỉnh bridge thành một lời nói dối thầm
  -- lặng về uptime.
  bridge_ageing_seconds integer,
  -- Phán quyết THÔ của worker cho lượt poll này.
  observed_health text NOT NULL,
  observed_health_reason text NOT NULL,
  -- Trễ trước khi gọi là chết. Worker quan sát, cơ sở dữ liệu mới phán quyết —
  -- ranh giới này giữ nguyên từ plan 12/08 và là lý do một lượt im lặng không
  -- bao giờ thành OFFLINE.
  consecutive_absent_polls integer NOT NULL DEFAULT 0,
  evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at timestamp with time zone NOT NULL,
  last_seen_at timestamp with time zone NOT NULL,
  -- Lượt gần nhất THẬT SỰ thấy khung tin, khác với lượt gần nhất thấy lease.
  last_frame_at timestamp with time zone,
  capability_verdict text NOT NULL DEFAULT 'INDIRECT_ONLY',
  monitoring_mode text NOT NULL DEFAULT 'INDIRECT',
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_h196a_profiles_identity_check
    CHECK (identity_source = 'HARDWARE_MAC'),
  CONSTRAINT network_h196a_profiles_stable_key_check
    CHECK (stable_key ~ '^mac:[0-9a-f][048c](:[0-9a-f]{2}){5}$'),
  CONSTRAINT network_h196a_profiles_health_check
    CHECK (observed_health = ANY (ARRAY['ONLINE'::text, 'STALE'::text, 'UNKNOWN'::text])),
  CONSTRAINT network_h196a_profiles_absent_check
    CHECK (consecutive_absent_polls >= 0),
  CONSTRAINT network_h196a_profiles_seen_order_check
    CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT network_h196a_profiles_evidence_check
    CHECK (jsonb_typeof(evidence_sources) = 'array'),
  -- Khoá này là thứ chặn hai hàng cùng một thiết bị dưới một router.
  CONSTRAINT network_h196a_profiles_gateway_key_uniq UNIQUE (gateway_device_id, stable_key),
  CONSTRAINT network_h196a_profiles_verdict_check
    CHECK (capability_verdict = 'INDIRECT_ONLY' AND monitoring_mode = 'INDIRECT')
);

CREATE INDEX IF NOT EXISTS network_h196a_profiles_building_idx
  ON app_private.network_h196a_profiles (organization_id, building_id, device_id);

-- Bằng chứng KHÔNG ghi danh được. Một MAC ngẫu nhiên hoặc dị dạng phải để lại
-- dấu vết cho người vận hành xem, chứ không được im lặng biến mất và cũng không
-- được tự ghi danh — nó sẽ đẻ một thiết bị mới mỗi lượt poll.
CREATE TABLE IF NOT EXISTS app_private.network_h196a_quarantine (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  gateway_device_id uuid NOT NULL REFERENCES public.network_devices(id) ON DELETE CASCADE,
  code text NOT NULL,
  fingerprint character(64) NOT NULL,
  sighting_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (gateway_device_id, fingerprint),
  CONSTRAINT network_h196a_quarantine_code_check
    CHECK (code = 'H196A_STABLE_IDENTITY_INVALID'),
  CONSTRAINT network_h196a_quarantine_fingerprint_check
    CHECK (fingerprint ~ '^[a-f0-9]{64}$')
);

-- --------------------------------------------------------------------------
-- 3. Nạp bằng chứng.
--
-- Gọi từ lớp bọc inventory v2, SAU khi nó đã khoá router bằng FOR UPDATE và đã
-- kiểm worker có quyền INVENTORY trên router đó. Hàm này KHÔNG tự kiểm quyền và
-- vì thế không được cấp cho bất kỳ role nào.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.network_center_h196a_inventory_v1(
  p_router public.network_devices,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_observed_at timestamptz;
  v_item jsonb;
  v_stable_key text;
  v_mac macaddr;
  v_display_name text;
  v_health text;
  v_device_id uuid;
  v_thay_khung boolean;
  v_mapping jsonb := '[]'::jsonb;
  v_seen text[] := ARRAY[]::text[];
BEGIN
  v_observed_at := coalesce(
    nullif(p_payload->>'observedAt', '')::timestamptz, v_now
  );

  -- `DISTINCT ON` là hàng rào thứ hai, không phải hàng rào duy nhất: worker đã
  -- gộp một-MAC-một-dòng ở `collapseDuplicateLeaseClients`. Lý do vẫn đặt ở đây
  -- là ngày 26–27/08 một MAC hai lease đã làm ON CONFLICT chạm cùng một dòng hai
  -- lần, ném 21000, và vì writer ghi all-or-nothing nên CẢ LÔ telemetry của MỌI
  -- toà bị huỷ — 240 lượt poll hỏng liên tiếp, mù 20 tiếng. Một bản worker cũ
  -- hoặc một bản vá tương lai bị lùi lại không được phép tái tạo chuyện đó.
  FOR v_item IN
    SELECT DISTINCT ON (item->>'stableKey') item
    -- `coalesce` PHAI boc ca nhanh THEN, khong chi nhanh kiem tra. Ban dau day
    -- viet `THEN p_payload->'h196a'`, nen khi payload thieu khoa thi jsonb_typeof
    -- nhin thay '[]' va cho qua, con nhanh THEN lai tra ve NULL. Ban dien tap bat
    -- duoc dung loi nay o cot evidence_sources ben duoi (23502).
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(coalesce(p_payload->'h196a', '[]'::jsonb)) = 'array'
        THEN coalesce(p_payload->'h196a', '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) item
    ORDER BY item->>'stableKey', (item->>'healthStatus' = 'ONLINE') DESC
  LOOP
    v_stable_key := nullif(v_item->>'stableKey', '');
    v_health := coalesce(nullif(v_item->>'healthStatus', ''), 'UNKNOWN');

    CONTINUE WHEN v_stable_key IS NULL
      OR v_stable_key !~ '^mac:[0-9a-f][048c](:[0-9a-f]{2}){5}$'
      OR v_health NOT IN ('ONLINE', 'STALE', 'UNKNOWN');

    v_mac := substring(v_stable_key from 5)::macaddr;
    v_display_name := left(
      btrim(coalesce(nullif(v_item->>'displayName', ''), 'H196A ' || substring(v_stable_key from 14))),
      160
    );
    CONTINUE WHEN char_length(v_display_name) < 1;
    v_thay_khung := v_health = 'ONLINE';

    SELECT device.id INTO v_device_id
    FROM public.network_devices device
    WHERE device.organization_id = p_router.organization_id
      AND device.building_id = p_router.building_id
      AND device.device_kind = 'ZTE_H196A'
      AND device.external_key = v_stable_key
    FOR UPDATE;

    IF v_device_id IS NULL THEN
      INSERT INTO public.network_devices (
        organization_id, building_id, device_kind, external_key, display_name,
        vendor, parent_device_id, lifecycle_status, write_capability,
        is_active, credential_ref, inventory_metadata
      ) VALUES (
        p_router.organization_id, p_router.building_id, 'ZTE_H196A', v_stable_key,
        v_display_name, 'ZTE', p_router.id, 'ONLINE', false,
        true, NULL, jsonb_build_object('discovery', 'mikrotik-dhcp-lease')
      )
      RETURNING id INTO v_device_id;
    ELSE
      -- Tên đọc lại MỖI lượt poll, không phải chỉ ghi lúc ghi danh: ba trong năm
      -- con còn chờ tên thật, và đổi tên không được đòi hỏi migration hay deploy.
      UPDATE public.network_devices device
      SET display_name = v_display_name,
          parent_device_id = p_router.id,
          is_active = true,
          updated_at = v_now
      WHERE device.id = v_device_id;
    END IF;

    INSERT INTO app_private.network_h196a_profiles AS profile (
      device_id, organization_id, building_id, gateway_device_id, stable_key,
      mac_address, observed_ip, observed_ip_at, hostname, bridge_port, arp_status,
      bridge_ageing_seconds, observed_health, observed_health_reason,
      consecutive_absent_polls, evidence_sources, first_seen_at, last_seen_at,
      last_frame_at
    ) VALUES (
      v_device_id, p_router.organization_id, p_router.building_id, p_router.id,
      v_stable_key, v_mac,
      nullif(v_item->>'observedIp', '')::inet,
      CASE WHEN nullif(v_item->>'observedIp', '') IS NULL THEN NULL ELSE v_observed_at END,
      nullif(v_item->>'hostname', ''),
      nullif(v_item->>'bridgePort', ''),
      nullif(v_item->>'arpStatus', ''),
      nullif(v_item->>'bridgeAgeingSeconds', '')::integer,
      v_health,
      left(coalesce(nullif(v_item->>'healthReason', ''), 'UNSPECIFIED'), 120),
      CASE WHEN v_thay_khung THEN 0 ELSE 1 END,
      CASE
        WHEN jsonb_typeof(coalesce(v_item->'evidenceSources', '[]'::jsonb)) = 'array'
        THEN coalesce(v_item->'evidenceSources', '[]'::jsonb) ELSE '[]'::jsonb
      END,
      v_observed_at, v_observed_at,
      CASE WHEN v_thay_khung THEN v_observed_at ELSE NULL END
    )
    ON CONFLICT (device_id) DO UPDATE SET
      observed_ip = coalesce(EXCLUDED.observed_ip, profile.observed_ip),
      observed_ip_at = coalesce(EXCLUDED.observed_ip_at, profile.observed_ip_at),
      hostname = EXCLUDED.hostname,
      bridge_port = EXCLUDED.bridge_port,
      arp_status = EXCLUDED.arp_status,
      bridge_ageing_seconds = EXCLUDED.bridge_ageing_seconds,
      observed_health = EXCLUDED.observed_health,
      observed_health_reason = EXCLUDED.observed_health_reason,
      -- Một lượt KHÔNG ĐỌC ĐƯỢC bảng (UNKNOWN) không được tính là một lượt vắng
      -- mặt. Nếu tính, một lệnh bị router từ chối sẽ dựng nên một sự cố không hề
      -- xảy ra — đúng loại số 0 bịa đặt mà phần còn lại của worker né suốt.
      consecutive_absent_polls = CASE
        WHEN EXCLUDED.observed_health = 'ONLINE' THEN 0
        WHEN EXCLUDED.observed_health = 'UNKNOWN' THEN profile.consecutive_absent_polls
        ELSE least(profile.consecutive_absent_polls + 1, 1000)
      END,
      evidence_sources = EXCLUDED.evidence_sources,
      last_seen_at = greatest(profile.last_seen_at, EXCLUDED.last_seen_at),
      last_frame_at = coalesce(EXCLUDED.last_frame_at, profile.last_frame_at),
      updated_at = v_now
    WHERE EXCLUDED.last_seen_at >= profile.last_seen_at;

    v_seen := v_seen || v_stable_key;
    v_mapping := v_mapping || jsonb_build_object('stableKey', v_stable_key, 'id', v_device_id);
  END LOOP;

  -- Bằng chứng bị cách ly. Đếm số lần thấy để người vận hành phân biệt được một
  -- lần nhiễu với một thiết bị thật đang bị chặn cửa suốt.
  INSERT INTO app_private.network_h196a_quarantine (
    organization_id, building_id, gateway_device_id, code, fingerprint
  )
  SELECT DISTINCT
    p_router.organization_id, p_router.building_id, p_router.id,
    item->>'code', item->>'fingerprint'
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(coalesce(p_payload->'h196aQuarantine', '[]'::jsonb)) = 'array'
      THEN coalesce(p_payload->'h196aQuarantine', '[]'::jsonb) ELSE '[]'::jsonb
    END
  ) item
  WHERE item->>'code' = 'H196A_STABLE_IDENTITY_INVALID'
    AND item->>'fingerprint' ~ '^[a-f0-9]{64}$'
  ON CONFLICT (gateway_device_id, fingerprint) DO UPDATE SET
    sighting_count = least(app_private.network_h196a_quarantine.sighting_count + 1, 1000000),
    last_seen_at = clock_timestamp();

  RETURN v_mapping;
END;
$$;

REVOKE ALL ON FUNCTION app_private.network_center_h196a_inventory_v1(public.network_devices, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. Nối vào lớp bọc inventory v2.
--
-- CHỈ thêm một bước ở cuối. Mọi dòng phía trên giữ nguyên byte-for-byte so với
-- bản đang chạy: đường Aruba đang phục vụ 10 con IAP ở 102LVT và không có lý do
-- nào để nó chịu rủi ro vì việc này. Chữ ký không đổi nên CREATE OR REPLACE giữ
-- nguyên quyền EXECUTE hiện có.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_center_worker_inventory_v2(
  p_credential_digest text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_router public.network_devices%ROWTYPE;
  v_result jsonb;
  v_mapping jsonb;
  v_h196a jsonb;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid inventory payload' USING ERRCODE = '22023';
  END IF;
  SELECT router.* INTO v_router
  FROM public.network_devices router
  WHERE router.id = nullif(p_payload->>'routerDeviceId', '')::uuid
    AND router.device_kind = 'MIKROTIK'
    AND router.is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory router not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_router.organization_id, v_router.building_id,
    v_router.id, 'INVENTORY'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to inventory target'
      USING ERRCODE = '42501';
  END IF;

  v_result := app_private.network_center_worker_inventory_legacy_impl_v1(
    v_worker_key, p_payload
  );
  v_mapping := app_private.network_center_managed_interface_mapping_v1(
    v_router.id
  );
  -- Keep Task 9's Aruba/quarantine fields byte-for-byte and replace only the
  -- interface authorization mapping with Task 10's private authoritative data.
  v_result := jsonb_set(v_result, '{interfaces}', v_mapping, true);
  v_result := jsonb_set(
    v_result, '{interfaceCount}', to_jsonb(jsonb_array_length(v_mapping)), true
  );

  -- Downstream không nói LLDP. Chạy sau lớp Aruba, dùng chung khoá router và
  -- chung kiểm quyền ở trên; một payload không có `h196a` trả về mảng rỗng nên
  -- worker bản cũ vẫn chạy y như trước.
  v_h196a := app_private.network_center_h196a_inventory_v1(v_router, p_payload);
  v_result := jsonb_set(v_result, '{h196a}', v_h196a, true);
  v_result := jsonb_set(
    v_result, '{h196aCount}', to_jsonb(jsonb_array_length(v_h196a)), true
  );
  RETURN v_result;
END;
$$;

-- --------------------------------------------------------------------------
-- 5. Đọc cho trình duyệt.
--
-- Soi gương `network_center_list_aruba_v1`, kể cả con trỏ phân trang, để hai
-- danh sách hành xử giống nhau trên cùng một màn hình.
--
-- Chỗ khác duy nhất là cột trạng thái, và đó chính là mục đích: Aruba trả
-- `reachable` do worker gán cứng `true`, còn ở đây OFFLINE được SUY RA từ số
-- lượt vắng mặt liên tiếp. Ba lượt là ngưỡng — một lượt im lặng không phải cái
-- chết, và chu kỳ già hoá của bridge (mặc định 5 phút) nghĩa là ba lượt đã là
-- khoảng mười lăm phút không một khung tin nào.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_center_list_h196a_v1(
  p_building_id uuid,
  p_after_sort_order integer DEFAULT NULL::integer,
  p_after_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $$
DECLARE
  v_scope record;
  v_result jsonb;
BEGIN
  IF p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 250
     OR ((p_after_sort_order IS NULL) <> (p_after_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid H196A cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope
  FROM app_private.network_center_require_view_v1(p_building_id);

  WITH page AS (
    SELECT
      device.id, device.sort_order, device.display_name, device.external_key,
      device.lifecycle_status,
      profile.observed_health, profile.observed_health_reason,
      profile.consecutive_absent_polls, profile.bridge_port, profile.arp_status,
      profile.bridge_ageing_seconds, profile.last_seen_at, profile.last_frame_at,
      profile.evidence_sources,
      host(profile.observed_ip) AS observed_ip
    FROM public.network_devices device
    LEFT JOIN app_private.network_h196a_profiles profile
      ON profile.device_id = device.id
    WHERE device.organization_id = v_scope.organization_id
      AND device.building_id = p_building_id
      AND device.device_kind = 'ZTE_H196A'
      AND device.is_active
      AND (
        p_after_id IS NULL
        OR ROW(device.sort_order, device.id) > ROW(p_after_sort_order, p_after_id)
      )
    ORDER BY device.sort_order, device.id
    LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY sort_order, id LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id,
        'name', item.display_name,
        'externalKey', item.external_key,
        'lifecycleStatus', item.lifecycle_status,
        'address', item.observed_ip,
        'bridgePort', item.bridge_port,
        'arpStatus', item.arp_status,
        'bridgeAgeingSeconds', item.bridge_ageing_seconds,
        'lastSeenAt', item.last_seen_at,
        'lastFrameAt', item.last_frame_at,
        'evidenceSources', item.evidence_sources,
        -- Chưa có hồ sơ nghĩa là chưa lượt poll nào chạm tới nó. Đó là UNKNOWN,
        -- không phải OFFLINE: chưa đo không phải là đã chết.
        'healthStatus', CASE
          WHEN item.observed_health IS NULL THEN 'UNKNOWN'
          WHEN item.observed_health = 'UNKNOWN' THEN 'UNKNOWN'
          WHEN item.observed_health = 'ONLINE' THEN 'ONLINE'
          WHEN item.consecutive_absent_polls >= 3 THEN 'OFFLINE'
          ELSE 'STALE'
        END,
        'healthReason', coalesce(item.observed_health_reason, 'NEVER_OBSERVED'),
        'absentPolls', coalesce(item.consecutive_absent_polls, 0)
      ) ORDER BY item.sort_order, item.id)
      FROM items item
    ), '[]'::jsonb),
    'nextCursor', (
      SELECT CASE
        WHEN (SELECT count(*) FROM page) > p_limit
        THEN jsonb_build_object('sortOrder', last_item.sort_order, 'id', last_item.id)
        ELSE NULL
      END
      FROM (SELECT sort_order, id FROM items ORDER BY sort_order DESC, id DESC LIMIT 1) last_item
    ),
    'total', (
      SELECT count(*)
      FROM public.network_devices device
      WHERE device.organization_id = v_scope.organization_id
        AND device.building_id = p_building_id
        AND device.device_kind = 'ZTE_H196A'
        AND device.is_active
    )
  ) INTO v_result;

  RETURN coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'nextCursor', NULL, 'total', 0));
END;
$$;

REVOKE ALL ON FUNCTION public.network_center_list_h196a_v1(uuid, integer, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_list_h196a_v1(uuid, integer, uuid, integer)
  TO authenticated;

-- --------------------------------------------------------------------------
-- 6. Khẳng định ngay trong cùng transaction những điều bước sau phụ thuộc vào,
--    để một giả định hỏng ngã ở đây thay vì hiện ra sau đó dưới dạng một lỗi
--    khó truy trên production.
-- --------------------------------------------------------------------------
DO $kiem_tra$
DECLARE
  v_kind text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_kind
  FROM pg_constraint WHERE conname = 'network_devices_kind_check';
  IF v_kind IS NULL OR v_kind NOT LIKE '%ZTE_H196A%' THEN
    RAISE EXCEPTION 'network_devices_kind_check chua nhan ZTE_H196A: %', v_kind
      USING ERRCODE = 'P0001';
  END IF;

  IF to_regclass('app_private.network_h196a_profiles') IS NULL
     OR to_regclass('app_private.network_h196a_quarantine') IS NULL THEN
    RAISE EXCEPTION 'Thieu bang ho so hoac bang cach ly H196A' USING ERRCODE = 'P0001';
  END IF;

  -- Index mot-MikroTik-mot-toa la thu giu cho so do khong bao gio co hai goc.
  -- Neu buoc noi rong kind lam roi no thi phai biet NGAY.
  IF to_regclass('public.network_devices_one_active_mikrotik_per_building') IS NULL THEN
    RAISE EXCEPTION 'Index mot-MikroTik-mot-toa da bien mat' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'network_devices_guard_h196a_parent' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Trigger canh cha H196A chua duoc gan' USING ERRCODE = 'P0001';
  END IF;
END
$kiem_tra$;
