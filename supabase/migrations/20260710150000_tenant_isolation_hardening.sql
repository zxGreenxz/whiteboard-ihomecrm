-- =============================================================
-- CÁCH LY TENANT — vá lỗ hổng xuyên-tenant (Phase 1b, 2026-07-10)
--
-- Bối cảnh: hệ thống đã có người ngoài dùng + định hướng SaaS đa-chủ-nhà →
-- cách ly tenant là ưu tiên #1. Audit vòng 2 phát hiện tầng RLS có nhiều đường
-- BYPASS XUYÊN-TENANT (phần lớn còn TIỀM ẨN vì dữ liệu hiện tại chỉ có 1
-- super_admin trùng với admin duy nhất, và 0 staff full-scope — nhưng sẽ KÍCH
-- HOẠT ngay khi một chủ nhà khác tạo role tên 'Admin'/__superadmin hoặc cấp 1
-- assignment full-scope):
--
--  (1) is_admin() KHÔNG tenant-aware. Nó true nếu caller giữ BẤT KỲ
--      staff_assignment có role tên 'Admin' hoặc permissions @>{"__superadmin":true},
--      KHÔNG kiểm sa.user_id (owner). 147 policy PERMISSIVE nhúng bare is_admin()
--      (82 policy *_admin_all cmd=ALL + 65 policy compose/misc) + 42 RPC + 4 helper
--      lõi (can_access_building/can_do_on_building/can_access_org_entity/
--      has_full_building_scope) → 1 "Admin" của chủ B đọc/ghi được TẤT CẢ tenant.
--      Vì is_admin() 0-arg không biết owner của DÒNG đích nên KHÔNG THỂ tenant-safe
--      tại chỗ. Bypass toàn cục HỢP LỆ duy nhất là super_admin → gom
--      is_admin()→is_super_admin(). Đây là NO-OP với dữ liệu hiện tại (chỉ NG TÂM
--      thoả is_admin, mà NG TÂM cũng là super_admin DUY NHẤT), nhưng khoá mọi
--      bypass admin-cấp-tenant xuyên hệ thống. Admin cấp-tenant (khi có) mô hình
--      hoá qua assignment full-scope DƯỚI owner, enforce theo dòng bởi can_*.
--
--  (2) can_access_building / can_do_on_building: nhánh full-scope
--      (building_id IS NULL AND area_id IS NULL) và nhánh is_admin KHÔNG join
--      buildings theo owner → 1 assignment full-scope (hoặc is_admin) cho phép
--      truy cập MỌI building của MỌI owner. Sửa: bind nhánh full-scope + nhánh
--      admin-cấp-tenant theo `buildings.user_id = staff_assignments.user_id`
--      (mẫu đúng đã có sẵn ở ie_all_buildings_scope). GIỮ NGUYÊN nhánh gán-tòa-
--      cụ-thể / gán-khu (KHÔNG join owner) vì (a) building_id/area tự định danh
--      tenant, (b) live data có assignment hợp lệ trỏ tòa của owner khác (NG TÂM
--      quản 1 tòa của Nathan) — thêm owner-join sẽ CẮT NHẦM quyền hợp lệ.
--
--  (3) has_full_building_scope()/has_perm_full_scope() 0/2-arg: trả boolean
--      "mù" (không tham số building) → khi true lộ MỌI dòng MỌI tenant. Sửa:
--      chuyển "mở rộng full-scope" vào accessible_building_ids()/
--      permitted_building_ids() theo owner (chỉ tòa CÙNG owner), rồi rút 2 helper
--      này về is_super_admin() (super thấy hết; full-scope-staff đi qua tập
--      building owner-bounded). No-op hôm nay (0 staff full-scope).
--
--  (4) LỖ HỔNG LIVE (không tiềm ẩn): can_access_org_entity() dùng MỘT MÌNH ở
--      nhánh building_id IS NULL của assets/asset_warehouses/auto_debt_config →
--      bất kỳ staff giữ quyền assets/warehouse/auto_debt DƯỚI BẤT KỲ owner đọc/
--      ghi được dòng cấp-tổ-chức (building-less) của MỌI owner. Sửa: AND thêm
--      `user_id = ANY(current_visible_owner_ids())` ở nhánh đó (cùng mô hình đã
--      dùng cho customers/tenants/suppliers…).
--
--  (5) DROP 82 policy *_admin_all (đã dư thừa sau khi is_admin→is_super_admin;
--      mọi bảng đã có *_super_admin_all — bổ sung cho 2 bảng còn thiếu trước).
--
-- Idempotent. Đối chứng: node scripts/test-cross-tenant.mjs (ma trận âm bản
-- owner/Admin/full-scope staff của tenant B).
-- =============================================================

BEGIN;

-- ── 1. is_admin() → is_super_admin() + helper admin-cấp-tenant ───────────────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  -- is_admin() cũ = "Admin ở BẤT KỲ tenant" → bypass xuyên-tenant. 0-arg nên
  -- không thể tenant-safe tại chỗ. Bypass toàn cục hợp lệ = super_admin.
  SELECT public.is_super_admin();
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_assignments sa
    JOIN public.roles r ON r.id = sa.role_id
    WHERE sa.staff_id = auth.uid()
      AND sa.user_id = _owner
      AND (r.name = 'Admin' OR r.permissions @> '{"__superadmin": true}'::jsonb)
  );
