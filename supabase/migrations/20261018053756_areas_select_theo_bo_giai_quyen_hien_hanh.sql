-- Khu vực: policy đọc theo bộ giải quyền hiện hành, bỏ bảng phân công cũ staff_assignments
--
-- Lỗ (xác minh trên source 18/10/2026): policy areas_select_rbac (bản sống
-- 20260710140000_rls_initplan_wrap_remaining.sql:28-32, khớp baseline 06/08) cho đọc khu theo
-- public.staff_assignments. Bảng đó không còn là nguồn quyền từ cutover 25/07/2026
-- (20260725230000_cutover_cut_legacy_sync.sql tắt trigger đồng bộ; comment bảng: "HỆ CŨ").
-- Hệ quả:
--   · Nhân viên được cấp quyền qua role_bindings sau 25/07 (không có dòng staff_assignments) đọc
--     area_buildings được (policy theo accessible_building_ids) nhưng khu thì không, nên embed
--     area_links:area_buildings(area_id, area:areas(...)) của useBuildings trả area = null.
--   · Dòng staff_assignments cũ còn sót của người vẫn là thành viên nhưng đã bị thu hẹp quyền vẫn
--     mở khu; nhánh phân công toàn tổ chức cũ (building_id IS NULL AND area_id IS NULL) mở MỌI khu
--     của công ty. (Ranh giới công ty thì đã có policy RESTRICTIVE areas_org_boundary từ
--     20260808010000, nên không lọt xuyên công ty.)
--
-- Sửa (chỉ USING của areas_select_rbac; policy ghi, areas_org_boundary và hai policy RESTRICTIVE
-- ẩn demo/sandbox giữ nguyên). Khu hiện khi:
--   (a) super admin (is_admin() hiện cũng chỉ là is_super_admin());
--   (b) khu chứa ít nhất một toà trong accessible_building_ids() (buildings.view qua
--       buildings_for_v3/authorized_scope_v3), nối qua area_buildings — đúng tập toà mà policy
--       area_buildings_select_rbac cho đọc, nên embed không còn null. Lọc toà phải TƯỜNG MINH:
--       area_buildings_write_rbac (FOR ALL, vẫn theo staff_assignments) còn mở SELECT
--       area_buildings cho phân công cũ, không dựa được vào RLS của area_buildings;
--   (c) người gọi có một khoá khu (areas.view/create/edit/delete — đều chỉ có phạm vi
--       ORGANIZATION) TOÀN CÔNG TY ở chính công ty của khu, qua authorized_scope_v3 — để màn Quản
--       lý khu vẫn thấy khu chưa gắn toà, và người tạo/sửa khu đọc lại được dòng vừa ghi
--       (useAreas dùng insert().select()).
-- Dạng tập (IN (SELECT …)), không gọi hàm theo từng dòng.
--
-- Chạy lại được: ALTER POLICY; chốt đầu nhận qual cũ (còn staff_assignments) hoặc qual mới.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $chot$
DECLARE v_pol record;
BEGIN
  SELECT * INTO v_pol FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'areas' AND policyname = 'areas_select_rbac';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chot: thieu policy areas_select_rbac';
  END IF;
  IF v_pol.permissive <> 'PERMISSIVE' OR v_pol.cmd <> 'SELECT'
     OR (position('staff_assignments' in v_pol.qual) = 0
         AND position('accessible_building_ids' in v_pol.qual) = 0) THEN
    RAISE EXCEPTION 'chot: areas_select_rbac khong con la ban 20260710140000 hoac ban va nay (%, %, %)',
      v_pol.permissive, v_pol.cmd, v_pol.qual;
  END IF;
END
$chot$;

ALTER POLICY areas_select_rbac ON public.areas
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.is_admin())
    OR id IN (
      SELECT ab.area_id
        FROM public.area_buildings ab
       WHERE ab.building_id IN (SELECT public.accessible_building_ids())
    )
    OR organization_id IN (
      SELECT o.org
        FROM unnest(public.my_org_ids()) AS o(org)
        CROSS JOIN unnest(ARRAY['areas.view', 'areas.create', 'areas.edit', 'areas.delete']) AS k(permission_key)
        CROSS JOIN LATERAL app_private.authorized_scope_v3(k.permission_key, o.org) s
       WHERE s.org_wide
    )
  );

DO $nghiem_thu$
DECLARE v_pol record;
BEGIN
  SELECT * INTO v_pol FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'areas' AND policyname = 'areas_select_rbac';
  IF v_pol.permissive <> 'PERMISSIVE' OR v_pol.cmd <> 'SELECT' OR v_pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'nghiem_thu: areas_select_rbac sai hinh (%, %)', v_pol.permissive, v_pol.cmd;
  END IF;
  IF position('staff_assignments' in v_pol.qual) <> 0
     OR position('accessible_building_ids()' in v_pol.qual) = 0
     OR position('area_buildings' in v_pol.qual) = 0
     OR position('ab.building_id IN' in v_pol.qual) = 0
     OR position('authorized_scope_v3(k.permission_key, o.org)' in v_pol.qual) = 0
     OR position('''areas.view''' in v_pol.qual) = 0
     OR position('''areas.create''' in v_pol.qual) = 0
     OR position('my_org_ids()' in v_pol.qual) = 0
     OR position('org_wide' in v_pol.qual) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: areas_select_rbac chua theo bo giai quyen hien hanh: %', v_pol.qual;
  END IF;
  -- Ba policy RESTRICTIVE vẫn còn (ranh giới công ty, ẩn demo, ẩn sandbox).
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'areas' AND permissive = 'RESTRICTIVE'
         AND policyname IN ('areas_org_boundary', 'areas_hide_demo_admin', 'areas_hide_sandbox_admin')) <> 3 THEN
    RAISE EXCEPTION 'nghiem_thu: thieu policy RESTRICTIVE ranh gioi/an demo/sandbox tren areas';
  END IF;
END
$nghiem_thu$;

COMMIT;
NOTIFY pgrst, 'reload schema';
