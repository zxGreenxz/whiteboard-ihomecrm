-- =============================================
-- Batch A: RBAC policies cho 17 bảng config còn lại
-- =============================================
-- Bảng này phần lớn là template/category/setting → dùng can_access_org_entity
-- map đến permission tương ứng đã có trong roles.permissions.
--
-- expenses có building_id nullable → dùng pattern hybrid như assets/jobs.
-- issue_phase_history/status_history + phase_transitions/task_phases:
-- traverse qua issue_id/flow_id.
-- =============================================

-- ─── CT01_DECLARATIONS (kê khai mẫu CT01) ──────────────────────────────────
CREATE POLICY ct01_declarations_select_rbac ON public.ct01_declarations FOR SELECT
  USING (public.can_access_org_entity('customers','view'));
CREATE POLICY ct01_declarations_insert_rbac ON public.ct01_declarations FOR INSERT
  WITH CHECK (public.can_access_org_entity('customers','create'));
CREATE POLICY ct01_declarations_update_rbac ON public.ct01_declarations FOR UPDATE
  USING (public.can_access_org_entity('customers','edit'))
  WITH CHECK (public.can_access_org_entity('customers','edit'));
CREATE POLICY ct01_declarations_delete_rbac ON public.ct01_declarations FOR DELETE
  USING (public.can_access_org_entity('customers','delete'));

-- ─── EXPENSES (chi phí — building_id nullable) ─────────────────────────────
CREATE POLICY expenses_select_rbac ON public.expenses FOR SELECT
  USING (
    public.is_super_admin() OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('income_expenses','view'))
  );
CREATE POLICY expenses_insert_rbac ON public.expenses FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','create', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('income_expenses','create'))
  );
CREATE POLICY expenses_update_rbac ON public.expenses FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('income_expenses','edit'))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','edit', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('income_expenses','edit'))
  );
CREATE POLICY expenses_delete_rbac ON public.expenses FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','delete', building_id))
    OR (building_id IS NULL AND public.can_access_org_entity('income_expenses','delete'))
  );

-- ─── INCOME_EXPENSE_BATCHES (gộp nhiều phiếu thu chi) ──────────────────────
CREATE POLICY income_expense_batches_select_rbac ON public.income_expense_batches FOR SELECT
  USING (public.can_access_org_entity('income_expenses','view'));
CREATE POLICY income_expense_batches_insert_rbac ON public.income_expense_batches FOR INSERT
  WITH CHECK (public.can_access_org_entity('income_expenses','create'));
CREATE POLICY income_expense_batches_update_rbac ON public.income_expense_batches FOR UPDATE
  USING (public.can_access_org_entity('income_expenses','edit'))
  WITH CHECK (public.can_access_org_entity('income_expenses','edit'));
CREATE POLICY income_expense_batches_delete_rbac ON public.income_expense_batches FOR DELETE
  USING (public.can_access_org_entity('income_expenses','delete'));

-- ─── INCOME_EXPENSE_BATCH_ITEMS (FK qua batch_id) ──────────────────────────
CREATE POLICY income_expense_batch_items_select_rbac ON public.income_expense_batch_items FOR SELECT
  USING (public.can_access_org_entity('income_expenses','view'));
CREATE POLICY income_expense_batch_items_insert_rbac ON public.income_expense_batch_items FOR INSERT
  WITH CHECK (public.can_access_org_entity('income_expenses','create'));
CREATE POLICY income_expense_batch_items_update_rbac ON public.income_expense_batch_items FOR UPDATE
  USING (public.can_access_org_entity('income_expenses','edit'))
  WITH CHECK (public.can_access_org_entity('income_expenses','edit'));
CREATE POLICY income_expense_batch_items_delete_rbac ON public.income_expense_batch_items FOR DELETE
  USING (public.can_access_org_entity('income_expenses','delete'));

-- ─── INCOME_EXPENSE_TEMPLATES ──────────────────────────────────────────────
CREATE POLICY income_expense_templates_select_rbac ON public.income_expense_templates FOR SELECT
  USING (public.can_access_org_entity('templates','view'));
CREATE POLICY income_expense_templates_insert_rbac ON public.income_expense_templates FOR INSERT
  WITH CHECK (public.can_access_org_entity('templates','create'));
CREATE POLICY income_expense_templates_update_rbac ON public.income_expense_templates FOR UPDATE
  USING (public.can_access_org_entity('templates','edit'))
  WITH CHECK (public.can_access_org_entity('templates','edit'));