$$;

-- ── 2. can_access_building: owner-join cho nhánh full-scope + admin ──────────
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    public.is_super_admin()
    -- đặc quyền cấp-owner: KHÔNG áp cho tòa demo (ẩn demo khỏi admin thật)
    OR ( NOT (_building_id = ANY(public.demo_building_ids())) AND (
         -- admin CẤP TENANT: chỉ tòa của owner mình quản
         EXISTS (SELECT 1 FROM public.staff_assignments sa
                 JOIN public.roles r ON r.id = sa.role_id
                 JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
                 WHERE sa.staff_id = auth.uid()
                   AND (r.name = 'Admin' OR r.permissions @> '{"__superadmin": true}'::jsonb))
         -- full-scope: mọi tòa của CÙNG owner
      OR EXISTS (SELECT 1 FROM public.staff_assignments sa
                 JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
                 WHERE sa.staff_id = auth.uid()
                   AND sa.building_id IS NULL AND sa.area_id IS NULL)))
    -- gán tòa cụ thể / theo khu: building_id/area tự định danh tenant → KHÔNG
    -- join owner (giữ nguyên uỷ quyền chéo-owner hợp lệ đang có trong live data)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               WHERE sa.staff_id = auth.uid()
                 AND (sa.building_id = _building_id
                   OR (sa.area_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM public.area_buildings ab
                        WHERE ab.area_id = sa.area_id AND ab.building_id = _building_id))))
    -- quản lý phân bổ lợi nhuận (đã theo tòa)
    OR EXISTS (SELECT 1 FROM public.profit_manager_salary_buildings pmsb
               JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
               JOIN public.profit_managers pm ON pm.id = pms.manager_id
               WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL
                 AND pmsb.building_id = _building_id);
$$;

-- ── 3. can_do_on_building: owner-join cho nhánh full-scope + admin ───────────
CREATE OR REPLACE FUNCTION public.can_do_on_building(_table text, _action text, _building_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
  SELECT
    public.is_super_admin()
    -- admin cấp-tenant (owner-join): admin làm mọi thứ trong tenant mình
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               JOIN public.roles r ON r.id = sa.role_id
               JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
               WHERE sa.staff_id = auth.uid()
                 AND (r.name = 'Admin' OR r.permissions @> '{"__superadmin": true}'::jsonb))
    -- full-scope + quyền (owner-join): mọi tòa CÙNG owner
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
               WHERE sa.staff_id = auth.uid()
                 AND sa.building_id IS NULL AND sa.area_id IS NULL
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    -- gán tòa cụ thể + quyền (KHÔNG owner-join)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               WHERE sa.staff_id = auth.uid() AND sa.building_id = _building_id
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    -- gán theo khu + quyền (KHÔNG owner-join)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               JOIN public.area_buildings ab ON ab.area_id = sa.area_id
               WHERE sa.staff_id = auth.uid() AND sa.area_id IS NOT NULL AND ab.building_id = _building_id
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true);
$$;

-- ── 4. accessible_building_ids / permitted_building_ids: mở rộng full-scope
--       THEO OWNER (thay cho has_full_building_scope() mù) ──────────────────
CREATE OR REPLACE FUNCTION public.accessible_building_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT sa.building_id FROM public.staff_assignments sa
   WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
  UNION
  SELECT ab.building_id FROM public.staff_assignments sa2
    JOIN public.area_buildings ab ON ab.area_id = sa2.area_id
   WHERE sa2.staff_id = auth.uid() AND sa2.area_id IS NOT NULL
  UNION
  -- full-scope: mọi tòa của CÙNG owner (thay has_full_building_scope() mù)
  SELECT b.id FROM public.staff_assignments sa3
    JOIN public.buildings b ON b.user_id = sa3.user_id
   WHERE sa3.staff_id = auth.uid()
     AND sa3.building_id IS NULL AND sa3.area_id IS NULL
  UNION
  SELECT pmsb.building_id
    FROM public.profit_manager_salary_buildings pmsb
    JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
    JOIN public.profit_managers pm ON pm.id = pms.manager_id
   WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.permitted_building_ids(_table text, _action text)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
  SELECT sa.building_id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true
  UNION
  SELECT ab.building_id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  JOIN public.area_buildings ab ON ab.area_id = sa.area_id
  WHERE sa.staff_id = auth.uid() AND sa.area_id IS NOT NULL
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true
  UNION
  -- full-scope + quyền: mọi tòa của CÙNG owner
  SELECT b.id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  JOIN public.buildings b ON b.user_id = sa.user_id
  WHERE sa.staff_id = auth.uid()
    AND sa.building_id IS NULL AND sa.area_id IS NULL
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true;
$$;

-- ── 5. has_full_building_scope()/has_perm_full_scope(): rút về super-only ────
-- (full-scope owner-bounded đã chuyển vào accessible_/permitted_building_ids)
CREATE OR REPLACE FUNCTION public.has_full_building_scope()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.is_super_admin(); $$;

