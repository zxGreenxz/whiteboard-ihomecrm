-- =============================================================================
-- GĐ3 — Rào biên giới tổ chức cho 251 bảng ĐÃ ĐO là an toàn
--
-- SINH BẰNG MÁY: node scripts/sinh-migration-org-boundary.mjs
-- Nguồn: docs/generated/org-boundary-inventory.json (chụp 2026-08-07T17:08:24.839Z)
-- Phân bố: A_RONG=204 · B_KHONG_CAP_QUYEN=5 · C_DA_KIN=42
--
-- VÌ SAO NHÓM NÀY KHÔNG THỂ GÂY HỒI QUY.
-- Mỗi bảng dưới đây đã được ĐO trên production bằng vai người dùng thật của ba
-- tổ chức (scripts/measure-org-leak.mjs, 4 chốt chống ảo giác đạt cho từng vai),
-- và rơi vào đúng một trong ba tình huống:
--   • rỗng — gắn biên giới không lấy mất của ai dòng nào;
--   • authenticated không có quyền SELECT — RLS đã chặn từ tầng trên;
--   • có dữ liệu, đọc được, nhưng 0 dòng của tổ chức khác — đã kín bằng đường
--     khác (theo toà, theo người), nên đây là siết chồng chứ không phải siết mới.
--
-- Bảng ĐANG RÒ THẬT nằm ở giai đoạn sau, không có trong file này — vá chúng cần
-- xét từng đường đọc đang phụ thuộc vào chỗ hở.
--
-- Công thức nguyên văn Sprint 3b (20260713121000), RESTRICTIVE = chỉ siết:
--   organization_id IS NULL OR is_super_admin() OR organization_id IN my_org_ids()
-- Nhánh IS NULL giữ đúng parity với 32 bảng đã có; nó sẽ được đóng ở GĐ6 sau khi
-- backfill, không đóng ở đây kẻo lệch công thức giữa các bảng.
--
-- Idempotent: DROP POLICY IF EXISTS trước CREATE.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE v_thieu text;
BEGIN
  -- Mọi bảng trong file phải còn tồn tại và còn cột organization_id. Lệch là
  -- inventory đã cũ so với production — dừng chứ không đoán.
  SELECT string_agg(t, ', ') INTO v_thieu FROM unnest(ARRAY[
    'account_shared_users',
    'accounting_integrity_exceptions',
    'accounting_repair_audit',
    'ai_copilot_entitlements',
    'ai_usage_logs',
    'ai_write_audit',
    'approval_decisions',
    'approval_request_step_candidates',
    'approval_request_steps',
    'approval_requests',
    'approval_rule_sets',
    'approval_rule_steps',
    'approval_rules',
    'approval_step_approvers',
    'area_buildings',
    'areas',
    'asset_categories',
    'asset_handovers',
    'asset_maintenance',
    'asset_warehouses',
    'authorization_audit_events',
    'authorization_scopes',
    'auto_debt_config',
    'building_fee_accounts',
    'building_shareholders',
    'building_utility_accounts',
    'buildings',
    'cash_handover_items',
    'cash_handovers',
    'cashbook_possession_bindings',
    'cashbook_reconciliations',
    'code_sequences',
    'contract_deposit_links',
    'cron_runs',
    'ct01_declarations',
    'customer_credit_applications',
    'customer_credit_lots',
    'demo_reset_log',
    'demo_reset_tables',
    'departments',
    'expenses',
    'finance_contract_month_snapshots',
    'finance_evidence_objects',
    'finance_evidence_system_sources',
    'finance_invoice_component_allocations',
    'finance_invoice_component_manifests',
    'finance_invoice_components',
    'finance_month_snapshot_runs',
    'finance_reporting_role_assignments',
    'finance_room_month_snapshots',
    'hotlines',
    'income_expense_audit_log',
    'income_expense_posting_evidence',
    'income_expense_posting_lines',
    'income_expense_postings',
    'income_expense_recognition_adjustments',
    'income_expense_templates',
    'income_expense_type_merge_audit',
    'inspection_photos',
    'inspection_sessions',
    'invoice_audit_log',
    'invoice_generation_settings',
    'invoice_payment_allocations',
    'invoice_payment_collections',
    'invoice_payment_tenders',
    'issue_categories',
    'issue_comments',
    'issue_phase_history',
    'issue_status_history',
    'issues',
    'lead_activities',
    'legacy_owner_organization_map',
    'lucky_events',
    'manager_salary_config',
    'member_override_scopes',
    'member_permission_overrides',
    'network_audit_events',
    'network_client_current',
    'network_client_links',
    'network_client_sessions',
    'network_command_attempts',
    'network_command_events',
    'network_command_observations',
    'network_commands',
    'network_config_snapshots',
    'network_desired_state_versions',
    'network_device_connections',
    'network_device_current',
    'network_device_leases',
    'network_device_samples',
    'network_devices',
    'network_incident_events',
    'network_incidents',
    'network_interface_current',
    'network_interface_samples',
    'network_interfaces',
    'network_maintenance_windows',
    'network_managed_resources',
    'network_metric_hourly',
    'network_org_mutation_gates',
    'network_outbox_events',
    'network_site_settings',
    'network_sla_daily',
    'network_worker_assignments',
    'network_worker_building_status',
    'notification_logs',
    'notification_templates',
    'openclaw_account_connections',
    'openclaw_accounts',
    'openclaw_ai_drafts',
    'openclaw_audit_events',
    'openclaw_audit_gateway_tickets',
    'openclaw_audit_roots',
    'openclaw_audit_signing_configs',
    'openclaw_automation_versions',
    'openclaw_automations',
    'openclaw_campaign_runs',
    'openclaw_campaigns',
    'openclaw_capacity_controls',
    'openclaw_cell_rebinds',
    'openclaw_client_operations',
    'openclaw_consents',
    'openclaw_contacts',
    'openclaw_control_states',
    'openclaw_conversation_members',
    'openclaw_conversations',
    'openclaw_crm_event_occurrences',
    'openclaw_crm_event_subscription_snapshots',
    'openclaw_crm_event_subscriptions',
    'openclaw_dead_letters',
    'openclaw_delivery_attempts',
    'openclaw_generation_revocations',
    'openclaw_health_events',
    'openclaw_inbound_automation_decisions',
    'openclaw_inbound_collisions',
    'openclaw_inbound_events',
    'openclaw_inbound_provider_identities',
    'openclaw_knowledge_chunks',
    'openclaw_knowledge_sources',
    'openclaw_knowledge_versions',
    'openclaw_maintenance_credentials',
    'openclaw_maintenance_leases',
    'openclaw_maintenance_principals',
    'openclaw_maintenance_work_attempts',
    'openclaw_maintenance_work_items',
    'openclaw_media_upload_tickets',
    'openclaw_message_media',
    'openclaw_messages',
    'openclaw_outbound_authorizations',
    'openclaw_outbox',
    'openclaw_policies',
    'openclaw_policy_versions',
    'openclaw_qr_challenges',
    'openclaw_retention_delete_authorizations',
    'openclaw_retention_delete_ticket_lineage',
    'openclaw_retention_delete_tickets',
    'openclaw_retention_evidence_seals',
    'openclaw_retention_gateway_configs',
    'openclaw_retention_hold_clocks',
    'openclaw_retention_hold_scopes',
    'openclaw_retention_holds',
    'openclaw_retention_policies',
    'openclaw_retention_tombstones',
    'openclaw_rollout_checkpoints',
    'openclaw_rollout_observations',
    'openclaw_rollout_runs',
    'openclaw_runtime_cells',
    'openclaw_runtime_commands',
    'openclaw_runtime_credentials',
    'openclaw_runtime_leases',
    'openclaw_sales_group_allowlists',
    'openclaw_sales_groups',
    'openclaw_schedule_occurrences',
    'openclaw_schedule_snapshots',
    'openclaw_schedules',
    'openclaw_send_work_attempts',
    'openclaw_send_work_items',
    'openclaw_service_nonces',
    'openclaw_smoke_cleanup_proofs',
    'openclaw_smoke_observations',
    'openclaw_smoke_runs',
    'openclaw_suppressions',
    'openclaw_takeovers',
    'openclaw_targets',
    'openclaw_unknown_resolutions',
    'openclaw_watchdog_envelope_nonces',
    'organization_invitations',
    'organization_invoice_settings',
    'organization_memberships',
    'organization_roles',
    'organization_timezones',
    'personal_transactions',
    'phase_transitions',
    'profit_allocations',
    'profit_close_revisions',
    'profit_close_runs',
    'profit_manager_allocations',
    'profit_manager_salaries',
    'profit_manager_salary_buildings',
    'profit_managers',
    'profit_monthly',
    'profit_payout_exceptions',
    'profit_payout_reservations',
    'profit_unallocated_decisions',
    'public_room_settings',
    'public_room_share_tokens',
    'push_subscriptions',
    'role_binding_scopes',
    'role_bindings',
    'role_permissions',
    'room_pass_listings',
    'room_reservation_holds',
    'salary_adjustments',
    'salary_attendance_day',
    'salary_award_errors',
    'salary_bonus_rules',
    'salary_cash_authorizations',
    'salary_earning_consumptions',
    'salary_holidays',
    'salary_monthly',
    'salary_settlement_bundles',
    'salary_settlement_tranches',
    'salary_streak_state',
    'salary_work_ledger_snapshot',
    'scheduled_jobs',
    'service_quota_tiers',
    'service_quotas',
    'shareholders',
    'signature_templates',
    'special_fee_claims',
    'staff_assignments',
    'subscription_plans',
    'super_admins',
    'suppliers',
    'task_flows',
    'task_phases',
    'task_types',
    'team_members',
    'teams',
    'termination_move_out_authorizations',
    'termination_move_out_settlement_lines',
    'termination_refund_obligations',
    'user_roles',
    'user_subscriptions',
    'zalo_accounts',
    'zalo_automations',
    'zalo_conversations',
    'zalo_labels',
    'zalo_message_templates',
    'zalo_messages',
    'zalo_send_queue'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                         AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t
  );
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Không thấy (hoặc mất cột organization_id): %. Inventory đã cũ so với production. DỪNG.', v_thieu;
  END IF;

  -- Không bảng nào trong file được nằm trong sổ miễn trừ.
  SELECT string_agg(e.table_name, ', ') INTO v_thieu
    FROM app_private.org_boundary_exemptions e
   WHERE e.table_name = ANY(ARRAY[
    'account_shared_users',
    'accounting_integrity_exceptions',
    'accounting_repair_audit',
    'ai_copilot_entitlements',
    'ai_usage_logs',
    'ai_write_audit',
    'approval_decisions',
    'approval_request_step_candidates',
    'approval_request_steps',
    'approval_requests',
    'approval_rule_sets',
    'approval_rule_steps',
    'approval_rules',
    'approval_step_approvers',
    'area_buildings',
    'areas',
    'asset_categories',
    'asset_handovers',
    'asset_maintenance',
    'asset_warehouses',
    'authorization_audit_events',
    'authorization_scopes',
    'auto_debt_config',
    'building_fee_accounts',
    'building_shareholders',
    'building_utility_accounts',
    'buildings',
    'cash_handover_items',
    'cash_handovers',
    'cashbook_possession_bindings',
    'cashbook_reconciliations',
    'code_sequences',
    'contract_deposit_links',
    'cron_runs',
    'ct01_declarations',
    'customer_credit_applications',
    'customer_credit_lots',
    'demo_reset_log',
    'demo_reset_tables',
    'departments',
    'expenses',
    'finance_contract_month_snapshots',
    'finance_evidence_objects',
    'finance_evidence_system_sources',
    'finance_invoice_component_allocations',
    'finance_invoice_component_manifests',
    'finance_invoice_components',
    'finance_month_snapshot_runs',
    'finance_reporting_role_assignments',
    'finance_room_month_snapshots',
    'hotlines',
    'income_expense_audit_log',
    'income_expense_posting_evidence',
    'income_expense_posting_lines',
    'income_expense_postings',
    'income_expense_recognition_adjustments',
    'income_expense_templates',
    'income_expense_type_merge_audit',
    'inspection_photos',
    'inspection_sessions',
    'invoice_audit_log',
    'invoice_generation_settings',
    'invoice_payment_allocations',
    'invoice_payment_collections',
    'invoice_payment_tenders',
    'issue_categories',
    'issue_comments',
    'issue_phase_history',
    'issue_status_history',
    'issues',
    'lead_activities',
    'legacy_owner_organization_map',
    'lucky_events',
    'manager_salary_config',
    'member_override_scopes',
    'member_permission_overrides',
    'network_audit_events',
    'network_client_current',
    'network_client_links',
    'network_client_sessions',
    'network_command_attempts',
    'network_command_events',
    'network_command_observations',
    'network_commands',
    'network_config_snapshots',
    'network_desired_state_versions',
    'network_device_connections',
    'network_device_current',
    'network_device_leases',
    'network_device_samples',
    'network_devices',
    'network_incident_events',
    'network_incidents',
    'network_interface_current',
    'network_interface_samples',
    'network_interfaces',
    'network_maintenance_windows',
    'network_managed_resources',
    'network_metric_hourly',
    'network_org_mutation_gates',
    'network_outbox_events',
    'network_site_settings',
    'network_sla_daily',
    'network_worker_assignments',
    'network_worker_building_status',
    'notification_logs',
    'notification_templates',
    'openclaw_account_connections',
    'openclaw_accounts',
    'openclaw_ai_drafts',
    'openclaw_audit_events',
    'openclaw_audit_gateway_tickets',
    'openclaw_audit_roots',
    'openclaw_audit_signing_configs',
    'openclaw_automation_versions',
    'openclaw_automations',
    'openclaw_campaign_runs',
    'openclaw_campaigns',
    'openclaw_capacity_controls',
    'openclaw_cell_rebinds',
    'openclaw_client_operations',
    'openclaw_consents',
    'openclaw_contacts',
    'openclaw_control_states',
    'openclaw_conversation_members',
    'openclaw_conversations',
    'openclaw_crm_event_occurrences',
    'openclaw_crm_event_subscription_snapshots',
    'openclaw_crm_event_subscriptions',
    'openclaw_dead_letters',
    'openclaw_delivery_attempts',
    'openclaw_generation_revocations',
    'openclaw_health_events',
    'openclaw_inbound_automation_decisions',
    'openclaw_inbound_collisions',
    'openclaw_inbound_events',
    'openclaw_inbound_provider_identities',
    'openclaw_knowledge_chunks',
    'openclaw_knowledge_sources',
    'openclaw_knowledge_versions',
    'openclaw_maintenance_credentials',
    'openclaw_maintenance_leases',
    'openclaw_maintenance_principals',
    'openclaw_maintenance_work_attempts',
    'openclaw_maintenance_work_items',
    'openclaw_media_upload_tickets',
    'openclaw_message_media',
    'openclaw_messages',
    'openclaw_outbound_authorizations',
    'openclaw_outbox',
    'openclaw_policies',
    'openclaw_policy_versions',
    'openclaw_qr_challenges',
    'openclaw_retention_delete_authorizations',
    'openclaw_retention_delete_ticket_lineage',
    'openclaw_retention_delete_tickets',
    'openclaw_retention_evidence_seals',
    'openclaw_retention_gateway_configs',
    'openclaw_retention_hold_clocks',
    'openclaw_retention_hold_scopes',
    'openclaw_retention_holds',
    'openclaw_retention_policies',
    'openclaw_retention_tombstones',
    'openclaw_rollout_checkpoints',
    'openclaw_rollout_observations',
    'openclaw_rollout_runs',
    'openclaw_runtime_cells',
    'openclaw_runtime_commands',
    'openclaw_runtime_credentials',
    'openclaw_runtime_leases',
    'openclaw_sales_group_allowlists',
    'openclaw_sales_groups',
    'openclaw_schedule_occurrences',
    'openclaw_schedule_snapshots',
    'openclaw_schedules',
    'openclaw_send_work_attempts',
    'openclaw_send_work_items',
    'openclaw_service_nonces',
    'openclaw_smoke_cleanup_proofs',
    'openclaw_smoke_observations',
    'openclaw_smoke_runs',
    'openclaw_suppressions',
    'openclaw_takeovers',
    'openclaw_targets',
    'openclaw_unknown_resolutions',
    'openclaw_watchdog_envelope_nonces',
    'organization_invitations',
    'organization_invoice_settings',
    'organization_memberships',
    'organization_roles',
    'organization_timezones',
    'personal_transactions',
    'phase_transitions',
    'profit_allocations',
    'profit_close_revisions',
    'profit_close_runs',
    'profit_manager_allocations',
    'profit_manager_salaries',
    'profit_manager_salary_buildings',
    'profit_managers',
    'profit_monthly',
    'profit_payout_exceptions',
    'profit_payout_reservations',
    'profit_unallocated_decisions',
    'public_room_settings',
    'public_room_share_tokens',
    'push_subscriptions',
    'role_binding_scopes',
    'role_bindings',
    'role_permissions',
    'room_pass_listings',
    'room_reservation_holds',
    'salary_adjustments',
    'salary_attendance_day',
    'salary_award_errors',
    'salary_bonus_rules',
    'salary_cash_authorizations',
    'salary_earning_consumptions',
    'salary_holidays',
    'salary_monthly',
    'salary_settlement_bundles',
    'salary_settlement_tranches',
    'salary_streak_state',
    'salary_work_ledger_snapshot',
    'scheduled_jobs',
    'service_quota_tiers',
    'service_quotas',
    'shareholders',
    'signature_templates',
    'special_fee_claims',
    'staff_assignments',
    'subscription_plans',
    'super_admins',
    'suppliers',
    'task_flows',
    'task_phases',
    'task_types',
    'team_members',
    'teams',
    'termination_move_out_authorizations',
    'termination_move_out_settlement_lines',
    'termination_refund_obligations',
    'user_roles',
    'user_subscriptions',
    'zalo_accounts',
    'zalo_automations',
    'zalo_conversations',
    'zalo_labels',
    'zalo_message_templates',
    'zalo_messages',
    'zalo_send_queue'
  ]);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Bảng vừa nằm trong sổ miễn trừ vừa bị rào ở đây: %. DỪNG.', v_thieu;
  END IF;
END
$preflight$;

-- ─── A_RONG: bảng rỗng — không có dòng nào để mất (204 bảng) ───
DROP POLICY IF EXISTS account_shared_users_org_boundary ON public.account_shared_users;
CREATE POLICY account_shared_users_org_boundary ON public.account_shared_users
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS ai_copilot_entitlements_org_boundary ON public.ai_copilot_entitlements;
CREATE POLICY ai_copilot_entitlements_org_boundary ON public.ai_copilot_entitlements
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS ai_usage_logs_org_boundary ON public.ai_usage_logs;
CREATE POLICY ai_usage_logs_org_boundary ON public.ai_usage_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS ai_write_audit_org_boundary ON public.ai_write_audit;
CREATE POLICY ai_write_audit_org_boundary ON public.ai_write_audit
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_decisions_org_boundary ON public.approval_decisions;
CREATE POLICY approval_decisions_org_boundary ON public.approval_decisions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_request_step_candidates_org_boundary ON public.approval_request_step_candidates;
CREATE POLICY approval_request_step_candidates_org_boundary ON public.approval_request_step_candidates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_request_steps_org_boundary ON public.approval_request_steps;
CREATE POLICY approval_request_steps_org_boundary ON public.approval_request_steps
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_requests_org_boundary ON public.approval_requests;
CREATE POLICY approval_requests_org_boundary ON public.approval_requests
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_rule_sets_org_boundary ON public.approval_rule_sets;
CREATE POLICY approval_rule_sets_org_boundary ON public.approval_rule_sets
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_step_approvers_org_boundary ON public.approval_step_approvers;
CREATE POLICY approval_step_approvers_org_boundary ON public.approval_step_approvers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS asset_categories_org_boundary ON public.asset_categories;
CREATE POLICY asset_categories_org_boundary ON public.asset_categories
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS asset_handovers_org_boundary ON public.asset_handovers;
CREATE POLICY asset_handovers_org_boundary ON public.asset_handovers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS asset_maintenance_org_boundary ON public.asset_maintenance;
CREATE POLICY asset_maintenance_org_boundary ON public.asset_maintenance
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS asset_warehouses_org_boundary ON public.asset_warehouses;
CREATE POLICY asset_warehouses_org_boundary ON public.asset_warehouses
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS authorization_audit_events_org_boundary ON public.authorization_audit_events;
CREATE POLICY authorization_audit_events_org_boundary ON public.authorization_audit_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS authorization_scopes_org_boundary ON public.authorization_scopes;
CREATE POLICY authorization_scopes_org_boundary ON public.authorization_scopes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS auto_debt_config_org_boundary ON public.auto_debt_config;
CREATE POLICY auto_debt_config_org_boundary ON public.auto_debt_config
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS cashbook_possession_bindings_org_boundary ON public.cashbook_possession_bindings;
CREATE POLICY cashbook_possession_bindings_org_boundary ON public.cashbook_possession_bindings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS cashbook_reconciliations_org_boundary ON public.cashbook_reconciliations;
CREATE POLICY cashbook_reconciliations_org_boundary ON public.cashbook_reconciliations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS code_sequences_org_boundary ON public.code_sequences;
CREATE POLICY code_sequences_org_boundary ON public.code_sequences
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS cron_runs_org_boundary ON public.cron_runs;
CREATE POLICY cron_runs_org_boundary ON public.cron_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS demo_reset_log_org_boundary ON public.demo_reset_log;
CREATE POLICY demo_reset_log_org_boundary ON public.demo_reset_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS demo_reset_tables_org_boundary ON public.demo_reset_tables;
CREATE POLICY demo_reset_tables_org_boundary ON public.demo_reset_tables
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS departments_org_boundary ON public.departments;
CREATE POLICY departments_org_boundary ON public.departments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS expenses_org_boundary ON public.expenses;
CREATE POLICY expenses_org_boundary ON public.expenses
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_contract_month_snapshots_org_boundary ON public.finance_contract_month_snapshots;
CREATE POLICY finance_contract_month_snapshots_org_boundary ON public.finance_contract_month_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_evidence_system_sources_org_boundary ON public.finance_evidence_system_sources;
CREATE POLICY finance_evidence_system_sources_org_boundary ON public.finance_evidence_system_sources
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_invoice_component_allocations_org_boundary ON public.finance_invoice_component_allocations;
CREATE POLICY finance_invoice_component_allocations_org_boundary ON public.finance_invoice_component_allocations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_invoice_component_manifests_org_boundary ON public.finance_invoice_component_manifests;
CREATE POLICY finance_invoice_component_manifests_org_boundary ON public.finance_invoice_component_manifests
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_invoice_components_org_boundary ON public.finance_invoice_components;
CREATE POLICY finance_invoice_components_org_boundary ON public.finance_invoice_components
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_month_snapshot_runs_org_boundary ON public.finance_month_snapshot_runs;
CREATE POLICY finance_month_snapshot_runs_org_boundary ON public.finance_month_snapshot_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_reporting_role_assignments_org_boundary ON public.finance_reporting_role_assignments;
CREATE POLICY finance_reporting_role_assignments_org_boundary ON public.finance_reporting_role_assignments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_room_month_snapshots_org_boundary ON public.finance_room_month_snapshots;
CREATE POLICY finance_room_month_snapshots_org_boundary ON public.finance_room_month_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS hotlines_org_boundary ON public.hotlines;
CREATE POLICY hotlines_org_boundary ON public.hotlines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_posting_evidence_org_boundary ON public.income_expense_posting_evidence;
CREATE POLICY income_expense_posting_evidence_org_boundary ON public.income_expense_posting_evidence
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_recognition_adjustments_org_boundary ON public.income_expense_recognition_adjustments;
CREATE POLICY income_expense_recognition_adjustments_org_boundary ON public.income_expense_recognition_adjustments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_templates_org_boundary ON public.income_expense_templates;
CREATE POLICY income_expense_templates_org_boundary ON public.income_expense_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_type_merge_audit_org_boundary ON public.income_expense_type_merge_audit;
CREATE POLICY income_expense_type_merge_audit_org_boundary ON public.income_expense_type_merge_audit
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS inspection_photos_org_boundary ON public.inspection_photos;
CREATE POLICY inspection_photos_org_boundary ON public.inspection_photos
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS invoice_generation_settings_org_boundary ON public.invoice_generation_settings;
CREATE POLICY invoice_generation_settings_org_boundary ON public.invoice_generation_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS issue_categories_org_boundary ON public.issue_categories;
CREATE POLICY issue_categories_org_boundary ON public.issue_categories
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS issue_comments_org_boundary ON public.issue_comments;
CREATE POLICY issue_comments_org_boundary ON public.issue_comments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS issue_phase_history_org_boundary ON public.issue_phase_history;
CREATE POLICY issue_phase_history_org_boundary ON public.issue_phase_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS issue_status_history_org_boundary ON public.issue_status_history;
CREATE POLICY issue_status_history_org_boundary ON public.issue_status_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS issues_org_boundary ON public.issues;
CREATE POLICY issues_org_boundary ON public.issues
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS lead_activities_org_boundary ON public.lead_activities;
CREATE POLICY lead_activities_org_boundary ON public.lead_activities
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS legacy_owner_organization_map_org_boundary ON public.legacy_owner_organization_map;
CREATE POLICY legacy_owner_organization_map_org_boundary ON public.legacy_owner_organization_map
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS lucky_events_org_boundary ON public.lucky_events;
CREATE POLICY lucky_events_org_boundary ON public.lucky_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS manager_salary_config_org_boundary ON public.manager_salary_config;
CREATE POLICY manager_salary_config_org_boundary ON public.manager_salary_config
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS member_override_scopes_org_boundary ON public.member_override_scopes;
CREATE POLICY member_override_scopes_org_boundary ON public.member_override_scopes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS member_permission_overrides_org_boundary ON public.member_permission_overrides;
CREATE POLICY member_permission_overrides_org_boundary ON public.member_permission_overrides
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_audit_events_org_boundary ON public.network_audit_events;
CREATE POLICY network_audit_events_org_boundary ON public.network_audit_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_client_current_org_boundary ON public.network_client_current;
CREATE POLICY network_client_current_org_boundary ON public.network_client_current
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_client_links_org_boundary ON public.network_client_links;
CREATE POLICY network_client_links_org_boundary ON public.network_client_links
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_client_sessions_org_boundary ON public.network_client_sessions;
CREATE POLICY network_client_sessions_org_boundary ON public.network_client_sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_command_attempts_org_boundary ON public.network_command_attempts;
CREATE POLICY network_command_attempts_org_boundary ON public.network_command_attempts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_command_observations_org_boundary ON public.network_command_observations;
CREATE POLICY network_command_observations_org_boundary ON public.network_command_observations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_commands_org_boundary ON public.network_commands;
CREATE POLICY network_commands_org_boundary ON public.network_commands
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_config_snapshots_org_boundary ON public.network_config_snapshots;
CREATE POLICY network_config_snapshots_org_boundary ON public.network_config_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_desired_state_versions_org_boundary ON public.network_desired_state_versions;
CREATE POLICY network_desired_state_versions_org_boundary ON public.network_desired_state_versions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_device_connections_org_boundary ON public.network_device_connections;
CREATE POLICY network_device_connections_org_boundary ON public.network_device_connections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_device_leases_org_boundary ON public.network_device_leases;
CREATE POLICY network_device_leases_org_boundary ON public.network_device_leases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_device_samples_org_boundary ON public.network_device_samples;  -- bảng phân mảnh cha
CREATE POLICY network_device_samples_org_boundary ON public.network_device_samples
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_devices_org_boundary ON public.network_devices;
CREATE POLICY network_devices_org_boundary ON public.network_devices
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_incident_events_org_boundary ON public.network_incident_events;
CREATE POLICY network_incident_events_org_boundary ON public.network_incident_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_interface_samples_org_boundary ON public.network_interface_samples;  -- bảng phân mảnh cha
CREATE POLICY network_interface_samples_org_boundary ON public.network_interface_samples
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_interfaces_org_boundary ON public.network_interfaces;
CREATE POLICY network_interfaces_org_boundary ON public.network_interfaces
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_maintenance_windows_org_boundary ON public.network_maintenance_windows;
CREATE POLICY network_maintenance_windows_org_boundary ON public.network_maintenance_windows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_managed_resources_org_boundary ON public.network_managed_resources;
CREATE POLICY network_managed_resources_org_boundary ON public.network_managed_resources
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_metric_hourly_org_boundary ON public.network_metric_hourly;
CREATE POLICY network_metric_hourly_org_boundary ON public.network_metric_hourly
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_org_mutation_gates_org_boundary ON public.network_org_mutation_gates;
CREATE POLICY network_org_mutation_gates_org_boundary ON public.network_org_mutation_gates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_outbox_events_org_boundary ON public.network_outbox_events;
CREATE POLICY network_outbox_events_org_boundary ON public.network_outbox_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_site_settings_org_boundary ON public.network_site_settings;
CREATE POLICY network_site_settings_org_boundary ON public.network_site_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_sla_daily_org_boundary ON public.network_sla_daily;
CREATE POLICY network_sla_daily_org_boundary ON public.network_sla_daily
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_worker_assignments_org_boundary ON public.network_worker_assignments;
CREATE POLICY network_worker_assignments_org_boundary ON public.network_worker_assignments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS notification_logs_org_boundary ON public.notification_logs;
CREATE POLICY notification_logs_org_boundary ON public.notification_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS notification_templates_org_boundary ON public.notification_templates;
CREATE POLICY notification_templates_org_boundary ON public.notification_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_ai_drafts_org_boundary ON public.openclaw_ai_drafts;
CREATE POLICY openclaw_ai_drafts_org_boundary ON public.openclaw_ai_drafts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_audit_events_org_boundary ON public.openclaw_audit_events;
CREATE POLICY openclaw_audit_events_org_boundary ON public.openclaw_audit_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_audit_gateway_tickets_org_boundary ON public.openclaw_audit_gateway_tickets;
CREATE POLICY openclaw_audit_gateway_tickets_org_boundary ON public.openclaw_audit_gateway_tickets
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_audit_roots_org_boundary ON public.openclaw_audit_roots;
CREATE POLICY openclaw_audit_roots_org_boundary ON public.openclaw_audit_roots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_audit_signing_configs_org_boundary ON public.openclaw_audit_signing_configs;
CREATE POLICY openclaw_audit_signing_configs_org_boundary ON public.openclaw_audit_signing_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_automation_versions_org_boundary ON public.openclaw_automation_versions;
CREATE POLICY openclaw_automation_versions_org_boundary ON public.openclaw_automation_versions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_automations_org_boundary ON public.openclaw_automations;
CREATE POLICY openclaw_automations_org_boundary ON public.openclaw_automations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_campaign_runs_org_boundary ON public.openclaw_campaign_runs;
CREATE POLICY openclaw_campaign_runs_org_boundary ON public.openclaw_campaign_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_campaigns_org_boundary ON public.openclaw_campaigns;
CREATE POLICY openclaw_campaigns_org_boundary ON public.openclaw_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_capacity_controls_org_boundary ON public.openclaw_capacity_controls;
CREATE POLICY openclaw_capacity_controls_org_boundary ON public.openclaw_capacity_controls
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_cell_rebinds_org_boundary ON public.openclaw_cell_rebinds;
CREATE POLICY openclaw_cell_rebinds_org_boundary ON public.openclaw_cell_rebinds
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_client_operations_org_boundary ON public.openclaw_client_operations;
CREATE POLICY openclaw_client_operations_org_boundary ON public.openclaw_client_operations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_consents_org_boundary ON public.openclaw_consents;
CREATE POLICY openclaw_consents_org_boundary ON public.openclaw_consents
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_contacts_org_boundary ON public.openclaw_contacts;
CREATE POLICY openclaw_contacts_org_boundary ON public.openclaw_contacts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_control_states_org_boundary ON public.openclaw_control_states;
CREATE POLICY openclaw_control_states_org_boundary ON public.openclaw_control_states
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_conversation_members_org_boundary ON public.openclaw_conversation_members;
CREATE POLICY openclaw_conversation_members_org_boundary ON public.openclaw_conversation_members
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_conversations_org_boundary ON public.openclaw_conversations;
CREATE POLICY openclaw_conversations_org_boundary ON public.openclaw_conversations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_crm_event_occurrences_org_boundary ON public.openclaw_crm_event_occurrences;
CREATE POLICY openclaw_crm_event_occurrences_org_boundary ON public.openclaw_crm_event_occurrences
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_crm_event_subscription_snapshots_org_boundary ON public.openclaw_crm_event_subscription_snapshots;
CREATE POLICY openclaw_crm_event_subscription_snapshots_org_boundary ON public.openclaw_crm_event_subscription_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_crm_event_subscriptions_org_boundary ON public.openclaw_crm_event_subscriptions;
CREATE POLICY openclaw_crm_event_subscriptions_org_boundary ON public.openclaw_crm_event_subscriptions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_dead_letters_org_boundary ON public.openclaw_dead_letters;
CREATE POLICY openclaw_dead_letters_org_boundary ON public.openclaw_dead_letters
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_delivery_attempts_org_boundary ON public.openclaw_delivery_attempts;
CREATE POLICY openclaw_delivery_attempts_org_boundary ON public.openclaw_delivery_attempts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_generation_revocations_org_boundary ON public.openclaw_generation_revocations;
CREATE POLICY openclaw_generation_revocations_org_boundary ON public.openclaw_generation_revocations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_inbound_automation_decisions_org_boundary ON public.openclaw_inbound_automation_decisions;
CREATE POLICY openclaw_inbound_automation_decisions_org_boundary ON public.openclaw_inbound_automation_decisions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_inbound_collisions_org_boundary ON public.openclaw_inbound_collisions;
CREATE POLICY openclaw_inbound_collisions_org_boundary ON public.openclaw_inbound_collisions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_inbound_events_org_boundary ON public.openclaw_inbound_events;
CREATE POLICY openclaw_inbound_events_org_boundary ON public.openclaw_inbound_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_inbound_provider_identities_org_boundary ON public.openclaw_inbound_provider_identities;
CREATE POLICY openclaw_inbound_provider_identities_org_boundary ON public.openclaw_inbound_provider_identities
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_knowledge_chunks_org_boundary ON public.openclaw_knowledge_chunks;
CREATE POLICY openclaw_knowledge_chunks_org_boundary ON public.openclaw_knowledge_chunks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_knowledge_sources_org_boundary ON public.openclaw_knowledge_sources;
CREATE POLICY openclaw_knowledge_sources_org_boundary ON public.openclaw_knowledge_sources
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_knowledge_versions_org_boundary ON public.openclaw_knowledge_versions;
CREATE POLICY openclaw_knowledge_versions_org_boundary ON public.openclaw_knowledge_versions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_maintenance_credentials_org_boundary ON public.openclaw_maintenance_credentials;
CREATE POLICY openclaw_maintenance_credentials_org_boundary ON public.openclaw_maintenance_credentials
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_maintenance_leases_org_boundary ON public.openclaw_maintenance_leases;
CREATE POLICY openclaw_maintenance_leases_org_boundary ON public.openclaw_maintenance_leases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_maintenance_principals_org_boundary ON public.openclaw_maintenance_principals;
CREATE POLICY openclaw_maintenance_principals_org_boundary ON public.openclaw_maintenance_principals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_maintenance_work_attempts_org_boundary ON public.openclaw_maintenance_work_attempts;
CREATE POLICY openclaw_maintenance_work_attempts_org_boundary ON public.openclaw_maintenance_work_attempts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_maintenance_work_items_org_boundary ON public.openclaw_maintenance_work_items;
CREATE POLICY openclaw_maintenance_work_items_org_boundary ON public.openclaw_maintenance_work_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_media_upload_tickets_org_boundary ON public.openclaw_media_upload_tickets;
CREATE POLICY openclaw_media_upload_tickets_org_boundary ON public.openclaw_media_upload_tickets
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_message_media_org_boundary ON public.openclaw_message_media;
CREATE POLICY openclaw_message_media_org_boundary ON public.openclaw_message_media
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_messages_org_boundary ON public.openclaw_messages;
CREATE POLICY openclaw_messages_org_boundary ON public.openclaw_messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_outbound_authorizations_org_boundary ON public.openclaw_outbound_authorizations;
CREATE POLICY openclaw_outbound_authorizations_org_boundary ON public.openclaw_outbound_authorizations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_outbox_org_boundary ON public.openclaw_outbox;
CREATE POLICY openclaw_outbox_org_boundary ON public.openclaw_outbox
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_policies_org_boundary ON public.openclaw_policies;
CREATE POLICY openclaw_policies_org_boundary ON public.openclaw_policies
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_policy_versions_org_boundary ON public.openclaw_policy_versions;
CREATE POLICY openclaw_policy_versions_org_boundary ON public.openclaw_policy_versions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_qr_challenges_org_boundary ON public.openclaw_qr_challenges;
CREATE POLICY openclaw_qr_challenges_org_boundary ON public.openclaw_qr_challenges
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_delete_authorizations_org_boundary ON public.openclaw_retention_delete_authorizations;
CREATE POLICY openclaw_retention_delete_authorizations_org_boundary ON public.openclaw_retention_delete_authorizations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_delete_ticket_lineage_org_boundary ON public.openclaw_retention_delete_ticket_lineage;
CREATE POLICY openclaw_retention_delete_ticket_lineage_org_boundary ON public.openclaw_retention_delete_ticket_lineage
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_delete_tickets_org_boundary ON public.openclaw_retention_delete_tickets;
CREATE POLICY openclaw_retention_delete_tickets_org_boundary ON public.openclaw_retention_delete_tickets
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_evidence_seals_org_boundary ON public.openclaw_retention_evidence_seals;
CREATE POLICY openclaw_retention_evidence_seals_org_boundary ON public.openclaw_retention_evidence_seals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_gateway_configs_org_boundary ON public.openclaw_retention_gateway_configs;
CREATE POLICY openclaw_retention_gateway_configs_org_boundary ON public.openclaw_retention_gateway_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_hold_clocks_org_boundary ON public.openclaw_retention_hold_clocks;
CREATE POLICY openclaw_retention_hold_clocks_org_boundary ON public.openclaw_retention_hold_clocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_hold_scopes_org_boundary ON public.openclaw_retention_hold_scopes;
CREATE POLICY openclaw_retention_hold_scopes_org_boundary ON public.openclaw_retention_hold_scopes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_holds_org_boundary ON public.openclaw_retention_holds;
CREATE POLICY openclaw_retention_holds_org_boundary ON public.openclaw_retention_holds
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_policies_org_boundary ON public.openclaw_retention_policies;
CREATE POLICY openclaw_retention_policies_org_boundary ON public.openclaw_retention_policies
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_retention_tombstones_org_boundary ON public.openclaw_retention_tombstones;
CREATE POLICY openclaw_retention_tombstones_org_boundary ON public.openclaw_retention_tombstones
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_rollout_checkpoints_org_boundary ON public.openclaw_rollout_checkpoints;
CREATE POLICY openclaw_rollout_checkpoints_org_boundary ON public.openclaw_rollout_checkpoints
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_rollout_observations_org_boundary ON public.openclaw_rollout_observations;
CREATE POLICY openclaw_rollout_observations_org_boundary ON public.openclaw_rollout_observations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_runtime_commands_org_boundary ON public.openclaw_runtime_commands;
CREATE POLICY openclaw_runtime_commands_org_boundary ON public.openclaw_runtime_commands
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_runtime_credentials_org_boundary ON public.openclaw_runtime_credentials;
CREATE POLICY openclaw_runtime_credentials_org_boundary ON public.openclaw_runtime_credentials
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_runtime_leases_org_boundary ON public.openclaw_runtime_leases;
CREATE POLICY openclaw_runtime_leases_org_boundary ON public.openclaw_runtime_leases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_sales_group_allowlists_org_boundary ON public.openclaw_sales_group_allowlists;
CREATE POLICY openclaw_sales_group_allowlists_org_boundary ON public.openclaw_sales_group_allowlists
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_sales_groups_org_boundary ON public.openclaw_sales_groups;
CREATE POLICY openclaw_sales_groups_org_boundary ON public.openclaw_sales_groups
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_schedule_occurrences_org_boundary ON public.openclaw_schedule_occurrences;
CREATE POLICY openclaw_schedule_occurrences_org_boundary ON public.openclaw_schedule_occurrences
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_schedule_snapshots_org_boundary ON public.openclaw_schedule_snapshots;
CREATE POLICY openclaw_schedule_snapshots_org_boundary ON public.openclaw_schedule_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_schedules_org_boundary ON public.openclaw_schedules;
CREATE POLICY openclaw_schedules_org_boundary ON public.openclaw_schedules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_send_work_attempts_org_boundary ON public.openclaw_send_work_attempts;
CREATE POLICY openclaw_send_work_attempts_org_boundary ON public.openclaw_send_work_attempts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_send_work_items_org_boundary ON public.openclaw_send_work_items;
CREATE POLICY openclaw_send_work_items_org_boundary ON public.openclaw_send_work_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_service_nonces_org_boundary ON public.openclaw_service_nonces;
CREATE POLICY openclaw_service_nonces_org_boundary ON public.openclaw_service_nonces
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_smoke_cleanup_proofs_org_boundary ON public.openclaw_smoke_cleanup_proofs;
CREATE POLICY openclaw_smoke_cleanup_proofs_org_boundary ON public.openclaw_smoke_cleanup_proofs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_smoke_observations_org_boundary ON public.openclaw_smoke_observations;
CREATE POLICY openclaw_smoke_observations_org_boundary ON public.openclaw_smoke_observations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_smoke_runs_org_boundary ON public.openclaw_smoke_runs;
CREATE POLICY openclaw_smoke_runs_org_boundary ON public.openclaw_smoke_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_suppressions_org_boundary ON public.openclaw_suppressions;
CREATE POLICY openclaw_suppressions_org_boundary ON public.openclaw_suppressions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_takeovers_org_boundary ON public.openclaw_takeovers;
CREATE POLICY openclaw_takeovers_org_boundary ON public.openclaw_takeovers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_targets_org_boundary ON public.openclaw_targets;
CREATE POLICY openclaw_targets_org_boundary ON public.openclaw_targets
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_unknown_resolutions_org_boundary ON public.openclaw_unknown_resolutions;
CREATE POLICY openclaw_unknown_resolutions_org_boundary ON public.openclaw_unknown_resolutions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_watchdog_envelope_nonces_org_boundary ON public.openclaw_watchdog_envelope_nonces;
CREATE POLICY openclaw_watchdog_envelope_nonces_org_boundary ON public.openclaw_watchdog_envelope_nonces
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS organization_invitations_org_boundary ON public.organization_invitations;
CREATE POLICY organization_invitations_org_boundary ON public.organization_invitations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS organization_memberships_org_boundary ON public.organization_memberships;
CREATE POLICY organization_memberships_org_boundary ON public.organization_memberships
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS organization_roles_org_boundary ON public.organization_roles;
CREATE POLICY organization_roles_org_boundary ON public.organization_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS organization_timezones_org_boundary ON public.organization_timezones;
CREATE POLICY organization_timezones_org_boundary ON public.organization_timezones
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS phase_transitions_org_boundary ON public.phase_transitions;
CREATE POLICY phase_transitions_org_boundary ON public.phase_transitions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_close_revisions_org_boundary ON public.profit_close_revisions;
CREATE POLICY profit_close_revisions_org_boundary ON public.profit_close_revisions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_close_runs_org_boundary ON public.profit_close_runs;
CREATE POLICY profit_close_runs_org_boundary ON public.profit_close_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_manager_allocations_org_boundary ON public.profit_manager_allocations;
CREATE POLICY profit_manager_allocations_org_boundary ON public.profit_manager_allocations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_manager_salaries_org_boundary ON public.profit_manager_salaries;
CREATE POLICY profit_manager_salaries_org_boundary ON public.profit_manager_salaries
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_manager_salary_buildings_org_boundary ON public.profit_manager_salary_buildings;
CREATE POLICY profit_manager_salary_buildings_org_boundary ON public.profit_manager_salary_buildings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_payout_exceptions_org_boundary ON public.profit_payout_exceptions;
CREATE POLICY profit_payout_exceptions_org_boundary ON public.profit_payout_exceptions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_payout_reservations_org_boundary ON public.profit_payout_reservations;
CREATE POLICY profit_payout_reservations_org_boundary ON public.profit_payout_reservations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_unallocated_decisions_org_boundary ON public.profit_unallocated_decisions;
CREATE POLICY profit_unallocated_decisions_org_boundary ON public.profit_unallocated_decisions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS public_room_settings_org_boundary ON public.public_room_settings;
CREATE POLICY public_room_settings_org_boundary ON public.public_room_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS public_room_share_tokens_org_boundary ON public.public_room_share_tokens;
CREATE POLICY public_room_share_tokens_org_boundary ON public.public_room_share_tokens
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS push_subscriptions_org_boundary ON public.push_subscriptions;
CREATE POLICY push_subscriptions_org_boundary ON public.push_subscriptions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS role_binding_scopes_org_boundary ON public.role_binding_scopes;
CREATE POLICY role_binding_scopes_org_boundary ON public.role_binding_scopes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS role_bindings_org_boundary ON public.role_bindings;
CREATE POLICY role_bindings_org_boundary ON public.role_bindings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS role_permissions_org_boundary ON public.role_permissions;
CREATE POLICY role_permissions_org_boundary ON public.role_permissions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS room_reservation_holds_org_boundary ON public.room_reservation_holds;
CREATE POLICY room_reservation_holds_org_boundary ON public.room_reservation_holds
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_adjustments_org_boundary ON public.salary_adjustments;
CREATE POLICY salary_adjustments_org_boundary ON public.salary_adjustments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_attendance_day_org_boundary ON public.salary_attendance_day;
CREATE POLICY salary_attendance_day_org_boundary ON public.salary_attendance_day
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_award_errors_org_boundary ON public.salary_award_errors;
CREATE POLICY salary_award_errors_org_boundary ON public.salary_award_errors
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_bonus_rules_org_boundary ON public.salary_bonus_rules;
CREATE POLICY salary_bonus_rules_org_boundary ON public.salary_bonus_rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_cash_authorizations_org_boundary ON public.salary_cash_authorizations;
CREATE POLICY salary_cash_authorizations_org_boundary ON public.salary_cash_authorizations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_earning_consumptions_org_boundary ON public.salary_earning_consumptions;
CREATE POLICY salary_earning_consumptions_org_boundary ON public.salary_earning_consumptions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_holidays_org_boundary ON public.salary_holidays;
CREATE POLICY salary_holidays_org_boundary ON public.salary_holidays
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_settlement_bundles_org_boundary ON public.salary_settlement_bundles;
CREATE POLICY salary_settlement_bundles_org_boundary ON public.salary_settlement_bundles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_settlement_tranches_org_boundary ON public.salary_settlement_tranches;
CREATE POLICY salary_settlement_tranches_org_boundary ON public.salary_settlement_tranches
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_work_ledger_snapshot_org_boundary ON public.salary_work_ledger_snapshot;
CREATE POLICY salary_work_ledger_snapshot_org_boundary ON public.salary_work_ledger_snapshot
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS scheduled_jobs_org_boundary ON public.scheduled_jobs;
CREATE POLICY scheduled_jobs_org_boundary ON public.scheduled_jobs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS service_quota_tiers_org_boundary ON public.service_quota_tiers;
CREATE POLICY service_quota_tiers_org_boundary ON public.service_quota_tiers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS service_quotas_org_boundary ON public.service_quotas;
CREATE POLICY service_quotas_org_boundary ON public.service_quotas
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS signature_templates_org_boundary ON public.signature_templates;
CREATE POLICY signature_templates_org_boundary ON public.signature_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS special_fee_claims_org_boundary ON public.special_fee_claims;
CREATE POLICY special_fee_claims_org_boundary ON public.special_fee_claims
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS subscription_plans_org_boundary ON public.subscription_plans;
CREATE POLICY subscription_plans_org_boundary ON public.subscription_plans
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS super_admins_org_boundary ON public.super_admins;
CREATE POLICY super_admins_org_boundary ON public.super_admins
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS suppliers_org_boundary ON public.suppliers;
CREATE POLICY suppliers_org_boundary ON public.suppliers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS task_flows_org_boundary ON public.task_flows;
CREATE POLICY task_flows_org_boundary ON public.task_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS task_phases_org_boundary ON public.task_phases;
CREATE POLICY task_phases_org_boundary ON public.task_phases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS task_types_org_boundary ON public.task_types;
CREATE POLICY task_types_org_boundary ON public.task_types
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS termination_move_out_authorizations_org_boundary ON public.termination_move_out_authorizations;
CREATE POLICY termination_move_out_authorizations_org_boundary ON public.termination_move_out_authorizations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS termination_move_out_settlement_lines_org_boundary ON public.termination_move_out_settlement_lines;
CREATE POLICY termination_move_out_settlement_lines_org_boundary ON public.termination_move_out_settlement_lines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS termination_refund_obligations_org_boundary ON public.termination_refund_obligations;
CREATE POLICY termination_refund_obligations_org_boundary ON public.termination_refund_obligations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS user_roles_org_boundary ON public.user_roles;
CREATE POLICY user_roles_org_boundary ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS user_subscriptions_org_boundary ON public.user_subscriptions;
CREATE POLICY user_subscriptions_org_boundary ON public.user_subscriptions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_accounts_org_boundary ON public.zalo_accounts;
CREATE POLICY zalo_accounts_org_boundary ON public.zalo_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_automations_org_boundary ON public.zalo_automations;
CREATE POLICY zalo_automations_org_boundary ON public.zalo_automations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_conversations_org_boundary ON public.zalo_conversations;
CREATE POLICY zalo_conversations_org_boundary ON public.zalo_conversations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_labels_org_boundary ON public.zalo_labels;
CREATE POLICY zalo_labels_org_boundary ON public.zalo_labels
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_message_templates_org_boundary ON public.zalo_message_templates;
CREATE POLICY zalo_message_templates_org_boundary ON public.zalo_message_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_messages_org_boundary ON public.zalo_messages;
CREATE POLICY zalo_messages_org_boundary ON public.zalo_messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS zalo_send_queue_org_boundary ON public.zalo_send_queue;
CREATE POLICY zalo_send_queue_org_boundary ON public.zalo_send_queue
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));

