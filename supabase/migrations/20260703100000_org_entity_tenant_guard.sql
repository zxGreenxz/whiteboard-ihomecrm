-- =============================================================================
-- TENANT-GUARD cho nhóm bảng org-entity (customers/tenants/ct01/vehicles/suppliers/hotlines)
-- =============================================================================
-- Bối cảnh: policy *_rbac chỉ check can_access_org_entity(entity, action) — KHÔNG có
-- predicate tenant. Trước giờ hệ là single-org nên vô hại; khi xuất hiện tenant thứ 2
-- (sandbox demo cho trang docs, owner demo.chunha) thì staff tenant này thấy/sửa được
-- dữ liệu khách hàng của tenant kia (lộ tên/SĐT/CMND xuyên tenant).
--
-- Vá: AND thêm `user_id = ANY (public.current_visible_owner_ids())` — closure tenant
-- (mình + owner mình phục vụ + staff của mình + đồng nghiệp cùng owner, đã có từ
-- 20260506000004). Với dữ liệu hiện tại đây là NO-OP cho staff thật (đã verify bằng
-- impersonation đếm rows trước/sau). Dùng dạng mảng = ANY(fn()) đúng pattern sẵn có trong codebase (fn STABLE).
--
-- vehicles: chỉ vá nhánh org-entity (building_id IS NULL); nhánh theo tòa giữ nguyên.
-- Các policy *_admin_all / *_super_admin_all giữ nguyên (admin xuyên tenant by design).
-- =============================================================================

-- ===== customers =====
ALTER POLICY customers_select_rbac ON public.customers
  USING (can_access_org_entity('customers', 'view')
         AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY customers_insert_rbac ON public.customers
  WITH CHECK (can_access_org_entity('customers', 'create')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY customers_update_rbac ON public.customers
  USING (can_access_org_entity('customers', 'edit')
         AND user_id = ANY (public.current_visible_owner_ids()))
  WITH CHECK (can_access_org_entity('customers', 'edit')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY customers_delete_rbac ON public.customers
  USING (can_access_org_entity('customers', 'delete')
         AND user_id = ANY (public.current_visible_owner_ids()));

-- ===== tenants (người ở cùng — entity permission dùng chung 'customers') =====
ALTER POLICY tenants_select_rbac ON public.tenants
  USING (can_access_org_entity('customers', 'view')
         AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY tenants_insert_rbac ON public.tenants
  WITH CHECK (can_access_org_entity('customers', 'create')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY tenants_update_rbac ON public.tenants
  USING (can_access_org_entity('customers', 'edit')
         AND user_id = ANY (public.current_visible_owner_ids()))
  WITH CHECK (can_access_org_entity('customers', 'edit')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY tenants_delete_rbac ON public.tenants
  USING (can_access_org_entity('customers', 'delete')
         AND user_id = ANY (public.current_visible_owner_ids()));

-- ===== ct01_declarations (khai báo cư trú — entity 'customers') =====
ALTER POLICY ct01_declarations_select_rbac ON public.ct01_declarations
  USING (can_access_org_entity('customers', 'view')
         AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY ct01_declarations_insert_rbac ON public.ct01_declarations
  WITH CHECK (can_access_org_entity('customers', 'create')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY ct01_declarations_update_rbac ON public.ct01_declarations
  USING (can_access_org_entity('customers', 'edit')
         AND user_id = ANY (public.current_visible_owner_ids()))
  WITH CHECK (can_access_org_entity('customers', 'edit')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY ct01_declarations_delete_rbac ON public.ct01_declarations
  USING (can_access_org_entity('customers', 'delete')
         AND user_id = ANY (public.current_visible_owner_ids()));

-- ===== suppliers =====
ALTER POLICY suppliers_select_rbac ON public.suppliers
  USING (can_access_org_entity('suppliers', 'view')
         AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY suppliers_insert_rbac ON public.suppliers
  WITH CHECK (can_access_org_entity('suppliers', 'create')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY suppliers_update_rbac ON public.suppliers
  USING (can_access_org_entity('suppliers', 'edit')
         AND user_id = ANY (public.current_visible_owner_ids()))
  WITH CHECK (can_access_org_entity('suppliers', 'edit')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY suppliers_delete_rbac ON public.suppliers
  USING (can_access_org_entity('suppliers', 'delete')
         AND user_id = ANY (public.current_visible_owner_ids()));

-- ===== hotlines =====
ALTER POLICY hotlines_select_rbac ON public.hotlines
  USING (can_access_org_entity('hotline', 'view')
         AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY hotlines_insert_rbac ON public.hotlines
  WITH CHECK (can_access_org_entity('hotline', 'create')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY hotlines_update_rbac ON public.hotlines
  USING (can_access_org_entity('hotline', 'edit')
         AND user_id = ANY (public.current_visible_owner_ids()))
  WITH CHECK (can_access_org_entity('hotline', 'edit')
              AND user_id = ANY (public.current_visible_owner_ids()));
ALTER POLICY hotlines_delete_rbac ON public.hotlines
  USING (can_access_org_entity('hotline', 'delete')
         AND user_id = ANY (public.current_visible_owner_ids()));

-- ===== vehicles: chỉ vá nhánh building_id IS NULL =====
ALTER POLICY vehicles_select_rbac ON public.vehicles
  USING (is_super_admin() OR is_admin()
         OR ((building_id IS NOT NULL) AND can_access_building(building_id))
         OR ((building_id IS NULL) AND can_access_org_entity('vehicles', 'view')
             AND user_id = ANY (public.current_visible_owner_ids())));
ALTER POLICY vehicles_insert_rbac ON public.vehicles
  WITH CHECK (is_super_admin()
              OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles', 'create', building_id))
              OR ((building_id IS NULL) AND can_access_org_entity('vehicles', 'create')
                  AND user_id = ANY (public.current_visible_owner_ids())));
ALTER POLICY vehicles_update_rbac ON public.vehicles
  USING (is_super_admin()
         OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles', 'edit', building_id))
         OR ((building_id IS NULL) AND can_access_org_entity('vehicles', 'edit')
             AND user_id = ANY (public.current_visible_owner_ids())))
  WITH CHECK (is_super_admin()
              OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles', 'edit', building_id))
              OR ((building_id IS NULL) AND can_access_org_entity('vehicles', 'edit')
                  AND user_id = ANY (public.current_visible_owner_ids())));
ALTER POLICY vehicles_delete_rbac ON public.vehicles
  USING (is_super_admin()
         OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles', 'delete', building_id))
         OR ((building_id IS NULL) AND can_access_org_entity('vehicles', 'delete')
             AND user_id = ANY (public.current_visible_owner_ids())));
