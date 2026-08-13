-- =============================================================================
-- Network Center: biến backfill "cấp lại slot MikroTik" thành hàm tái-lập-được.
--
-- VÌ SAO CẦN (nối tiếp 20260813020000_network_center_cap_lai_slot_mikrotik.sql)
--   Migration 20260813020000 là DML thuần: nó không thêm object catalog nào và
--   không sở hữu thân hàm nào, nên bộ audit rollout KHÔNG có cách phân biệt
--   "stage đã chạy" với "stage bị bỏ qua" — audit tuyên bố release complete
--   ngay cả khi stage đó chưa từng chạy. Bộ đo
--   scripts/__tests__/network-center-rollout-body-evidence.test.mjs từ chối cả
--   release vì đúng lỗ này (đỏ từ 14:41 ngày 13/08, bị che tới 18:11 vì workflow
--   dừng ở bước đỏ đứng trước).
--
--   File này đi đường forward-fix mà chính bộ đo chỉ định: một stage SAU tái
--   tạo hiệu ứng của stage trước bằng CREATE OR REPLACE FUNCTION mà release
--   này sở hữu thân hàm. Được hai điều cùng lúc:
--     1. Quan sát được: hàm là object catalog — audit phân biệt được đã-chạy/
--        chưa-chạy bằng to_regprocedure, và thân hàm được ghim làm bằng chứng.
--     2. Tái lập được: gọi lại hàm là no-op khi dữ liệu đã đủ (WHERE NOT
--        EXISTS / ON CONFLICT DO NOTHING), nên "chạy lại lần hai" an toàn —
--        đúng luật idempotent của lane migration.
--
--   Logic bên trong GIỮ NGUYÊN NGỮ NGHĨA 20260813020000: cấp một slot MikroTik
--   `slot:primary` + site settings cho mọi toà nhà vật lý còn thiếu, thuộc mọi
--   tổ chức. Đã đo 13/08: tổ chức thật 17/17 toà có sẵn slot nên không bị chạm;
--   chỉ DEMO (dựng lại 11/08, sau đợt seed 29/07) sinh dòng mới. Khối DO kiểm
--   tiền đề DEMO của file gốc KHÔNG lặp lại ở đây: hàm này phải an toàn trên
--   mọi database (kể cả cụm dùng-một-lần của CI), còn phép khẳng định one-shot
--   đã có file gốc giữ.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_private.network_center_cap_lai_slot_mikrotik_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
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

  INSERT INTO public.network_site_settings (organization_id, building_id)
  SELECT b.organization_id, b.id
  FROM public.buildings b
  WHERE b.organization_id IS NOT NULL
    AND b.is_virtual = false
    AND b.deleted_at IS NULL
  ON CONFLICT DO NOTHING;
END;
$fn$;

-- Hàm backfill nội bộ của lane migration — không vai API nào được gọi.
REVOKE ALL ON FUNCTION app_private.network_center_cap_lai_slot_mikrotik_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- Áp dụng ngay trong migration: lần đầu tạo dữ liệu còn thiếu, các lần replay
-- sau là no-op — chính phép chạy này chứng minh tính tái lập.
SELECT app_private.network_center_cap_lai_slot_mikrotik_v1();

-- Khối khẳng định dưới đây CHÉP NGUYÊN VĂN từ 20260813020000 — có chủ đích:
-- luật thay-thế của audit rollout (assertStagesObservable, lớp thứ tư) đòi TỪNG
-- câu lệnh của stage DML thuần xuất hiện nguyên văn trong source của stage sau
-- tự quan sát được thì stage đó mới được coi là đã-được-tái-tạo. Sửa chữ nào ở
-- đây là stage 20260813020000 quay lại trạng thái "unobservable" và audit từ
-- chối cả release. Chạy lại khối này cũng là tái khẳng định tiền đề của ma trận
-- cách ly ngay tại thời điểm apply stage này.
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