CREATE POLICY income_expense_templates_delete_rbac ON public.income_expense_templates FOR DELETE
  USING (public.can_access_org_entity('templates','delete'));

-- ─── INCOME_EXPENSE_TYPES ──────────────────────────────────────────────────
CREATE POLICY income_expense_types_select_rbac ON public.income_expense_types FOR SELECT
  USING (public.can_access_org_entity('categories','view'));
CREATE POLICY income_expense_types_insert_rbac ON public.income_expense_types FOR INSERT
  WITH CHECK (public.can_access_org_entity('categories','create'));
CREATE POLICY income_expense_types_update_rbac ON public.income_expense_types FOR UPDATE
  USING (public.can_access_org_entity('categories','edit'))
  WITH CHECK (public.can_access_org_entity('categories','edit'));
CREATE POLICY income_expense_types_delete_rbac ON public.income_expense_types FOR DELETE
  USING (public.can_access_org_entity('categories','delete'));

-- ─── INVOICE_GENERATION_SETTINGS ───────────────────────────────────────────
CREATE POLICY invoice_generation_settings_select_rbac ON public.invoice_generation_settings FOR SELECT
  USING (public.can_access_org_entity('settings','view'));
CREATE POLICY invoice_generation_settings_insert_rbac ON public.invoice_generation_settings FOR INSERT
  WITH CHECK (public.can_access_org_entity('settings','create'));
CREATE POLICY invoice_generation_settings_update_rbac ON public.invoice_generation_settings FOR UPDATE
  USING (public.can_access_org_entity('settings','edit'))
  WITH CHECK (public.can_access_org_entity('settings','edit'));
CREATE POLICY invoice_generation_settings_delete_rbac ON public.invoice_generation_settings FOR DELETE
  USING (public.can_access_org_entity('settings','delete'));

-- ─── ISSUE_CATEGORIES ──────────────────────────────────────────────────────
CREATE POLICY issue_categories_select_rbac ON public.issue_categories FOR SELECT
  USING (public.can_access_org_entity('categories','view'));
CREATE POLICY issue_categories_insert_rbac ON public.issue_categories FOR INSERT
  WITH CHECK (public.can_access_org_entity('categories','create'));
CREATE POLICY issue_categories_update_rbac ON public.issue_categories FOR UPDATE
  USING (public.can_access_org_entity('categories','edit'))
  WITH CHECK (public.can_access_org_entity('categories','edit'));
CREATE POLICY issue_categories_delete_rbac ON public.issue_categories FOR DELETE
  USING (public.can_access_org_entity('categories','delete'));

-- ─── ISSUE_PHASE_HISTORY (audit; traverse qua issue_id) ────────────────────
CREATE POLICY issue_phase_history_select_rbac ON public.issue_phase_history FOR SELECT
  USING (public.can_access_org_entity('tasks','view'));
CREATE POLICY issue_phase_history_insert_rbac ON public.issue_phase_history FOR INSERT
  WITH CHECK (public.can_access_org_entity('tasks','create'));
CREATE POLICY issue_phase_history_update_rbac ON public.issue_phase_history FOR UPDATE
  USING (public.can_access_org_entity('tasks','edit'))
  WITH CHECK (public.can_access_org_entity('tasks','edit'));
CREATE POLICY issue_phase_history_delete_rbac ON public.issue_phase_history FOR DELETE
  USING (public.can_access_org_entity('tasks','delete'));

-- ─── ISSUE_STATUS_HISTORY ──────────────────────────────────────────────────
CREATE POLICY issue_status_history_select_rbac ON public.issue_status_history FOR SELECT
  USING (public.can_access_org_entity('tasks','view'));
CREATE POLICY issue_status_history_insert_rbac ON public.issue_status_history FOR INSERT
  WITH CHECK (public.can_access_org_entity('tasks','create'));
CREATE POLICY issue_status_history_update_rbac ON public.issue_status_history FOR UPDATE
  USING (public.can_access_org_entity('tasks','edit'))
  WITH CHECK (public.can_access_org_entity('tasks','edit'));
CREATE POLICY issue_status_history_delete_rbac ON public.issue_status_history FOR DELETE
  USING (public.can_access_org_entity('tasks','delete'));

-- ─── NOTIFICATION_TEMPLATES ────────────────────────────────────────────────
CREATE POLICY notification_templates_select_rbac ON public.notification_templates FOR SELECT
  USING (public.can_access_org_entity('templates','view'));
CREATE POLICY notification_templates_insert_rbac ON public.notification_templates FOR INSERT
  WITH CHECK (public.can_access_org_entity('templates','create'));
