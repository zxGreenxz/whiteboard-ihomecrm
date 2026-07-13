-- Sprint 3a — organization_id rollout to all business tables (GENERATED, ADDITIVE).
-- (AUTHORIZATION-PLAN.md §16.2–16.3) Derive org: parent (authoritative) > user_id
-- via membership > PROD default. NULLABLE (INSERT hiện tại chưa set). Inert.
-- 132 tables, topological order.
BEGIN;
SET LOCAL statement_timeout = '180s';

-- account_shared_users
ALTER TABLE public.account_shared_users ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.account_shared_users x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS account_shared_users_organization_id_idx ON public.account_shared_users(organization_id);

-- ai_chat_messages
ALTER TABLE public.ai_chat_messages ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_chat_messages x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_chat_messages_organization_id_idx ON public.ai_chat_messages(organization_id);

-- ai_chat_threads
ALTER TABLE public.ai_chat_threads ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_chat_threads x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_chat_threads_organization_id_idx ON public.ai_chat_threads(organization_id);

-- ai_copilot_entitlements
ALTER TABLE public.ai_copilot_entitlements ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_copilot_entitlements x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_copilot_entitlements_organization_id_idx ON public.ai_copilot_entitlements(organization_id);

-- ai_copilot_settings
ALTER TABLE public.ai_copilot_settings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_copilot_settings x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_copilot_settings_organization_id_idx ON public.ai_copilot_settings(organization_id);

-- ai_providers
ALTER TABLE public.ai_providers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_providers x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_providers_organization_id_idx ON public.ai_providers(organization_id);

-- ai_usage_logs
ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_usage_logs x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_usage_logs_organization_id_idx ON public.ai_usage_logs(organization_id);

-- ai_write_audit
ALTER TABLE public.ai_write_audit ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ai_write_audit x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_write_audit_organization_id_idx ON public.ai_write_audit(organization_id);

-- area_buildings
ALTER TABLE public.area_buildings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.area_buildings x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.areas p WHERE p.id = x.area_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS area_buildings_organization_id_idx ON public.area_buildings(organization_id);

-- asset_categories
ALTER TABLE public.asset_categories ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.asset_categories x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS asset_categories_organization_id_idx ON public.asset_categories(organization_id);

-- asset_warehouses
ALTER TABLE public.asset_warehouses ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.asset_warehouses x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS asset_warehouses_organization_id_idx ON public.asset_warehouses(organization_id);

-- auto_debt_config
ALTER TABLE public.auto_debt_config ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.auto_debt_config x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS auto_debt_config_organization_id_idx ON public.auto_debt_config(organization_id);

-- building_fee_accounts
ALTER TABLE public.building_fee_accounts ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.building_fee_accounts x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS building_fee_accounts_organization_id_idx ON public.building_fee_accounts(organization_id);

-- building_services
ALTER TABLE public.building_services ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.building_services x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS building_services_organization_id_idx ON public.building_services(organization_id);

-- building_shareholders
ALTER TABLE public.building_shareholders ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.building_shareholders x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS building_shareholders_organization_id_idx ON public.building_shareholders(organization_id);

-- building_utility_accounts
ALTER TABLE public.building_utility_accounts ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.building_utility_accounts x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS building_utility_accounts_organization_id_idx ON public.building_utility_accounts(organization_id);

-- cash_handover_items
ALTER TABLE public.cash_handover_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.cash_handover_items x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS cash_handover_items_organization_id_idx ON public.cash_handover_items(organization_id);

-- cash_handovers
ALTER TABLE public.cash_handovers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.cash_handovers x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS cash_handovers_organization_id_idx ON public.cash_handovers(organization_id);

-- cashbook_reconciliations
ALTER TABLE public.cashbook_reconciliations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.cashbook_reconciliations x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS cashbook_reconciliations_organization_id_idx ON public.cashbook_reconciliations(organization_id);

