begin;

grant usage on schema app_private to authenticated, openclaw_function_owner;
grant execute on function public.my_org_ids() to openclaw_function_owner;
grant execute on function app_private.authorized_scope_v3(text, uuid) to openclaw_function_owner;

create or replace function app_private.openclaw_authorized_org_ids_v1(
  p_permission_key text
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select candidate.organization_id
  from pg_catalog.unnest(public.my_org_ids()) as candidate(organization_id)
  cross join lateral app_private.authorized_scope_v3(
    p_permission_key,
    candidate.organization_id
  ) as scope
  where scope.org_wide
$function$;

create or replace function app_private.openclaw_can_org_v1(
  p_organization_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from app_private.openclaw_authorized_org_ids_v1(p_permission_key)
      as allowed(organization_id)
    where allowed.organization_id = p_organization_id
  )
$function$;

alter function app_private.openclaw_authorized_org_ids_v1(text)
  owner to openclaw_function_owner;
alter function app_private.openclaw_can_org_v1(uuid, text)
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_authorized_org_ids_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_can_org_v1(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_authorized_org_ids_v1(text)
  to authenticated;
grant execute on function app_private.openclaw_can_org_v1(uuid, text)
  to authenticated;

create policy openclaw_accounts_authenticated_view_select
  on public.openclaw_accounts for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_account_connections_authenticated_view_select
  on public.openclaw_account_connections for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_runtime_cells_authenticated_view_select
  on public.openclaw_runtime_cells for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_contacts_authenticated_view_select
  on public.openclaw_contacts for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_sales_groups_authenticated_view_select
  on public.openclaw_sales_groups for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_targets_authenticated_view_select
  on public.openclaw_targets for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_conversations_authenticated_view_select
  on public.openclaw_conversations for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_conversation_members_authenticated_view_select
  on public.openclaw_conversation_members for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_messages_authenticated_view_select
  on public.openclaw_messages for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_message_media_authenticated_view_select
  on public.openclaw_message_media for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_control_states_authenticated_view_select
  on public.openclaw_control_states for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));
create policy openclaw_takeovers_authenticated_view_select
  on public.openclaw_takeovers for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  ));

create policy openclaw_policies_authenticated_manage_automation_select
  on public.openclaw_policies for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));
create policy openclaw_automations_authenticated_published_select
  on public.openclaw_automations for select to authenticated
  using (
    lifecycle_state in ('PUBLISHED','PAUSED')
    and organization_id in (
      select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
    )
  );
create policy openclaw_automations_authenticated_manage_automation_select
  on public.openclaw_automations for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));
create policy openclaw_campaigns_authenticated_manage_automation_select
  on public.openclaw_campaigns for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));
create policy openclaw_campaign_runs_authenticated_manage_automation_select
  on public.openclaw_campaign_runs for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));
create policy openclaw_schedules_authenticated_manage_automation_select
  on public.openclaw_schedules for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));
create policy openclaw_crm_event_subscriptions_authenticated_manage_automation_select
  on public.openclaw_crm_event_subscriptions for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));
create policy openclaw_sales_group_allowlists_authenticated_manage_automation_select
  on public.openclaw_sales_group_allowlists for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_automation')
  ));

create policy openclaw_knowledge_sources_authenticated_published_select
  on public.openclaw_knowledge_sources for select to authenticated
  using (
    lifecycle_state = 'PUBLISHED' and sensitivity = 'CUSTOMER_SAFE'
    and organization_id in (
      select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
    )
  );
create policy openclaw_knowledge_sources_authenticated_manage_knowledge_select
  on public.openclaw_knowledge_sources for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.manage_knowledge')
  ));

create policy openclaw_audit_roots_authenticated_audit_select
  on public.openclaw_audit_roots for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));
create policy openclaw_health_events_authenticated_audit_select
  on public.openclaw_health_events for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));
create policy openclaw_rollout_runs_authenticated_audit_select
  on public.openclaw_rollout_runs for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));
create policy openclaw_rollout_observations_authenticated_audit_select
  on public.openclaw_rollout_observations for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));
create policy openclaw_rollout_checkpoints_authenticated_audit_select
  on public.openclaw_rollout_checkpoints for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));
create policy openclaw_smoke_runs_authenticated_audit_select
  on public.openclaw_smoke_runs for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));
create policy openclaw_smoke_cleanup_proofs_authenticated_audit_select
  on public.openclaw_smoke_cleanup_proofs for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));

create index openclaw_health_events_account_dashboard_idx
  on public.openclaw_health_events
    (organization_id, account_id, observed_at desc, id desc);

