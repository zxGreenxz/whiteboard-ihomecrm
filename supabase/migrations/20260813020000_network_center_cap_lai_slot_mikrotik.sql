-- =============================================================================
-- Network Center: cấp lại slot MikroTik cho toà nhà vật lý chưa có.
--
-- VÌ SAO CẦN
--   Ma trận cách ly tenant (scripts/test-cross-tenant.mjs) dừng ngay ở bước
--   tiền đề với `Network Center MikroTik slots were not provisioned by the
--   migration`. Nó cần đúng hai thiết bị MIKROTIK đang hoạt động trong tổ chức
--   DEMO, mỗi toà một cái, để dựng các ca thử "người của toà A không được chạm
--   router toà B". Không có thiết bị thì không dựng được ca nào — và một bộ đo
--   an ninh KHÔNG CHẠY thì tệ hơn một bộ đo đỏ, vì nó im lặng.
--
-- NGUỒN GỐC (đã truy, không phải suy đoán)
--   Seed gốc nằm ở 20260729010000_network_center_permissions_inventory.sql
--   (dòng 341-367): mỗi toà nhà vật lý được cấp một `slot:primary`. Migration
--   chạy MỘT LẦN ngày 29/07 nên nó chỉ với tới các toà nhà TỒN TẠI lúc đó.
--
--   Tổ chức DEMO thì bị xoá và dựng lại sau đó — 20260808080000 xoá hai tổ chức
--   test, 20260811040000 dựng lại công ty DEMO. Toà nhà DEMO hiện tại được sinh
--   ngày 11/08, tức SAU khi seed đã chạy xong, nên chúng chưa bao giờ được cấp
--   slot. Đây là lớp lỗi "seed một lần gặp dữ liệu sinh sau", không phải ai đó
--   xoá nhầm thiết bị.
--
--   Đo trên production 13/08/2026, đếm theo tổ chức:
--     iHome CRM (thật) : 17/17 toà vật lý đã có slot  → câu lệnh dưới KHÔNG
--                        chạm một dòng nào của tổ chức thật.
--     iHome CRM (Demo) : 0/2  toà vật lý có slot      → đúng hai dòng sẽ sinh.
--
-- VÌ SAO VIẾT LẠI THEO ĐIỀU KIỆN, KHÔNG CHÉP HAI DÒNG THEO ID
--   Chép id toà nhà DEMO vào đây thì lần dựng lại DEMO kế tiếp lại hỏng y hệt,
--   và người gặp nó sẽ mất đúng chừng này thời gian để truy lại. Viết theo điều
--   kiện "toà vật lý nào chưa có slot thì cấp" khiến migration tự lành cho mọi
--   lần dựng lại sau — kể cả khi tôi không còn ở đây để nhớ.
--
-- AN TOÀN
--   Chỉ INSERT hàng tồn kho: không endpoint, không credential, không telemetry —
--   đúng phạm vi mà seed gốc tự đặt cho mình (comment dòng 341). Trạng thái
--   `UNPROVISIONED` nghĩa là chưa có đường tác động nào tới router thật:
--   network_center_execute_action_v1 chỉ nhận thiết bị ở ONLINE/OFFLINE, mà
--   muốn tới hai trạng thái đó phải có telemetry thật chạm vào
--   (20260729148000). Nói cách khác, cấp slot KHÔNG mở thêm quyền điều khiển
--   nào; nó chỉ dựng lại cái hộc trống mà bộ đo cần để kiểm tra chốt cửa.
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

-- Khẳng định tiền đề mà bộ đo cách ly cần, ngay trong cùng transaction: tổ chức
-- DEMO phải có ít nhất hai toà vật lý, mỗi toà một router đang hoạt động. Nếu
-- không đạt thì ngã ở đây — để câu trả lời "vì sao ma trận không chạy" nằm cạnh
-- nguyên nhân, thay vì hiện ra dưới dạng một exception khó hiểu trong CI.
DO $kiem_tra$
DECLARE v_toa int;
BEGIN
  SELECT count(DISTINCT d.building_id) INTO v_toa
    FROM public.network_devices d
    JOIN public.organizations o ON o.id = d.organization_id
   WHERE o.name ILIKE '%demo%'
     AND d.device_kind = 'MIKROTIK'
     AND d.is_active;
  IF v_toa < 2 THEN
    RAISE EXCEPTION 'To chuc DEMO chi co % toa co router MikroTik hoat dong, ma tran cach ly can it nhat 2 — kiem lai buildings cua DEMO (is_virtual/deleted_at) truoc khi coi la xong.', v_toa
      USING ERRCODE = 'P0001';
  END IF;
END
$kiem_tra$;
