-- =============================================================
-- Khu vực N-N: bảng area_buildings — 1 toà thuộc NHIỀU khu
--
-- Bối cảnh: trước đây quan hệ lưu bằng cột đơn buildings.area_id
-- → mỗi toà chỉ thuộc tối đa 1 khu. User muốn khu vực = nhóm toà
-- tuỳ biến (vd "Nhà cũ"={A,B,C}, "Lầu cao"={A,D,E}) dùng cho bộ lọc
-- và phân quyền theo nhóm. Chuỗi migration:
--   1) 20260611100000 (file này): tạo area_buildings + backfill
--   2) 20260611110000: staff_assignments.area_id (scope nhóm LIVE)
--      + cập nhật toàn bộ helper/policy
--   3) 20260611120000: viết lại các object phụ thuộc b.area_id
--   4) 20260611130000: drop buildings.area_id
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.area_buildings (
  area_id     UUID NOT NULL REFERENCES public.areas(id)     ON DELETE CASCADE,
  building_id UUID NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id)       ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (area_id, building_id)
);

COMMENT ON TABLE public.area_buildings IS
'Quan hệ N-N khu vực ↔ toà nhà. Khu vực = nhãn nhóm toà (bộ lọc + gán phạm vi nhân viên theo nhóm), KHÔNG phải ranh giới dữ liệu.';

-- PK phục vụ lookup theo area_id; index này phục vụ chiều ngược
-- (building → areas) — hot path trong can_access_building/areas_select_rbac.
CREATE INDEX IF NOT EXISTS idx_area_buildings_building_id ON public.area_buildings(building_id);
CREATE INDEX IF NOT EXISTS idx_area_buildings_user_id     ON public.area_buildings(user_id);

ALTER TABLE public.area_buildings ENABLE ROW LEVEL SECURITY;

-- SELECT: ai thấy toà thì thấy membership của toà đó.
-- (can_access_building là SECURITY DEFINER nên không đệ quy RLS.)
DROP POLICY IF EXISTS area_buildings_select_rbac ON public.area_buildings;
CREATE POLICY area_buildings_select_rbac ON public.area_buildings
  FOR SELECT
  USING (public.can_access_building(building_id));

-- WRITE: mirror areas_*_rbac — super admin hoặc staff full-scope có areas.edit.
-- (Bản v1: full-scope = building_id IS NULL; file 20260611110000 siết thêm
--  AND area_id IS NULL sau khi cột tồn tại.)
DROP POLICY IF EXISTS area_buildings_write_rbac ON public.area_buildings;
CREATE POLICY area_buildings_write_rbac ON public.area_buildings
  FOR ALL
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  );

-- auto-fill user_id (owner) khi insert — cùng pattern areas/buildings
DROP TRIGGER IF EXISTS area_buildings_set_user_id_audit ON public.area_buildings;
CREATE TRIGGER area_buildings_set_user_id_audit
  BEFORE INSERT ON public.area_buildings
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.area_buildings TO authenticated, service_role;
REVOKE ALL ON public.area_buildings FROM anon;

-- Backfill từ mô hình cũ buildings.area_id (bỏ qua ref dangling)
INSERT INTO public.area_buildings (area_id, building_id, user_id)
SELECT b.area_id, b.id, b.user_id
FROM public.buildings b
JOIN public.areas a ON a.id = b.area_id
WHERE b.area_id IS NOT NULL
ON CONFLICT (area_id, building_id) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
