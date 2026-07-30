begin;

create table public.openclaw_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  target_id uuid not null,
  consent_scope text not null check (consent_scope in ('REPLY','PROACTIVE','SALES_GROUP','CRM_EVENT','FIRST_CONTACT')),
  consent_status text not null default 'ACTIVE' check (consent_status in ('ACTIVE','REVOKED','EXPIRED')),
  consent_source text not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  granted_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  consent_version bigint not null default 1 check (consent_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, target_id, consent_scope, consent_version),
  foreign key (organization_id, account_id, target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  check (expires_at is null or expires_at > granted_at),
  check ((consent_status = 'REVOKED') = (revoked_at is not null))
);

create table public.openclaw_suppressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  target_id uuid,
  suppression_scope text not null check (suppression_scope in ('ORGANIZATION','ACCOUNT','TARGET','CAMPAIGN')),
  suppression_reason text not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  active_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  released_at timestamptz,
  suppression_version bigint not null default 1 check (suppression_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  check ((suppression_scope = 'TARGET') = (target_id is not null)),
  check (expires_at is null or expires_at > active_from)
);

create table public.openclaw_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  name text not null,
  lifecycle_state text not null default 'DRAFT' check (lifecycle_state in ('DRAFT','PUBLISHED','ARCHIVED')),
  current_version bigint not null default 0 check (current_version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, name),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict
);

create table public.openclaw_policy_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  policy_id uuid not null,
  version bigint not null check (version > 0),
  lifecycle_state text not null check (lifecycle_state in ('DRAFT','PUBLISHED','ARCHIVED')),
  timezone text not null,
  quiet_hours_start time not null default '20:00',
  quiet_hours_end time not null default '08:00',
  rate_limits jsonb not null,
  consent_required boolean not null default true,
  disclosure_version integer not null check (disclosure_version > 0),
  policy_payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, policy_id, version),
  foreign key (organization_id, account_id, policy_id)
    references public.openclaw_policies(organization_id, account_id, id) on delete restrict,
  check (
    (lifecycle_state = 'DRAFT' and published_at is null)
    or (lifecycle_state in ('PUBLISHED','ARCHIVED') and published_at is not null)
  ),
  check (jsonb_typeof(rate_limits) = 'object')
);

create table public.openclaw_control_states (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  control_key text not null default 'GLOBAL_STOP' check (control_key = 'GLOBAL_STOP'),
  global_stop boolean not null default false,
  feature_enabled boolean not null default false,
  limited_auto_reply_enabled boolean not null default false,
  proactive_enabled boolean not null default false,
  sales_groups_enabled boolean not null default false,
  first_contact_enabled boolean not null default false,
  control_version bigint not null default 1 check (control_version > 0),
  disclosure_version integer not null default 1 check (disclosure_version > 0),
  reason text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  primary key (organization_id, control_key)
);

create table public.openclaw_takeovers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  owner_membership_id uuid not null,
  takeover_version bigint not null check (takeover_version > 0),
  started_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, conversation_id, takeover_version),
  foreign key (organization_id, account_id, conversation_id)
    references public.openclaw_conversations(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, owner_membership_id)
    references public.organization_memberships(organization_id, id) on delete restrict,
  check (expires_at > started_at),
  check (released_at is null or released_at >= started_at)
);

create unique index openclaw_takeovers_one_active_uidx
  on public.openclaw_takeovers (organization_id, account_id, conversation_id)
  where released_at is null;

create table public.openclaw_automations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  name text not null,
  automation_kind text not null check (automation_kind in ('INBOUND_REPLY','PROACTIVE','SALES_GROUP','CRM_EVENT','FIRST_CONTACT')),
  lifecycle_state text not null default 'DRAFT' check (lifecycle_state in ('DRAFT','PUBLISHED','PAUSED','ARCHIVED')),
  current_version bigint not null default 0 check (current_version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, name),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict
);