CREATE OR REPLACE FUNCTION public.has_perm_full_scope(_table text, _action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$ SELECT public.is_super_admin(); $$;

-- ── 6. LỖ HỔNG LIVE: khoá nhánh org-level (building_id IS NULL) của
--       assets / asset_warehouses / auto_debt_config theo owner ─────────────
ALTER POLICY assets_select_rbac ON public.assets USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_access_building(building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('assets', 'view'))
);
ALTER POLICY assets_insert_rbac ON public.assets WITH CHECK (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_do_on_building('assets', 'create', building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('assets', 'create'))
);
ALTER POLICY assets_update_rbac ON public.assets
  USING (
    (SELECT public.is_super_admin())
    OR (building_id IS NOT NULL AND public.can_do_on_building('assets', 'edit', building_id))
    OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
        AND public.can_access_org_entity('assets', 'edit'))
  )
  WITH CHECK (
    (SELECT public.is_super_admin())
    OR (building_id IS NOT NULL AND public.can_do_on_building('assets', 'edit', building_id))
    OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
        AND public.can_access_org_entity('assets', 'edit'))
  );
ALTER POLICY assets_delete_rbac ON public.assets USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_do_on_building('assets', 'delete', building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('assets', 'delete'))
);

ALTER POLICY asset_warehouses_select_rbac ON public.asset_warehouses USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_access_building(building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('warehouses', 'view'))
);
ALTER POLICY asset_warehouses_insert_rbac ON public.asset_warehouses WITH CHECK (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses', 'create', building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('warehouses', 'create'))
);
ALTER POLICY asset_warehouses_update_rbac ON public.asset_warehouses
  USING (
    (SELECT public.is_super_admin())
    OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses', 'edit', building_id))
    OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
        AND public.can_access_org_entity('warehouses', 'edit'))
  )
  WITH CHECK (
    (SELECT public.is_super_admin())
    OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses', 'edit', building_id))
    OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
        AND public.can_access_org_entity('warehouses', 'edit'))
  );
ALTER POLICY asset_warehouses_delete_rbac ON public.asset_warehouses USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses', 'delete', building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('warehouses', 'delete'))
);

ALTER POLICY auto_debt_config_select_rbac ON public.auto_debt_config USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_access_building(building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('auto_debt', 'view'))
);
ALTER POLICY auto_debt_config_insert_rbac ON public.auto_debt_config WITH CHECK (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt', 'create', building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('auto_debt', 'create'))
);
ALTER POLICY auto_debt_config_update_rbac ON public.auto_debt_config
  USING (
    (SELECT public.is_super_admin())
    OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt', 'edit', building_id))
    OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
        AND public.can_access_org_entity('auto_debt', 'edit'))
  )
  WITH CHECK (
    (SELECT public.is_super_admin())
    OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt', 'edit', building_id))
    OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
        AND public.can_access_org_entity('auto_debt', 'edit'))
  );
ALTER POLICY auto_debt_config_delete_rbac ON public.auto_debt_config USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt', 'delete', building_id))
  OR (building_id IS NULL AND user_id = ANY(public.current_visible_owner_ids())
      AND public.can_access_org_entity('auto_debt', 'delete'))
);

-- ── 7. Bổ sung *_super_admin_all cho 2 bảng thiếu, rồi DROP 82 *_admin_all ──
CREATE POLICY account_shared_users_super_admin_all ON public.account_shared_users
  FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin())) WITH CHECK ((SELECT public.is_super_admin()));
CREATE POLICY push_subscriptions_super_admin_all ON public.push_subscriptions
  FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin())) WITH CHECK ((SELECT public.is_super_admin()));

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE '%\_admin\_all'
      AND policyname NOT LIKE '%\_super\_admin\_all'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Dropped % *_admin_all policies', n;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================
-- ROLLBACK — CẢNH BÁO BẢO MẬT:
--   KHÔNG khôi phục định nghĩa is_admin()/can_*/has_* CŨ — CHÍNH CHÚNG là lỗ
--   hổng xuyên-tenant. Nếu một luồng HỢP LỆ bị chặn nhầm sau migration này, hãy
--   FORWARD-FIX (cấp quyền phạm-vi-hẹp) thay vì đảo ngược:
--     • Staff cần thấy nhiều tòa của owner mình → cấp assignment full-scope
--       (building_id NULL, area_id NULL) DƯỚI owner đó; can_access_building/
--       accessible_building_ids đã bind theo owner nên an toàn.
--     • Cần quyền cấp-tổ-chức (building-less) trên assets/warehouse/auto_debt →
--       gán quyền tương ứng dưới owner; nhánh org-level đã lọc theo
--       current_visible_owner_ids().
--     • Admin cấp-tenant → tạo role 'Admin' dưới owner; is_tenant_admin/
--       can_access_building nhận diện đúng phạm vi owner.
--   Nếu buộc phải đảo khẩn cấp: chỉ khôi phục các policy *_admin_all từ git
--   history (git show <hash>) TẠM THỜI, KHÔNG khôi phục is_admin() bản cũ.
-- =============================================================
