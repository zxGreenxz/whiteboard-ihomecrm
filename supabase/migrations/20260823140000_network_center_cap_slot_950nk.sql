-- =============================================================================
-- Network Center: cấp slot MikroTik cho toà nhà vật lý sinh SAU đợt seed 13/08.
--
-- VÌ SAO CẦN
--   Toà `950NK` (org iHome CRM thật) sắp được lắp một MikroTik hEX refresh
--   E50UG thật và phải nhìn thấy được trên trang Network Center. Nhưng nó
--   không có dòng nào trong `network_devices`, nên không có gì để gắn
--   connection vào — `provision-connection` cần một deviceId có thật.
--
-- ĐÂY LÀ LỖI CŨ TÁI DIỄN, KHÔNG PHẢI CA MỚI
--   20260813020000 đã sửa đúng lớp lỗi này và tự mô tả nó là "seed một lần gặp
--   dữ liệu sinh sau": seed gốc 20260729010000 cấp `slot:primary` cho mọi toà
--   vật lý TỒN TẠI lúc đó, nên toà tạo sau seed thì vĩnh viễn không có slot.
--   20260813020000 viết theo điều kiện để tự lành — nhưng nó cũng chỉ chạy một
--   lần, ngày 13/08. Toà 950NK sinh sau mốc đó nên lại rơi vào đúng cái bẫy.
--
--   Câu lệnh dưới đây CỐ Ý giữ nguyên điều kiện của 20260813020000 thay vì
--   nhắm vào id của 950NK. Chép id vào đây thì toà thứ hai mươi tạo tuần sau
--   lại hỏng y hệt, và người gặp nó sẽ mất đúng chừng này thời gian để truy
--   lại. Viết theo điều kiện khiến mỗi lần chạy là một lần quét dọn.
--
-- ĐO TRÊN PRODUCTION 23/08/2026 TRƯỚC KHI VIẾT (không phải suy đoán)
--   Đúng 3 toà vật lý đang thiếu slot, và đây là toàn bộ những gì sẽ sinh ra:
--     iHome CRM        | 950NK        ← lý do của migration này
--     iHome CRM (Demo) | DEMO Toà C   ← cùng lớp lỗi, sinh sau 13/08
--     iHome CRM (Demo) | DEMO Toà D   ← cùng lớp lỗi, sinh sau 13/08
--   17/17 toà còn lại của org thật đã có slot → câu lệnh KHÔNG chạm tới chúng.
--   `network_site_settings` của 950NK cũng đang trống (0 dòng).
--
-- AN TOÀN
--   Chỉ INSERT hàng tồn kho: không endpoint, không credential, không telemetry.
--   `UNPROVISIONED` nghĩa là chưa có đường tác động nào tới router thật —
--   network_center_execute_action_v1 chỉ nhận thiết bị ở ONLINE/OFFLINE, mà
--   tới được hai trạng thái đó phải có telemetry thật chạm vào (20260729148000).
--   Cấp slot KHÔNG mở thêm quyền điều khiển; nó dựng cái hộc trống để
--   `provision-connection` có chỗ gắn vào.
--
--   `NOT EXISTS` khớp đúng điều kiện của index bán phần
--   `network_devices_one_active_mikrotik_per_building`
--   (organization_id, building_id) WHERE device_kind='MIKROTIK' AND is_active,
--   nên chạy lại nhiều lần cũng không sinh trùng và không ném lỗi.
-- =============================================================================

INSERT INTO public.network_devices (
  organization_id,
  building_id,
  device_kind,
  external_key,
  display_name,
  vendor,
  lifecycle_status,
  write_capability,
  is_active
)
SELECT
  b.organization_id,
  b.id,
  'MIKROTIK',
  'slot:primary',
  'MikroTik — ' || COALESCE(NULLIF(btrim(b.name), ''), b.id::text),
  'MikroTik',
  'UNPROVISIONED',
  true,
  true
FROM public.buildings b
WHERE b.organization_id IS NOT NULL
  AND b.is_virtual = false
  AND b.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.network_devices d
     WHERE d.organization_id = b.organization_id
       AND d.building_id = b.id
       AND d.device_kind = 'MIKROTIK'
       AND d.is_active
  );

-- Cùng lý do như seed gốc: site settings đi kèm thiết bị, thiếu nó thì trang
-- Network Center của toà đó không dựng được ngữ cảnh.
INSERT INTO public.network_site_settings (organization_id, building_id)
SELECT b.organization_id, b.id
FROM public.buildings b
WHERE b.organization_id IS NOT NULL
  AND b.is_virtual = false
  AND b.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Khẳng định ngay trong cùng transaction cái điều kiện mà bước kế tiếp cần:
-- toà 950NK phải có đúng một slot MikroTik đang hoạt động, và phải có site
-- settings. Không đạt thì ngã ở đây — để câu trả lời "vì sao provision-connection
-- không gắn được" nằm cạnh nguyên nhân, thay vì hiện ra sau đó dưới dạng một
-- lỗi khoá ngoại khó truy.
DO $kiem_tra$
DECLARE
  v_slot int;
  v_settings int;
BEGIN
  SELECT count(*) INTO v_slot
    FROM public.network_devices d
    JOIN public.buildings b ON b.id = d.building_id
   WHERE b.name = '950NK'
     AND d.device_kind = 'MIKROTIK'
     AND d.is_active;

  SELECT count(*) INTO v_settings
    FROM public.network_site_settings s
    JOIN public.buildings b ON b.id = s.building_id
   WHERE b.name = '950NK';

  IF v_slot < 1 THEN
    RAISE EXCEPTION 'Toa 950NK van khong co slot MikroTik hoat dong (dem duoc %) — kiem lai is_virtual/deleted_at/organization_id cua toa nay truoc khi coi la xong.', v_slot
      USING ERRCODE = 'P0001';
  END IF;

  IF v_settings < 1 THEN
    RAISE EXCEPTION 'Toa 950NK khong co network_site_settings (dem duoc %) — trang Network Center se khong dung duoc ngu canh cho toa nay.', v_settings
      USING ERRCODE = 'P0001';
  END IF;
END
$kiem_tra$;