grant select (
  id, organization_id, account_profile, display_name, is_active,
  connection_state, session_risk_state, configured_mode, effective_mode,
  connection_generation, disclosure_version, disclosure_acknowledged_version,
  disclosure_acknowledged_at, paused_at, created_at, updated_at
) on public.openclaw_accounts to authenticated;
grant select (
  id, organization_id, account_id, connection_generation, connection_state,
  session_risk_state, configured_mode, effective_mode, reason_code,
  disclosure_version, disclosure_acknowledged_version, changed_at
) on public.openclaw_account_connections to authenticated;
grant select (
  id, organization_id, account_id, cell_generation, state, is_current,
  last_heartbeat_at, created_at, retired_at
) on public.openclaw_runtime_cells to authenticated;
grant select (
  id, organization_id, account_id, display_name, directory_version,
  directory_refreshed_at, created_at, updated_at
) on public.openclaw_contacts to authenticated;
grant select (
  id, organization_id, account_id, display_name, member_count,
  directory_version, directory_refreshed_at, created_at, updated_at
) on public.openclaw_sales_groups to authenticated;
grant select (
  id, organization_id, account_id, kind, contact_id, sales_group_id,
  target_version, directory_refreshed_at, is_active, created_at, updated_at
) on public.openclaw_targets to authenticated;
grant select (
  id, organization_id, account_id, target_id, status,
  assigned_membership_id, unread_count, last_received_at, last_message_id,
  version, created_at, updated_at
) on public.openclaw_conversations to authenticated;
grant select (
  id, organization_id, account_id, conversation_id, display_name,
  member_role, joined_at, left_at, created_at
) on public.openclaw_conversation_members to authenticated;
grant select (
  id, organization_id, account_id, conversation_id, direction, event_kind,
  provider_timestamp, received_at, created_at
) on public.openclaw_messages to authenticated;
grant select (
  id, organization_id, account_id, conversation_id, message_id, media_index,
  media_kind, mime, byte_length, byte_state, retention_delete_not_before,
  created_at, updated_at
) on public.openclaw_message_media to authenticated;
grant select (
  id, organization_id, control_key, global_stop, feature_enabled,
  limited_auto_reply_enabled, proactive_enabled, sales_groups_enabled,
  first_contact_enabled, control_version, disclosure_version, updated_at
) on public.openclaw_control_states to authenticated;
grant select (
  id, organization_id, account_id, conversation_id, owner_membership_id,
  takeover_version, started_at, expires_at, released_at
) on public.openclaw_takeovers to authenticated;

grant select (
  id, organization_id, account_id, name, lifecycle_state, current_version,
  created_at, updated_at
) on public.openclaw_policies to authenticated;
grant select (
  id, organization_id, account_id, name, automation_kind, lifecycle_state,
  current_version, created_at, updated_at
) on public.openclaw_automations to authenticated;
grant select (
  id, organization_id, account_id, automation_version_id, name, status,
  cancellation_version, cancelled_at, created_at, updated_at
) on public.openclaw_campaigns to authenticated;
grant select (
  id, organization_id, account_id, campaign_id, campaign_version,
  automation_version_id, run_key, status, started_at, finished_at, created_at
) on public.openclaw_campaign_runs to authenticated;
grant select (
  id, organization_id, account_id, automation_version_id, target_id, campaign_id,
  schedule_version, status, timezone, local_recurrence_rule, next_run_at,
  missed_occurrence_policy, created_at, updated_at
) on public.openclaw_schedules to authenticated;
grant select (
  id, organization_id, account_id, automation_version_id, destination_target_id,
  event_type, subscription_version, is_active, created_at, updated_at
) on public.openclaw_crm_event_subscriptions to authenticated;
grant select (
  id, organization_id, account_id, sales_group_target_id, sales_group_target_kind,
  allowlist_version, is_allowed, directory_refreshed_at, directory_expires_at,
  approved_at, created_at
) on public.openclaw_sales_group_allowlists to authenticated;
grant select (
  id, organization_id, account_id, title, source_kind, sensitivity,
  lifecycle_state, current_version, created_at, updated_at
) on public.openclaw_knowledge_sources to authenticated;

grant select (
  id, organization_id, root_date, first_sequence, last_sequence, root_hash,
  event_count, signing_key_generation, signature_algorithm, signature_hash,
  gateway_receipt_hash, anchored_at, created_at
) on public.openclaw_audit_roots to authenticated;
grant select (
  id, organization_id, account_id, cell_id, severity, health_kind, status,
  fingerprint, content_free_metrics, observed_at, created_at
) on public.openclaw_health_events to authenticated;
grant select (
  id, organization_id, stage, stage_version, continuous_green_started_at,
  status, started_at, completed_at
) on public.openclaw_rollout_runs to authenticated;
grant select (
  id, organization_id, rollout_run_id, stage, window_started_at, window_ended_at,
  passed, content_free_metrics, observation_hash, created_at
) on public.openclaw_rollout_observations to authenticated;
grant select (
  id, organization_id, rollout_run_id, checkpoint_name, stage, status,
  trusted_evidence_hash, created_at, completed_at
) on public.openclaw_rollout_checkpoints to authenticated;
grant select (
  id, organization_id, rollout_run_id, cleanup_generation, status,
  started_at, finished_at
) on public.openclaw_smoke_runs to authenticated;
grant select (
  id, organization_id, smoke_run_id, cleanup_generation, queued_residual,
  leased_residual, dispatching_residual, proof_hash, verified_at
) on public.openclaw_smoke_cleanup_proofs to authenticated;

commit;
