-- =============================================================================
-- Network Center: bien "cap slot cho toa 950NK" thanh stage tai-lap-duoc.
--
-- VI SAO CAN (noi tiep 20260823140000_network_center_cap_slot_950nk.sql)
--   File 20260823140000 la DML thuan (hai INSERT dieu-kien + mot khoi khang
--   dinh): no khong them object catalog nao va khong so huu than ham nao, nen
--   assertStagesObservable tu choi ca release voi "rollout stage 26 ...
--   is unobservable" (do that tren run CI 32874901646, ngay 25/08/2026 —
--   phat hien khi ho so migration bo do duoc commit not).
--
--   Day la DUNG lop loi cua 20260813020000, va cach chua chep nguyen khuon
--   20260814004500: mot stage SAU tai tao hieu ung cua stage truoc bang
--   CREATE OR REPLACE FUNCTION ma release nay so huu than ham. Duoc hai dieu:
--     1. Quan sat duoc: ham la object catalog — audit phan biet duoc da-chay/
--        chua-chay, va than ham duoc ghim lam bang chung.
--     2. Tai lap duoc: goi lai ham la no-op khi du lieu da du (NOT EXISTS /
--        ON CONFLICT DO NOTHING) — dung luat idempotent cua lane.
--
--   HAI INSERT va KHOI KHANG DINH duoi day CHEP NGUYEN VAN tu 20260823140000
--   — co chu dich: luat thay-the cua audit (assertStagesObservable, lop thu
--   tu) doi TUNG cau lenh cua stage DML thuan xuat hien nguyen van trong
--   source cua stage sau tu quan sat duoc. Sua chu nao la stage 20260823140000
--   quay lai "unobservable" va audit tu choi ca release.
--
-- AN TOAN
--   Nhu file goc: chi INSERT hang ton kho UNPROVISIONED, khong endpoint,
--   khong credential. Ham nam trong app_private va REVOKE het moi vai API.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_private.network_center_cap_slot_950nk_v1()
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

-- Cùng lý do như seed gốc: site settings đi kèm thiết bị, thiếu nó thì trang
-- Network Center của toà đó không dựng được ngữ cảnh.
INSERT INTO public.network_site_settings (organization_id, building_id)
SELECT b.organization_id, b.id
FROM public.buildings b
WHERE b.organization_id IS NOT NULL
  AND b.is_virtual = false
  AND b.deleted_at IS NULL
ON CONFLICT DO NOTHING;
END;
$fn$;

-- Ham backfill noi bo cua lane migration — khong vai API nao duoc goi.
REVOKE ALL ON FUNCTION app_private.network_center_cap_slot_950nk_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- Ap dung ngay trong migration: lan dau tao du lieu con thieu, cac lan replay
-- sau la no-op — chinh phep chay nay chung minh tinh tai lap.
SELECT app_private.network_center_cap_slot_950nk_v1();

-- Khoi khang dinh CHEP NGUYEN VAN tu 20260823140000 (xem ly do o dau file):
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
