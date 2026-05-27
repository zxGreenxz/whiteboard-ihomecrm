-- =============================================
-- Phase 5: RBAC policies cho misc tables
-- =============================================
-- ADDITIVE: policy mới song song policy cũ.
--
-- Phân nhóm:
--   A. Có building_id NOT NULL → can_access_building(building_id) trực tiếp:
--      meters
--   B. Có building_id NULLABLE → tách 2 case (NULL = global/admin-only;
--      NOT NULL = can_access_building):
--      meter_readings, assets, asset_warehouses, auto_debt_config,
--      issues, jobs, leads, vehicles
--   C. Có contract_id NOT NULL → traverse qua contract:
--      asset_handovers
--   D. Có contract_id/invoice_id nullable (notifications):
--      Traverse contract HOẶC invoice nếu có; fallback recipient (user_id).
--   E. Global entities (không có FK building/contract): super_admin/admin
--      OR full-scope staff với role permission. Áp dụng cho:
--      accounts, customers, tenants, services, hotlines, document_templates,
--      signature_templates, asset_categories, asset_maintenance,
--      asset_movements, job_groups, job_types, lead_activities, issue_comments
-- =============================================

-- ─── Helper for "global org entity" access (group E) ────────────────────────
CREATE OR REPLACE FUNCTION public.can_access_org_entity(_resource text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND (
          r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> _resource ->> _action)::boolean, false) = true
        )
    );
$$;

COMMENT ON FUNCTION public.can_access_org_entity(text, text) IS
  'RBAC: cho phép user truy cập entity "thuộc tổ chức" (không gắn building) nếu có role permission tương ứng.';

-- ═══ NHÓM A: building_id NOT NULL ═══════════════════════════════════════════
-- METERS
CREATE POLICY meters_select_rbac ON public.meters FOR SELECT
  USING (public.can_access_building(building_id));
CREATE POLICY meters_insert_rbac ON public.meters FOR INSERT
  WITH CHECK (public.can_do_on_building('meters','create', building_id));
CREATE POLICY meters_update_rbac ON public.meters FOR UPDATE
  USING (public.can_do_on_building('meters','edit', building_id))
  WITH CHECK (public.can_do_on_building('meters','edit', building_id));
CREATE POLICY meters_delete_rbac ON public.meters FOR DELETE
  USING (public.can_do_on_building('meters','delete', building_id));

-- ═══ NHÓM B: building_id nullable ═══════════════════════════════════════════
-- METER_READINGS
CREATE POLICY meter_readings_select_rbac ON public.meter_readings FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
  );
CREATE POLICY meter_readings_insert_rbac ON public.meter_readings FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('meter_readings','create', building_id))
  );
CREATE POLICY meter_readings_update_rbac ON public.meter_readings FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('meter_readings','edit', building_id))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('meter_readings','edit', building_id))
  );
CREATE POLICY meter_readings_delete_rbac ON public.meter_readings FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('meter_readings','delete', building_id))
  );

-- ASSETS
CREATE POLICY assets_select_rbac ON public.assets FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('assets','view'))
  );
CREATE POLICY assets_insert_rbac ON public.assets FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('assets','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('assets','create'))
  );
CREATE POLICY assets_update_rbac ON public.assets FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('assets','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('assets','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('assets','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('assets','edit'))
  );
CREATE POLICY assets_delete_rbac ON public.assets FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('assets','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('assets','delete'))
  );

-- ASSET_WAREHOUSES
CREATE POLICY asset_warehouses_select_rbac ON public.asset_warehouses FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('warehouses','view'))
  );
CREATE POLICY asset_warehouses_insert_rbac ON public.asset_warehouses FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('warehouses','create'))
  );
CREATE POLICY asset_warehouses_update_rbac ON public.asset_warehouses FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('warehouses','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('warehouses','edit'))
  );
CREATE POLICY asset_warehouses_delete_rbac ON public.asset_warehouses FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('warehouses','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('warehouses','delete'))
  );

-- AUTO_DEBT_CONFIG
CREATE POLICY auto_debt_config_select_rbac ON public.auto_debt_config FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('auto_debt','view'))
  );
CREATE POLICY auto_debt_config_insert_rbac ON public.auto_debt_config FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('auto_debt','create'))
  );
CREATE POLICY auto_debt_config_update_rbac ON public.auto_debt_config FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('auto_debt','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('auto_debt','edit'))
  );
CREATE POLICY auto_debt_config_delete_rbac ON public.auto_debt_config FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('auto_debt','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('auto_debt','delete'))
  );

-- ISSUES
CREATE POLICY issues_select_rbac ON public.issues FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','view'))
  );
CREATE POLICY issues_insert_rbac ON public.issues FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','create'))
  );
