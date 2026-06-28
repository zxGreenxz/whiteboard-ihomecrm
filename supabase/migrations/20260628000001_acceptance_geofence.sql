-- =============================================
-- Migration: Geo-fence nghiệm thu công việc
-- Created: 2026-06-28
-- Description:
--   1) Toạ độ GPS cho buildings (mốc so khoảng cách khi hoàn thành job).
--   2) Cột audit GPS trên jobs khi hoàn thành (luôn cho xong, chỉ ghi cảnh báo).
--   3) RPC get_acceptance_geofence_config() để staff đọc setting bật/tắt +
--      bán kính của OWNER (settings là per-user, RLS chỉ cho đọc của mình).
-- =============================================

-- 1. TOẠ ĐỘ TÒA NHÀ
-- =============================================
ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS latitude  double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

COMMENT ON COLUMN public.buildings.latitude  IS 'Vĩ độ tòa nhà — mốc geo-fence nghiệm thu';
COMMENT ON COLUMN public.buildings.longitude IS 'Kinh độ tòa nhà — mốc geo-fence nghiệm thu';

-- 2. AUDIT GPS KHI HOÀN THÀNH JOB
-- =============================================
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS completion_lat        double precision,
  ADD COLUMN IF NOT EXISTS completion_lng        double precision,
  ADD COLUMN IF NOT EXISTS completion_distance_m double precision,
  ADD COLUMN IF NOT EXISTS completion_geofence_status text;

COMMENT ON COLUMN public.jobs.completion_geofence_status IS
  'Trạng thái geo-fence lúc hoàn thành: ok | out_of_range | gps_denied | no_building_coords | disabled';

-- 3. RPC ĐỌC CẤU HÌNH GEO-FENCE CỦA OWNER
-- =============================================
CREATE OR REPLACE FUNCTION public.get_acceptance_geofence_config()
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $BODY$
DECLARE
  v_caller UUID := auth.uid();
  v_owner  UUID;
  v_value  JSONB;
  v_enabled BOOLEAN := TRUE;
  v_radius  INTEGER := 70;
BEGIN
  IF v_caller IS NULL THEN
    RETURN json_build_object('enabled', true, 'radius_m', 70);
  END IF;

  -- Resolve owner: super-admin/owner = chính mình; staff = chủ workspace.
  IF EXISTS (SELECT 1 FROM super_admins WHERE user_id = v_caller) THEN
    v_owner := v_caller;
  ELSE
    SELECT sa.user_id INTO v_owner
    FROM staff_assignments sa
    WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
    LIMIT 1;
    IF v_owner IS NULL THEN
      v_owner := v_caller;
    END IF;
  END IF;

  SELECT s.value INTO v_value
  FROM settings s
  WHERE s.user_id = v_owner AND s.key = 'acceptance_geofence'
  LIMIT 1;

  IF v_value IS NOT NULL THEN
    IF jsonb_typeof(v_value -> 'enabled') = 'boolean' THEN
      v_enabled := (v_value ->> 'enabled')::boolean;
    END IF;
    IF (v_value ->> 'radius_m') ~ '^\d+$' THEN
      v_radius := (v_value ->> 'radius_m')::integer;
    END IF;
  END IF;

  RETURN json_build_object('enabled', v_enabled, 'radius_m', v_radius);
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.get_acceptance_geofence_config() TO authenticated;

COMMENT ON FUNCTION public.get_acceptance_geofence_config() IS
  'Trả {enabled, radius_m} của cấu hình geo-fence nghiệm thu (đọc settings của owner). SECURITY DEFINER để staff dùng chung. Mặc định enabled=true, radius_m=70.';