CREATE POLICY notification_templates_update_rbac ON public.notification_templates FOR UPDATE
  USING (public.can_access_org_entity('templates','edit'))
  WITH CHECK (public.can_access_org_entity('templates','edit'));
CREATE POLICY notification_templates_delete_rbac ON public.notification_templates FOR DELETE
  USING (public.can_access_org_entity('templates','delete'));

-- ─── PHASE_TRANSITIONS (transitions giữa task_phases) ──────────────────────
CREATE POLICY phase_transitions_select_rbac ON public.phase_transitions FOR SELECT
  USING (public.can_access_org_entity('task_types','view'));
CREATE POLICY phase_transitions_insert_rbac ON public.phase_transitions FOR INSERT
  WITH CHECK (public.can_access_org_entity('task_types','create'));
CREATE POLICY phase_transitions_update_rbac ON public.phase_transitions FOR UPDATE
  USING (public.can_access_org_entity('task_types','edit'))
  WITH CHECK (public.can_access_org_entity('task_types','edit'));
CREATE POLICY phase_transitions_delete_rbac ON public.phase_transitions FOR DELETE
  USING (public.can_access_org_entity('task_types','delete'));

-- ─── SCHEDULED_JOBS (cron / scheduled) ─────────────────────────────────────
CREATE POLICY scheduled_jobs_select_rbac ON public.scheduled_jobs FOR SELECT
  USING (public.can_access_org_entity('settings','view'));
CREATE POLICY scheduled_jobs_insert_rbac ON public.scheduled_jobs FOR INSERT
  WITH CHECK (public.can_access_org_entity('settings','create'));
CREATE POLICY scheduled_jobs_update_rbac ON public.scheduled_jobs FOR UPDATE
  USING (public.can_access_org_entity('settings','edit'))
  WITH CHECK (public.can_access_org_entity('settings','edit'));
CREATE POLICY scheduled_jobs_delete_rbac ON public.scheduled_jobs FOR DELETE
  USING (public.can_access_org_entity('settings','delete'));

-- ─── SERVICE_QUOTAS ────────────────────────────────────────────────────────
CREATE POLICY service_quotas_select_rbac ON public.service_quotas FOR SELECT
  USING (public.can_access_org_entity('service_quotas','view'));
CREATE POLICY service_quotas_insert_rbac ON public.service_quotas FOR INSERT
  WITH CHECK (public.can_access_org_entity('service_quotas','create'));
CREATE POLICY service_quotas_update_rbac ON public.service_quotas FOR UPDATE
  USING (public.can_access_org_entity('service_quotas','edit'))
  WITH CHECK (public.can_access_org_entity('service_quotas','edit'));
CREATE POLICY service_quotas_delete_rbac ON public.service_quotas FOR DELETE
  USING (public.can_access_org_entity('service_quotas','delete'));

-- ─── SERVICE_QUOTA_TIERS (FK qua quota_id) ─────────────────────────────────
CREATE POLICY service_quota_tiers_select_rbac ON public.service_quota_tiers FOR SELECT
  USING (public.can_access_org_entity('service_quotas','view'));
CREATE POLICY service_quota_tiers_insert_rbac ON public.service_quota_tiers FOR INSERT
  WITH CHECK (public.can_access_org_entity('service_quotas','create'));
CREATE POLICY service_quota_tiers_update_rbac ON public.service_quota_tiers FOR UPDATE
  USING (public.can_access_org_entity('service_quotas','edit'))
  WITH CHECK (public.can_access_org_entity('service_quotas','edit'));
CREATE POLICY service_quota_tiers_delete_rbac ON public.service_quota_tiers FOR DELETE
  USING (public.can_access_org_entity('service_quotas','delete'));

-- ─── SLA_CONFIGS ───────────────────────────────────────────────────────────
CREATE POLICY sla_configs_select_rbac ON public.sla_configs FOR SELECT
  USING (public.can_access_org_entity('settings','view'));
CREATE POLICY sla_configs_insert_rbac ON public.sla_configs FOR INSERT
  WITH CHECK (public.can_access_org_entity('settings','create'));
CREATE POLICY sla_configs_update_rbac ON public.sla_configs FOR UPDATE
  USING (public.can_access_org_entity('settings','edit'))
  WITH CHECK (public.can_access_org_entity('settings','edit'));
CREATE POLICY sla_configs_delete_rbac ON public.sla_configs FOR DELETE
  USING (public.can_access_org_entity('settings','delete'));