CREATE POLICY issues_update_rbac ON public.issues FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','edit'))
  );
CREATE POLICY issues_delete_rbac ON public.issues FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','delete'))
  );

-- JOBS
CREATE POLICY jobs_select_rbac ON public.jobs FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','view'))
  );
CREATE POLICY jobs_insert_rbac ON public.jobs FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','create'))
  );
CREATE POLICY jobs_update_rbac ON public.jobs FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','edit'))
  );
CREATE POLICY jobs_delete_rbac ON public.jobs FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('tasks','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('tasks','delete'))
  );

-- LEADS
CREATE POLICY leads_select_rbac ON public.leads FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('leads','view'))
  );
CREATE POLICY leads_insert_rbac ON public.leads FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('leads','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('leads','create'))
  );
CREATE POLICY leads_update_rbac ON public.leads FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('leads','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('leads','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('leads','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('leads','edit'))
  );
CREATE POLICY leads_delete_rbac ON public.leads FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('leads','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('leads','delete'))
  );

-- VEHICLES
CREATE POLICY vehicles_select_rbac ON public.vehicles FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('vehicles','view'))
  );
CREATE POLICY vehicles_insert_rbac ON public.vehicles FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('vehicles','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('vehicles','create'))
  );
CREATE POLICY vehicles_update_rbac ON public.vehicles FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('vehicles','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('vehicles','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('vehicles','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('vehicles','edit'))
  );
CREATE POLICY vehicles_delete_rbac ON public.vehicles FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('vehicles','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('vehicles','delete'))
  );

-- ═══ NHÓM C: contract_id NOT NULL ═══════════════════════════════════════════
-- ASSET_HANDOVERS
CREATE POLICY asset_handovers_select_rbac ON public.asset_handovers FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));
CREATE POLICY asset_handovers_insert_rbac ON public.asset_handovers FOR INSERT
  WITH CHECK (public.can_do_on_building('assets','create', public.building_of_contract(contract_id)));