-- code_sequences
ALTER TABLE public.code_sequences ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.code_sequences x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS code_sequences_organization_id_idx ON public.code_sequences(organization_id);

-- cron_runs
ALTER TABLE public.cron_runs ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.cron_runs x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS cron_runs_organization_id_idx ON public.cron_runs(organization_id);

-- customers
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.customers x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS customers_organization_id_idx ON public.customers(organization_id);

-- demo_reset_log
ALTER TABLE public.demo_reset_log ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.demo_reset_log x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS demo_reset_log_organization_id_idx ON public.demo_reset_log(organization_id);

-- demo_reset_tables
ALTER TABLE public.demo_reset_tables ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.demo_reset_tables x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS demo_reset_tables_organization_id_idx ON public.demo_reset_tables(organization_id);

-- departments
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.departments x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS departments_organization_id_idx ON public.departments(organization_id);

-- document_templates
ALTER TABLE public.document_templates ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.document_templates x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS document_templates_organization_id_idx ON public.document_templates(organization_id);

-- floors
ALTER TABLE public.floors ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.floors x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS floors_organization_id_idx ON public.floors(organization_id);

-- hotlines
ALTER TABLE public.hotlines ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.hotlines x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS hotlines_organization_id_idx ON public.hotlines(organization_id);

-- income_expense_batches
ALTER TABLE public.income_expense_batches ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expense_batches x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expense_batches_organization_id_idx ON public.income_expense_batches(organization_id);

-- income_expense_templates
ALTER TABLE public.income_expense_templates ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expense_templates x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expense_templates_organization_id_idx ON public.income_expense_templates(organization_id);

-- income_expense_types
ALTER TABLE public.income_expense_types ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expense_types x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expense_types_organization_id_idx ON public.income_expense_types(organization_id);

-- inspection_photos
ALTER TABLE public.inspection_photos ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.inspection_photos x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS inspection_photos_organization_id_idx ON public.inspection_photos(organization_id);

-- invoice_generation_settings
ALTER TABLE public.invoice_generation_settings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.invoice_generation_settings x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS invoice_generation_settings_organization_id_idx ON public.invoice_generation_settings(organization_id);

-- issue_categories
ALTER TABLE public.issue_categories ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.issue_categories x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS issue_categories_organization_id_idx ON public.issue_categories(organization_id);

-- issue_comments
ALTER TABLE public.issue_comments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.issue_comments x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS issue_comments_organization_id_idx ON public.issue_comments(organization_id);

-- issue_phase_history
ALTER TABLE public.issue_phase_history ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.issue_phase_history x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS issue_phase_history_organization_id_idx ON public.issue_phase_history(organization_id);

-- issue_status_history
ALTER TABLE public.issue_status_history ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.issue_status_history x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS issue_status_history_organization_id_idx ON public.issue_status_history(organization_id);

-- job_groups
ALTER TABLE public.job_groups ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.job_groups x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS job_groups_organization_id_idx ON public.job_groups(organization_id);

-- job_types
ALTER TABLE public.job_types ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.job_types x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS job_types_organization_id_idx ON public.job_types(organization_id);

-- lead_activities
ALTER TABLE public.lead_activities ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.lead_activities x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS lead_activities_organization_id_idx ON public.lead_activities(organization_id);

-- material_adjustment_items
ALTER TABLE public.material_adjustment_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_adjustment_items x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_adjustment_items_organization_id_idx ON public.material_adjustment_items(organization_id);

-- material_adjustments
ALTER TABLE public.material_adjustments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_adjustments x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_adjustments_organization_id_idx ON public.material_adjustments(organization_id);

-- material_categories
ALTER TABLE public.material_categories ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_categories x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_categories_organization_id_idx ON public.material_categories(organization_id);

-- material_purchase_items
ALTER TABLE public.material_purchase_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_purchase_items x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_purchase_items_organization_id_idx ON public.material_purchase_items(organization_id);

-- material_purchases
ALTER TABLE public.material_purchases ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_purchases x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_purchases_organization_id_idx ON public.material_purchases(organization_id);