create table public.openclaw_automation_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  automation_id uuid not null,
  version bigint not null check (version > 0),
  lifecycle_state text not null check (lifecycle_state in ('DRAFT','PUBLISHED','ARCHIVED')),
  mode text not null check (mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')),
  template_body text not null,
  allowed_crm_fields text[] not null default '{}'::text[],
  missing_value_policy text not null check (missing_value_policy IN ('REJECT','EMPTY','OMIT')),
  escaping_mode text not null check (escaping_mode IN ('PLAIN_TEXT','CONTROL_SAFE')),
  maximum_rendered_codepoints integer not null check (maximum_rendered_codepoints between 1 and 40000),
  content_version_id uuid not null default gen_random_uuid(),
  policy_version_id uuid not null,
  knowledge_version_ids uuid[] not null default '{}'::uuid[],
  configuration jsonb not null,
  dry_run_hash text check (dry_run_hash is null or dry_run_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, automation_id, version),
  unique (organization_id, account_id, content_version_id),
  foreign key (organization_id, account_id, automation_id)
    references public.openclaw_automations(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, policy_version_id)
    references public.openclaw_policy_versions(organization_id, account_id, id) on delete restrict,
  check (
    (lifecycle_state = 'DRAFT' and published_at is null)
    or (lifecycle_state in ('PUBLISHED','ARCHIVED') and published_at is not null)
  ),
  check (jsonb_typeof(configuration) = 'object')
);

create table public.openclaw_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  automation_version_id uuid not null,
  name text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','PAUSED','CANCELLED','COMPLETE')),
  cancellation_version bigint not null default 0 check (cancellation_version >= 0),
  cancelled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict,
  check ((status = 'CANCELLED') = (cancelled_at is not null))
);

create table public.openclaw_campaign_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  campaign_id uuid not null,
  campaign_version bigint not null check (campaign_version > 0),
  automation_version_id uuid not null,
  run_key text not null,
  status text not null check (status in ('PLANNED','RUNNING','COMPLETE','CANCELLED','FAILED')),
  target_snapshot_hash text not null check (target_snapshot_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, campaign_id, campaign_version, run_key),
  foreign key (organization_id, account_id, campaign_id)
    references public.openclaw_campaigns(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict
);

create table public.openclaw_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  automation_version_id uuid not null,
  target_id uuid,
  campaign_id uuid,
  schedule_version bigint not null check (schedule_version > 0),
  status text not null default 'PAUSED' check (status in ('PAUSED','ACTIVE','CANCELLED','COMPLETE')),
  timezone text not null,
  local_recurrence_rule text not null,
  next_run_at timestamptz,
  missed_occurrence_policy text not null default 'SKIPPED_MISSED' check (missed_occurrence_policy = 'SKIPPED_MISSED'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, id, schedule_version),
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, campaign_id)
    references public.openclaw_campaigns(organization_id, account_id, id) on delete restrict
);

create table public.openclaw_crm_event_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  automation_version_id uuid not null,
  destination_target_id uuid not null,
  event_type text not null
    check (event_type IN ('lead_created_or_assigned','room_became_available','sales_task_due')),
  subscription_version bigint not null check (subscription_version > 0),
  field_mapping jsonb not null,
  field_mapping_hash text not null check (field_mapping_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, id, subscription_version),
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, destination_target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  check (jsonb_typeof(field_mapping) = 'object')
);

alter table public.openclaw_targets
  add constraint openclaw_targets_org_account_id_kind_key
  unique (organization_id, account_id, id, kind);

create table public.openclaw_sales_group_allowlists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  sales_group_target_id uuid not null,
  sales_group_target_kind text not null default 'SALES_GROUP'
    check (sales_group_target_kind = 'SALES_GROUP'),
  allowlist_version bigint not null check (allowlist_version > 0),
  is_allowed boolean not null default false,
  directory_refreshed_at timestamptz not null,
  directory_expires_at timestamptz not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, sales_group_target_id, allowlist_version),
  foreign key (organization_id, account_id, sales_group_target_id, sales_group_target_kind)
    references public.openclaw_targets(organization_id, account_id, id, kind) on delete restrict,
  check (directory_expires_at = directory_refreshed_at + interval '24 hours'),
  check ((is_allowed and approved_at is not null) or not is_allowed)
);

create table public.openclaw_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  title text not null,
  source_kind text not null check (source_kind in ('TEXT','DOCUMENT','FAQ','CRM_SNAPSHOT')),
  sensitivity text not null check (sensitivity IN ('CUSTOMER_SAFE','INTERNAL_REVIEW_ONLY','RESTRICTED')),
  lifecycle_state text not null default 'DRAFT' check (lifecycle_state in ('DRAFT','PUBLISHED','ARCHIVED')),
  current_version bigint not null default 0 check (current_version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, id, sensitivity),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict
);