-- ─── SUPPLIERS ─────────────────────────────────────────────────────────────
CREATE POLICY suppliers_select_rbac ON public.suppliers FOR SELECT
  USING (public.can_access_org_entity('suppliers','view'));
CREATE POLICY suppliers_insert_rbac ON public.suppliers FOR INSERT
  WITH CHECK (public.can_access_org_entity('suppliers','create'));
CREATE POLICY suppliers_update_rbac ON public.suppliers FOR UPDATE
  USING (public.can_access_org_entity('suppliers','edit'))
  WITH CHECK (public.can_access_org_entity('suppliers','edit'));
CREATE POLICY suppliers_delete_rbac ON public.suppliers FOR DELETE
  USING (public.can_access_org_entity('suppliers','delete'));

-- ─── TASK_FLOWS ────────────────────────────────────────────────────────────
CREATE POLICY task_flows_select_rbac ON public.task_flows FOR SELECT
  USING (public.can_access_org_entity('task_types','view'));
CREATE POLICY task_flows_insert_rbac ON public.task_flows FOR INSERT
  WITH CHECK (public.can_access_org_entity('task_types','create'));
CREATE POLICY task_flows_update_rbac ON public.task_flows FOR UPDATE
  USING (public.can_access_org_entity('task_types','edit'))
  WITH CHECK (public.can_access_org_entity('task_types','edit'));
CREATE POLICY task_flows_delete_rbac ON public.task_flows FOR DELETE
  USING (public.can_access_org_entity('task_types','delete'));

-- ─── TASK_PHASES (FK qua flow_id) ──────────────────────────────────────────
CREATE POLICY task_phases_select_rbac ON public.task_phases FOR SELECT
  USING (public.can_access_org_entity('task_types','view'));
CREATE POLICY task_phases_insert_rbac ON public.task_phases FOR INSERT
  WITH CHECK (public.can_access_org_entity('task_types','create'));
CREATE POLICY task_phases_update_rbac ON public.task_phases FOR UPDATE
  USING (public.can_access_org_entity('task_types','edit'))
  WITH CHECK (public.can_access_org_entity('task_types','edit'));
CREATE POLICY task_phases_delete_rbac ON public.task_phases FOR DELETE
  USING (public.can_access_org_entity('task_types','delete'));

-- ─── TASK_TYPES ────────────────────────────────────────────────────────────
CREATE POLICY task_types_select_rbac ON public.task_types FOR SELECT
  USING (public.can_access_org_entity('task_types','view'));
CREATE POLICY task_types_insert_rbac ON public.task_types FOR INSERT
  WITH CHECK (public.can_access_org_entity('task_types','create'));
CREATE POLICY task_types_update_rbac ON public.task_types FOR UPDATE
  USING (public.can_access_org_entity('task_types','edit'))
  WITH CHECK (public.can_access_org_entity('task_types','edit'));
CREATE POLICY task_types_delete_rbac ON public.task_types FOR DELETE
  USING (public.can_access_org_entity('task_types','delete'));

-- ─── TRIGGERS audit cho các bảng có cột user_id ─────────────────────────────
CREATE TRIGGER ct01_declarations_set_user_id_audit BEFORE INSERT ON public.ct01_declarations
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER expenses_set_user_id_audit BEFORE INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER income_expense_batches_set_user_id_audit BEFORE INSERT ON public.income_expense_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER income_expense_templates_set_user_id_audit BEFORE INSERT ON public.income_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER income_expense_types_set_user_id_audit BEFORE INSERT ON public.income_expense_types
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER invoice_generation_settings_set_user_id_audit BEFORE INSERT ON public.invoice_generation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER issue_categories_set_user_id_audit BEFORE INSERT ON public.issue_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER issue_phase_history_set_user_id_audit BEFORE INSERT ON public.issue_phase_history
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER issue_status_history_set_user_id_audit BEFORE INSERT ON public.issue_status_history
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER notification_templates_set_user_id_audit BEFORE INSERT ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER scheduled_jobs_set_user_id_audit BEFORE INSERT ON public.scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER service_quotas_set_user_id_audit BEFORE INSERT ON public.service_quotas
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER sla_configs_set_user_id_audit BEFORE INSERT ON public.sla_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER suppliers_set_user_id_audit BEFORE INSERT ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER task_flows_set_user_id_audit BEFORE INSERT ON public.task_flows
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER task_types_set_user_id_audit BEFORE INSERT ON public.task_types
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