-- material_usage_items
ALTER TABLE public.material_usage_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_usage_items x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_usage_items_organization_id_idx ON public.material_usage_items(organization_id);

-- materials
ALTER TABLE public.materials ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.materials x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS materials_organization_id_idx ON public.materials(organization_id);

-- notification_logs
ALTER TABLE public.notification_logs ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.notification_logs x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS notification_logs_organization_id_idx ON public.notification_logs(organization_id);

-- notification_templates
ALTER TABLE public.notification_templates ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.notification_templates x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS notification_templates_organization_id_idx ON public.notification_templates(organization_id);

-- personal_transactions
ALTER TABLE public.personal_transactions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.personal_transactions x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS personal_transactions_organization_id_idx ON public.personal_transactions(organization_id);

-- phase_transitions
ALTER TABLE public.phase_transitions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.phase_transitions x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS phase_transitions_organization_id_idx ON public.phase_transitions(organization_id);

-- profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profiles x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profiles_organization_id_idx ON public.profiles(organization_id);

-- profit_allocations
ALTER TABLE public.profit_allocations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profit_allocations x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profit_allocations_organization_id_idx ON public.profit_allocations(organization_id);

-- profit_manager_allocations
ALTER TABLE public.profit_manager_allocations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profit_manager_allocations x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profit_manager_allocations_organization_id_idx ON public.profit_manager_allocations(organization_id);

-- profit_manager_salaries
ALTER TABLE public.profit_manager_salaries ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profit_manager_salaries x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profit_manager_salaries_organization_id_idx ON public.profit_manager_salaries(organization_id);

-- profit_manager_salary_buildings
ALTER TABLE public.profit_manager_salary_buildings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profit_manager_salary_buildings x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profit_manager_salary_buildings_organization_id_idx ON public.profit_manager_salary_buildings(organization_id);

-- profit_managers
ALTER TABLE public.profit_managers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profit_managers x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profit_managers_organization_id_idx ON public.profit_managers(organization_id);

-- profit_monthly
ALTER TABLE public.profit_monthly ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profit_monthly x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profit_monthly_organization_id_idx ON public.profit_monthly(organization_id);

-- public_room_settings
ALTER TABLE public.public_room_settings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.public_room_settings x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS public_room_settings_organization_id_idx ON public.public_room_settings(organization_id);

-- public_room_share_tokens
ALTER TABLE public.public_room_share_tokens ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.public_room_share_tokens x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS public_room_share_tokens_organization_id_idx ON public.public_room_share_tokens(organization_id);

-- push_subscriptions
ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.push_subscriptions x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS push_subscriptions_organization_id_idx ON public.push_subscriptions(organization_id);

-- rooms
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.rooms x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS rooms_organization_id_idx ON public.rooms(organization_id);

-- salary_attendance_day
ALTER TABLE public.salary_attendance_day ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_attendance_day x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_attendance_day_organization_id_idx ON public.salary_attendance_day(organization_id);

-- salary_award_errors
ALTER TABLE public.salary_award_errors ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_award_errors x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_award_errors_organization_id_idx ON public.salary_award_errors(organization_id);

-- salary_bonus_rules
ALTER TABLE public.salary_bonus_rules ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_bonus_rules x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_bonus_rules_organization_id_idx ON public.salary_bonus_rules(organization_id);

-- salary_holidays
ALTER TABLE public.salary_holidays ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_holidays x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_holidays_organization_id_idx ON public.salary_holidays(organization_id);

-- salary_monthly
ALTER TABLE public.salary_monthly ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_monthly x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_monthly_organization_id_idx ON public.salary_monthly(organization_id);

-- salary_streak_state
ALTER TABLE public.salary_streak_state ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_streak_state x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_streak_state_organization_id_idx ON public.salary_streak_state(organization_id);