create table public.openclaw_knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  source_id uuid not null,
  version bigint not null check (version > 0),
  sensitivity text not null check (sensitivity IN ('CUSTOMER_SAFE','INTERNAL_REVIEW_ONLY','RESTRICTED')),
  lifecycle_state text not null check (lifecycle_state in ('DRAFT','PUBLISHED','ARCHIVED')),
  content text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  validation_result jsonb,
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, source_id, version),
  unique (organization_id, account_id, source_id, id, sensitivity),
  foreign key (organization_id, account_id, source_id, sensitivity)
    references public.openclaw_knowledge_sources(organization_id, account_id, id, sensitivity) on delete restrict,
  check (
    (lifecycle_state = 'DRAFT' and published_at is null)
    or (lifecycle_state in ('PUBLISHED','ARCHIVED') and published_at is not null)
  ),
  check (jsonb_typeof(metadata) = 'object')
);

create table public.openclaw_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  source_id uuid not null,
  knowledge_version_id uuid not null,
  sensitivity text not null check (sensitivity IN ('CUSTOMER_SAFE','INTERNAL_REVIEW_ONLY','RESTRICTED')),
  chunk_index integer not null check (chunk_index >= 0),
  chunk_text text not null,
  chunk_hash text not null check (chunk_hash ~ '^[0-9a-f]{64}$'),
  embedding jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, knowledge_version_id, chunk_index),
  foreign key (organization_id, account_id, source_id, knowledge_version_id, sensitivity)
    references public.openclaw_knowledge_versions(organization_id, account_id, source_id, id, sensitivity) on delete restrict,
  check (embedding is null or jsonb_typeof(embedding) = 'array'),
  check (jsonb_typeof(metadata) = 'object')
);

create index openclaw_consents_active_idx
  on public.openclaw_consents (organization_id, account_id, target_id, consent_scope, expires_at)
  where consent_status = 'ACTIVE';
create index openclaw_suppressions_active_idx
  on public.openclaw_suppressions (organization_id, account_id, target_id, expires_at)
  where released_at is null;
create index openclaw_schedules_due_idx
  on public.openclaw_schedules (next_run_at, organization_id, account_id)
  where status = 'ACTIVE';
create index openclaw_crm_subscriptions_active_idx
  on public.openclaw_crm_event_subscriptions (event_type, organization_id, account_id)
  where is_active;
create index openclaw_sales_group_allowlists_active_idx
  on public.openclaw_sales_group_allowlists
    (organization_id, account_id, sales_group_target_id, directory_expires_at)
  where is_allowed;
create index openclaw_knowledge_chunks_customer_safe_idx
  on public.openclaw_knowledge_chunks
    (organization_id, account_id, knowledge_version_id, chunk_index)
  where sensitivity = 'CUSTOMER_SAFE';

