-- =============================================
-- Phase 6 (soft): Annotate cột user_id trên data tables là audit-only
-- =============================================
-- KHÔNG rename cột — frontend đang reference ~80+ chỗ, đợi monitoring stable
-- 2+ tuần trước khi rename hẳn (xem plan breezy-finding-gem.md mục Phase 6).
--
-- Mục tiêu phase này: chỉ thêm COMMENT để document rõ vai trò mới của cột:
--   "audit-only: ghi nhận ai tạo row; KHÔNG tham gia access control"
-- Sau phase 1-5, access đã chuyển sang RBAC qua building_id + roles.
--
-- KHÔNG động giá trị data; chỉ metadata schema (COMMENT).
-- =============================================

COMMENT ON COLUMN public.invoices.user_id IS
  'Audit-only: auth.uid() của user đã tạo row (set by trigger set_user_id_from_auth). RBAC dùng can_access_building(building_id), không dùng cột này.';
COMMENT ON COLUMN public.payments.user_id IS
  'Audit-only: auth.uid() đã tạo row. RBAC dùng building qua invoice_id.';
COMMENT ON COLUMN public.income_expenses.user_id IS
  'Audit-only. RBAC dùng can_access_building(building_id).';
COMMENT ON COLUMN public.excess_amounts.user_id IS
  'Audit-only. RBAC traverse contract_id → building.';
COMMENT ON COLUMN public.contracts.user_id IS
  'Audit-only. RBAC traverse room_id → building.';
COMMENT ON COLUMN public.contract_extensions.user_id IS
  'Audit-only. RBAC traverse contract_id → building.';
COMMENT ON COLUMN public.contract_terminations.user_id IS
  'Audit-only. RBAC traverse contract_id → building.';
COMMENT ON COLUMN public.contract_transfers.user_id IS
  'Audit-only. RBAC traverse contract_id → building.';
COMMENT ON COLUMN public.deposits.user_id IS
  'Audit-only. RBAC traverse contract_id (hoặc room_id) → building.';
COMMENT ON COLUMN public.buildings.user_id IS
  'Audit-only. RBAC dùng can_access_building(id) + staff_assignments.';
COMMENT ON COLUMN public.areas.user_id IS
  'Audit-only. RBAC: full-scope staff với areas:view permission.';
COMMENT ON COLUMN public.floors.user_id IS
  'Audit-only. RBAC dùng can_access_building(building_id).';
COMMENT ON COLUMN public.meters.user_id IS
  'Audit-only. RBAC dùng can_access_building(building_id).';
COMMENT ON COLUMN public.meter_readings.user_id IS
  'Audit-only. RBAC dùng can_access_building(building_id) khi NOT NULL.';
COMMENT ON COLUMN public.customers.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(customers).';
COMMENT ON COLUMN public.tenants.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(customers).';
COMMENT ON COLUMN public.assets.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (assets).';
COMMENT ON COLUMN public.asset_warehouses.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (warehouses).';
COMMENT ON COLUMN public.asset_handovers.user_id IS
  'Audit-only. RBAC traverse contract_id → building.';
COMMENT ON COLUMN public.asset_categories.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(assets).';
COMMENT ON COLUMN public.asset_maintenance.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(assets).';
COMMENT ON COLUMN public.asset_movements.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(assets).';
COMMENT ON COLUMN public.auto_debt_config.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (auto_debt).';
COMMENT ON COLUMN public.document_templates.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(templates).';
COMMENT ON COLUMN public.signature_templates.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(templates).';
COMMENT ON COLUMN public.hotlines.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(hotline).';
COMMENT ON COLUMN public.services.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(services).';
COMMENT ON COLUMN public.issues.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (tasks).';
COMMENT ON COLUMN public.issue_comments.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(tasks).';
COMMENT ON COLUMN public.jobs.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (tasks).';
COMMENT ON COLUMN public.job_groups.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(tasks).';
COMMENT ON COLUMN public.job_types.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(task_types).';
COMMENT ON COLUMN public.leads.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (leads).';
COMMENT ON COLUMN public.lead_activities.user_id IS
  'Audit-only. RBAC dùng can_access_org_entity(leads).';
COMMENT ON COLUMN public.vehicles.user_id IS
  'Audit-only. RBAC: building_id (nếu có) OR org-level (vehicles).';
COMMENT ON COLUMN public.accounts.user_id IS
  'Owner của sổ quỹ. CHƯA chuyển sang RBAC (giữ semantic owner do có shared_users system).';