-- salary_work_ledger_snapshot
ALTER TABLE public.salary_work_ledger_snapshot ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_work_ledger_snapshot x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_work_ledger_snapshot_organization_id_idx ON public.salary_work_ledger_snapshot(organization_id);

-- scheduled_jobs
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.scheduled_jobs x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS scheduled_jobs_organization_id_idx ON public.scheduled_jobs(organization_id);

-- service_quota_tiers
ALTER TABLE public.service_quota_tiers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.service_quota_tiers x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS service_quota_tiers_organization_id_idx ON public.service_quota_tiers(organization_id);

-- service_quotas
ALTER TABLE public.service_quotas ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.service_quotas x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS service_quotas_organization_id_idx ON public.service_quotas(organization_id);

-- services
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.services x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS services_organization_id_idx ON public.services(organization_id);

-- settings
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.settings x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS settings_organization_id_idx ON public.settings(organization_id);

-- shareholders
ALTER TABLE public.shareholders ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.shareholders x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS shareholders_organization_id_idx ON public.shareholders(organization_id);

-- signature_templates
ALTER TABLE public.signature_templates ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.signature_templates x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS signature_templates_organization_id_idx ON public.signature_templates(organization_id);

-- sla_configs
ALTER TABLE public.sla_configs ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.sla_configs x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS sla_configs_organization_id_idx ON public.sla_configs(organization_id);

-- staff_assignments
ALTER TABLE public.staff_assignments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.staff_assignments x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.areas p WHERE p.id = x.area_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS staff_assignments_organization_id_idx ON public.staff_assignments(organization_id);

-- subscription_plans
ALTER TABLE public.subscription_plans ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.subscription_plans x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS subscription_plans_organization_id_idx ON public.subscription_plans(organization_id);

-- super_admins
ALTER TABLE public.super_admins ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.super_admins x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS super_admins_organization_id_idx ON public.super_admins(organization_id);

-- suppliers
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.suppliers x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS suppliers_organization_id_idx ON public.suppliers(organization_id);

-- task_flows
ALTER TABLE public.task_flows ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.task_flows x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS task_flows_organization_id_idx ON public.task_flows(organization_id);