alter table public.openclaw_consents owner to openclaw_function_owner;
alter table public.openclaw_consents enable row level security;
alter table public.openclaw_consents force row level security;
revoke all on public.openclaw_consents from public, anon, authenticated, service_role;
alter table public.openclaw_suppressions owner to openclaw_function_owner;
alter table public.openclaw_suppressions enable row level security;
alter table public.openclaw_suppressions force row level security;
revoke all on public.openclaw_suppressions from public, anon, authenticated, service_role;
alter table public.openclaw_policies owner to openclaw_function_owner;
alter table public.openclaw_policies enable row level security;
alter table public.openclaw_policies force row level security;
revoke all on public.openclaw_policies from public, anon, authenticated, service_role;
alter table public.openclaw_policy_versions owner to openclaw_function_owner;
alter table public.openclaw_policy_versions enable row level security;
alter table public.openclaw_policy_versions force row level security;
revoke all on public.openclaw_policy_versions from public, anon, authenticated, service_role;
alter table public.openclaw_control_states owner to openclaw_function_owner;
alter table public.openclaw_control_states enable row level security;
alter table public.openclaw_control_states force row level security;
revoke all on public.openclaw_control_states from public, anon, authenticated, service_role;
alter table public.openclaw_takeovers owner to openclaw_function_owner;
alter table public.openclaw_takeovers enable row level security;
alter table public.openclaw_takeovers force row level security;
revoke all on public.openclaw_takeovers from public, anon, authenticated, service_role;
alter table public.openclaw_automations owner to openclaw_function_owner;
alter table public.openclaw_automations enable row level security;
alter table public.openclaw_automations force row level security;
revoke all on public.openclaw_automations from public, anon, authenticated, service_role;
alter table public.openclaw_automation_versions owner to openclaw_function_owner;
alter table public.openclaw_automation_versions enable row level security;
alter table public.openclaw_automation_versions force row level security;
revoke all on public.openclaw_automation_versions from public, anon, authenticated, service_role;
alter table public.openclaw_campaigns owner to openclaw_function_owner;
alter table public.openclaw_campaigns enable row level security;
alter table public.openclaw_campaigns force row level security;
revoke all on public.openclaw_campaigns from public, anon, authenticated, service_role;
alter table public.openclaw_campaign_runs owner to openclaw_function_owner;
alter table public.openclaw_campaign_runs enable row level security;
alter table public.openclaw_campaign_runs force row level security;
revoke all on public.openclaw_campaign_runs from public, anon, authenticated, service_role;
alter table public.openclaw_schedules owner to openclaw_function_owner;
alter table public.openclaw_schedules enable row level security;
alter table public.openclaw_schedules force row level security;
revoke all on public.openclaw_schedules from public, anon, authenticated, service_role;
alter table public.openclaw_crm_event_subscriptions owner to openclaw_function_owner;
alter table public.openclaw_crm_event_subscriptions enable row level security;
alter table public.openclaw_crm_event_subscriptions force row level security;
revoke all on public.openclaw_crm_event_subscriptions from public, anon, authenticated, service_role;
alter table public.openclaw_sales_group_allowlists owner to openclaw_function_owner;
alter table public.openclaw_sales_group_allowlists enable row level security;
alter table public.openclaw_sales_group_allowlists force row level security;
revoke all on public.openclaw_sales_group_allowlists from public, anon, authenticated, service_role;
alter table public.openclaw_knowledge_sources owner to openclaw_function_owner;
alter table public.openclaw_knowledge_sources enable row level security;
alter table public.openclaw_knowledge_sources force row level security;
revoke all on public.openclaw_knowledge_sources from public, anon, authenticated, service_role;
alter table public.openclaw_knowledge_versions owner to openclaw_function_owner;
alter table public.openclaw_knowledge_versions enable row level security;
alter table public.openclaw_knowledge_versions force row level security;
revoke all on public.openclaw_knowledge_versions from public, anon, authenticated, service_role;
alter table public.openclaw_knowledge_chunks owner to openclaw_function_owner;
alter table public.openclaw_knowledge_chunks enable row level security;
alter table public.openclaw_knowledge_chunks force row level security;
revoke all on public.openclaw_knowledge_chunks from public, anon, authenticated, service_role;

do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'openclaw_consents','openclaw_suppressions','openclaw_policies','openclaw_policy_versions',
    'openclaw_control_states','openclaw_takeovers','openclaw_automations','openclaw_automation_versions',
    'openclaw_campaigns','openclaw_campaign_runs','openclaw_schedules','openclaw_crm_event_subscriptions',
    'openclaw_sales_group_allowlists','openclaw_knowledge_sources','openclaw_knowledge_versions','openclaw_knowledge_chunks'
  ] loop
    execute format(
      'create policy %I on public.%I for all to openclaw_function_owner using (true) with check (true)',
      v_table || '_function_owner_all', v_table
    );
    execute format(
      'create policy %I on public.%I for all to openclaw_runtime_writer using (true) with check (true)',
      v_table || '_runtime_writer_all', v_table
    );
    execute format(
      'create trigger %I before update on public.%I for each row execute function app_private.reject_openclaw_tenant_identity_update_v1()',
      v_table || '_immutable_tenant', v_table
    );
  end loop;
end
$policies$;

create trigger openclaw_policy_versions_append_only
before update or delete on public.openclaw_policy_versions
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_automation_versions_append_only
before update or delete on public.openclaw_automation_versions
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_campaign_runs_append_only
before update or delete on public.openclaw_campaign_runs
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_knowledge_versions_append_only
before update or delete on public.openclaw_knowledge_versions
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_knowledge_chunks_append_only
before update or delete on public.openclaw_knowledge_chunks
for each row execute function app_private.reject_openclaw_append_only_v1();

grant select, insert, update on
  public.openclaw_consents,
  public.openclaw_suppressions,
  public.openclaw_policies,
  public.openclaw_control_states,
  public.openclaw_takeovers,
  public.openclaw_automations,
  public.openclaw_campaigns,
  public.openclaw_schedules,
  public.openclaw_crm_event_subscriptions,
  public.openclaw_sales_group_allowlists,
  public.openclaw_knowledge_sources
to openclaw_runtime_writer;
grant select, insert on
  public.openclaw_policy_versions,
  public.openclaw_automation_versions,
  public.openclaw_campaign_runs,
  public.openclaw_knowledge_versions,
  public.openclaw_knowledge_chunks
to openclaw_runtime_writer;

commit;