-- ─── B_KHONG_CAP_QUYEN: authenticated không có quyền SELECT — đã chặn từ tầng quyền (5 bảng) ───
DROP POLICY IF EXISTS openclaw_account_connections_org_boundary ON public.openclaw_account_connections;
CREATE POLICY openclaw_account_connections_org_boundary ON public.openclaw_account_connections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_accounts_org_boundary ON public.openclaw_accounts;
CREATE POLICY openclaw_accounts_org_boundary ON public.openclaw_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_health_events_org_boundary ON public.openclaw_health_events;
CREATE POLICY openclaw_health_events_org_boundary ON public.openclaw_health_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_rollout_runs_org_boundary ON public.openclaw_rollout_runs;
CREATE POLICY openclaw_rollout_runs_org_boundary ON public.openclaw_rollout_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS openclaw_runtime_cells_org_boundary ON public.openclaw_runtime_cells;
CREATE POLICY openclaw_runtime_cells_org_boundary ON public.openclaw_runtime_cells
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));

-- ─── C_DA_KIN: có dữ liệu và đọc được, nhưng đo ra 0 dòng của tổ chức khác — đã kín bằng đường khác (42 bảng) ───
DROP POLICY IF EXISTS accounting_integrity_exceptions_org_boundary ON public.accounting_integrity_exceptions;
CREATE POLICY accounting_integrity_exceptions_org_boundary ON public.accounting_integrity_exceptions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS accounting_repair_audit_org_boundary ON public.accounting_repair_audit;
CREATE POLICY accounting_repair_audit_org_boundary ON public.accounting_repair_audit
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_rule_steps_org_boundary ON public.approval_rule_steps;
CREATE POLICY approval_rule_steps_org_boundary ON public.approval_rule_steps
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS approval_rules_org_boundary ON public.approval_rules;
CREATE POLICY approval_rules_org_boundary ON public.approval_rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS area_buildings_org_boundary ON public.area_buildings;
CREATE POLICY area_buildings_org_boundary ON public.area_buildings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS areas_org_boundary ON public.areas;
CREATE POLICY areas_org_boundary ON public.areas
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS building_fee_accounts_org_boundary ON public.building_fee_accounts;
CREATE POLICY building_fee_accounts_org_boundary ON public.building_fee_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS building_shareholders_org_boundary ON public.building_shareholders;
CREATE POLICY building_shareholders_org_boundary ON public.building_shareholders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS building_utility_accounts_org_boundary ON public.building_utility_accounts;
CREATE POLICY building_utility_accounts_org_boundary ON public.building_utility_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS buildings_org_boundary ON public.buildings;
CREATE POLICY buildings_org_boundary ON public.buildings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS cash_handover_items_org_boundary ON public.cash_handover_items;
CREATE POLICY cash_handover_items_org_boundary ON public.cash_handover_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS cash_handovers_org_boundary ON public.cash_handovers;
CREATE POLICY cash_handovers_org_boundary ON public.cash_handovers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS contract_deposit_links_org_boundary ON public.contract_deposit_links;
CREATE POLICY contract_deposit_links_org_boundary ON public.contract_deposit_links
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS ct01_declarations_org_boundary ON public.ct01_declarations;
CREATE POLICY ct01_declarations_org_boundary ON public.ct01_declarations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS customer_credit_applications_org_boundary ON public.customer_credit_applications;
CREATE POLICY customer_credit_applications_org_boundary ON public.customer_credit_applications
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS customer_credit_lots_org_boundary ON public.customer_credit_lots;
CREATE POLICY customer_credit_lots_org_boundary ON public.customer_credit_lots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS finance_evidence_objects_org_boundary ON public.finance_evidence_objects;
CREATE POLICY finance_evidence_objects_org_boundary ON public.finance_evidence_objects
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_audit_log_org_boundary ON public.income_expense_audit_log;
CREATE POLICY income_expense_audit_log_org_boundary ON public.income_expense_audit_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_posting_lines_org_boundary ON public.income_expense_posting_lines;
CREATE POLICY income_expense_posting_lines_org_boundary ON public.income_expense_posting_lines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS income_expense_postings_org_boundary ON public.income_expense_postings;
CREATE POLICY income_expense_postings_org_boundary ON public.income_expense_postings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS inspection_sessions_org_boundary ON public.inspection_sessions;
CREATE POLICY inspection_sessions_org_boundary ON public.inspection_sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS invoice_audit_log_org_boundary ON public.invoice_audit_log;
CREATE POLICY invoice_audit_log_org_boundary ON public.invoice_audit_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS invoice_payment_allocations_org_boundary ON public.invoice_payment_allocations;
CREATE POLICY invoice_payment_allocations_org_boundary ON public.invoice_payment_allocations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS invoice_payment_collections_org_boundary ON public.invoice_payment_collections;
CREATE POLICY invoice_payment_collections_org_boundary ON public.invoice_payment_collections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS invoice_payment_tenders_org_boundary ON public.invoice_payment_tenders;
CREATE POLICY invoice_payment_tenders_org_boundary ON public.invoice_payment_tenders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_command_events_org_boundary ON public.network_command_events;
CREATE POLICY network_command_events_org_boundary ON public.network_command_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_device_current_org_boundary ON public.network_device_current;
CREATE POLICY network_device_current_org_boundary ON public.network_device_current
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_incidents_org_boundary ON public.network_incidents;
CREATE POLICY network_incidents_org_boundary ON public.network_incidents
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_interface_current_org_boundary ON public.network_interface_current;
CREATE POLICY network_interface_current_org_boundary ON public.network_interface_current
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS network_worker_building_status_org_boundary ON public.network_worker_building_status;
CREATE POLICY network_worker_building_status_org_boundary ON public.network_worker_building_status
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS organization_invoice_settings_org_boundary ON public.organization_invoice_settings;
CREATE POLICY organization_invoice_settings_org_boundary ON public.organization_invoice_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS personal_transactions_org_boundary ON public.personal_transactions;
CREATE POLICY personal_transactions_org_boundary ON public.personal_transactions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_allocations_org_boundary ON public.profit_allocations;
CREATE POLICY profit_allocations_org_boundary ON public.profit_allocations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_managers_org_boundary ON public.profit_managers;
CREATE POLICY profit_managers_org_boundary ON public.profit_managers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS profit_monthly_org_boundary ON public.profit_monthly;
CREATE POLICY profit_monthly_org_boundary ON public.profit_monthly
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS room_pass_listings_org_boundary ON public.room_pass_listings;
CREATE POLICY room_pass_listings_org_boundary ON public.room_pass_listings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_monthly_org_boundary ON public.salary_monthly;
CREATE POLICY salary_monthly_org_boundary ON public.salary_monthly
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS salary_streak_state_org_boundary ON public.salary_streak_state;
CREATE POLICY salary_streak_state_org_boundary ON public.salary_streak_state
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS shareholders_org_boundary ON public.shareholders;
CREATE POLICY shareholders_org_boundary ON public.shareholders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS staff_assignments_org_boundary ON public.staff_assignments;
CREATE POLICY staff_assignments_org_boundary ON public.staff_assignments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS team_members_org_boundary ON public.team_members;
CREATE POLICY team_members_org_boundary ON public.team_members
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS teams_org_boundary ON public.teams;
CREATE POLICY teams_org_boundary ON public.teams
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));