CREATE POLICY asset_handovers_update_rbac ON public.asset_handovers FOR UPDATE
  USING (public.can_do_on_building('assets','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('assets','edit', public.building_of_contract(contract_id)));
CREATE POLICY asset_handovers_delete_rbac ON public.asset_handovers FOR DELETE
  USING (public.can_do_on_building('assets','delete', public.building_of_contract(contract_id)));

-- ═══ NHÓM D: notifications ─ recipient-based + admin ════════════════════════
-- notifications.user_id = recipient. Người nhận luôn được xem; super_admin/admin xem hết.
-- KHÔNG thêm policy mới cho notifications — policy cũ đã cover đầy đủ qua auth.uid()=user_id.
-- (Notifications mang tính cá nhân, không cần override RBAC.)

-- ═══ NHÓM E: global org entities ════════════════════════════════════════════
-- Pattern: super_admin/admin OR có role permission tương ứng.

-- CUSTOMERS
CREATE POLICY customers_select_rbac ON public.customers FOR SELECT
  USING (public.can_access_org_entity('customers','view'));
CREATE POLICY customers_insert_rbac ON public.customers FOR INSERT
  WITH CHECK (public.can_access_org_entity('customers','create'));
CREATE POLICY customers_update_rbac ON public.customers FOR UPDATE
  USING (public.can_access_org_entity('customers','edit'))
  WITH CHECK (public.can_access_org_entity('customers','edit'));
CREATE POLICY customers_delete_rbac ON public.customers FOR DELETE
  USING (public.can_access_org_entity('customers','delete'));

-- TENANTS
CREATE POLICY tenants_select_rbac ON public.tenants FOR SELECT
  USING (public.can_access_org_entity('customers','view'));
CREATE POLICY tenants_insert_rbac ON public.tenants FOR INSERT
  WITH CHECK (public.can_access_org_entity('customers','create'));
CREATE POLICY tenants_update_rbac ON public.tenants FOR UPDATE
  USING (public.can_access_org_entity('customers','edit'))
  WITH CHECK (public.can_access_org_entity('customers','edit'));
CREATE POLICY tenants_delete_rbac ON public.tenants FOR DELETE
  USING (public.can_access_org_entity('customers','delete'));

-- SERVICES
CREATE POLICY services_select_rbac ON public.services FOR SELECT
  USING (public.can_access_org_entity('services','view'));
CREATE POLICY services_insert_rbac ON public.services FOR INSERT
  WITH CHECK (public.can_access_org_entity('services','create'));
CREATE POLICY services_update_rbac ON public.services FOR UPDATE
  USING (public.can_access_org_entity('services','edit'))
  WITH CHECK (public.can_access_org_entity('services','edit'));
CREATE POLICY services_delete_rbac ON public.services FOR DELETE
  USING (public.can_access_org_entity('services','delete'));

-- HOTLINES
CREATE POLICY hotlines_select_rbac ON public.hotlines FOR SELECT
  USING (public.can_access_org_entity('hotline','view'));
CREATE POLICY hotlines_insert_rbac ON public.hotlines FOR INSERT
  WITH CHECK (public.can_access_org_entity('hotline','create'));
CREATE POLICY hotlines_update_rbac ON public.hotlines FOR UPDATE
  USING (public.can_access_org_entity('hotline','edit'))
  WITH CHECK (public.can_access_org_entity('hotline','edit'));
CREATE POLICY hotlines_delete_rbac ON public.hotlines FOR DELETE
  USING (public.can_access_org_entity('hotline','delete'));

-- DOCUMENT_TEMPLATES
CREATE POLICY document_templates_select_rbac ON public.document_templates FOR SELECT
  USING (public.can_access_org_entity('templates','view'));
CREATE POLICY document_templates_insert_rbac ON public.document_templates FOR INSERT
  WITH CHECK (public.can_access_org_entity('templates','create'));
CREATE POLICY document_templates_update_rbac ON public.document_templates FOR UPDATE
  USING (public.can_access_org_entity('templates','edit'))
  WITH CHECK (public.can_access_org_entity('templates','edit'));
CREATE POLICY document_templates_delete_rbac ON public.document_templates FOR DELETE
  USING (public.can_access_org_entity('templates','delete'));

-- SIGNATURE_TEMPLATES
CREATE POLICY signature_templates_select_rbac ON public.signature_templates FOR SELECT
  USING (public.can_access_org_entity('templates','view'));
CREATE POLICY signature_templates_insert_rbac ON public.signature_templates FOR INSERT
  WITH CHECK (public.can_access_org_entity('templates','create'));
CREATE POLICY signature_templates_update_rbac ON public.signature_templates FOR UPDATE
  USING (public.can_access_org_entity('templates','edit'))
  WITH CHECK (public.can_access_org_entity('templates','edit'));
CREATE POLICY signature_templates_delete_rbac ON public.signature_templates FOR DELETE
  USING (public.can_access_org_entity('templates','delete'));

-- ASSET_CATEGORIES
CREATE POLICY asset_categories_select_rbac ON public.asset_categories FOR SELECT
  USING (public.can_access_org_entity('assets','view'));
CREATE POLICY asset_categories_insert_rbac ON public.asset_categories FOR INSERT
  WITH CHECK (public.can_access_org_entity('assets','create'));
CREATE POLICY asset_categories_update_rbac ON public.asset_categories FOR UPDATE
  USING (public.can_access_org_entity('assets','edit'))
  WITH CHECK (public.can_access_org_entity('assets','edit'));
CREATE POLICY asset_categories_delete_rbac ON public.asset_categories FOR DELETE
  USING (public.can_access_org_entity('assets','delete'));

-- ASSET_MAINTENANCE
CREATE POLICY asset_maintenance_select_rbac ON public.asset_maintenance FOR SELECT
  USING (public.can_access_org_entity('assets','view'));
CREATE POLICY asset_maintenance_insert_rbac ON public.asset_maintenance FOR INSERT
  WITH CHECK (public.can_access_org_entity('assets','create'));
CREATE POLICY asset_maintenance_update_rbac ON public.asset_maintenance FOR UPDATE
  USING (public.can_access_org_entity('assets','edit'))
  WITH CHECK (public.can_access_org_entity('assets','edit'));
CREATE POLICY asset_maintenance_delete_rbac ON public.asset_maintenance FOR DELETE
  USING (public.can_access_org_entity('assets','delete'));

-- ASSET_MOVEMENTS
CREATE POLICY asset_movements_select_rbac ON public.asset_movements FOR SELECT
  USING (public.can_access_org_entity('assets','view'));
CREATE POLICY asset_movements_insert_rbac ON public.asset_movements FOR INSERT
  WITH CHECK (public.can_access_org_entity('assets','create'));
CREATE POLICY asset_movements_update_rbac ON public.asset_movements FOR UPDATE
  USING (public.can_access_org_entity('assets','edit'))
  WITH CHECK (public.can_access_org_entity('assets','edit'));
CREATE POLICY asset_movements_delete_rbac ON public.asset_movements FOR DELETE
  USING (public.can_access_org_entity('assets','delete'));

-- JOB_GROUPS
CREATE POLICY job_groups_select_rbac ON public.job_groups FOR SELECT
  USING (public.can_access_org_entity('tasks','view'));
CREATE POLICY job_groups_insert_rbac ON public.job_groups FOR INSERT
  WITH CHECK (public.can_access_org_entity('tasks','create'));
CREATE POLICY job_groups_update_rbac ON public.job_groups FOR UPDATE
  USING (public.can_access_org_entity('tasks','edit'))
  WITH CHECK (public.can_access_org_entity('tasks','edit'));
CREATE POLICY job_groups_delete_rbac ON public.job_groups FOR DELETE
  USING (public.can_access_org_entity('tasks','delete'));

-- JOB_TYPES
CREATE POLICY job_types_select_rbac ON public.job_types FOR SELECT
  USING (public.can_access_org_entity('task_types','view'));
CREATE POLICY job_types_insert_rbac ON public.job_types FOR INSERT
  WITH CHECK (public.can_access_org_entity('task_types','create'));
CREATE POLICY job_types_update_rbac ON public.job_types FOR UPDATE
  USING (public.can_access_org_entity('task_types','edit'))
  WITH CHECK (public.can_access_org_entity('task_types','edit'));
CREATE POLICY job_types_delete_rbac ON public.job_types FOR DELETE
  USING (public.can_access_org_entity('task_types','delete'));

-- LEAD_ACTIVITIES
CREATE POLICY lead_activities_select_rbac ON public.lead_activities FOR SELECT
  USING (public.can_access_org_entity('leads','view'));
CREATE POLICY lead_activities_insert_rbac ON public.lead_activities FOR INSERT
  WITH CHECK (public.can_access_org_entity('leads','create'));
CREATE POLICY lead_activities_update_rbac ON public.lead_activities FOR UPDATE
  USING (public.can_access_org_entity('leads','edit'))
  WITH CHECK (public.can_access_org_entity('leads','edit'));
CREATE POLICY lead_activities_delete_rbac ON public.lead_activities FOR DELETE
  USING (public.can_access_org_entity('leads','delete'));

-- ISSUE_COMMENTS
CREATE POLICY issue_comments_select_rbac ON public.issue_comments FOR SELECT
  USING (public.can_access_org_entity('tasks','view'));
CREATE POLICY issue_comments_insert_rbac ON public.issue_comments FOR INSERT
  WITH CHECK (public.can_access_org_entity('tasks','create'));
CREATE POLICY issue_comments_update_rbac ON public.issue_comments FOR UPDATE
  USING (public.can_access_org_entity('tasks','edit'))
  WITH CHECK (public.can_access_org_entity('tasks','edit'));
CREATE POLICY issue_comments_delete_rbac ON public.issue_comments FOR DELETE
  USING (public.can_access_org_entity('tasks','delete'));

-- ACCOUNTS (sổ quỹ) — KHÔNG override; đã có cơ chế shared_users phức tạp riêng.
-- Để chuyển sang RBAC thuần, cần phân tích thêm; giữ nguyên ở phase này.

-- ─── TRIGGERS auto-fill user_id cho các bảng có cột user_id ─────────────────
CREATE TRIGGER meters_set_user_id_audit BEFORE INSERT ON public.meters
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER meter_readings_set_user_id_audit BEFORE INSERT ON public.meter_readings
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER assets_set_user_id_audit BEFORE INSERT ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER asset_warehouses_set_user_id_audit BEFORE INSERT ON public.asset_warehouses
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER asset_handovers_set_user_id_audit BEFORE INSERT ON public.asset_handovers
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER asset_maintenance_set_user_id_audit BEFORE INSERT ON public.asset_maintenance
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER asset_movements_set_user_id_audit BEFORE INSERT ON public.asset_movements
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER asset_categories_set_user_id_audit BEFORE INSERT ON public.asset_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER auto_debt_config_set_user_id_audit BEFORE INSERT ON public.auto_debt_config
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER customers_set_user_id_audit BEFORE INSERT ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER tenants_set_user_id_audit BEFORE INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER services_set_user_id_audit BEFORE INSERT ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER hotlines_set_user_id_audit BEFORE INSERT ON public.hotlines
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER document_templates_set_user_id_audit BEFORE INSERT ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER signature_templates_set_user_id_audit BEFORE INSERT ON public.signature_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER issues_set_user_id_audit BEFORE INSERT ON public.issues
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER issue_comments_set_user_id_audit BEFORE INSERT ON public.issue_comments
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER jobs_set_user_id_audit BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER job_groups_set_user_id_audit BEFORE INSERT ON public.job_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER job_types_set_user_id_audit BEFORE INSERT ON public.job_types
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER leads_set_user_id_audit BEFORE INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER lead_activities_set_user_id_audit BEFORE INSERT ON public.lead_activities
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER vehicles_set_user_id_audit BEFORE INSERT ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