-- task_phases
ALTER TABLE public.task_phases ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.task_phases x SET organization_id = COALESCE(
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS task_phases_organization_id_idx ON public.task_phases(organization_id);

-- task_types
ALTER TABLE public.task_types ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.task_types x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS task_types_organization_id_idx ON public.task_types(organization_id);

-- team_members
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.team_members x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS team_members_organization_id_idx ON public.team_members(organization_id);

-- teams
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.teams x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS teams_organization_id_idx ON public.teams(organization_id);

-- tenants
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.tenants x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS tenants_organization_id_idx ON public.tenants(organization_id);

-- user_roles
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.user_roles x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS user_roles_organization_id_idx ON public.user_roles(organization_id);

-- user_subscriptions
ALTER TABLE public.user_subscriptions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.user_subscriptions x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS user_subscriptions_organization_id_idx ON public.user_subscriptions(organization_id);

-- zalo_accounts
ALTER TABLE public.zalo_accounts ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_accounts x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_accounts_organization_id_idx ON public.zalo_accounts(organization_id);

-- zalo_automations
ALTER TABLE public.zalo_automations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_automations x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_automations_organization_id_idx ON public.zalo_automations(organization_id);

-- zalo_labels
ALTER TABLE public.zalo_labels ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_labels x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_labels_organization_id_idx ON public.zalo_labels(organization_id);

-- zalo_message_templates
ALTER TABLE public.zalo_message_templates ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_message_templates x SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_message_templates_organization_id_idx ON public.zalo_message_templates(organization_id);

-- zalo_messages
ALTER TABLE public.zalo_messages ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_messages x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_messages_organization_id_idx ON public.zalo_messages(organization_id);

-- zalo_send_queue
ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_send_queue x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_send_queue_organization_id_idx ON public.zalo_send_queue(organization_id);

-- assets
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.assets x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS assets_organization_id_idx ON public.assets(organization_id);

-- contracts
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contracts x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.tenants p WHERE p.id = x.tenant_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contracts_organization_id_idx ON public.contracts(organization_id);

-- ct01_declarations
ALTER TABLE public.ct01_declarations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.ct01_declarations x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.customers p WHERE p.id = x.customer_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS ct01_declarations_organization_id_idx ON public.ct01_declarations(organization_id);

-- deposits
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.deposits x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.tenants p WHERE p.id = x.tenant_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS deposits_organization_id_idx ON public.deposits(organization_id);

-- excess_amounts
ALTER TABLE public.excess_amounts ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.excess_amounts x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS excess_amounts_organization_id_idx ON public.excess_amounts(organization_id);

-- expenses
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.expenses x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS expenses_organization_id_idx ON public.expenses(organization_id);

-- invoices
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.invoices x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS invoices_organization_id_idx ON public.invoices(organization_id);

-- issues
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.issues x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS issues_organization_id_idx ON public.issues(organization_id);

-- jobs
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.jobs x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS jobs_organization_id_idx ON public.jobs(organization_id);

-- leads
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.leads x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.deposits p WHERE p.id = x.deposit_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS leads_organization_id_idx ON public.leads(organization_id);

-- manager_salary_config
ALTER TABLE public.manager_salary_config ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.manager_salary_config x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS manager_salary_config_organization_id_idx ON public.manager_salary_config(organization_id);

-- material_usages
ALTER TABLE public.material_usages ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.material_usages x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.jobs p WHERE p.id = x.job_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS material_usages_organization_id_idx ON public.material_usages(organization_id);

-- meters
ALTER TABLE public.meters ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.meters x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS meters_organization_id_idx ON public.meters(organization_id);

-- notifications
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.notifications x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.invoices p WHERE p.id = x.invoice_id),
    (SELECT p.organization_id FROM public.jobs p WHERE p.id = x.job_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS notifications_organization_id_idx ON public.notifications(organization_id);

-- payments
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.payments x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.invoices p WHERE p.id = x.invoice_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS payments_organization_id_idx ON public.payments(organization_id);

-- public_room_events
ALTER TABLE public.public_room_events ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.public_room_events x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS public_room_events_organization_id_idx ON public.public_room_events(organization_id);

-- room_pass_listings
ALTER TABLE public.room_pass_listings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.room_pass_listings x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS room_pass_listings_organization_id_idx ON public.room_pass_listings(organization_id);

-- vehicles
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.vehicles x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.customers p WHERE p.id = x.customer_id),
    (SELECT p.organization_id FROM public.tenants p WHERE p.id = x.tenant_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS vehicles_organization_id_idx ON public.vehicles(organization_id);

-- zalo_conversations
ALTER TABLE public.zalo_conversations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.zalo_conversations x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    (SELECT p.organization_id FROM public.customers p WHERE p.id = x.customer_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_conversations_organization_id_idx ON public.zalo_conversations(organization_id);

-- asset_handovers
ALTER TABLE public.asset_handovers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.asset_handovers x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS asset_handovers_organization_id_idx ON public.asset_handovers(organization_id);

-- asset_maintenance
ALTER TABLE public.asset_maintenance ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.asset_maintenance x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.assets p WHERE p.id = x.asset_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS asset_maintenance_organization_id_idx ON public.asset_maintenance(organization_id);

-- asset_movements
ALTER TABLE public.asset_movements ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.asset_movements x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.assets p WHERE p.id = x.asset_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS asset_movements_organization_id_idx ON public.asset_movements(organization_id);

-- contract_customers
ALTER TABLE public.contract_customers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contract_customers x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.customers p WHERE p.id = x.customer_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_customers_organization_id_idx ON public.contract_customers(organization_id);

-- contract_extensions
ALTER TABLE public.contract_extensions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contract_extensions x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_extensions_organization_id_idx ON public.contract_extensions(organization_id);

-- contract_services
ALTER TABLE public.contract_services ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contract_services x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_services_organization_id_idx ON public.contract_services(organization_id);

-- contract_tenants
ALTER TABLE public.contract_tenants ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contract_tenants x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.tenants p WHERE p.id = x.tenant_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_tenants_organization_id_idx ON public.contract_tenants(organization_id);

-- contract_terminations
ALTER TABLE public.contract_terminations ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contract_terminations x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_terminations_organization_id_idx ON public.contract_terminations(organization_id);

-- contract_transfers
ALTER TABLE public.contract_transfers ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.contract_transfers x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_transfers_organization_id_idx ON public.contract_transfers(organization_id);

-- income_expenses
ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expenses x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.invoices p WHERE p.id = x.invoice_id),
    (SELECT p.organization_id FROM public.payments p WHERE p.id = x.payment_id),
    (SELECT p.organization_id FROM public.accounts p WHERE p.id = x.account_id),
    (SELECT p.organization_id FROM public.tenants p WHERE p.id = x.tenant_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expenses_organization_id_idx ON public.income_expenses(organization_id);

-- inspection_sessions
ALTER TABLE public.inspection_sessions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.inspection_sessions x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.jobs p WHERE p.id = x.job_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS inspection_sessions_organization_id_idx ON public.inspection_sessions(organization_id);

-- invoice_audit_log
ALTER TABLE public.invoice_audit_log ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.invoice_audit_log x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.invoices p WHERE p.id = x.invoice_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS invoice_audit_log_organization_id_idx ON public.invoice_audit_log(organization_id);

-- invoice_items
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.invoice_items x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.invoices p WHERE p.id = x.invoice_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS invoice_items_organization_id_idx ON public.invoice_items(organization_id);

-- meter_readings
ALTER TABLE public.meter_readings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.meter_readings x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.buildings p WHERE p.id = x.building_id),
    (SELECT p.organization_id FROM public.rooms p WHERE p.id = x.room_id),
    (SELECT p.organization_id FROM public.contracts p WHERE p.id = x.contract_id),
    (SELECT p.organization_id FROM public.meters p WHERE p.id = x.meter_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS meter_readings_organization_id_idx ON public.meter_readings(organization_id);

-- salary_adjustments
ALTER TABLE public.salary_adjustments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.salary_adjustments x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.income_expenses p WHERE p.id = x.income_expense_id),
    (SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.user_id AND m.status='ACTIVE' LIMIT 1),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS salary_adjustments_organization_id_idx ON public.salary_adjustments(organization_id);

-- income_expense_audit_log
ALTER TABLE public.income_expense_audit_log ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expense_audit_log x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.income_expenses p WHERE p.id = x.income_expense_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expense_audit_log_organization_id_idx ON public.income_expense_audit_log(organization_id);

-- income_expense_batch_items
ALTER TABLE public.income_expense_batch_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expense_batch_items x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.income_expenses p WHERE p.id = x.income_expense_id),
    (SELECT p.organization_id FROM public.income_expense_batches p WHERE p.id = x.batch_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expense_batch_items_organization_id_idx ON public.income_expense_batch_items(organization_id);

-- income_expense_items
ALTER TABLE public.income_expense_items ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.income_expense_items x SET organization_id = COALESCE(
    (SELECT p.organization_id FROM public.income_expenses p WHERE p.id = x.income_expense_id),
    'aaaa0000-0000-4000-8000-000000000001'::uuid
  ) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS income_expense_items_organization_id_idx ON public.income_expense_items(organization_id);

-- profiles (PK id = auth user id)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT;
UPDATE public.profiles x SET organization_id = COALESCE((SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id = x.id AND m.status='ACTIVE' LIMIT 1), 'aaaa0000-0000-4000-8000-000000000001'::uuid) WHERE x.organization_id IS NULL;
CREATE INDEX IF NOT EXISTS profiles_organization_id_idx ON public.profiles(organization_id);

COMMIT;