DO $verify$
DECLARE v_thieu text; v_sai text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_thieu FROM unnest(ARRAY[
    'account_shared_users',
    'accounting_integrity_exceptions',
    'accounting_repair_audit',
    'ai_copilot_entitlements',
    'ai_usage_logs',
    'ai_write_audit',
    'approval_decisions',
    'approval_request_step_candidates',
    'approval_request_steps',
    'approval_requests',
    'approval_rule_sets',
    'approval_rule_steps',
    'approval_rules',
    'approval_step_approvers',
    'area_buildings',
    'areas',
    'asset_categories',
    'asset_handovers',
    'asset_maintenance',
    'asset_warehouses',
    'authorization_audit_events',
    'authorization_scopes',
    'auto_debt_config',
    'building_fee_accounts',
    'building_shareholders',
    'building_utility_accounts',
    'buildings',
    'cash_handover_items',
    'cash_handovers',
    'cashbook_possession_bindings',
    'cashbook_reconciliations',
    'code_sequences',
    'contract_deposit_links',
    'cron_runs',
    'ct01_declarations',
    'customer_credit_applications',
    'customer_credit_lots',
    'demo_reset_log',
    'demo_reset_tables',
    'departments',
    'expenses',
    'finance_contract_month_snapshots',
    'finance_evidence_objects',
    'finance_evidence_system_sources',
    'finance_invoice_component_allocations',
    'finance_invoice_component_manifests',
    'finance_invoice_components',
    'finance_month_snapshot_runs',
    'finance_reporting_role_assignments',
    'finance_room_month_snapshots',
    'hotlines',
    'income_expense_audit_log',
    'income_expense_posting_evidence',
    'income_expense_posting_lines',
    'income_expense_postings',
    'income_expense_recognition_adjustments',
    'income_expense_templates',
    'income_expense_type_merge_audit',
    'inspection_photos',
    'inspection_sessions',
    'invoice_audit_log',
    'invoice_generation_settings',
    'invoice_payment_allocations',
    'invoice_payment_collections',
    'invoice_payment_tenders',
    'issue_categories',
    'issue_comments',
    'issue_phase_history',
    'issue_status_history',
    'issues',
    'lead_activities',
    'legacy_owner_organization_map',
    'lucky_events',
    'manager_salary_config',
    'member_override_scopes',
    'member_permission_overrides',
    'network_audit_events',
    'network_client_current',
    'network_client_links',
    'network_client_sessions',
    'network_command_attempts',
    'network_command_events',
    'network_command_observations',
    'network_commands',
    'network_config_snapshots',
    'network_desired_state_versions',
    'network_device_connections',
    'network_device_current',
    'network_device_leases',
    'network_device_samples',
    'network_devices',
    'network_incident_events',
    'network_incidents',
    'network_interface_current',
    'network_interface_samples',
    'network_interfaces',
    'network_maintenance_windows',
    'network_managed_resources',
    'network_metric_hourly',
    'network_org_mutation_gates',
    'network_outbox_events',
    'network_site_settings',
    'network_sla_daily',
    'network_worker_assignments',
    'network_worker_building_status',
    'notification_logs',
    'notification_templates',
    'openclaw_account_connections',
    'openclaw_accounts',
    'openclaw_ai_drafts',
    'openclaw_audit_events',
    'openclaw_audit_gateway_tickets',
    'openclaw_audit_roots',
    'openclaw_audit_signing_configs',
    'openclaw_automation_versions',
    'openclaw_automations',
    'openclaw_campaign_runs',
    'openclaw_campaigns',
    'openclaw_capacity_controls',
    'openclaw_cell_rebinds',
    'openclaw_client_operations',
    'openclaw_consents',
    'openclaw_contacts',
    'openclaw_control_states',
    'openclaw_conversation_members',
    'openclaw_conversations',
    'openclaw_crm_event_occurrences',
    'openclaw_crm_event_subscription_snapshots',
    'openclaw_crm_event_subscriptions',
    'openclaw_dead_letters',
    'openclaw_delivery_attempts',
    'openclaw_generation_revocations',
    'openclaw_health_events',
    'openclaw_inbound_automation_decisions',
    'openclaw_inbound_collisions',
    'openclaw_inbound_events',
    'openclaw_inbound_provider_identities',
    'openclaw_knowledge_chunks',
    'openclaw_knowledge_sources',
    'openclaw_knowledge_versions',
    'openclaw_maintenance_credentials',
    'openclaw_maintenance_leases',
    'openclaw_maintenance_principals',
    'openclaw_maintenance_work_attempts',
    'openclaw_maintenance_work_items',
    'openclaw_media_upload_tickets',
    'openclaw_message_media',
    'openclaw_messages',
    'openclaw_outbound_authorizations',
    'openclaw_outbox',
    'openclaw_policies',
    'openclaw_policy_versions',
    'openclaw_qr_challenges',
    'openclaw_retention_delete_authorizations',
    'openclaw_retention_delete_ticket_lineage',
    'openclaw_retention_delete_tickets',
    'openclaw_retention_evidence_seals',
    'openclaw_retention_gateway_configs',
    'openclaw_retention_hold_clocks',
    'openclaw_retention_hold_scopes',
    'openclaw_retention_holds',
    'openclaw_retention_policies',
    'openclaw_retention_tombstones',
    'openclaw_rollout_checkpoints',
    'openclaw_rollout_observations',
    'openclaw_rollout_runs',
    'openclaw_runtime_cells',
    'openclaw_runtime_commands',
    'openclaw_runtime_credentials',
    'openclaw_runtime_leases',
    'openclaw_sales_group_allowlists',
    'openclaw_sales_groups',
    'openclaw_schedule_occurrences',
    'openclaw_schedule_snapshots',
    'openclaw_schedules',
    'openclaw_send_work_attempts',
    'openclaw_send_work_items',
    'openclaw_service_nonces',
    'openclaw_smoke_cleanup_proofs',
    'openclaw_smoke_observations',
    'openclaw_smoke_runs',
    'openclaw_suppressions',
    'openclaw_takeovers',
    'openclaw_targets',
    'openclaw_unknown_resolutions',
    'openclaw_watchdog_envelope_nonces',
    'organization_invitations',
    'organization_invoice_settings',
    'organization_memberships',
    'organization_roles',
    'organization_timezones',
    'personal_transactions',
    'phase_transitions',
    'profit_allocations',
    'profit_close_revisions',
    'profit_close_runs',
    'profit_manager_allocations',
    'profit_manager_salaries',
    'profit_manager_salary_buildings',
    'profit_managers',
    'profit_monthly',
    'profit_payout_exceptions',
    'profit_payout_reservations',
    'profit_unallocated_decisions',
    'public_room_settings',
    'public_room_share_tokens',
    'push_subscriptions',
    'role_binding_scopes',
    'role_bindings',
    'role_permissions',
    'room_pass_listings',
    'room_reservation_holds',
    'salary_adjustments',
    'salary_attendance_day',
    'salary_award_errors',
    'salary_bonus_rules',
    'salary_cash_authorizations',
    'salary_earning_consumptions',
    'salary_holidays',
    'salary_monthly',
    'salary_settlement_bundles',
    'salary_settlement_tranches',
    'salary_streak_state',
    'salary_work_ledger_snapshot',
    'scheduled_jobs',
    'service_quota_tiers',
    'service_quotas',
    'shareholders',
    'signature_templates',
    'special_fee_claims',
    'staff_assignments',
    'subscription_plans',
    'super_admins',
    'suppliers',
    'task_flows',
    'task_phases',
    'task_types',
    'team_members',
    'teams',
    'termination_move_out_authorizations',
    'termination_move_out_settlement_lines',
    'termination_refund_obligations',
    'user_roles',
    'user_subscriptions',
    'zalo_accounts',
    'zalo_automations',
    'zalo_conversations',
    'zalo_labels',
    'zalo_message_templates',
    'zalo_messages',
    'zalo_send_queue'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = t AND p.polname = t || '_org_boundary'
  );
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu policy biên giới sau khi chạy: %. DỪNG.', v_thieu;
  END IF;

  -- Policy phải RESTRICTIVE. PERMISSIVE là NỚI quyền — hỏng ngược hoàn toàn.
  SELECT string_agg(c.relname, ', ') INTO v_sai
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE p.polname = c.relname || '_org_boundary' AND p.polpermissive;
  IF v_sai IS NOT NULL THEN
    RAISE EXCEPTION 'Policy biên giới ra PERMISSIVE (nới quyền) ở: %. DỪNG.', v_sai;
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: sinh lại bằng
--   node -e "const i=require('./docs/generated/org-boundary-inventory.json');
--     i.rows.filter(r=>r.assigned_phase==='GĐ3'&&!r.boundary_policy_name)
--      .forEach(r=>console.log(`DROP POLICY IF EXISTS ${r.table_name}_org_boundary ON public.${r.table_name};`))"
-- =============================================================================
