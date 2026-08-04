begin;

do $dependencies$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_function_owner')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_runtime_writer')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_maintenance_writer')
  then
    raise exception 'OpenClaw prerequisite roles are missing';
  end if;
  if to_regprocedure('app_private.require_perm_v1(uuid,text,text)') is null
     or to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') is null
     or to_regprocedure('app_private.append_openclaw_audit_v1(uuid,text,uuid,text,uuid,uuid,jsonb,bytea)') is null
  then
    raise exception 'OpenClaw prerequisite authorization or audit helpers are missing';
  end if;
end;
$dependencies$;

do $role$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'openclaw_service_dispatcher'
  ) then
    create role openclaw_service_dispatcher with NOLOGIN NOINHERIT NOBYPASSRLS
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  else
    alter role openclaw_service_dispatcher with NOLOGIN NOINHERIT NOBYPASSRLS
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  end if;
end;
$role$;

-- Ownership assignment needs two things a superuser has for free and the Supabase
-- `postgres` role does not: SET on the owning role (PostgreSQL 16+ withholds it
-- from role creators) and CREATE for that role on the object's schema. Both are
-- given here and taken back before this file commits.
grant openclaw_function_owner to current_user with set true;
grant openclaw_runtime_writer to current_user with set true;
grant openclaw_maintenance_writer to current_user with set true;
grant openclaw_service_dispatcher to current_user with set true;
grant create on schema public, app_private to openclaw_function_owner, openclaw_runtime_writer, openclaw_maintenance_writer, openclaw_service_dispatcher;

--
-- The actor id, read WITHOUT going through schema auth.
--
-- Every OpenClaw browser RPC is SECURITY DEFINER owned by openclaw_function_owner
-- and used to call auth.uid(). That fails in production with
-- "42501: permission denied for schema auth": schema auth belongs to
-- supabase_admin, `postgres` is not a member of it, and so the
-- `grant usage on schema auth to openclaw_function_owner` these migrations issue
-- is silently discarded - PostgreSQL WARNS that no privileges were granted and
-- carries on, so the migration reports success while every browser call is dead.
-- A superuser harness grants it fine, which is why nothing caught this locally.
--
-- auth.uid() is itself only a read of two GUCs, so this reproduces it exactly
-- while needing no privilege on any schema at all.
create or replace function app_private.openclaw_actor_id_v1()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

alter function app_private.openclaw_actor_id_v1() owner to openclaw_function_owner;
revoke all on function app_private.openclaw_actor_id_v1()
  from public, anon, authenticated, service_role;

revoke all on all tables in schema public from openclaw_service_dispatcher;
revoke all on all sequences in schema public from openclaw_service_dispatcher;
grant usage on schema public, app_private to openclaw_service_dispatcher;
grant execute on function app_private.lock_org_for_decision_v1(uuid) to openclaw_function_owner;
grant execute on function app_private.require_perm_v1(uuid,text,text) to openclaw_function_owner;

create table public.openclaw_client_operations (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  operation_key text not null,
  client_operation_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  replay_policy text not null default 'RETURN_SAFE_RESULT'
    check (replay_policy in ('RETURN_SAFE_RESULT','SINGLE_USE')),
  safe_result jsonb,
  result_hash text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  primary key (organization_id, actor_id, operation_key, client_operation_id),
  unique (organization_id, id),
  check (operation_key ~ '^openclaw_[a-z0-9_]+_v[1-9][0-9]*$'),
  check ((safe_result is null) = (result_hash is null)),
  check ((safe_result is null) = (completed_at is null)),
  check (safe_result is null or jsonb_typeof(safe_result) = 'object'),
  check (safe_result is null or octet_length(safe_result::text) <= 8192)
);

create index openclaw_client_operations_incomplete_idx
  on public.openclaw_client_operations (organization_id, created_at)
  where completed_at is null;

create table public.openclaw_runtime_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  command_key text not null,
  command_kind text not null
    check (command_kind in ('QR_LOGIN','DISCONNECT','DIRECTORY_SYNC','CELL_REBIND','GENERATION_REVOKE')),
  command_version bigint not null default 1 check (command_version > 0),
  source_session_generation bigint not null check (source_session_generation > 0),
  target_session_generation bigint not null check (target_session_generation > 0),
  source_connection_generation bigint not null check (source_connection_generation >= 0),
  target_connection_generation bigint not null check (target_connection_generation >= 0),
  expected_session_generation bigint not null check (expected_session_generation > 0),
  expected_connection_generation bigint not null check (expected_connection_generation >= 0),
  expected_fencing_token bigint not null check (expected_fencing_token > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_bytes bytea not null check (octet_length(payload_bytes) > 0),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'PENDING'
    check (state in ('PENDING','LEASED','STARTED','ACKNOWLEDGED','FAILED','EXPIRED','REVOKED')),
  claim_token_hash text check (claim_token_hash is null or claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  lease_expires_at timestamptz,
  started_at timestamptz,
  effect_deadline_at timestamptz,
  effect_disposition text not null default 'NONE'
    check (effect_disposition in ('NONE','PROVIDER_CONFIRMED','SEALED_UNCONFIRMED')),
  sealed_at timestamptz,
  seal_reason text,
  result jsonb,
  result_hash text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  completion_claim_token_hash text
    check (completion_claim_token_hash is null or completion_claim_token_hash ~ '^[0-9a-f]{64}$'),
  completion_claim_generation bigint
    check (completion_claim_generation is null or completion_claim_generation > 0),
  acknowledged_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (organization_id, id),
  unique (organization_id, account_id, command_key),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (convert_from(payload_bytes, 'UTF8')::jsonb = payload),
  check (payload_hash = encode(extensions.digest(payload_bytes, 'sha256'), 'hex')),
  check (expected_session_generation = target_session_generation),
  check (expected_connection_generation = source_connection_generation),
  check ((state in ('LEASED','STARTED')) = (claim_token_hash is not null)),
  check ((state in ('LEASED','STARTED')) = (lease_expires_at is not null)),
  check (state <> 'STARTED' or (started_at is not null and effect_deadline_at is not null)),
  check (started_at is null or state in ('STARTED','ACKNOWLEDGED','FAILED','REVOKED')),
  check ((sealed_at is null) = (seal_reason is null)),
  check ((effect_disposition = 'SEALED_UNCONFIRMED') = (sealed_at is not null)),
  check (effect_disposition = 'NONE' or state in ('ACKNOWLEDGED','FAILED','REVOKED')),
  check ((result is null) = (result_hash is null)),
  check ((completion_claim_token_hash is null) = (completion_claim_generation is null)),
  check ((acknowledged_at is not null) = (state = 'ACKNOWLEDGED'))
);

create index openclaw_runtime_commands_claimable_idx
  on public.openclaw_runtime_commands (organization_id, account_id, created_at, id)
  where state = 'PENDING';

create table public.openclaw_generation_revocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  principal_kind text not null check (principal_kind in ('CHANNEL','MAINTENANCE')),
  account_id uuid,
  cell_id uuid,
  maintenance_principal_id uuid,
  revocation_kind text not null
    check (revocation_kind in ('CREDENTIAL','LEASE','SESSION','MEDIA','CELL')),
  revoked_generation bigint not null check (revoked_generation > 0),
  minimum_valid_generation bigint not null check (minimum_valid_generation > revoked_generation),
  command_id uuid,
  reason_code text not null,
  acknowledgement_hash text check (acknowledgement_hash is null or acknowledgement_hash ~ '^[0-9a-f]{64}$'),
  acknowledged_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, maintenance_principal_id)
    references public.openclaw_maintenance_principals(organization_id, id) on delete restrict,
  foreign key (organization_id, command_id)
    references public.openclaw_runtime_commands(organization_id, id) on delete restrict,
  check (
    (principal_kind = 'CHANNEL' and account_id is not null and cell_id is not null
      and maintenance_principal_id is null)
    or (principal_kind = 'MAINTENANCE' and account_id is null and cell_id is null
      and maintenance_principal_id is not null)
  ),
  check ((acknowledgement_hash is null) = (acknowledged_at is null))
);

create unique index openclaw_generation_revocations_channel_uidx
  on public.openclaw_generation_revocations
    (organization_id, account_id, cell_id, revocation_kind, revoked_generation)
  where principal_kind = 'CHANNEL';
create unique index openclaw_generation_revocations_maintenance_uidx
  on public.openclaw_generation_revocations
    (organization_id, maintenance_principal_id, revocation_kind, revoked_generation)
  where principal_kind = 'MAINTENANCE';

create table public.openclaw_cell_rebinds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  old_cell_id uuid not null,
  new_cell_id uuid not null,
  runtime_command_id uuid not null,
  rebind_generation bigint not null check (rebind_generation > 0),
  expected_session_generation bigint not null check (expected_session_generation > 0),
  old_lease_generation bigint not null check (old_lease_generation > 0),
  old_fencing_token bigint not null check (old_fencing_token > 0),
  new_lease_generation bigint not null check (new_lease_generation > old_lease_generation),
  new_fencing_token bigint not null check (new_fencing_token > old_fencing_token),
  revocation_id uuid,
  acknowledgement_hash text check (acknowledgement_hash is null or acknowledgement_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'PREPARED' check (status in ('PREPARED','AWAITING_ACK','COMPLETED','ABORTED')),
  prepared_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  aborted_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, account_id, rebind_generation),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, old_cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, new_cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, runtime_command_id)
    references public.openclaw_runtime_commands(organization_id, id) on delete restrict,
  foreign key (organization_id, revocation_id)
    references public.openclaw_generation_revocations(organization_id, id) on delete restrict,
  check (old_cell_id <> new_cell_id),
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check ((status = 'ABORTED') = (aborted_at is not null)),
  check (status not in ('AWAITING_ACK','COMPLETED') or revocation_id is not null),
  check (status <> 'COMPLETED' or acknowledgement_hash is not null)
);

create unique index openclaw_cell_rebinds_one_prepared_uidx
  on public.openclaw_cell_rebinds (organization_id, account_id)
  where status in ('PREPARED','AWAITING_ACK');

create table public.openclaw_schedule_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  schedule_id uuid not null,
  schedule_version bigint not null check (schedule_version > 0),
  automation_version_id uuid not null,
  target_id uuid,
  campaign_id uuid,
  status text not null check (status in ('PAUSED','ACTIVE','CANCELLED','COMPLETE')),
  timezone text not null,
  local_recurrence_rule text not null,
  missed_occurrence_policy text not null check (missed_occurrence_policy = 'SKIPPED_MISSED'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_bytes bytea not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id, id),
  unique (organization_id, account_id, schedule_id, schedule_version),
  foreign key (organization_id, account_id, schedule_id)
    references public.openclaw_schedules(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, campaign_id)
    references public.openclaw_campaigns(organization_id, account_id, id) on delete restrict,
  check (convert_from(snapshot_bytes, 'UTF8')::jsonb = snapshot),
  check (snapshot_hash = encode(extensions.digest(
    convert_to('ihome-openclaw-schedule-snapshot-v1', 'UTF8')
      || decode('00', 'hex') || snapshot_bytes,
    'sha256'
  ), 'hex'))
);

create table public.openclaw_crm_event_subscription_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  subscription_id uuid not null,
  subscription_version bigint not null check (subscription_version > 0),
  automation_version_id uuid not null,
  destination_target_id uuid not null,
  event_type text not null
    check (event_type in ('lead_created_or_assigned','room_became_available','sales_task_due')),
  field_mapping jsonb not null check (jsonb_typeof(field_mapping) = 'object'),
  field_mapping_hash text not null check (field_mapping_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_bytes bytea not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id, id),
  unique (organization_id, account_id, subscription_id, subscription_version),
  foreign key (organization_id, account_id, subscription_id)
    references public.openclaw_crm_event_subscriptions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, destination_target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  check (convert_from(snapshot_bytes, 'UTF8')::jsonb = snapshot),
  check (snapshot_hash = encode(extensions.digest(
    convert_to('ihome-openclaw-crm-subscription-snapshot-v1', 'UTF8')
      || decode('00', 'hex') || snapshot_bytes,
    'sha256'
  ), 'hex'))
);

create table public.openclaw_inbound_collisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  request_id uuid not null,
  batch_index integer not null check (batch_index >= 0),
  existing_inbound_event_id uuid,
  event_kind text not null,
  provider_event_id text,
  provider_message_id text,
  raw_envelope_hash text not null check (raw_envelope_hash ~ '^[0-9a-f]{64}$'),
  normalized_hash text not null check (normalized_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  collision_kind text not null
    check (collision_kind in ('CROSS_KIND','PAIR_MISMATCH','PAYLOAD_MISMATCH','FINGERPRINT_COLLISION')),
  quarantined_envelope jsonb not null check (jsonb_typeof(quarantined_envelope) = 'object'),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id, id),
  unique (organization_id, account_id, request_id, batch_index),
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, existing_inbound_event_id)
    references public.openclaw_inbound_events(organization_id, account_id, id) on delete restrict
);

create table public.openclaw_retention_tombstones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  work_item_id uuid not null,
  subject_kind text not null
    check (subject_kind in ('MESSAGE','AI_DRAFT','MEDIA','KNOWLEDGE','HEALTH','AUDIT','POLICY','CONTROL','DELIVERY')),
  subject_id uuid not null,
  retention_version bigint not null check (retention_version > 0),
  hold_version bigint not null check (hold_version >= 0),
  quarantine_version bigint not null check (quarantine_version > 0),
  object_key text,
  redaction_evidence_hash text not null check (redaction_evidence_hash ~ '^[0-9a-f]{64}$'),
  quarantined_at timestamptz not null default statement_timestamp(),
  final_delete_not_before timestamptz,
  unique (organization_id, id),
  unique (organization_id, subject_kind, subject_id, retention_version, quarantine_version),
  foreign key (organization_id, maintenance_principal_id, work_item_id)
    references public.openclaw_maintenance_work_items(organization_id, maintenance_principal_id, id) on delete restrict,
  check (
    (subject_kind = 'MEDIA' and object_key is not null
      and final_delete_not_before = quarantined_at + interval '7 days')
    or (subject_kind <> 'MEDIA' and object_key is null and final_delete_not_before is null)
  )
);

create table public.openclaw_retention_delete_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  work_item_id uuid not null,
  tombstone_id uuid not null,
  claim_generation bigint not null check (claim_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  object_key text not null,
  hold_version bigint not null check (hold_version >= 0),
  quarantine_version bigint not null check (quarantine_version > 0),
  delete_ticket_jti uuid not null,
  delete_authorization_jti uuid not null,
  authorization_payload jsonb not null check (jsonb_typeof(authorization_payload) = 'object'),
  authorization_bytes bytea not null,
  authorization_hash text not null check (authorization_hash ~ '^[0-9a-f]{64}$'),
  gateway_signing_key_generation bigint not null check (gateway_signing_key_generation > 0),
  issued_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  work_lease_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  receipt jsonb,
  receipt_hash text check (receipt_hash is null or receipt_hash ~ '^[0-9a-f]{64}$'),
  finalized_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, maintenance_principal_id, work_item_id)
    references public.openclaw_maintenance_work_items(organization_id, maintenance_principal_id, id) on delete restrict,
  foreign key (organization_id, tombstone_id)
    references public.openclaw_retention_tombstones(organization_id, id) on delete restrict,
  check (convert_from(authorization_bytes, 'UTF8')::jsonb = authorization_payload),
  check (authorization_hash = encode(extensions.digest(
    convert_to('ihome-openclaw-retention-authorization-v1', 'UTF8')
      || decode('00', 'hex') || authorization_bytes,
    'sha256'
  ), 'hex')),
  check (expires_at <= issued_at + interval '5 seconds'),
  check (expires_at <= work_lease_expires_at),
  check ((revoked_at is null) = (revoked_reason is null)),
  check ((receipt is null) = (receipt_hash is null)),
  check ((receipt is null) = (finalized_at is null))
);

create unique index openclaw_retention_delete_ticket_jti_uidx
  on public.openclaw_retention_delete_authorizations (organization_id, delete_ticket_jti);
create unique index openclaw_retention_delete_authorization_jti_uidx
  on public.openclaw_retention_delete_authorizations (organization_id, delete_authorization_jti);

create table public.openclaw_smoke_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  smoke_run_id uuid not null,
  rollout_run_id uuid not null,
  rollout_stage text not null,
  rollout_stage_version bigint not null check (rollout_stage_version > 0),
  observation_kind text not null,
  trusted_row_ids uuid[] not null,
  trusted_rows_hash text not null check (trusted_rows_hash ~ '^[0-9a-f]{64}$'),
  content_free_metrics jsonb not null check (jsonb_typeof(content_free_metrics) = 'object'),
  lineage_hash text not null check (lineage_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default statement_timestamp(),
  unique (organization_id, id),
  unique (organization_id, smoke_run_id, observation_kind, lineage_hash),
  foreign key (organization_id, smoke_run_id)
    references public.openclaw_smoke_runs(organization_id, id) on delete restrict,
  foreign key (organization_id, rollout_run_id)
    references public.openclaw_rollout_runs(organization_id, id) on delete restrict,
  check (cardinality(trusted_row_ids) > 0)
);

create table public.openclaw_service_nonces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  principal_kind text not null check (principal_kind in ('CHANNEL','MAINTENANCE')),
  account_id uuid,
  cell_id uuid,
  maintenance_principal_id uuid,
  credential_generation bigint not null check (credential_generation > 0),
  lease_generation bigint not null check (lease_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  operation text not null,
  nonce_namespace text not null check (nonce_namespace in ('RUNTIME','EXCHANGE')),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  envelope_hash text not null check (envelope_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  result_hash text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  unique (organization_id, id),
  check (expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'),
  check ((consumed_at is null) = (result_hash is null)),
  check (
    (principal_kind = 'CHANNEL' and account_id is not null and cell_id is not null
      and maintenance_principal_id is null)
    or (principal_kind = 'MAINTENANCE' and account_id is null and cell_id is null
      and maintenance_principal_id is not null)
  )
);

create unique index openclaw_service_nonces_channel_uidx
  on public.openclaw_service_nonces (
    organization_id, account_id, cell_id, nonce_namespace, nonce_hash
  )
  where principal_kind = 'CHANNEL';
create unique index openclaw_service_nonces_maintenance_uidx
  on public.openclaw_service_nonces (
    organization_id, maintenance_principal_id, nonce_namespace, nonce_hash
  )
  where principal_kind = 'MAINTENANCE';
create index openclaw_service_nonces_unconsumed_idx
  on public.openclaw_service_nonces (expires_at, organization_id)
  where consumed_at is null;

alter table public.openclaw_runtime_commands
  add constraint openclaw_runtime_commands_org_account_cell_id_key
  unique (organization_id, account_id, cell_id, id);

alter table public.openclaw_runtime_credentials
  drop constraint openclaw_runtime_credentials_allowed_scopes_check,
  add constraint openclaw_runtime_credentials_allowed_scopes_check
    check (allowed_scopes <@ array[
      'heartbeat','qr.publish','qr.result','inbound.commit','outbox.claim',
      'outbox.preflight','outbox.authorize-send','outbox.requeue','outbox.complete',
      'work.claim','work.context','work.complete','media.issue','lease.acquire','cell.rebind',
      'generation.ack','credential.exchange','runtime.sweep'
    ]::text[]);

alter table public.openclaw_maintenance_credentials
  drop constraint openclaw_maintenance_credentials_allowed_scopes_check,
  add constraint openclaw_maintenance_credentials_allowed_scopes_check
    check (allowed_scopes <@ array[
      'maintenance.claim','maintenance.complete','maintenance.exchange',
      'retention.authorize','watchdog.health','rollout.manage','smoke.manage',
      'media.issue','maintenance.sweep'
    ]::text[]);

alter table public.openclaw_qr_challenges
  alter column ciphertext drop not null,
  alter column cipher_iv drop not null,
  alter column auth_tag drop not null,
  add column runtime_command_id uuid,
  add column material_version integer not null default 0,
  add column material_published_at timestamptz,
  add column poll_window_started_at timestamptz,
  add column poll_count integer not null default 0,
  add constraint openclaw_qr_poll_count_check
    check (poll_count between 0 and 10),
  add constraint openclaw_qr_poll_window_consistency_check
    check ((poll_count = 0) = (poll_window_started_at is null)),
  add constraint openclaw_qr_runtime_command_fkey
    foreign key (organization_id, account_id, cell_id, runtime_command_id)
    references public.openclaw_runtime_commands(organization_id, account_id, cell_id, id)
    on delete restrict;

update public.openclaw_qr_challenges
set material_version = 1,
    material_published_at = issued_at
where ciphertext is not null and cipher_iv is not null and auth_tag is not null;

alter table public.openclaw_qr_challenges
  add constraint openclaw_qr_material_version_check
    check (material_version in (0, 1)),
  add constraint openclaw_qr_material_consistency_check
    check (
      (material_version = 0 and ciphertext is null and cipher_iv is null
        and auth_tag is null and material_published_at is null)
      or (material_version = 1 and ciphertext is not null and cipher_iv is not null
        and auth_tag is not null and material_published_at is not null)
    );

create unique index openclaw_qr_challenges_one_result_per_command_uidx
  on public.openclaw_qr_challenges (organization_id, runtime_command_id)
  where runtime_command_id is not null;

alter table public.openclaw_outbox
  add column smoke_run_id uuid,
  add constraint openclaw_outbox_smoke_run_fkey
    foreign key (organization_id, smoke_run_id)
    references public.openclaw_smoke_runs(organization_id, id) on delete restrict,
  add constraint openclaw_outbox_schedule_snapshot_fkey
    foreign key (organization_id, account_id, schedule_id, schedule_version)
    references public.openclaw_schedule_snapshots(
      organization_id, account_id, schedule_id, schedule_version
    ) on delete restrict,
  add constraint openclaw_outbox_crm_subscription_snapshot_fkey
    foreign key (organization_id, account_id, subscription_id, subscription_version)
    references public.openclaw_crm_event_subscription_snapshots(
      organization_id, account_id, subscription_id, subscription_version
    ) on delete restrict;

alter table public.openclaw_send_work_items
  add column smoke_run_id uuid,
  add constraint openclaw_send_work_smoke_run_fkey
    foreign key (organization_id, smoke_run_id)
    references public.openclaw_smoke_runs(organization_id, id) on delete restrict;

alter table public.openclaw_maintenance_work_items
  add column smoke_run_id uuid,
  add constraint openclaw_maintenance_work_smoke_run_fkey
    foreign key (organization_id, smoke_run_id)
    references public.openclaw_smoke_runs(organization_id, id) on delete restrict;

create index openclaw_outbox_smoke_residual_idx
  on public.openclaw_outbox (organization_id, smoke_run_id, state, id)
  where smoke_run_id is not null;
create index openclaw_send_work_smoke_residual_idx
  on public.openclaw_send_work_items (organization_id, smoke_run_id, state, id)
  where smoke_run_id is not null;
create index openclaw_maintenance_work_smoke_residual_idx
  on public.openclaw_maintenance_work_items (organization_id, smoke_run_id, state, id)
  where smoke_run_id is not null;

alter table public.openclaw_rollout_runs
  add column project_ref text not null default 'tryymsxyyckgbrmmvozx'
    check (project_ref ~ '^[a-z0-9]{20}$'),
  add column stage_entered_at timestamptz not null default statement_timestamp(),
  add column shadow_started_at timestamptz;

alter table public.openclaw_smoke_runs
  add column project_ref text,
  add column reviewed_commit_sha text,
  add column rollout_stage text,
  add column rollout_stage_version bigint,
  add column lineage_hash text,
  add constraint openclaw_smoke_identity_consistency_check
    check (
      (project_ref is null and reviewed_commit_sha is null and rollout_stage is null
        and rollout_stage_version is null and lineage_hash is null)
      or (project_ref ~ '^[a-z0-9]{20}$'
        and reviewed_commit_sha ~ '^[0-9a-f]{40}$'
        and rollout_stage is not null
        and rollout_stage_version > 0
        and lineage_hash ~ '^[0-9a-f]{64}$')
    );

create unique index openclaw_retention_holds_one_active_target_uidx
  on public.openclaw_retention_holds (organization_id, target_kind, target_id)
  where released_at is null;

create or replace function app_private.guard_openclaw_rpc_lineage_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP = 'DELETE' then
    raise exception '% is immutable', TG_TABLE_NAME using errcode = '55000';
  end if;
  if TG_TABLE_NAME = 'openclaw_outbox' then
    if NEW.smoke_run_id is distinct from OLD.smoke_run_id then
      raise exception 'outbox smoke lineage is immutable' using errcode = '55000';
    end if;
  elsif TG_TABLE_NAME in ('openclaw_send_work_items','openclaw_maintenance_work_items') then
    if NEW.smoke_run_id is distinct from OLD.smoke_run_id then
      raise exception 'work smoke lineage is immutable' using errcode = '55000';
    end if;
  elsif TG_TABLE_NAME = 'openclaw_smoke_runs' then
    if NEW.project_ref is distinct from OLD.project_ref
       or NEW.reviewed_commit_sha is distinct from OLD.reviewed_commit_sha
       or NEW.rollout_stage is distinct from OLD.rollout_stage
       or NEW.rollout_stage_version is distinct from OLD.rollout_stage_version
       or NEW.lineage_hash is distinct from OLD.lineage_hash
    then
      raise exception 'smoke deployment identity is immutable' using errcode = '55000';
    end if;
  elsif TG_TABLE_NAME = 'openclaw_rollout_runs' then
    if NEW.project_ref is distinct from OLD.project_ref then
      raise exception 'rollout project identity is immutable' using errcode = '55000';
    end if;
  end if;
  return NEW;
end;
$function$;

alter function app_private.guard_openclaw_rpc_lineage_v1() owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_rpc_lineage_v1()
  from public, anon, authenticated, service_role;

create trigger openclaw_outbox_rpc_lineage_guard
before update or delete on public.openclaw_outbox
for each row execute function app_private.guard_openclaw_rpc_lineage_v1();
create trigger openclaw_send_work_rpc_lineage_guard
before update or delete on public.openclaw_send_work_items
for each row execute function app_private.guard_openclaw_rpc_lineage_v1();
create trigger openclaw_maintenance_work_rpc_lineage_guard
before update or delete on public.openclaw_maintenance_work_items
for each row execute function app_private.guard_openclaw_rpc_lineage_v1();
create trigger openclaw_rollout_rpc_lineage_guard
before update or delete on public.openclaw_rollout_runs
for each row execute function app_private.guard_openclaw_rpc_lineage_v1();
create trigger openclaw_smoke_rpc_lineage_guard
before update or delete on public.openclaw_smoke_runs
for each row execute function app_private.guard_openclaw_rpc_lineage_v1();

create or replace function app_private.openclaw_retention_holds_release_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP = 'DELETE' then
    raise exception 'retention hold history is immutable' using errcode = '55000';
  end if;
  if NEW.organization_id is distinct from OLD.organization_id
     or NEW.target_kind is distinct from OLD.target_kind
     or NEW.target_id is distinct from OLD.target_id
     or NEW.reason is distinct from OLD.reason
     or NEW.created_by is distinct from OLD.created_by
     or NEW.created_at is distinct from OLD.created_at
     or NEW.expires_at is distinct from OLD.expires_at
  then
    raise exception 'retention hold identity is immutable' using errcode = '55000';
  end if;
  if OLD.released_at is not null
     or NEW.released_at is null
     or NEW.released_by is null
     or NEW.release_reason is null
     or NEW.hold_version <> OLD.hold_version + 1
  then
    raise exception 'retention hold release must happen once and increment hold_version'
      using errcode = '55000';
  end if;
  return NEW;
end;
$function$;

alter function app_private.openclaw_retention_holds_release_guard_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_retention_holds_release_guard_v1()
  from public, anon, authenticated, service_role;
create trigger openclaw_retention_holds_release_guard
before update or delete on public.openclaw_retention_holds
for each row execute function app_private.openclaw_retention_holds_release_guard_v1();

create or replace function app_private.guard_openclaw_client_operation_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP = 'DELETE' then
    raise exception 'client operation history is immutable' using errcode = '55000';
  end if;
  if OLD.completed_at is not null
     or NEW.organization_id is distinct from OLD.organization_id
     or NEW.actor_id is distinct from OLD.actor_id
     or NEW.operation_key is distinct from OLD.operation_key
     or NEW.client_operation_id is distinct from OLD.client_operation_id
     or NEW.request_hash is distinct from OLD.request_hash
     or NEW.replay_policy is distinct from OLD.replay_policy
     or NEW.created_at is distinct from OLD.created_at
     or NEW.safe_result is null
     or NEW.result_hash is null
     or NEW.completed_at is null
  then
    raise exception 'client operation completion is immutable and one-time'
      using errcode = '55000';
  end if;
  return NEW;
end;
$function$;

alter function app_private.guard_openclaw_client_operation_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_client_operation_v1()
  from public, anon, authenticated, service_role;
create trigger openclaw_client_operations_completion_guard
before update or delete on public.openclaw_client_operations
for each row execute function app_private.guard_openclaw_client_operation_v1();

create or replace function app_private.guard_openclaw_retention_authorization_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP = 'DELETE' then
    raise exception 'retention authorization history is immutable' using errcode = '55000';
  end if;
  if OLD.finalized_at is not null
     or NEW.organization_id is distinct from OLD.organization_id
     or NEW.maintenance_principal_id is distinct from OLD.maintenance_principal_id
     or NEW.work_item_id is distinct from OLD.work_item_id
     or NEW.tombstone_id is distinct from OLD.tombstone_id
     or NEW.claim_generation is distinct from OLD.claim_generation
     or NEW.fencing_token is distinct from OLD.fencing_token
     or NEW.object_key is distinct from OLD.object_key
     or NEW.hold_version is distinct from OLD.hold_version
     or NEW.quarantine_version is distinct from OLD.quarantine_version
     or NEW.delete_ticket_jti is distinct from OLD.delete_ticket_jti
     or NEW.delete_authorization_jti is distinct from OLD.delete_authorization_jti
     or NEW.authorization_payload is distinct from OLD.authorization_payload
     or NEW.authorization_bytes is distinct from OLD.authorization_bytes
     or NEW.authorization_hash is distinct from OLD.authorization_hash
     or NEW.gateway_signing_key_generation is distinct from OLD.gateway_signing_key_generation
     or NEW.issued_at is distinct from OLD.issued_at
     or NEW.expires_at is distinct from OLD.expires_at
     or NEW.work_lease_expires_at is distinct from OLD.work_lease_expires_at
  then
    raise exception 'retention authorization finalization is immutable and one-time'
      using errcode = '55000';
  end if;
  if OLD.revoked_at is null and NEW.revoked_at is not null then
    if NEW.revoked_reason is null or NEW.receipt is not null
       or NEW.receipt_hash is not null or NEW.finalized_at is not null
    then
      raise exception 'retention authorization revocation is invalid' using errcode = '55000';
    end if;
    return NEW;
  end if;
  if NEW.revoked_at is distinct from OLD.revoked_at
     or NEW.revoked_reason is distinct from OLD.revoked_reason
     or NEW.receipt is null or NEW.receipt_hash is null or NEW.finalized_at is null
  then
    raise exception 'retention authorization finalization is immutable and one-time'
      using errcode = '55000';
  end if;
  return NEW;
end;
$function$;

alter function app_private.guard_openclaw_retention_authorization_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_retention_authorization_v1()
  from public, anon, authenticated, service_role;
create trigger openclaw_retention_authorization_finalize_guard
before update or delete on public.openclaw_retention_delete_authorizations
for each row execute function app_private.guard_openclaw_retention_authorization_v1();

create trigger openclaw_schedule_snapshots_append_only
before update or delete on public.openclaw_schedule_snapshots
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_crm_subscription_snapshots_append_only
before update or delete on public.openclaw_crm_event_subscription_snapshots
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_inbound_collisions_append_only
before update or delete on public.openclaw_inbound_collisions
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_retention_tombstones_append_only
before update or delete on public.openclaw_retention_tombstones
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_smoke_observations_append_only
before update or delete on public.openclaw_smoke_observations
for each row execute function app_private.reject_openclaw_append_only_v1();

alter table public.openclaw_client_operations owner to openclaw_function_owner;
alter table public.openclaw_client_operations enable row level security;
alter table public.openclaw_client_operations force row level security;
revoke all on public.openclaw_client_operations from public, anon, authenticated, service_role;
create policy openclaw_client_operations_function_owner_all
  on public.openclaw_client_operations for all to openclaw_function_owner
  using (true) with check (true);

alter table public.openclaw_runtime_commands owner to openclaw_function_owner;
alter table public.openclaw_runtime_commands enable row level security;
alter table public.openclaw_runtime_commands force row level security;
revoke all on public.openclaw_runtime_commands from public, anon, authenticated, service_role;
create policy openclaw_runtime_commands_function_owner_all
  on public.openclaw_runtime_commands for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_runtime_commands_runtime_writer_all
  on public.openclaw_runtime_commands for all to openclaw_runtime_writer
  using (true) with check (true);

alter table public.openclaw_generation_revocations owner to openclaw_function_owner;
alter table public.openclaw_generation_revocations enable row level security;
alter table public.openclaw_generation_revocations force row level security;
revoke all on public.openclaw_generation_revocations from public, anon, authenticated, service_role;
create policy openclaw_generation_revocations_function_owner_all
  on public.openclaw_generation_revocations for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_generation_revocations_runtime_writer_all
  on public.openclaw_generation_revocations for all to openclaw_runtime_writer
  using (principal_kind = 'CHANNEL') with check (principal_kind = 'CHANNEL');
create policy openclaw_generation_revocations_maintenance_writer_all
  on public.openclaw_generation_revocations for all to openclaw_maintenance_writer
  using (principal_kind = 'MAINTENANCE') with check (principal_kind = 'MAINTENANCE');

alter table public.openclaw_cell_rebinds owner to openclaw_function_owner;
alter table public.openclaw_cell_rebinds enable row level security;
alter table public.openclaw_cell_rebinds force row level security;
revoke all on public.openclaw_cell_rebinds from public, anon, authenticated, service_role;
create policy openclaw_cell_rebinds_function_owner_all
  on public.openclaw_cell_rebinds for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_cell_rebinds_runtime_writer_all
  on public.openclaw_cell_rebinds for all to openclaw_runtime_writer
  using (true) with check (true);

alter table public.openclaw_schedule_snapshots owner to openclaw_function_owner;
alter table public.openclaw_schedule_snapshots enable row level security;
alter table public.openclaw_schedule_snapshots force row level security;
revoke all on public.openclaw_schedule_snapshots from public, anon, authenticated, service_role;
create policy openclaw_schedule_snapshots_function_owner_all
  on public.openclaw_schedule_snapshots for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_schedule_snapshots_runtime_writer_select
  on public.openclaw_schedule_snapshots for select to openclaw_runtime_writer
  using (true);

alter table public.openclaw_crm_event_subscription_snapshots owner to openclaw_function_owner;
alter table public.openclaw_crm_event_subscription_snapshots enable row level security;
alter table public.openclaw_crm_event_subscription_snapshots force row level security;
revoke all on public.openclaw_crm_event_subscription_snapshots from public, anon, authenticated, service_role;
create policy openclaw_crm_event_subscription_snapshots_function_owner_all
  on public.openclaw_crm_event_subscription_snapshots for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_crm_event_subscription_snapshots_runtime_writer_select
  on public.openclaw_crm_event_subscription_snapshots for select to openclaw_runtime_writer
  using (true);

alter table public.openclaw_inbound_collisions owner to openclaw_function_owner;
alter table public.openclaw_inbound_collisions enable row level security;
alter table public.openclaw_inbound_collisions force row level security;
revoke all on public.openclaw_inbound_collisions from public, anon, authenticated, service_role;
create policy openclaw_inbound_collisions_function_owner_all
  on public.openclaw_inbound_collisions for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_inbound_collisions_runtime_writer_insert
  on public.openclaw_inbound_collisions for insert to openclaw_runtime_writer
  with check (true);
create policy openclaw_inbound_collisions_runtime_writer_select
  on public.openclaw_inbound_collisions for select to openclaw_runtime_writer
  using (true);

alter table public.openclaw_retention_tombstones owner to openclaw_function_owner;
alter table public.openclaw_retention_tombstones enable row level security;
alter table public.openclaw_retention_tombstones force row level security;
revoke all on public.openclaw_retention_tombstones from public, anon, authenticated, service_role;
create policy openclaw_retention_tombstones_function_owner_all
  on public.openclaw_retention_tombstones for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_retention_tombstones_maintenance_writer_all
  on public.openclaw_retention_tombstones for all to openclaw_maintenance_writer
  using (true) with check (true);

alter table public.openclaw_retention_delete_authorizations owner to openclaw_function_owner;
alter table public.openclaw_retention_delete_authorizations enable row level security;
alter table public.openclaw_retention_delete_authorizations force row level security;
revoke all on public.openclaw_retention_delete_authorizations from public, anon, authenticated, service_role;
create policy openclaw_retention_delete_authorizations_function_owner_all
  on public.openclaw_retention_delete_authorizations for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_retention_delete_authorizations_maintenance_writer_all
  on public.openclaw_retention_delete_authorizations for all to openclaw_maintenance_writer
  using (true) with check (true);

alter table public.openclaw_smoke_observations owner to openclaw_function_owner;
alter table public.openclaw_smoke_observations enable row level security;
alter table public.openclaw_smoke_observations force row level security;
revoke all on public.openclaw_smoke_observations from public, anon, authenticated, service_role;
create policy openclaw_smoke_observations_function_owner_all
  on public.openclaw_smoke_observations for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_smoke_observations_maintenance_writer_all
  on public.openclaw_smoke_observations for all to openclaw_maintenance_writer
  using (true) with check (true);

alter table public.openclaw_service_nonces owner to openclaw_function_owner;
alter table public.openclaw_service_nonces enable row level security;
alter table public.openclaw_service_nonces force row level security;
revoke all on public.openclaw_service_nonces from public, anon, authenticated, service_role;
create policy openclaw_service_nonces_function_owner_all
  on public.openclaw_service_nonces for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_service_nonces_runtime_writer_all
  on public.openclaw_service_nonces for all to openclaw_runtime_writer
  using (principal_kind = 'CHANNEL') with check (principal_kind = 'CHANNEL');
create policy openclaw_service_nonces_maintenance_writer_all
  on public.openclaw_service_nonces for all to openclaw_maintenance_writer
  using (principal_kind = 'MAINTENANCE') with check (principal_kind = 'MAINTENANCE');

grant select, insert, update on public.openclaw_client_operations to openclaw_function_owner;
grant select, insert, update on public.openclaw_runtime_commands to openclaw_function_owner, openclaw_runtime_writer;
grant select, insert, update on public.openclaw_generation_revocations
  to openclaw_function_owner, openclaw_runtime_writer, openclaw_maintenance_writer;
grant select, insert, update on public.openclaw_cell_rebinds
  to openclaw_function_owner, openclaw_runtime_writer;
grant select, insert on public.openclaw_schedule_snapshots, public.openclaw_crm_event_subscription_snapshots
  to openclaw_function_owner;
grant select on public.openclaw_schedule_snapshots, public.openclaw_crm_event_subscription_snapshots
  to openclaw_runtime_writer;
grant select, insert on public.openclaw_inbound_collisions
  to openclaw_function_owner, openclaw_runtime_writer;
grant select, insert on public.openclaw_retention_tombstones
  to openclaw_function_owner, openclaw_maintenance_writer;
grant select, insert, update on public.openclaw_retention_delete_authorizations
  to openclaw_function_owner, openclaw_maintenance_writer;
grant select, insert on public.openclaw_smoke_observations
  to openclaw_function_owner, openclaw_maintenance_writer;
grant select, insert, update on public.openclaw_service_nonces
  to openclaw_function_owner, openclaw_runtime_writer, openclaw_maintenance_writer;

-- Maintenance-only retention and smoke routines need narrow cross-domain row access.
-- The role is NOLOGIN; tenant and lineage predicates remain inside the SECURITY DEFINER leaves.
create policy openclaw_message_media_maintenance_retention_select
  on public.openclaw_message_media for select to openclaw_maintenance_writer using (true);
create policy openclaw_message_media_maintenance_retention_update
  on public.openclaw_message_media for update to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_outbox_maintenance_smoke_select
  on public.openclaw_outbox for select to openclaw_maintenance_writer using (true);
create policy openclaw_outbox_maintenance_smoke_update
  on public.openclaw_outbox for update to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_send_work_maintenance_smoke_select
  on public.openclaw_send_work_items for select to openclaw_maintenance_writer using (true);
create policy openclaw_send_work_maintenance_smoke_update
  on public.openclaw_send_work_items for update to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_rollout_checkpoints_maintenance_update
  on public.openclaw_rollout_checkpoints for update to openclaw_maintenance_writer
  using (true) with check (true);
grant select, update on public.openclaw_message_media,
  public.openclaw_outbox, public.openclaw_send_work_items
  to openclaw_maintenance_writer;
grant update on public.openclaw_rollout_checkpoints to openclaw_maintenance_writer;

create or replace function app_private.openclaw_assert_strict_object_v1(
  p_value jsonb,
  p_allowed_keys text[],
  p_required_keys text[] default '{}'::text[]
)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_key text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'strict JSON object required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_value) key_name
    where not (key_name = any(p_allowed_keys))
  ) then
    raise exception 'unknown JSON key rejected' using errcode = '22023';
  end if;
  foreach v_key in array p_required_keys loop
    if not (p_value ? v_key) then
      raise exception 'required JSON key % is missing', v_key using errcode = '22023';
    end if;
  end loop;
end;
$function$;

create or replace function app_private.openclaw_jcs_text_v1(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare
  v_type text := jsonb_typeof(p_value);
  v_text text;
begin
  if v_type = 'object' then
    if exists (
      select 1 from jsonb_object_keys(p_value) k
      where octet_length(k) <> char_length(k)
    ) then
      raise exception 'non-ASCII object key rejected' using errcode = '22023';
    end if;
    select '{' || coalesce(string_agg(
      to_jsonb(entry.key)::text || ':' || app_private.openclaw_jcs_text_v1(entry.value),
      ',' order by entry.key collate "C"
    ), '') || '}'
    into v_text
    from jsonb_each(p_value) entry;
    return v_text;
  elsif v_type = 'array' then
    select '[' || coalesce(string_agg(
      app_private.openclaw_jcs_text_v1(item.value),
      ',' order by item.ordinality
    ), '') || ']'
    into v_text
    from jsonb_array_elements(p_value) with ordinality item(value, ordinality);
    return v_text;
  elsif v_type = 'number' then
    v_text := p_value #>> '{}';
    if v_text !~ '^-?(0|[1-9][0-9]*)$' then
      raise exception 'integer-only JSON number required' using errcode = '22023';
    end if;
    return v_text;
  elsif v_type in ('string','boolean','null') then
    return p_value::text;
  end if;
  raise exception 'unsupported JSON type for JCS' using errcode = '22023';
end;
$function$;

create or replace function app_private.openclaw_jcs_bytes_v1(p_value jsonb)
returns bytea
language sql
immutable
strict
set search_path = ''
as $function$
  select convert_to(app_private.openclaw_jcs_text_v1(p_value), 'UTF8')
$function$;

create or replace function app_private.openclaw_secure_digest_equal_v1(
  p_expected text,
  p_actual text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_expected bytea;
  v_actual bytea;
  v_difference integer := 0;
  v_index integer;
begin
  if p_expected is null or p_actual is null
     or p_expected !~ '^[0-9a-f]{64}$'
     or p_actual !~ '^[0-9a-f]{64}$'
  then
    return false;
  end if;

  v_expected := decode(p_expected, 'hex');
  v_actual := decode(p_actual, 'hex');
  if octet_length(v_expected) <> 32 or octet_length(v_actual) <> 32 then
    return false;
  end if;

  for v_index in 0..31 loop
    v_difference := v_difference
      | (get_byte(v_expected, v_index) # get_byte(v_actual, v_index));
  end loop;
  return v_difference = 0;
exception
  when others then
    return false;
end;
$function$;

create or replace function app_private.openclaw_canonical_send_payload_bytes_v1(
  p_payload jsonb
)
returns bytea
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare
  v_part jsonb;
  v_ordinality bigint;
  v_frozen jsonb;
  v_target jsonb;
  v_part_count integer;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_payload,
    array['version','organizationId','accountId','target','channel','accountProfile',
      'idempotencyKey','parts','replyToProviderMessageId','policyVersionId',
      'automationVersionId','templateVersionId','frozenInputs'],
    array['version','organizationId','accountId','target','channel','accountProfile',
      'idempotencyKey','parts','replyToProviderMessageId','policyVersionId',
      'automationVersionId','templateVersionId','frozenInputs']
  );
  if p_payload ->> 'version' <> '1' or p_payload ->> 'channel' <> 'zalouser' then
    raise exception 'CanonicalSendPayloadV1 version/channel mismatch' using errcode = '22023';
  end if;
  if coalesce(p_payload ->> 'organizationId', '') = ''
     or coalesce(p_payload ->> 'accountId', '') = ''
     or coalesce(p_payload ->> 'accountProfile', '') = ''
     or coalesce(p_payload ->> 'idempotencyKey', '') = ''
     or coalesce(p_payload ->> 'policyVersionId', '') = ''
  then
    raise exception 'CanonicalSendPayloadV1 identity is incomplete' using errcode = '22023';
  end if;

  v_target := p_payload -> 'target';
  perform app_private.openclaw_assert_strict_object_v1(
    v_target, array['kind','providerId'], array['kind','providerId']
  );
  if v_target ->> 'kind' not in ('PEER','SALES_GROUP')
     or coalesce(v_target ->> 'providerId', '') = ''
  then
    raise exception 'CanonicalSendPayloadV1 target is invalid' using errcode = '22023';
  end if;

  v_frozen := p_payload -> 'frozenInputs';
  perform app_private.openclaw_assert_strict_object_v1(
    v_frozen,
    array['campaignVersionId','scheduleVersion','subscriptionVersion','subscriptionId',
      'occurrenceId','sourceTable','sourceId','sourceVersion','knowledgeVersionIds',
      'sourceSnapshotHash','targetVersion','targetDirectoryRefreshedAt','fieldMappingHash'],
    array['campaignVersionId','scheduleVersion','subscriptionVersion','subscriptionId',
      'occurrenceId','sourceTable','sourceId','sourceVersion','knowledgeVersionIds',
      'sourceSnapshotHash','targetVersion','targetDirectoryRefreshedAt','fieldMappingHash']
  );
  if jsonb_typeof(v_frozen -> 'knowledgeVersionIds') <> 'array'
     or (v_frozen ->> 'targetVersion')::bigint <= 0
     or coalesce(v_frozen ->> 'targetDirectoryRefreshedAt', '') = ''
  then
    raise exception 'CanonicalSendPayloadV1 frozenInputs are invalid' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'parts') <> 'array' then
    raise exception 'CanonicalSendPayloadV1 parts array required' using errcode = '22023';
  end if;
  v_part_count := jsonb_array_length(p_payload -> 'parts');
  if v_part_count < 1 or not (v_part_count <= 20) then
    raise exception 'CanonicalSendPayloadV1 part_count <= 20 and non-empty required'
      using errcode = '22023';
  end if;

  for v_part, v_ordinality in
    select item.value, item.ordinality
    from jsonb_array_elements(p_payload -> 'parts') with ordinality item(value, ordinality)
  loop
    if v_part ->> 'kind' = 'TEXT' then
      perform app_private.openclaw_assert_strict_object_v1(
        v_part, array['version','partIndex','kind','text'],
        array['version','partIndex','kind','text']
      );
      if (v_part ->> 'version')::integer <> 1
         or (v_part ->> 'partIndex')::integer <> v_ordinality - 1
         or char_length(v_part ->> 'text') < 1
         or char_length(v_part ->> 'text') > 2000
      then
        raise exception 'CanonicalSendPayloadV1 TEXT part is invalid' using errcode = '22023';
      end if;
    elsif v_part ->> 'kind' = 'MEDIA' then
      perform app_private.openclaw_assert_strict_object_v1(
        v_part, array['version','partIndex','kind','objectKey','sha256','mime','bytes'],
        array['version','partIndex','kind','objectKey','sha256','mime','bytes']
      );
      if (v_part ->> 'version')::integer <> 1
         or (v_part ->> 'partIndex')::integer <> v_ordinality - 1
         or coalesce(v_part ->> 'objectKey', '') = ''
         or (v_part ->> 'sha256') !~ '^[0-9a-f]{64}$'
         or coalesce(v_part ->> 'mime', '') = ''
         or (v_part ->> 'bytes')::bigint <= 0
      then
        raise exception 'CanonicalSendPayloadV1 MEDIA part is invalid' using errcode = '22023';
      end if;
    else
      raise exception 'CanonicalSendPayloadV1 part kind is invalid' using errcode = '22023';
    end if;
  end loop;

  return app_private.openclaw_jcs_bytes_v1(p_payload);
end;
$function$;

create or replace function app_private.openclaw_send_payload_hash_v1(p_payload jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  select encode(extensions.digest(
    convert_to('ihome-openclaw-' || 'send-v1', 'UTF8')
      || decode('00', 'hex')
      || app_private.openclaw_canonical_send_payload_bytes_v1(p_payload),
    'sha256'
  ), 'hex')
$function$;

create or replace function app_private.openclaw_text_chunks_v1(p_text text)
returns jsonb
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare
  v_offset integer := 1;
  v_part_count integer;
  v_chunks jsonb := '[]'::jsonb;
begin
  if char_length(p_text) = 0 then
    raise exception 'text must not be empty' using errcode = '22023';
  end if;
  v_part_count := ceil(char_length(p_text)::numeric / 2000)::integer;
  if not (v_part_count <= 20) then
    raise exception 'text requires more than 20 parts' using errcode = '22023';
  end if;
  while v_offset <= char_length(p_text) loop
    v_chunks := v_chunks || jsonb_build_array(substring(p_text from v_offset for 2000));
    v_offset := v_offset + 2000;
  end loop;
  return v_chunks;
end;
$function$;

do $unicode_golden$
declare
  v_astral text := repeat('a', 1999) || chr(128512) || 'b';
  v_decomposed text := repeat(convert_from(decode('65cc81', 'hex'), 'UTF8'), 1000);
  v_nfc text := convert_from(decode('c3a9', 'hex'), 'UTF8');
  v_nfd text := convert_from(decode('65cc81', 'hex'), 'UTF8');
begin
  if jsonb_array_length(app_private.openclaw_text_chunks_v1(v_astral)) <> 2
     or char_length(app_private.openclaw_text_chunks_v1(v_astral) ->> 0) <> 2000
     or char_length(app_private.openclaw_text_chunks_v1(v_astral) ->> 1) <> 1
  then
    raise exception '1999 × a + astral + b => 2000,1';
  end if;
  if jsonb_array_length(app_private.openclaw_text_chunks_v1(v_decomposed)) <> 1
     or char_length(app_private.openclaw_text_chunks_v1(v_decomposed) ->> 0) <> 2000
  then
    raise exception '1000 × decomposed e acute => 2000';
  end if;
  if extensions.digest(app_private.openclaw_jcs_bytes_v1(to_jsonb(v_nfc)), 'sha256')
     = extensions.digest(app_private.openclaw_jcs_bytes_v1(to_jsonb(v_nfd)), 'sha256')
  then
    raise exception 'NFC and NFD payload hashes must differ';
  end if;
end;
$unicode_golden$;

create or replace function app_private.openclaw_client_request_hash_v1(
  p_operation_key text,
  p_request jsonb
)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  select encode(extensions.digest(
    convert_to('ihome-openclaw-client-operation-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_operation_key, 'UTF8')
      || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(p_request),
    'sha256'
  ), 'hex')
$function$;

create or replace function app_private.openclaw_begin_client_operation_v1(
  p_organization_id uuid,
  p_actor_id uuid,
  p_operation_key text,
  p_client_operation_id uuid,
  p_request jsonb,
  p_replay_policy text default 'RETURN_SAFE_RESULT'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request_hash text;
  v_row public.openclaw_client_operations%rowtype;
  v_inserted boolean := false;
  v_row_count bigint := 0;
begin
  if p_actor_id is null or p_actor_id is distinct from (select app_private.openclaw_actor_id_v1()) then
    raise exception 'authenticated actor mismatch' using errcode = '42501';
  end if;
  v_request_hash := app_private.openclaw_client_request_hash_v1(p_operation_key, p_request);
  insert into public.openclaw_client_operations (
    organization_id, actor_id, operation_key, client_operation_id,
    request_hash, replay_policy
  ) values (
    p_organization_id, p_actor_id, p_operation_key, p_client_operation_id,
    v_request_hash, p_replay_policy
  )
  on conflict (organization_id, actor_id, operation_key, client_operation_id)
  do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted := v_row_count = 1;

  select operation_row.* into strict v_row
  from public.openclaw_client_operations operation_row
  where operation_row.organization_id = p_organization_id
    and operation_row.actor_id = p_actor_id
    and operation_row.operation_key = p_operation_key
    and operation_row.client_operation_id = p_client_operation_id
  for update;

  if v_row.request_hash is distinct from v_request_hash then
    return jsonb_build_object(
      'version', 1, 'conflict', true,
      'reason', 'client operation id reused with a different request'
    );
  end if;
  if v_row.completed_at is not null then
    if v_row.replay_policy = 'SINGLE_USE' then
      return jsonb_build_object('version', 1, 'conflict', true, 'reason', 'single-use operation replayed');
    end if;
    return jsonb_build_object(
      'version', 1, 'conflict', false, 'isReplay', true,
      'requestHash', v_request_hash, 'safeResult', v_row.safe_result
    );
  end if;
  return jsonb_build_object(
    'version', 1, 'conflict', false, 'isReplay', false,
    'requestHash', v_request_hash, 'inserted', v_inserted
  );
end;
$function$;

create or replace function app_private.openclaw_complete_client_operation_v1(
  p_organization_id uuid,
  p_actor_id uuid,
  p_operation_key text,
  p_client_operation_id uuid,
  p_request_hash text,
  p_safe_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result_hash text;
  v_result jsonb;
begin
  if p_actor_id is null or p_actor_id is distinct from (select app_private.openclaw_actor_id_v1()) then
    raise exception 'authenticated actor mismatch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_safe_result) <> 'object' or octet_length(p_safe_result::text) > 8192 then
    raise exception 'safe_result must be a compact object' using errcode = '22023';
  end if;
  v_result_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-client-result-v1', 'UTF8')
      || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(p_safe_result),
    'sha256'
  ), 'hex');
  update public.openclaw_client_operations operation_row
  set safe_result = p_safe_result,
      result_hash = v_result_hash,
      completed_at = statement_timestamp()
  where operation_row.organization_id = p_organization_id
    and operation_row.actor_id = p_actor_id
    and operation_row.operation_key = p_operation_key
    and operation_row.client_operation_id = p_client_operation_id
    and operation_row.request_hash = p_request_hash
    and operation_row.completed_at is null
  returning operation_row.safe_result into v_result;
  if not found then
    select operation_row.safe_result into v_result
    from public.openclaw_client_operations operation_row
    where operation_row.organization_id = p_organization_id
      and operation_row.actor_id = p_actor_id
      and operation_row.operation_key = p_operation_key
      and operation_row.client_operation_id = p_client_operation_id
      and operation_row.request_hash = p_request_hash
      and operation_row.result_hash = v_result_hash;
  end if;
  if v_result is null then
    raise exception 'client operation completion mismatch' using errcode = '40001';
  end if;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_finish_browser_write_v1(
  p_organization_id uuid,
  p_actor_id uuid,
  p_operation_key text,
  p_client_operation_id uuid,
  p_request_hash text,
  p_event_type text,
  p_safe_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_bytes bytea;
begin
  v_bytes := app_private.openclaw_jcs_bytes_v1(p_safe_result);
  perform app_private.append_openclaw_audit_v1(
    p_organization_id, p_event_type, p_actor_id, null,
    p_client_operation_id, p_client_operation_id, p_safe_result, v_bytes
  );
  return app_private.openclaw_complete_client_operation_v1(
    p_organization_id, p_actor_id, p_operation_key, p_client_operation_id,
    p_request_hash, p_safe_result
  );
end;
$function$;

create or replace function app_private.openclaw_validate_service_context_v1(
  p_principal jsonb,
  p_envelope jsonb,
  p_request jsonb,
  p_expected_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text;
  v_org uuid;
  v_account uuid;
  v_cell uuid;
  v_maintenance uuid;
  v_credential_generation bigint;
  v_lease_generation bigint;
  v_fencing_token bigint;
  v_session_generation bigint;
  v_local_session_generation bigint;
  v_auth_mode text;
  v_request_hash text;
  v_scope text;
  v_iat timestamptz;
  v_exp timestamptz;
  v_channel_operations constant text[] := array[
    'openclaw_runtime_heartbeat_v1','openclaw_submit_qr_result_v1',
    'openclaw_finalize_account_connection_v1','openclaw_ingest_inbound_batch_v1',
    'openclaw_claim_inbound_automation_v1','openclaw_complete_inbound_automation_v1',
    'openclaw_claim_outbox_v1','openclaw_preflight_outbox_v1',
    'openclaw_authorize_outbox_send_v1','openclaw_requeue_pre_handoff_v1',
    'openclaw_complete_outbox_v1','openclaw_claim_work_item_v1','openclaw_get_work_context_v1',
    'openclaw_complete_work_item_v1','openclaw_create_outbox_from_work_v1',
    'openclaw_issue_media_ticket_v1','openclaw_finalize_media_upload_v1','openclaw_acquire_cell_lease_v1',
    'openclaw_begin_cell_rebind_v1','openclaw_complete_cell_rebind_v1',
    'openclaw_ack_generation_revocation_v1','openclaw_sweep_runtime_v1'
  ];
  v_maintenance_operations constant text[] := array[
    'openclaw_claim_work_item_v1','openclaw_complete_maintenance_work_v1',
    'openclaw_issue_media_ticket_v1','openclaw_complete_retention_quarantine_v1',
    'openclaw_issue_retention_delete_ticket_v1','openclaw_authorize_retention_delete_v1',
    'openclaw_finalize_retention_delete_v1','openclaw_ack_audit_anchor_v1',
    'openclaw_record_watchdog_health_v1','openclaw_begin_rollout_v1',
    'openclaw_record_rollout_checkpoint_v1','openclaw_record_rollout_observation_v1',
    'openclaw_resume_rollout_v1','openclaw_advance_rollout_stage_v1',
    'openclaw_begin_smoke_run_v1','openclaw_record_smoke_observation_v1',
    'openclaw_cleanup_smoke_run_v1','openclaw_verify_smoke_cleanup_v1',
    'openclaw_sweep_runtime_v1'
  ];
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_principal,
    array['version','principalKind','organizationId','accountId','cellId',
      'maintenancePrincipalId','credentialGeneration','leaseGeneration','fencingToken',
      'sessionGeneration','localSessionGeneration','authMode','allowedOperations'],
    array['version','principalKind','organizationId','accountId','cellId',
      'maintenancePrincipalId','credentialGeneration','leaseGeneration','fencingToken',
      'sessionGeneration','localSessionGeneration','authMode','allowedOperations']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    p_envelope,
    array['version','operation','nonce','iat','exp','requestHash'],
    array['version','operation','nonce','iat','exp','requestHash']
  );
  if p_principal ->> 'version' <> '1' or p_envelope ->> 'version' <> '1' then
    raise exception 'service context version mismatch' using errcode = '42501';
  end if;
  if p_envelope ->> 'operation' is distinct from p_expected_operation then
    raise exception 'envelope operation mismatch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_principal -> 'allowedOperations') <> 'array'
     or not ((p_principal -> 'allowedOperations') ? p_expected_operation)
  then
    raise exception 'service operation is not allowed' using errcode = '42501';
  end if;
  v_request_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-service-request-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_expected_operation, 'UTF8')
      || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(p_request),
    'sha256'
  ), 'hex');
  if p_envelope ->> 'requestHash' is distinct from v_request_hash then
    raise exception 'service request hash mismatch' using errcode = '42501';
  end if;
  v_iat := (p_envelope ->> 'iat')::timestamptz;
  v_exp := (p_envelope ->> 'exp')::timestamptz;
  if statement_timestamp() < v_iat - interval '30 seconds'
     or statement_timestamp() >= v_exp
     or v_exp > v_iat + interval '5 minutes'
  then
    raise exception 'service envelope expired or outside DB time window' using errcode = '42501';
  end if;

  v_kind := p_principal ->> 'principalKind';
  v_org := (p_principal ->> 'organizationId')::uuid;
  v_account := nullif(p_principal ->> 'accountId', '')::uuid;
  v_cell := nullif(p_principal ->> 'cellId', '')::uuid;
  v_maintenance := nullif(p_principal ->> 'maintenancePrincipalId', '')::uuid;
  v_credential_generation := (p_principal ->> 'credentialGeneration')::bigint;
  v_lease_generation := (p_principal ->> 'leaseGeneration')::bigint;
  v_fencing_token := (p_principal ->> 'fencingToken')::bigint;
  v_session_generation := coalesce(nullif(p_principal ->> 'sessionGeneration', '')::bigint, 0);
  v_local_session_generation := coalesce(
    nullif(p_principal ->> 'localSessionGeneration', '')::bigint, 0
  );
  v_auth_mode := p_principal ->> 'authMode';
  v_scope := case p_expected_operation
    when 'openclaw_runtime_heartbeat_v1' then 'heartbeat'
    when 'openclaw_submit_qr_result_v1' then 'qr.publish'
    when 'openclaw_finalize_account_connection_v1' then 'qr.result'
    when 'openclaw_ingest_inbound_batch_v1' then 'inbound.commit'
    when 'openclaw_claim_outbox_v1' then 'outbox.claim'
    when 'openclaw_preflight_outbox_v1' then 'outbox.preflight'
    when 'openclaw_authorize_outbox_send_v1' then 'outbox.authorize-send'
    when 'openclaw_requeue_pre_handoff_v1' then 'outbox.requeue'
    when 'openclaw_complete_outbox_v1' then 'outbox.complete'
    when 'openclaw_claim_work_item_v1' then case when v_kind = 'CHANNEL' then 'work.claim' else 'maintenance.claim' end
    when 'openclaw_get_work_context_v1' then 'work.context'
    when 'openclaw_complete_work_item_v1' then 'work.complete'
    when 'openclaw_complete_maintenance_work_v1' then 'maintenance.complete'
    when 'openclaw_create_outbox_from_work_v1' then 'work.complete'
    when 'openclaw_issue_media_ticket_v1' then case when v_kind = 'CHANNEL' then 'media.issue' else 'maintenance.complete' end
    when 'openclaw_finalize_media_upload_v1' then 'media.issue'
    when 'openclaw_acquire_cell_lease_v1' then 'lease.acquire'
    when 'openclaw_begin_cell_rebind_v1' then 'cell.rebind'
    when 'openclaw_complete_cell_rebind_v1' then 'cell.rebind'
    when 'openclaw_ack_generation_revocation_v1' then 'generation.ack'
    when 'openclaw_complete_retention_quarantine_v1' then 'maintenance.complete'
    when 'openclaw_issue_retention_delete_ticket_v1' then 'maintenance.complete'
    when 'openclaw_authorize_retention_delete_v1' then 'maintenance.complete'
    when 'openclaw_finalize_retention_delete_v1' then 'maintenance.complete'
    when 'openclaw_ack_audit_anchor_v1' then 'maintenance.complete'
    when 'openclaw_record_watchdog_health_v1' then 'watchdog.health'
    when 'openclaw_begin_rollout_v1' then 'rollout.manage'
    when 'openclaw_record_rollout_checkpoint_v1' then 'rollout.manage'
    when 'openclaw_record_rollout_observation_v1' then 'rollout.manage'
    when 'openclaw_resume_rollout_v1' then 'rollout.manage'
    when 'openclaw_advance_rollout_stage_v1' then 'rollout.manage'
    when 'openclaw_begin_smoke_run_v1' then 'smoke.manage'
    when 'openclaw_record_smoke_observation_v1' then 'smoke.manage'
    when 'openclaw_cleanup_smoke_run_v1' then 'smoke.manage'
    when 'openclaw_verify_smoke_cleanup_v1' then 'smoke.manage'
    when 'openclaw_sweep_runtime_v1' then case when v_kind = 'CHANNEL' then 'runtime.sweep' else 'maintenance.sweep' end
    else null
  end;
  if v_scope is null then
    raise exception 'service operation has no frozen scope mapping' using errcode = '42501';
  end if;

  if v_kind = 'CHANNEL' then
    if not (p_expected_operation = any(v_channel_operations)) then
      raise exception 'channel service operation matrix mismatch' using errcode = '42501';
    end if;
    if v_account is null or v_cell is null or v_maintenance is not null
       or not exists (
         select 1
         from public.openclaw_runtime_credentials credential
         join public.openclaw_runtime_cells cell
           on cell.organization_id = credential.organization_id
          and cell.account_id = credential.account_id
          and cell.id = credential.cell_id
         join public.openclaw_runtime_leases lease
           on lease.organization_id = credential.organization_id
          and lease.account_id = credential.account_id
          and lease.cell_id = credential.cell_id
         join public.openclaw_accounts account
           on account.organization_id = credential.organization_id
          and account.id = credential.account_id
         where credential.organization_id = v_org
           and credential.account_id = v_account
           and credential.cell_id = v_cell
           and credential.credential_generation = v_credential_generation
           and credential.revoked_at is null
           and v_scope = any(credential.allowed_scopes)
           and lease.lease_generation = v_lease_generation
           and lease.fencing_token = v_fencing_token
           and lease.status = 'ACTIVE'
           and lease.expires_at > statement_timestamp()
           and cell.is_current and cell.state = 'READY'
           and account.session_generation = v_session_generation
           and (
             (v_auth_mode='NORMAL' and v_local_session_generation=v_session_generation)
             or (
               v_auth_mode='COMMAND_TRANSITION'
               and p_expected_operation='openclaw_runtime_heartbeat_v1'
               and account.connection_state='DISCONNECTING'
               and v_session_generation=v_local_session_generation+1
               and exists (
                 select 1
                 from public.openclaw_runtime_commands command
                 where command.organization_id=account.organization_id
                   and command.account_id=account.id
                   and command.cell_id=cell.id
                   and command.command_kind='DISCONNECT'
                   and command.source_session_generation=v_local_session_generation
                   and command.target_session_generation=v_session_generation
                   and command.source_connection_generation+1=command.target_connection_generation
                   and command.target_connection_generation=account.connection_generation
                   and command.expected_fencing_token=v_fencing_token
                   and command.state in ('PENDING','LEASED','STARTED')
               )
             )
           )
       )
    then
      raise exception 'credential generation mismatch, lease generation mismatch, fencing token mismatch, or channel principal is stale'
        using errcode = '42501';
    end if;
  elsif v_kind = 'MAINTENANCE' then
    if not (p_expected_operation = any(v_maintenance_operations)) then
      raise exception 'maintenance service operation matrix mismatch' using errcode = '42501';
    end if;
    if v_account is not null or v_cell is not null or v_maintenance is null
       or v_session_generation<>0 or v_local_session_generation<>0 or v_auth_mode<>'NORMAL'
       or not exists (
         select 1
         from public.openclaw_maintenance_credentials credential
         join public.openclaw_maintenance_principals principal
           on principal.organization_id = credential.organization_id
          and principal.id = credential.maintenance_principal_id
         join public.openclaw_maintenance_leases lease
           on lease.organization_id = credential.organization_id
          and lease.maintenance_principal_id = credential.maintenance_principal_id
         where credential.organization_id = v_org
           and credential.maintenance_principal_id = v_maintenance
           and credential.credential_generation = v_credential_generation
           and credential.revoked_at is null
           and v_scope = any(credential.allowed_scopes)
           and lease.lease_generation = v_lease_generation
           and lease.fencing_token = v_fencing_token
           and lease.status = 'ACTIVE'
           and lease.expires_at > statement_timestamp()
           and principal.is_current and principal.revoked_at is null
       )
    then
      raise exception 'credential generation mismatch, lease generation mismatch, fencing token mismatch, or maintenance principal is stale'
        using errcode = '42501';
    end if;
  else
    raise exception 'service principal kind mismatch' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'version', 1, 'principalKind', v_kind, 'organizationId', v_org,
    'accountId', v_account, 'cellId', v_cell,
    'maintenancePrincipalId', v_maintenance,
    'credentialGeneration', v_credential_generation,
    'leaseGeneration', v_lease_generation, 'fencingToken', v_fencing_token,
    'sessionGeneration', v_session_generation,
    'localSessionGeneration',v_local_session_generation,'authMode',v_auth_mode,
    'operation', p_expected_operation,
    'scope', v_scope, 'requestHash', v_request_hash,
    'iat', v_iat, 'exp', v_exp, 'nonce', p_envelope ->> 'nonce'
  );
end;
$function$;

create or replace function app_private.openclaw_consume_service_nonce_v1(
  p_context jsonb,
  p_envelope jsonb,
  p_request jsonb,
  p_namespace text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_nonce_hash text;
  v_inserted uuid;
begin
  if p_namespace is null or p_namespace not in ('RUNTIME', 'EXCHANGE') then
    raise exception 'service nonce namespace is invalid' using errcode = '42501';
  end if;
  v_nonce_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-service-nonce-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_namespace, 'UTF8')
      || decode('00', 'hex') || convert_to(p_envelope ->> 'nonce', 'UTF8'),
    'sha256'
  ), 'hex');
  insert into public.openclaw_service_nonces (
    organization_id, principal_kind, account_id, cell_id, maintenance_principal_id,
    credential_generation, lease_generation, fencing_token, operation,
    nonce_namespace, nonce_hash, envelope_hash, request_hash, issued_at, expires_at,
    consumed_at, result_hash
  ) values (
    (p_context ->> 'organizationId')::uuid,
    p_context ->> 'principalKind',
    nullif(p_context ->> 'accountId', '')::uuid,
    nullif(p_context ->> 'cellId', '')::uuid,
    nullif(p_context ->> 'maintenancePrincipalId', '')::uuid,
    (p_context ->> 'credentialGeneration')::bigint,
    (p_context ->> 'leaseGeneration')::bigint,
    (p_context ->> 'fencingToken')::bigint,
    p_context ->> 'operation',
    p_namespace,
    v_nonce_hash,
    encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(p_envelope), 'sha256'), 'hex'),
    p_context ->> 'requestHash',
    (p_context ->> 'iat')::timestamptz,
    (p_context ->> 'exp')::timestamptz,
    statement_timestamp(),
    p_context ->> 'requestHash'
  )
  on conflict do nothing
  returning id into v_inserted;
  if v_inserted is null then
    raise exception 'nonce replay rejected' using errcode = '42501';
  end if;
  return p_context || jsonb_build_object('nonceId', v_inserted, 'nonceConsumed', true);
end;
$function$;

create or replace function app_private.openclaw_browser_context_v1(
  p_request jsonb,
  p_permission_key text,
  p_action_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1());
  v_org uuid;
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_request ->> 'version' <> '1' then
    raise exception 'request version mismatch' using errcode = '22023';
  end if;
  v_org := (p_request ->> 'organizationId')::uuid;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, p_permission_key, p_action_label);
  return jsonb_build_object('actorId', v_actor, 'organizationId', v_org);
end;
$function$;

create or replace function app_private.openclaw_browser_account_context_v1(
  p_request jsonb,
  p_permission_key text,
  p_action_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
begin
  v_context := app_private.openclaw_browser_context_v1(
    p_request, p_permission_key, p_action_label
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  if not exists (
    select 1
    from public.openclaw_accounts account
    where account.organization_id = v_org
      and account.id = v_account
  ) then
    raise exception 'selected OpenClaw account is unavailable' using errcode = 'P0002';
  end if;
  return v_context || jsonb_build_object('accountId', v_account);
end;
$function$;

create or replace function public.openclaw_list_my_organizations_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1());
  v_items jsonb;
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', organization.id,
    'name', organization.name
  ) order by organization.name, organization.id), '[]'::jsonb)
  into v_items
  from public.organizations organization
  -- Only organizations where the caller actually holds openclaw_zalo.view.
  -- my_org_ids() is every membership, so the selector used to offer organizations
  -- the route guard then bounced out of, with no explanation to the user.
  where organization.id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view')
  );
  return jsonb_build_object('version', 1, 'organizations', v_items);
end;
$function$;

create or replace function public.openclaw_get_bootstrap_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account jsonb;
  v_control jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  select jsonb_build_object(
    'accountId', account.id, 'displayName', account.display_name,
    'connectionState', account.connection_state, 'sessionRiskState', account.session_risk_state,
    'configuredMode', account.configured_mode, 'effectiveMode', account.effective_mode,
    'connectionGeneration', account.connection_generation,
    'sessionGeneration', account.session_generation
  ) into v_account
  from public.openclaw_accounts account
  where account.organization_id = v_org and account.is_active
  order by account.created_at desc, account.id desc limit 1;
  select jsonb_build_object(
    'globalStop', control.global_stop, 'featureEnabled', control.feature_enabled,
    'limitedAutoReplyEnabled', control.limited_auto_reply_enabled,
    'proactiveEnabled', control.proactive_enabled,
    'salesGroupsEnabled', control.sales_groups_enabled,
    'controlVersion', control.control_version
  ) into v_control
  from public.openclaw_control_states control
  where control.organization_id = v_org and control.control_key = 'GLOBAL_STOP';
  return jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'account', v_account,
    'control', v_control, 'actorId', v_context ->> 'actorId'
  );
end;
$function$;

create or replace function public.openclaw_get_overview_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem tổng quan OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  return jsonb_build_object(
    'version', 1,
    'organizationId', v_org,
    'conversationCount', (select count(*) from public.openclaw_conversations conversation
      where conversation.organization_id = v_org),
    'unreadCount', (select coalesce(sum(conversation.unread_count), 0)
      from public.openclaw_conversations conversation where conversation.organization_id = v_org),
    'unresolvedUnknownCount', (select count(*) from public.openclaw_outbox outbox
      where outbox.organization_id = v_org and outbox.state = 'UNKNOWN'
        and outbox.resolution_version = 0),
    'resolvedUnknownCount', (select count(*) from public.openclaw_unknown_resolutions resolution
      where resolution.organization_id = v_org),
    'deadLetterCount', (select count(*) from public.openclaw_dead_letters dead_letter
      where dead_letter.organization_id = v_org)
  );
end;
$function$;

create or replace function public.openclaw_list_conversations_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cursorLastReceivedAt','cursorId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem hội thoại OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorLastReceivedAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  select coalesce(jsonb_agg(item.payload order by item.last_received_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select conversation.id, conversation.last_received_at,
      jsonb_build_object(
        'conversationId', conversation.id, 'targetId', conversation.target_id,
        'status', conversation.status, 'assignedMembershipId', conversation.assigned_membership_id,
        'unreadCount', conversation.unread_count,
        'lastReceivedAt', conversation.last_received_at,
        'lastMessageId', conversation.last_message_id, 'version', conversation.version
      ) as payload
    from public.openclaw_conversations conversation
    where conversation.organization_id = v_org and conversation.account_id = v_account
      and (v_cursor_at is null or (conversation.last_received_at, conversation.id) < (v_cursor_at, v_cursor_id))
    order by conversation.last_received_at desc, conversation.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_messages_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_conversation uuid;
  v_requested_limit integer;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','conversationId','cursorReceivedAt','cursorId','limit'],
    array['version','organizationId','accountId','conversationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem tin nhắn OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  v_conversation := (p_request ->> 'conversationId')::uuid;
  v_requested_limit := (p_request ->> 'limit')::integer;
  v_limit := greatest(1, least(coalesce(v_requested_limit, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorReceivedAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  select coalesce(jsonb_agg(item.payload order by item.received_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select m.id, m.received_at,
      jsonb_build_object(
        'messageId', m.id, 'direction', m.direction, 'eventKind', m.event_kind,
        'providerTimestamp', m.provider_timestamp, 'receivedAt', m.received_at,
        'createdAt', m.created_at
      ) as payload
    from public.openclaw_messages m
    where m.organization_id = v_org and m.account_id = v_account
      and m.conversation_id = v_conversation
      and (v_cursor_at is null or (m.received_at, m.id) < (v_cursor_at, v_cursor_id))
    order by m.received_at desc, m.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_resolve_media_object_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','mediaId'],
    array['version','organizationId','mediaId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem media OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  -- Only rows whose bytes are readable resolve. QUARANTINED and DELETED media
  -- never yield a ticket, so issuance stops the moment retention acts.
  select jsonb_build_object(
    'version', 1,
    'mediaId', media.id,
    'organizationId', media.organization_id,
    'accountId', media.account_id,
    'conversationId', media.conversation_id,
    'messageId', media.message_id,
    'mime', media.mime,
    'byteLength', media.byte_length,
    'sha256', media.sha256,
    'objectKey', media.object_key,
    'byteState', media.byte_state,
    'sessionGeneration', account.session_generation
  ) into v_result
  from public.openclaw_message_media media
  join public.openclaw_accounts account
    on account.organization_id = media.organization_id
   and account.id = media.account_id
  where media.organization_id = v_org
    and media.id = (p_request ->> 'mediaId')::uuid
    and media.byte_state in ('CACHED','AVAILABLE')
    and media.object_key is not null
    and media.sha256 is not null;
  if v_result is null then
    raise exception 'media object is not available' using errcode = 'P0002';
  end if;
  return v_result;
end;
$function$;

create or replace function public.openclaw_list_unknown_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_limit integer;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','limit'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_operations', 'xem UNKNOWN OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  select coalesce(jsonb_agg(item.payload order by item.terminal_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select outbox.id, outbox.terminal_at,
      jsonb_build_object(
        'outboxId', outbox.id, 'accountId', outbox.account_id,
        'payloadHash', outbox.payload_hash, 'terminalAt', outbox.terminal_at,
        'resolution_version', outbox.resolution_version,
        'authoritative_evidence_hash', resolution.authoritative_evidence_hash,
        'resolutionId', resolution.id, 'outcome', resolution.outcome,
        'new_outbox_id', resolution.new_outbox_id, 'resolvedAt', resolution.resolved_at
      ) as payload
    from public.openclaw_outbox outbox
    left join public.openclaw_unknown_resolutions resolution
      on resolution.organization_id = outbox.organization_id
     and resolution.account_id = outbox.account_id and resolution.outbox_id = outbox.id
    where outbox.organization_id = v_org and outbox.state = 'UNKNOWN'
    order by outbox.terminal_at desc, outbox.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_knowledge_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_items jsonb; v_limit integer;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','accountId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_knowledge', 'xem kho kiến thức OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1,least(coalesce((p_request ->> 'limit')::integer,50),100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceId', source.id, 'accountId', source.account_id, 'title', source.title,
    'sourceKind', source.source_kind, 'sensitivity', source.sensitivity,
    'lifecycleState', source.lifecycle_state, 'currentVersion', source.current_version,
    'createdAt', source.created_at, 'updatedAt', source.updated_at
  ) order by source.updated_at desc, source.id desc), '[]'::jsonb)
  into v_items
  from public.openclaw_knowledge_sources source
  join (
    select candidate.id from public.openclaw_knowledge_sources candidate
    where candidate.organization_id=v_org
      and candidate.account_id=(p_request ->> 'accountId')::uuid
    order by candidate.updated_at desc,candidate.id desc limit v_limit
  ) bounded on bounded.id=source.id
  where source.organization_id = v_org
    and source.account_id = (p_request ->> 'accountId')::uuid;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_get_knowledge_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','sourceId'],
    array['version','organizationId','sourceId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_knowledge', 'xem nguồn kiến thức OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  select jsonb_build_object(
    'sourceId', source.id, 'accountId', source.account_id, 'title', source.title,
    'sourceKind', source.source_kind, 'sensitivity', source.sensitivity,
    'lifecycleState', source.lifecycle_state, 'currentVersion', source.current_version,
    'publishedVersionId', version.id, 'contentHash', version.content_hash,
    'validationResult', version.validation_result, 'publishedAt', version.published_at,
    'archivedAt', version.archived_at
  ) into v_result
  from public.openclaw_knowledge_sources source
  left join public.openclaw_knowledge_versions version
    on version.organization_id = source.organization_id
   and version.account_id = source.account_id and version.source_id = source.id
   and version.version = source.current_version
  where source.organization_id = v_org and source.id = (p_request ->> 'sourceId')::uuid;
  return jsonb_build_object('version', 1, 'knowledge', v_result);
end;
$function$;

create or replace function public.openclaw_preview_knowledge_retrieval_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_items jsonb; v_limit integer;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','accountId','query','limit'],
    array['version','organizationId','accountId','query']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_knowledge', 'xem thử truy xuất kiến thức OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 5), 20));
  select coalesce(jsonb_agg(item.payload order by item.chunk_index, item.id), '[]'::jsonb)
  into v_items
  from (
    select chunk.id, chunk.chunk_index,
      jsonb_build_object(
        'chunkId', chunk.id, 'sourceId', chunk.source_id,
        'knowledgeVersionId', chunk.knowledge_version_id,
        'chunkIndex', chunk.chunk_index, 'chunkText', chunk.chunk_text,
        'chunkHash', chunk.chunk_hash
      ) as payload
    from public.openclaw_knowledge_chunks chunk
    where chunk.organization_id = v_org
      and chunk.account_id = (p_request ->> 'accountId')::uuid
      and chunk.sensitivity = 'CUSTOMER_SAFE'
      and chunk.chunk_text ilike '%' || replace(p_request ->> 'query', '%', '\%') || '%'
    order by chunk.chunk_index, chunk.id limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_automations_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_items jsonb; v_limit integer;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','accountId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_automation', 'xem tự động hóa OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1,least(coalesce((p_request ->> 'limit')::integer,50),100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'automationId', automation.id, 'name', automation.name,
    'automationKind', automation.automation_kind,
    'lifecycleState', automation.lifecycle_state,
    'currentVersion', automation.current_version,
    'updatedAt', automation.updated_at
  ) order by automation.updated_at desc, automation.id desc), '[]'::jsonb)
  into v_items
  from public.openclaw_automations automation
  join (
    select candidate.id from public.openclaw_automations candidate
    where candidate.organization_id=v_org
      and candidate.account_id=(p_request ->> 'accountId')::uuid
    order by candidate.updated_at desc,candidate.id desc limit v_limit
  ) bounded on bounded.id=automation.id
  where automation.organization_id = v_org
    and automation.account_id = (p_request ->> 'accountId')::uuid;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_get_automation_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','automationId'],
    array['version','organizationId','automationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_automation', 'xem tự động hóa OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  select jsonb_build_object(
    'automationId', automation.id, 'accountId', automation.account_id,
    'name', automation.name, 'automationKind', automation.automation_kind,
    'lifecycleState', automation.lifecycle_state,
    'currentVersion', automation.current_version,
    'versionId', version.id, 'mode', version.mode,
    'policyVersionId', version.policy_version_id,
    'knowledgeVersionIds', version.knowledge_version_ids,
    'configuration', version.configuration, 'dryRunHash', version.dry_run_hash
  ) into v_result
  from public.openclaw_automations automation
  left join public.openclaw_automation_versions version
    on version.organization_id = automation.organization_id
   and version.account_id = automation.account_id
   and version.automation_id = automation.id
   and version.version = automation.current_version
  where automation.organization_id = v_org
    and automation.id = (p_request ->> 'automationId')::uuid;
  return jsonb_build_object('version', 1, 'automation', v_result);
end;
$function$;

create or replace function public.openclaw_dry_run_automation_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_hash text; v_eligible boolean;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','automationVersionId','sampleInputs'],
    array['version','organizationId','automationVersionId','sampleInputs']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_automation', 'chạy thử tự động hóa OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_eligible := exists (
    select 1 from public.openclaw_automation_versions version
    where version.organization_id = v_org
      and version.id = (p_request ->> 'automationVersionId')::uuid
      and version.lifecycle_state in ('DRAFT','PUBLISHED')
  );
  v_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-automation-dry-run-v1', 'UTF8')
      || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(p_request -> 'sampleInputs'),
    'sha256'
  ), 'hex');
  return jsonb_build_object(
    'version', 1, 'eligible', v_eligible, 'dryRunHash', v_hash,
    'sendCreated', false, 'reason', case when v_eligible then 'DRY_RUN_ONLY' else 'NOT_ELIGIBLE' end
  );
end;
$function$;

create or replace function public.openclaw_list_sales_groups_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_items jsonb; v_limit integer;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','accountId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem nhóm sale OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1,least(coalesce((p_request ->> 'limit')::integer,50),100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'targetId', target.id, 'groupId', sales_group.id, 'displayName', sales_group.display_name,
    'memberCount', sales_group.member_count, 'directoryVersion', sales_group.directory_version,
    'directoryRefreshedAt', sales_group.directory_refreshed_at,
    'targetVersion', target.target_version, 'isActive', target.is_active,
    'isAllowed', allowlist.is_allowed, 'allowlistVersion', allowlist.allowlist_version,
    'directoryExpiresAt', allowlist.directory_expires_at
  ) order by sales_group.display_name, target.id), '[]'::jsonb)
  into v_items
  from public.openclaw_targets target
  join (
    select candidate.id
    from public.openclaw_targets candidate
    join public.openclaw_sales_groups group_row
      on group_row.organization_id=candidate.organization_id
     and group_row.account_id=candidate.account_id and group_row.id=candidate.sales_group_id
    where candidate.organization_id=v_org
      and candidate.account_id=(p_request ->> 'accountId')::uuid
      and candidate.kind='SALES_GROUP'
    order by group_row.display_name,candidate.id limit v_limit
  ) bounded on bounded.id=target.id
  join public.openclaw_sales_groups sales_group
    on sales_group.organization_id = target.organization_id
   and sales_group.account_id = target.account_id and sales_group.id = target.sales_group_id
  left join lateral (
    select entry.is_allowed, entry.allowlist_version, entry.directory_expires_at
    from public.openclaw_sales_group_allowlists entry
    where entry.organization_id = target.organization_id
      and entry.account_id = target.account_id
      and entry.sales_group_target_id = target.id
    order by entry.allowlist_version desc limit 1
  ) allowlist on true
  where target.organization_id = v_org
    and target.account_id = (p_request ->> 'accountId')::uuid
    and target.kind = 'SALES_GROUP';
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_schedules_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_items jsonb; v_limit integer;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','accountId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_automation', 'xem lịch OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1,least(coalesce((p_request ->> 'limit')::integer,50),100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'scheduleId', schedule.id, 'automationVersionId', schedule.automation_version_id,
    'targetId', schedule.target_id, 'campaignId', schedule.campaign_id,
    'scheduleVersion', schedule.schedule_version, 'status', schedule.status,
    'timezone', schedule.timezone, 'localRecurrenceRule', schedule.local_recurrence_rule,
    'nextRunAt', schedule.next_run_at,
    'missedOccurrencePolicy', schedule.missed_occurrence_policy,
    'updatedAt', schedule.updated_at
  ) order by schedule.updated_at desc, schedule.id desc), '[]'::jsonb)
  into v_items from public.openclaw_schedules schedule
  join (
    select candidate.id from public.openclaw_schedules candidate
    where candidate.organization_id=v_org
      and candidate.account_id=(p_request ->> 'accountId')::uuid
    order by candidate.updated_at desc,candidate.id desc limit v_limit
  ) bounded on bounded.id=schedule.id
  where schedule.organization_id = v_org
    and schedule.account_id = (p_request ->> 'accountId')::uuid;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_dead_letters_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_limit integer; v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','limit'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_operations', 'xem dead letter OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'deadLetterId', dead_letter.id, 'accountId', dead_letter.account_id,
    'outboxId', dead_letter.outbox_id, 'sendWorkItemId', dead_letter.send_work_item_id,
    'reasonCode', dead_letter.reason_code, 'payloadHash', dead_letter.payload_hash,
    'createdAt', dead_letter.created_at
  ) order by dead_letter.created_at desc, dead_letter.id desc), '[]'::jsonb)
  into v_items
  from (
    select row.* from public.openclaw_dead_letters row
    where row.organization_id = v_org
    order by row.created_at desc, row.id desc limit v_limit
  ) dead_letter;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_audit_events_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_limit integer; v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','limit'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.audit', 'xem audit OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'auditEventId', event.id, 'organizationSequence', event.organization_sequence,
    'eventType', event.event_type, 'actorId', event.actor_id,
    'workloadPrincipal', event.workload_principal,
    'requestId', event.request_id, 'correlationId', event.correlation_id,
    'evidenceHash', event.evidence_hash, 'previousHash', event.previous_hash,
    'eventHash', event.event_hash, 'occurredAt', event.occurred_at
  ) order by event.organization_sequence desc), '[]'::jsonb)
  into v_items
  from (
    select audit_event.* from public.openclaw_audit_events audit_event
    where audit_event.organization_id = v_org
    order by audit_event.organization_sequence desc limit v_limit
  ) event;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_health_events_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_limit integer; v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','limit'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.audit', 'xem sức khỏe OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'healthEventId', event.id, 'accountId', event.account_id, 'cellId', event.cell_id,
    'severity', event.severity, 'healthKind', event.health_kind,
    'status', event.status, 'fingerprint', event.fingerprint,
    'contentFreeMetrics', event.content_free_metrics,
    'observedAt', event.observed_at, 'createdAt', event.created_at
  ) order by event.observed_at desc, event.id desc), '[]'::jsonb)
  into v_items
  from (
    select health_event.* from public.openclaw_health_events health_event
    where health_event.organization_id = v_org
    order by health_event.observed_at desc, health_event.id desc limit v_limit
  ) event;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_unknown_by_account_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cursorTerminalAt','cursorId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_account_context_v1(
    p_request, 'openclaw_zalo.manage_operations', 'xem UNKNOWN OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (v_context ->> 'accountId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorTerminalAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  if (v_cursor_at is null) <> (v_cursor_id is null) then
    raise exception 'UNKNOWN cursor requires timestamp and id' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(item.payload order by item.terminal_at desc, item.id desc),
    '[]'::jsonb
  )
  into v_items
  from (
    select outbox.id, outbox.terminal_at,
      jsonb_build_object(
        'outboxId', outbox.id, 'accountId', outbox.account_id,
        'payloadHash', outbox.payload_hash, 'terminalAt', outbox.terminal_at,
        'resolution_version', outbox.resolution_version,
        'authoritative_evidence_hash', resolution.authoritative_evidence_hash,
        'resolutionId', resolution.id, 'outcome', resolution.outcome,
        'new_outbox_id', resolution.new_outbox_id, 'resolvedAt', resolution.resolved_at
      ) as payload
    from public.openclaw_outbox outbox
    left join public.openclaw_unknown_resolutions resolution
      on resolution.organization_id = outbox.organization_id
     and resolution.account_id = outbox.account_id
     and resolution.outbox_id = outbox.id
    where outbox.organization_id = v_org
      and outbox.account_id = v_account
      and outbox.state = 'UNKNOWN'
      and (
        v_cursor_at is null
        or (outbox.terminal_at, outbox.id) < (v_cursor_at, v_cursor_id)
      )
    order by outbox.terminal_at desc, outbox.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_dead_letters_by_account_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cursorCreatedAt','cursorId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_account_context_v1(
    p_request, 'openclaw_zalo.manage_operations', 'xem dead letter OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (v_context ->> 'accountId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorCreatedAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  if (v_cursor_at is null) <> (v_cursor_id is null) then
    raise exception 'dead-letter cursor requires timestamp and id' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(item.payload order by item.created_at desc, item.id desc),
    '[]'::jsonb
  )
  into v_items
  from (
    select dead_letter.id, dead_letter.created_at,
      jsonb_build_object(
        'deadLetterId', dead_letter.id, 'accountId', dead_letter.account_id,
        'outboxId', dead_letter.outbox_id,
        'sendWorkItemId', dead_letter.send_work_item_id,
        'reasonCode', dead_letter.reason_code, 'payloadHash', dead_letter.payload_hash,
        'createdAt', dead_letter.created_at
      ) as payload
    from public.openclaw_dead_letters dead_letter
    where dead_letter.organization_id = v_org
      and dead_letter.account_id = v_account
      and (
        v_cursor_at is null
        or (dead_letter.created_at, dead_letter.id) < (v_cursor_at, v_cursor_id)
      )
    order by dead_letter.created_at desc, dead_letter.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_list_health_events_by_account_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cursorObservedAt','cursorId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_account_context_v1(
    p_request, 'openclaw_zalo.audit', 'xem sức khỏe OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (v_context ->> 'accountId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorObservedAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  if (v_cursor_at is null) <> (v_cursor_id is null) then
    raise exception 'health cursor requires timestamp and id' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(item.payload order by item.observed_at desc, item.id desc),
    '[]'::jsonb
  )
  into v_items
  from (
    select event.id, event.observed_at,
      jsonb_build_object(
        'healthEventId', event.id, 'accountId', event.account_id,
        'cellId', event.cell_id, 'severity', event.severity,
        'healthKind', event.health_kind, 'status', event.status,
        'fingerprint', event.fingerprint,
        'contentFreeMetrics', event.content_free_metrics,
        'observedAt', event.observed_at, 'createdAt', event.created_at
      ) as payload
    from public.openclaw_health_events event
    where event.organization_id = v_org
      and (event.account_id = v_account or event.account_id is null)
      and (
        v_cursor_at is null
        or (event.observed_at, event.id) < (v_cursor_at, v_cursor_id)
      )
    order by event.observed_at desc, event.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_get_unknown_resolution_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_outbox uuid;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','outboxId'],
    array['version','organizationId','accountId','outboxId']
  );
  v_context := app_private.openclaw_browser_account_context_v1(
    p_request, 'openclaw_zalo.manage_operations', 'tải lại UNKNOWN winner OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (v_context ->> 'accountId')::uuid;
  v_outbox := (p_request ->> 'outboxId')::uuid;

  select jsonb_build_object(
    'version', 1, 'resolutionId', resolution.id,
    'organizationId', resolution.organization_id,
    'accountId', resolution.account_id, 'outboxId', resolution.outbox_id,
    'resolutionVersion', resolution.resolution_version,
    'outcome', resolution.outcome, 'newOutboxId', resolution.new_outbox_id,
    'authoritativeEvidenceDomain', resolution.authoritative_evidence_domain,
    'authoritativeEvidenceHash', resolution.authoritative_evidence_hash,
    'reasonCode', resolution.reason_code, 'resolvedBy', resolution.resolved_by,
    'resolvedAt', resolution.resolved_at
  )
  into v_result
  from public.openclaw_outbox outbox
  join public.openclaw_unknown_resolutions resolution
    on resolution.organization_id = outbox.organization_id
   and resolution.account_id = outbox.account_id
   and resolution.outbox_id = outbox.id
  where outbox.organization_id = v_org
    and outbox.account_id = v_account
    and outbox.id = v_outbox
    and outbox.state = 'UNKNOWN'
    and outbox.resolution_version = 1;
  return v_result;
end;
$function$;

create or replace function public.openclaw_list_legal_holds_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb; v_org uuid; v_limit integer; v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','limit'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.audit', 'xem legal hold OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  select coalesce(jsonb_agg(jsonb_build_object(
    'holdId', hold.id, 'targetKind', hold.target_kind, 'targetId', hold.target_id,
    'reason', hold.reason, 'holdVersion', hold.hold_version,
    'createdBy', hold.created_by, 'createdAt', hold.created_at,
    'expiresAt', hold.expires_at, 'releasedBy', hold.released_by,
    'releasedAt', hold.released_at, 'releaseReason', hold.release_reason
  ) order by hold.created_at desc, hold.id desc), '[]'::jsonb)
  into v_items
  from (
    select retention_hold.* from public.openclaw_retention_holds retention_hold
    where retention_hold.organization_id = v_org
    order by retention_hold.created_at desc, retention_hold.id desc limit v_limit
  ) hold;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

create or replace function public.openclaw_poll_qr_login_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_now timestamptz := statement_timestamp();
  v_challenge public.openclaw_qr_challenges%rowtype;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','challengeId','browserNonceHash','authSessionHash'],
    array['version','organizationId','challengeId','browserNonceHash','authSessionHash']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.manage_connections', 'theo dõi QR OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  if (p_request ->> 'browserNonceHash') !~ '^[0-9a-f]{64}$'
     or (p_request ->> 'authSessionHash') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'QR poll binding invalid' using errcode = '22023';
  end if;
  select challenge.* into v_challenge
  from public.openclaw_qr_challenges challenge
  join public.openclaw_accounts account
    on account.organization_id=challenge.organization_id
   and account.id=challenge.account_id
   and account.connection_generation=challenge.challenge_version
   and account.connection_state in ('QR_PENDING','CONNECTING')
  join public.openclaw_runtime_commands command
    on command.organization_id=challenge.organization_id
   and command.account_id=challenge.account_id
   and command.cell_id=challenge.cell_id
   and command.id=challenge.runtime_command_id
   and command.expected_session_generation=account.session_generation
   and command.expected_connection_generation+1=challenge.challenge_version
  where challenge.organization_id = v_org
    and challenge.id = (p_request ->> 'challengeId')::uuid
    and challenge.actor_id = (select app_private.openclaw_actor_id_v1())
    and challenge.browser_nonce_hash = p_request ->> 'browserNonceHash'
    and challenge.auth_session_hash = p_request ->> 'authSessionHash'
  for update of challenge;
  if not found then
    return jsonb_build_object('version', 1, 'challenge', null);
  end if;
  if v_challenge.poll_window_started_at is null
     or v_challenge.poll_window_started_at <= v_now - interval '10 seconds'
  then
    update public.openclaw_qr_challenges set
      poll_window_started_at=v_now,poll_count=1
    where organization_id=v_org and id=v_challenge.id;
  elsif v_challenge.poll_count >= 10 then
    raise exception 'QR poll rate limit exceeded' using errcode='P0003';
  else
    update public.openclaw_qr_challenges set poll_count=poll_count+1
    where organization_id=v_org and id=v_challenge.id;
  end if;
  v_result:=jsonb_build_object(
    'challengeId',v_challenge.id,'accountId',v_challenge.account_id,
    'cellId',v_challenge.cell_id,'challengeVersion',v_challenge.challenge_version,
    'challengeStatus',case
      when v_challenge.active_slot and v_challenge.expires_at<=v_now then 'EXPIRED'
      when v_challenge.material_version=1 then 'READY'
      else v_challenge.challenge_status
    end,
    'materialVersion',v_challenge.material_version,
    'issuedAt',v_challenge.issued_at,'expiresAt',v_challenge.expires_at,
    'consumedAt',v_challenge.consumed_at,'revokedAt',v_challenge.revoked_at
  );
  return jsonb_build_object('version', 1, 'challenge', v_result);
end;
$function$;

create or replace function public.openclaw_acknowledge_risk_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_account public.openclaw_accounts%rowtype;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','expectedRiskState','acknowledgedRiskState','evidenceHash'],
    array['version','organizationId','accountId','expectedRiskState','acknowledgedRiskState','evidenceHash']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_connections', 'xác nhận rủi ro OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_acknowledge_risk_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select account.* into strict v_account from public.openclaw_accounts account
  where account.organization_id = v_org and account.id = (p_request ->> 'accountId')::uuid
  for update;
  if v_account.session_risk_state is distinct from p_request ->> 'expectedRiskState'
     or p_request ->> 'acknowledgedRiskState' not in ('HEALTHY','DEGRADED')
     or (p_request ->> 'evidenceHash') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'risk acknowledgement CAS failed' using errcode = '40001';
  end if;
  update public.openclaw_accounts
  set session_risk_state = p_request ->> 'acknowledgedRiskState',
      effective_mode = 'DRAFT_ONLY', updated_at = statement_timestamp()
  where organization_id = v_org and id = v_account.id;
  v_result := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'accountId', v_account.id,
    'sessionRiskState', p_request ->> 'acknowledgedRiskState',
    'effectiveMode', 'DRAFT_ONLY'
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_acknowledge_risk_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_RISK_ACKNOWLEDGED', v_result
  );
end;
$function$;

create or replace function public.openclaw_begin_qr_login_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_account public.openclaw_accounts%rowtype;
  v_cell public.openclaw_runtime_cells%rowtype; v_lease public.openclaw_runtime_leases%rowtype;
  v_command_id uuid := gen_random_uuid(); v_challenge_id uuid := gen_random_uuid();
  v_payload jsonb; v_payload_bytes bytea; v_result jsonb;
  v_issued_at timestamptz := statement_timestamp();
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cellId','browserNonceHash','authSessionHash','disclosureVersion'],
    array['version','organizationId','accountId','cellId','browserNonceHash','authSessionHash','disclosureVersion']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_connections', 'bắt đầu đăng nhập QR OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_begin_qr_login_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select account.* into strict v_account from public.openclaw_accounts account
  where account.organization_id = v_org and account.id = (p_request ->> 'accountId')::uuid
    and account.is_active
    and account.connection_state in ('DISCONNECTED','QR_PENDING')
    and not exists (
      select 1 from public.openclaw_generation_revocations revocation
      where revocation.organization_id=account.organization_id
        and revocation.account_id=account.id
        and revocation.principal_kind='CHANNEL'
        and revocation.revocation_kind in ('SESSION','MEDIA')
        and revocation.acknowledged_at is null
    )
    and not exists (
      select 1
      from public.openclaw_runtime_commands command
      join public.openclaw_generation_revocations revocation
        on revocation.organization_id=command.organization_id
       and revocation.command_id=command.id
       and revocation.account_id=command.account_id
       and revocation.cell_id=command.cell_id
       and revocation.principal_kind='CHANNEL'
       and revocation.revocation_kind='SESSION'
      where command.organization_id=account.organization_id
        and command.account_id=account.id
        and command.command_kind='DISCONNECT'
        and (
          revocation.acknowledged_at is null
          or not (
            (command.state='ACKNOWLEDGED'
              and command.effect_disposition='PROVIDER_CONFIRMED')
            or (command.state in ('FAILED','REVOKED')
              and command.effect_disposition='SEALED_UNCONFIRMED'
              and command.sealed_at is not null)
          )
        )
    )
  for update;
  select cell.* into strict v_cell from public.openclaw_runtime_cells cell
  where cell.organization_id = v_org and cell.account_id = v_account.id
    and cell.id = (p_request ->> 'cellId')::uuid and cell.is_current and cell.state = 'READY'
  for update;
  select lease.* into strict v_lease from public.openclaw_runtime_leases lease
  where lease.organization_id = v_org and lease.account_id = v_account.id
    and lease.cell_id = v_cell.id and lease.status = 'ACTIVE'
    and lease.expires_at > statement_timestamp() for update;
  if v_account.disclosure_acknowledged_version is distinct from v_account.disclosure_version
     or v_account.disclosure_acknowledged_at is null
  then
    raise exception 'current disclosure acknowledgement required' using errcode = '42501';
  end if;
  if (p_request ->> 'browserNonceHash') !~ '^[0-9a-f]{64}$'
     or (p_request ->> 'authSessionHash') !~ '^[0-9a-f]{64}$'
     or (p_request ->> 'disclosureVersion')::integer <> v_account.disclosure_version
  then raise exception 'QR request binding mismatch' using errcode = '40001'; end if;
  update public.openclaw_qr_challenges
  set active_slot = false, challenge_status = 'REVOKED', revoked_at = statement_timestamp(),
      ciphertext=null,cipher_iv=null,auth_tag=null,
      material_version=0,material_published_at=null
  where organization_id = v_org and account_id = v_account.id and active_slot;
  update public.openclaw_runtime_commands command set
    state='REVOKED',claim_token_hash=null,lease_expires_at=null,
    acknowledged_at=null,updated_at=statement_timestamp()
  where command.organization_id=v_org and command.account_id=v_account.id
    and command.command_kind='QR_LOGIN'
    and command.state in ('PENDING','LEASED','ACKNOWLEDGED')
    and exists (
      select 1 from public.openclaw_qr_challenges challenge
      where challenge.organization_id=command.organization_id
        and challenge.account_id=command.account_id
        and challenge.runtime_command_id=command.id
        and challenge.challenge_status='REVOKED'
        and challenge.revoked_at=statement_timestamp()
    );
  v_payload := jsonb_build_object(
    'version', 1, 'challengeId', v_challenge_id, 'browserNonceHash', p_request ->> 'browserNonceHash'
  );
  v_payload_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  insert into public.openclaw_runtime_commands (
    id, organization_id, account_id, cell_id, command_key, command_kind,
    source_session_generation,target_session_generation,
    source_connection_generation,target_connection_generation,
    expected_session_generation, expected_connection_generation, expected_fencing_token,
    payload, payload_bytes, payload_hash, created_by
  ) values (
    v_command_id, v_org, v_account.id, v_cell.id, 'qr:' || v_challenge_id::text,
    'QR_LOGIN',v_account.session_generation,v_account.session_generation,
    v_account.connection_generation,v_account.connection_generation+1,
    v_account.session_generation, v_account.connection_generation,
    v_lease.fencing_token, v_payload, v_payload_bytes,
    encode(extensions.digest(v_payload_bytes, 'sha256'), 'hex'), v_actor
  );
  insert into public.openclaw_qr_challenges (
    id, organization_id, account_id, cell_id, runtime_command_id,
    challenge_version, challenge_status, active_slot,
    ciphertext, cipher_iv, auth_tag, material_version, material_published_at,
    actor_id, auth_session_hash, browser_nonce_hash, issued_at, expires_at
  ) values (
    v_challenge_id, v_org, v_account.id, v_cell.id, v_command_id,
    v_account.connection_generation + 1, 'PENDING', true,
    null, null, null, 0, null, v_actor,
    p_request ->> 'authSessionHash', p_request ->> 'browserNonceHash',
    v_issued_at, v_issued_at + interval '120 seconds'
  );
  update public.openclaw_accounts
  set connection_state = 'QR_PENDING', effective_mode = 'DRAFT_ONLY',
      connection_generation = connection_generation + 1, updated_at = statement_timestamp()
  where organization_id = v_org and id = v_account.id;
  v_result := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'accountId', v_account.id,
    'cellId', v_cell.id, 'challengeId', v_challenge_id,
    'runtimeCommandId', v_command_id,
    'issuedAt',v_issued_at,'expiresAt',v_issued_at + interval '120 seconds',
    'status', 'PENDING'
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_begin_qr_login_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_QR_LOGIN_BEGUN', v_result
  );
end;
$function$;

create or replace function public.openclaw_consume_qr_challenge_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_challenge public.openclaw_qr_challenges%rowtype;
  v_safe_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','challengeId','browserNonceHash','authSessionHash'],
    array['version','organizationId','challengeId','browserNonceHash','authSessionHash']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_connections', 'nhận QR OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_consume_qr_challenge_v1', p_client_operation_id,
    p_request, 'SINGLE_USE'
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select challenge.* into strict v_challenge
  from public.openclaw_qr_challenges challenge
  where challenge.organization_id = v_org
    and challenge.id = (p_request ->> 'challengeId')::uuid
    and challenge.actor_id = v_actor and challenge.active_slot
    and challenge.challenge_status = 'PENDING' and challenge.material_version = 1
    and challenge.expires_at > statement_timestamp()
    and challenge.browser_nonce_hash = p_request ->> 'browserNonceHash'
    and challenge.auth_session_hash = p_request ->> 'authSessionHash'
  for update;
  update public.openclaw_qr_challenges
  set challenge_status = 'CONSUMED', active_slot = false,
      consumed_at = statement_timestamp(), ciphertext = null,
      cipher_iv = null, auth_tag = null, material_version = 0,
      material_published_at = null
  where organization_id = v_org and id = v_challenge.id;
  v_safe_result := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'challengeId', v_challenge.id,
    'status', 'CONSUMED', 'materialVersion', v_challenge.material_version
  );
  perform app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_consume_qr_challenge_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_QR_CHALLENGE_CONSUMED', v_safe_result
  );
  return v_safe_result;
end;
$function$;

create or replace function public.openclaw_disconnect_account_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_account public.openclaw_accounts%rowtype;
  v_cell public.openclaw_runtime_cells%rowtype; v_lease public.openclaw_runtime_leases%rowtype;
  v_command_id uuid := gen_random_uuid(); v_revocation_id uuid := gen_random_uuid();
  v_new_session_generation bigint; v_payload jsonb; v_payload_bytes bytea; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','accountId','expectedConnectionGeneration','reasonCode'],
    array['version','organizationId','accountId','expectedConnectionGeneration','reasonCode']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_connections', 'ngắt kết nối OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_disconnect_account_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select account.* into strict v_account from public.openclaw_accounts account
  where account.organization_id = v_org and account.id = (p_request ->> 'accountId')::uuid
  for update;
  if v_account.connection_generation <> (p_request ->> 'expectedConnectionGeneration')::bigint then
    raise exception 'connection generation mismatch' using errcode = '40001';
  end if;
  select cell.* into strict v_cell from public.openclaw_runtime_cells cell
  where cell.organization_id = v_org and cell.account_id = v_account.id and cell.is_current
  for update;
  select lease.* into strict v_lease from public.openclaw_runtime_leases lease
  where lease.organization_id = v_org and lease.account_id = v_account.id
    and lease.cell_id = v_cell.id and lease.status = 'ACTIVE' for update;
  if exists (
    select 1 from public.openclaw_runtime_commands command
    where command.organization_id=v_org and command.account_id=v_account.id
      and command.cell_id=v_cell.id and command.command_kind='DISCONNECT'
      and command.state='STARTED'
  ) then
    raise exception 'started disconnect command cannot be superseded' using errcode='40001';
  end if;
  update public.openclaw_runtime_commands command set
    state='REVOKED',claim_token_hash=null,lease_expires_at=null,
    effect_disposition='NONE',sealed_at=null,seal_reason=null,
    updated_at=statement_timestamp()
  where command.organization_id=v_org and command.account_id=v_account.id
    and command.cell_id=v_cell.id and command.command_kind='DISCONNECT'
    and command.state in ('PENDING','LEASED');
  v_new_session_generation:=v_account.session_generation+1;
  v_payload := jsonb_build_object(
    'version',1,'reasonCode',p_request->>'reasonCode',
    'revocationId',v_revocation_id,
    'revokedSessionGeneration',v_account.session_generation,
    'minimumSessionGeneration',v_new_session_generation
  );
  v_payload_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  insert into public.openclaw_runtime_commands (
    id, organization_id, account_id, cell_id, command_key, command_kind,
    source_session_generation,target_session_generation,
    source_connection_generation,target_connection_generation,
    expected_session_generation, expected_connection_generation, expected_fencing_token,
    payload, payload_bytes, payload_hash, created_by
  ) values (
    v_command_id, v_org, v_account.id, v_cell.id, 'disconnect:' || p_client_operation_id::text,
    'DISCONNECT',v_account.session_generation,v_new_session_generation,
    v_account.connection_generation,v_account.connection_generation+1,
    v_new_session_generation, v_account.connection_generation,
    v_lease.fencing_token, v_payload, v_payload_bytes,
    encode(extensions.digest(v_payload_bytes, 'sha256'), 'hex'), v_actor
  );
  insert into public.openclaw_generation_revocations(
    id,organization_id,principal_kind,account_id,cell_id,revocation_kind,
    revoked_generation,minimum_valid_generation,command_id,reason_code
  ) values (
    v_revocation_id,v_org,'CHANNEL',v_account.id,v_cell.id,'SESSION',
    v_account.session_generation,v_new_session_generation,v_command_id,'ACCOUNT_DISCONNECT'
  );
  update public.openclaw_qr_challenges challenge set
    active_slot=false,challenge_status='REVOKED',revoked_at=statement_timestamp(),
    ciphertext=null,cipher_iv=null,auth_tag=null,
    material_version=0,material_published_at=null
  where challenge.organization_id=v_org and challenge.account_id=v_account.id
    and challenge.active_slot;
  update public.openclaw_runtime_commands command set
    state='REVOKED',claim_token_hash=null,lease_expires_at=null,
    acknowledged_at=null,updated_at=statement_timestamp()
  where command.organization_id=v_org and command.account_id=v_account.id
    and command.command_kind='QR_LOGIN'
    and command.state in ('PENDING','LEASED','ACKNOWLEDGED')
    and exists (
      select 1 from public.openclaw_qr_challenges challenge
      where challenge.organization_id=command.organization_id
        and challenge.account_id=command.account_id
        and challenge.runtime_command_id=command.id
        and challenge.challenge_status='REVOKED'
        and challenge.revoked_at=statement_timestamp()
    );
  update public.openclaw_accounts set connection_state = 'DISCONNECTING',
    effective_mode = 'DRAFT_ONLY', paused_at = statement_timestamp(),
    session_generation=v_new_session_generation,
    connection_generation = connection_generation + 1, updated_at = statement_timestamp()
  where organization_id = v_org and id = v_account.id;
  v_result := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'accountId', v_account.id,
    'cellId',v_cell.id,'runtimeCommandId',v_command_id,
    'revocationId',v_revocation_id,'revocationKind','SESSION',
    'revokedGeneration',v_account.session_generation,
    'minimumValidGeneration',v_new_session_generation,
    'connectionState', 'DISCONNECTING','effectiveMode', 'DRAFT_ONLY'
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_disconnect_account_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_ACCOUNT_DISCONNECT_REQUESTED', v_result
  );
end;
$function$;

create or replace function public.openclaw_create_send_intent_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_draft public.openclaw_ai_drafts%rowtype;
  v_target public.openclaw_targets%rowtype; v_account public.openclaw_accounts%rowtype;
  v_policy_version uuid; v_payload jsonb; v_parts jsonb; v_payload_bytes bytea;
  v_payload_hash text; v_outbox_id uuid := gen_random_uuid(); v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','sourceDraftId','targetId','expectedDraftVersion','replyToMessageId'],
    array['version','organizationId','sourceDraftId','targetId','expectedDraftVersion','replyToMessageId']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.send', 'gửi tin nhắn OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_create_send_intent_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select draft.* into strict v_draft from public.openclaw_ai_drafts draft
  where draft.organization_id = v_org and draft.id = (p_request ->> 'sourceDraftId')::uuid
    and draft.draft_version = (p_request ->> 'expectedDraftVersion')::bigint
    and draft.dlp_decision = 'PASS' and draft.publication_state in ('REVIEW_ONLY','APPROVED')
  for update;
  select target.* into strict v_target from public.openclaw_targets target
  where target.organization_id = v_org and target.account_id = v_draft.account_id
    and target.id = (p_request ->> 'targetId')::uuid and target.is_active for update;
  select account.* into strict v_account from public.openclaw_accounts account
  where account.organization_id = v_org and account.id = v_draft.account_id and account.is_active
  for update;
  if v_account.effective_mode not in ('MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')
     or v_account.connection_state <> 'CONNECTED' or v_account.paused_at is not null
  then raise exception 'account is not eligible to send' using errcode = '55000'; end if;
  select version.id into v_policy_version from public.openclaw_policy_versions version
  join public.openclaw_policies policy
    on policy.organization_id = version.organization_id and policy.account_id = version.account_id
   and policy.id = version.policy_id and policy.current_version = version.version
  where version.organization_id = v_org and version.account_id = v_account.id
    and version.lifecycle_state = 'PUBLISHED' order by version.created_at desc limit 1;
  if v_policy_version is null then raise exception 'published policy required' using errcode = '55000'; end if;
  select jsonb_agg(jsonb_build_object(
    'version', 1, 'partIndex', chunk.ordinality - 1, 'kind', 'TEXT', 'text', chunk.value
  ) order by chunk.ordinality)
  into v_parts
  from jsonb_array_elements_text(app_private.openclaw_text_chunks_v1(v_draft.draft_text))
    with ordinality chunk(value, ordinality);
  v_payload := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'accountId', v_account.id,
    'target', jsonb_build_object('kind', v_target.kind, 'providerId', v_target.provider_id),
    'channel', 'zalouser', 'accountProfile', v_account.account_profile,
    'idempotencyKey', p_client_operation_id::text, 'parts', v_parts,
    'replyToProviderMessageId', (
      select message.provider_message_id from public.openclaw_messages message
      where message.organization_id = v_org
        and message.id = nullif(p_request ->> 'replyToMessageId', '')::uuid
    ),
    'policyVersionId', v_policy_version, 'automationVersionId', v_draft.automation_version_id,
    'templateVersionId', null,
    'frozenInputs', jsonb_build_object(
      'campaignVersionId', null, 'scheduleVersion', null, 'subscriptionVersion', null,
      'subscriptionId', null, 'occurrenceId', null, 'sourceTable', null,
      'sourceId', v_draft.id, 'sourceVersion', v_draft.draft_version::text,
      'knowledgeVersionIds', to_jsonb(v_draft.knowledge_version_ids),
      'sourceSnapshotHash', v_draft.prompt_input_hash,
      'targetVersion', v_target.target_version,
      'targetDirectoryRefreshedAt', v_target.directory_refreshed_at,
      'fieldMappingHash', null
    )
  );
  v_payload_bytes := app_private.openclaw_canonical_send_payload_bytes_v1(v_payload);
  v_payload_hash := app_private.openclaw_send_payload_hash_v1(v_payload);
  insert into public.openclaw_outbox (
    id, organization_id, account_id, target_id, source_kind, actor_id,
    client_operation_id, idempotency_key, canonical_payload,
    canonical_payload_bytes, payload_hash, session_generation
  ) values (
    v_outbox_id, v_org, v_account.id, v_target.id, 'MANUAL', v_actor,
    p_client_operation_id, p_client_operation_id::text, v_payload,
    v_payload_bytes, v_payload_hash, v_account.session_generation
  );
  update public.openclaw_ai_drafts set publication_state = 'PUBLISHED',
    publication_intent_id = v_outbox_id
  where organization_id = v_org and id = v_draft.id;
  v_result := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'accountId', v_account.id,
    'outboxId', v_outbox_id, 'state', 'QUEUED', 'payloadHash', v_payload_hash,
    'idempotencyKey', p_client_operation_id
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_create_send_intent_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_SEND_INTENT_CREATED', v_result
  );
end;
$function$;

create or replace function public.openclaw_takeover_conversation_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_conversation public.openclaw_conversations%rowtype;
  v_membership uuid; v_takeover_id uuid := gen_random_uuid(); v_version bigint; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','conversationId','expectedConversationVersion','expiresAt'],
    array['version','organizationId','conversationId','expectedConversationVersion','expiresAt']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select conversation.* into strict v_conversation
  from public.openclaw_conversations conversation
  where conversation.organization_id = v_org
    and conversation.id = (p_request ->> 'conversationId')::uuid for update;
  select membership.id into v_membership from public.organization_memberships membership
  where membership.organization_id = v_org and membership.user_id = v_actor
    and membership.status = 'ACTIVE' limit 1;
  -- assigned active user may take over own conversation without the elevated branch.
  if v_membership is null or v_conversation.assigned_membership_id is distinct from v_membership then
    perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_handoff', 'tiếp quản hội thoại OpenClaw Zalo');
  end if;
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_takeover_conversation_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  if v_membership is null
     or v_conversation.version <> (p_request ->> 'expectedConversationVersion')::bigint
  then raise exception 'takeover conversation CAS failed' using errcode = '40001'; end if;
  if (p_request ->> 'expiresAt')::timestamptz <= statement_timestamp()
     or (p_request ->> 'expiresAt')::timestamptz > statement_timestamp() + interval '8 hours'
  then raise exception 'takeover expiry is invalid' using errcode = '22023'; end if;
  update public.openclaw_takeovers set released_at = statement_timestamp()
  where organization_id = v_org and account_id = v_conversation.account_id
    and conversation_id = v_conversation.id and released_at is null;
  select coalesce(max(takeover.takeover_version), 0) + 1 into v_version
  from public.openclaw_takeovers takeover
  where takeover.organization_id = v_org and takeover.account_id = v_conversation.account_id
    and takeover.conversation_id = v_conversation.id;
  insert into public.openclaw_takeovers (
    id, organization_id, account_id, conversation_id, owner_membership_id,
    takeover_version, started_at, expires_at
  ) values (
    v_takeover_id, v_org, v_conversation.account_id, v_conversation.id,
    v_membership, v_version, statement_timestamp(), (p_request ->> 'expiresAt')::timestamptz
  );
  update public.openclaw_conversations set assigned_membership_id = v_membership,
    version = version + 1, updated_at = statement_timestamp()
  where organization_id = v_org and id = v_conversation.id;
  v_result := jsonb_build_object(
    'version', 1, 'takeoverId', v_takeover_id, 'conversationId', v_conversation.id,
    'ownerMembershipId', v_membership, 'takeoverVersion', v_version,
    'expiresAt', (p_request ->> 'expiresAt')::timestamptz
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_takeover_conversation_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_CONVERSATION_TAKEN_OVER', v_result
  );
end;
$function$;

create or replace function public.openclaw_release_takeover_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_takeover public.openclaw_takeovers%rowtype;
  v_membership uuid; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','takeoverId','expectedTakeoverVersion'],
    array['version','organizationId','takeoverId','expectedTakeoverVersion']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select takeover.* into strict v_takeover from public.openclaw_takeovers takeover
  where takeover.organization_id = v_org and takeover.id = (p_request ->> 'takeoverId')::uuid
  for update;
  select membership.id into v_membership from public.organization_memberships membership
  where membership.organization_id = v_org and membership.user_id = v_actor
    and membership.status = 'ACTIVE' limit 1;
  if v_membership is null or v_takeover.owner_membership_id is distinct from v_membership then
    perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_handoff', 'trả hội thoại OpenClaw Zalo');
  end if;
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_release_takeover_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  if v_takeover.released_at is not null
     or v_takeover.takeover_version <> (p_request ->> 'expectedTakeoverVersion')::bigint
  then raise exception 'release takeover CAS failed' using errcode = '40001'; end if;
  update public.openclaw_takeovers set released_at = statement_timestamp()
  where organization_id = v_org and id = v_takeover.id;
  v_result := jsonb_build_object(
    'version', 1, 'takeoverId', v_takeover.id,
    'conversationId', v_takeover.conversation_id,
    'takeoverVersion', v_takeover.takeover_version, 'released', true
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_release_takeover_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_TAKEOVER_RELEASED', v_result
  );
end;
$function$;

create or replace function public.openclaw_assign_conversation_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_conversation public.openclaw_conversations%rowtype;
  v_membership uuid := (p_request ->> 'membershipId')::uuid; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','conversationId','membershipId','expectedConversationVersion'],
    array['version','organizationId','conversationId','membershipId','expectedConversationVersion']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_handoff', 'gán hội thoại OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_assign_conversation_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  if not exists (select 1 from public.organization_memberships membership
    where membership.organization_id = v_org and membership.id = v_membership
      and membership.status = 'ACTIVE')
  then raise exception 'active membership required' using errcode = '23503'; end if;
  select conversation.* into strict v_conversation
  from public.openclaw_conversations conversation
  where conversation.organization_id = v_org
    and conversation.id = (p_request ->> 'conversationId')::uuid for update;
  if v_conversation.version <> (p_request ->> 'expectedConversationVersion')::bigint then
    raise exception 'assign conversation CAS failed' using errcode = '40001';
  end if;
  update public.openclaw_conversations set assigned_membership_id = v_membership,
    version = version + 1, updated_at = statement_timestamp()
  where organization_id = v_org and id = v_conversation.id;
  v_result := jsonb_build_object(
    'version', 1, 'conversationId', v_conversation.id,
    'assignedMembershipId', v_membership, 'conversationVersion', v_conversation.version + 1
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_assign_conversation_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_CONVERSATION_ASSIGNED', v_result
  );
end;
$function$;

create or replace function public.openclaw_mark_conversation_read_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_conversation public.openclaw_conversations%rowtype;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId','conversationId','expectedConversationVersion'],
    array['version','organizationId','conversationId','expectedConversationVersion']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.view', 'đánh dấu đã đọc OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_mark_conversation_read_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select conversation.* into strict v_conversation
  from public.openclaw_conversations conversation
  where conversation.organization_id = v_org
    and conversation.id = (p_request ->> 'conversationId')::uuid for update;
  if v_conversation.version <> (p_request ->> 'expectedConversationVersion')::bigint then
    raise exception 'mark read CAS failed' using errcode = '40001';
  end if;
  update public.openclaw_conversations set unread_count = 0,
    version = version + 1, updated_at = statement_timestamp()
  where organization_id = v_org and id = v_conversation.id;
  v_result := jsonb_build_object(
    'version', 1, 'conversationId', v_conversation.id,
    'unreadCount', 0, 'conversationVersion', v_conversation.version + 1
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_mark_conversation_read_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_CONVERSATION_MARKED_READ', v_result
  );
end;
$function$;

create or replace function app_private.openclaw_apply_knowledge_write_v1(
  p_action text, p_organization_id uuid, p_actor_id uuid, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_source public.openclaw_knowledge_sources%rowtype;
  v_version public.openclaw_knowledge_versions%rowtype;
  v_source_id uuid := coalesce(nullif(p_request ->> 'sourceId', '')::uuid, gen_random_uuid());
  v_version_id uuid := gen_random_uuid();
  v_next_version bigint;
  v_content text;
  v_content_hash text;
begin
  if p_action = 'CREATE_DRAFT' then
    v_content := p_request ->> 'content';
    if coalesce(v_content, '') = '' then raise exception 'knowledge content required' using errcode = '22023'; end if;
    v_content_hash := encode(extensions.digest(
      convert_to('ihome-openclaw-knowledge-content-v1', 'UTF8')
        || decode('00', 'hex') || convert_to(v_content, 'UTF8'), 'sha256'
    ), 'hex');
    insert into public.openclaw_knowledge_sources (
      id, organization_id, account_id, title, source_kind, sensitivity,
      lifecycle_state, current_version
    ) values (
      v_source_id, p_organization_id, (p_request ->> 'accountId')::uuid,
      p_request ->> 'title', p_request ->> 'sourceKind', p_request ->> 'sensitivity',
      'DRAFT', 1
    );
    insert into public.openclaw_knowledge_versions (
      id, organization_id, account_id, source_id, version, sensitivity,
      lifecycle_state, content, content_hash, metadata, created_by
    ) values (
      v_version_id, p_organization_id, (p_request ->> 'accountId')::uuid,
      v_source_id, 1, p_request ->> 'sensitivity', 'DRAFT',
      v_content, v_content_hash, coalesce(p_request -> 'metadata', '{}'::jsonb), p_actor_id
    );
    return jsonb_build_object(
      'version', 1, 'sourceId', v_source_id, 'knowledgeVersionId', v_version_id,
      'knowledgeVersion', 1, 'lifecycleState', 'DRAFT', 'contentHash', v_content_hash
    );
  end if;

  select source.* into strict v_source from public.openclaw_knowledge_sources source
  where source.organization_id = p_organization_id
    and source.id = (p_request ->> 'sourceId')::uuid for update;

  if p_action = 'UPDATE_DRAFT' then
    if v_source.current_version <> (p_request ->> 'expectedSourceVersion')::bigint then
      raise exception 'knowledge source version mismatch' using errcode = '40001';
    end if;
    v_next_version := v_source.current_version + 1;
    v_content := p_request ->> 'content';
    v_content_hash := encode(extensions.digest(
      convert_to('ihome-openclaw-knowledge-content-v1', 'UTF8')
        || decode('00', 'hex') || convert_to(v_content, 'UTF8'), 'sha256'
    ), 'hex');
    insert into public.openclaw_knowledge_versions (
      id, organization_id, account_id, source_id, version, sensitivity,
      lifecycle_state, content, content_hash, metadata, created_by
    ) values (
      v_version_id, p_organization_id, v_source.account_id, v_source.id,
      v_next_version, v_source.sensitivity, 'DRAFT', v_content, v_content_hash,
      coalesce(p_request -> 'metadata', '{}'::jsonb), p_actor_id
    );
    update public.openclaw_knowledge_sources set current_version = v_next_version,
      lifecycle_state = 'DRAFT', updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_source.id;
    return jsonb_build_object(
      'version', 1, 'sourceId', v_source.id, 'knowledgeVersionId', v_version_id,
      'knowledgeVersion', v_next_version, 'lifecycleState', 'DRAFT',
      'contentHash', v_content_hash
    );
  end if;

  select version.* into strict v_version from public.openclaw_knowledge_versions version
  where version.organization_id = p_organization_id and version.source_id = v_source.id
    and version.id = (p_request ->> 'knowledgeVersionId')::uuid for update;

  if p_action = 'VALIDATE' then
    if v_version.lifecycle_state <> 'DRAFT' then
      raise exception 'only draft knowledge can be validated' using errcode = '55000';
    end if;
    update public.openclaw_knowledge_versions
    set validation_result = jsonb_build_object(
      'version', 1, 'valid', true, 'validatedAt', statement_timestamp(),
      'contentHash', v_version.content_hash
    )
    where organization_id = p_organization_id and id = v_version.id;
    return jsonb_build_object(
      'version', 1, 'sourceId', v_source.id, 'knowledgeVersionId', v_version.id,
      'valid', true, 'contentHash', v_version.content_hash
    );
  elsif p_action = 'PUBLISH' then
    if v_version.lifecycle_state <> 'DRAFT' or v_version.validation_result is null
       or v_source.current_version <> v_version.version
    then raise exception 'validated current knowledge draft required' using errcode = '55000'; end if;
    update public.openclaw_knowledge_versions set lifecycle_state = 'PUBLISHED',
      published_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_version.id;
    update public.openclaw_knowledge_sources set lifecycle_state = 'PUBLISHED',
      updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_source.id;
    return jsonb_build_object(
      'version', 1, 'sourceId', v_source.id, 'knowledgeVersionId', v_version.id,
      'knowledgeVersion', v_version.version, 'lifecycleState', 'PUBLISHED'
    );
  elsif p_action = 'ARCHIVE' then
    if v_version.lifecycle_state not in ('PUBLISHED','DRAFT') then
      raise exception 'knowledge version cannot be archived' using errcode = '55000';
    end if;
    update public.openclaw_knowledge_versions set lifecycle_state = 'ARCHIVED',
      archived_at = statement_timestamp(), published_at = coalesce(published_at, statement_timestamp())
    where organization_id = p_organization_id and id = v_version.id;
    update public.openclaw_knowledge_sources set lifecycle_state = 'ARCHIVED',
      updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_source.id;
    return jsonb_build_object(
      'version', 1, 'sourceId', v_source.id, 'knowledgeVersionId', v_version.id,
      'knowledgeVersion', v_version.version, 'lifecycleState', 'ARCHIVED'
    );
  end if;
  raise exception 'unsupported knowledge action' using errcode = '22023';
end;
$function$;

create or replace function public.openclaw_create_knowledge_draft_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','accountId','title','sourceKind','sensitivity','content','metadata'],
    array['version','organizationId','accountId','title','sourceKind','sensitivity','content']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_knowledge', 'tạo bản nháp kiến thức OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org, v_actor,
    'openclaw_create_knowledge_draft_v1', p_client_operation_id, p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_knowledge_write_v1('CREATE_DRAFT',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_create_knowledge_draft_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_KNOWLEDGE_DRAFT_CREATED',v_result);
end;
$function$;

create or replace function public.openclaw_update_knowledge_draft_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','sourceId','expectedSourceVersion','content','metadata'],
    array['version','organizationId','sourceId','expectedSourceVersion','content']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_knowledge', 'sửa bản nháp kiến thức OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_update_knowledge_draft_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_knowledge_write_v1('UPDATE_DRAFT',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_update_knowledge_draft_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_KNOWLEDGE_DRAFT_UPDATED',v_result);
end;
$function$;

create or replace function public.openclaw_validate_knowledge_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','sourceId','knowledgeVersionId'],
    array['version','organizationId','sourceId','knowledgeVersionId']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_knowledge', 'kiểm tra kiến thức OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_validate_knowledge_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_knowledge_write_v1('VALIDATE',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_validate_knowledge_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_KNOWLEDGE_VALIDATED',v_result);
end;
$function$;

create or replace function public.openclaw_publish_knowledge_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','sourceId','knowledgeVersionId'],
    array['version','organizationId','sourceId','knowledgeVersionId']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_knowledge', 'xuất bản kiến thức OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_publish_knowledge_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_knowledge_write_v1('PUBLISH',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_publish_knowledge_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_KNOWLEDGE_PUBLISHED',v_result);
end;
$function$;

create or replace function public.openclaw_archive_knowledge_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','sourceId','knowledgeVersionId'],
    array['version','organizationId','sourceId','knowledgeVersionId']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_knowledge', 'lưu trữ kiến thức OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_archive_knowledge_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_knowledge_write_v1('ARCHIVE',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_archive_knowledge_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_KNOWLEDGE_ARCHIVED',v_result);
end;
$function$;

create or replace function app_private.openclaw_apply_automation_write_v1(
  p_action text, p_organization_id uuid, p_actor_id uuid, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_automation public.openclaw_automations%rowtype;
  v_current public.openclaw_automation_versions%rowtype;
  v_automation_id uuid := coalesce(nullif(p_request ->> 'automationId', '')::uuid, gen_random_uuid());
  v_version_id uuid := gen_random_uuid();
  v_next_version bigint;
  v_config jsonb;
begin
  if p_action = 'CREATE_DRAFT' then
    v_config := coalesce(p_request -> 'configuration', '{}'::jsonb);
    insert into public.openclaw_automations (
      id, organization_id, account_id, name, automation_kind,
      lifecycle_state, current_version
    ) values (
      v_automation_id, p_organization_id, (p_request ->> 'accountId')::uuid,
      p_request ->> 'name', p_request ->> 'automationKind', 'DRAFT', 1
    );
    insert into public.openclaw_automation_versions (
      id, organization_id, account_id, automation_id, version, lifecycle_state,
      mode, template_body, allowed_crm_fields, missing_value_policy, escaping_mode,
      maximum_rendered_codepoints, policy_version_id, knowledge_version_ids,
      configuration, dry_run_hash, created_by
    ) values (
      v_version_id, p_organization_id, (p_request ->> 'accountId')::uuid,
      v_automation_id, 1, 'DRAFT', p_request ->> 'mode',
      p_request ->> 'templateBody',
      coalesce(array(select jsonb_array_elements_text(p_request -> 'allowedCrmFields')), '{}'::text[]),
      coalesce(p_request ->> 'missingValuePolicy', 'REJECT'),
      coalesce(p_request ->> 'escapingMode', 'CONTROL_SAFE'),
      coalesce((p_request ->> 'maximumRenderedCodepoints')::integer, 40000),
      (p_request ->> 'policyVersionId')::uuid,
      coalesce(array(select value::uuid from jsonb_array_elements_text(p_request -> 'knowledgeVersionIds') value), '{}'::uuid[]),
      v_config, nullif(p_request ->> 'dryRunHash', ''), p_actor_id
    );
    return jsonb_build_object(
      'version', 1, 'automationId', v_automation_id,
      'automationVersionId', v_version_id, 'automationVersion', 1,
      'lifecycleState', 'DRAFT'
    );
  end if;

  select automation.* into strict v_automation from public.openclaw_automations automation
  where automation.organization_id = p_organization_id
    and automation.id = (p_request ->> 'automationId')::uuid for update;
  select version.* into strict v_current from public.openclaw_automation_versions version
  where version.organization_id = p_organization_id
    and version.automation_id = v_automation.id and version.version = v_automation.current_version
  for update;

  if p_action = 'SAVE_STEP' then
    if v_automation.current_version <> (p_request ->> 'expectedAutomationVersion')::bigint then
      raise exception 'automation version mismatch' using errcode = '40001';
    end if;
    v_next_version := v_automation.current_version + 1;
    v_config := v_current.configuration || coalesce(p_request -> 'configurationPatch', '{}'::jsonb);
    insert into public.openclaw_automation_versions (
      id, organization_id, account_id, automation_id, version, lifecycle_state,
      mode, template_body, allowed_crm_fields, missing_value_policy, escaping_mode,
      maximum_rendered_codepoints, policy_version_id, knowledge_version_ids,
      configuration, dry_run_hash, created_by
    ) values (
      v_version_id, p_organization_id, v_automation.account_id, v_automation.id,
      v_next_version, 'DRAFT', coalesce(p_request ->> 'mode', v_current.mode),
      coalesce(p_request ->> 'templateBody', v_current.template_body),
      v_current.allowed_crm_fields, v_current.missing_value_policy, v_current.escaping_mode,
      v_current.maximum_rendered_codepoints, v_current.policy_version_id,
      v_current.knowledge_version_ids, v_config, nullif(p_request ->> 'dryRunHash', ''), p_actor_id
    );
    update public.openclaw_automations set current_version = v_next_version,
      lifecycle_state = 'DRAFT', updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_automation.id;
    return jsonb_build_object(
      'version', 1, 'automationId', v_automation.id,
      'automationVersionId', v_version_id, 'automationVersion', v_next_version,
      'lifecycleState', 'DRAFT'
    );
  elsif p_action = 'PUBLISH' then
    if v_current.lifecycle_state <> 'DRAFT' or v_current.dry_run_hash is null
       or v_automation.current_version <> (p_request ->> 'expectedAutomationVersion')::bigint
    then raise exception 'current dry-run automation draft required' using errcode = '55000'; end if;
    update public.openclaw_automation_versions set lifecycle_state = 'PUBLISHED',
      published_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_current.id;
    update public.openclaw_automations set lifecycle_state = 'PUBLISHED',
      updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_automation.id;
    return jsonb_build_object(
      'version', 1, 'automationId', v_automation.id,
      'automationVersionId', v_current.id, 'automationVersion', v_current.version,
      'lifecycleState', 'PUBLISHED', 'dryRunHash', v_current.dry_run_hash
    );
  elsif p_action = 'PAUSE' then
    if v_automation.current_version <> (p_request ->> 'expectedAutomationVersion')::bigint then
      raise exception 'automation pause version mismatch' using errcode = '40001';
    end if;
    update public.openclaw_automations set lifecycle_state = 'PAUSED',
      updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_automation.id;
    return jsonb_build_object(
      'version', 1, 'automationId', v_automation.id,
      'automationVersion', v_automation.current_version, 'lifecycleState', 'PAUSED'
    );
  end if;
  raise exception 'unsupported automation action' using errcode = '22023';
end;
$function$;

create or replace function public.openclaw_create_automation_draft_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','accountId','name','automationKind','mode','templateBody',
      'allowedCrmFields','missingValuePolicy','escapingMode','maximumRenderedCodepoints',
      'policyVersionId','knowledgeVersionIds','configuration','dryRunHash'],
    array['version','organizationId','accountId','name','automationKind','mode','templateBody',
      'policyVersionId','knowledgeVersionIds','configuration']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','tạo tự động hóa OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_create_automation_draft_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_automation_write_v1('CREATE_DRAFT',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_create_automation_draft_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_AUTOMATION_DRAFT_CREATED',v_result);
end;
$function$;

create or replace function public.openclaw_save_automation_step_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','automationId','expectedAutomationVersion',
      'configurationPatch','mode','templateBody','dryRunHash'],
    array['version','organizationId','automationId','expectedAutomationVersion','configurationPatch']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','lưu bước tự động hóa OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_save_automation_step_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_automation_write_v1('SAVE_STEP',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_save_automation_step_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_AUTOMATION_STEP_SAVED',v_result);
end;
$function$;

create or replace function public.openclaw_publish_automation_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','automationId','expectedAutomationVersion'],
    array['version','organizationId','automationId','expectedAutomationVersion']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','xuất bản tự động hóa OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_publish_automation_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_automation_write_v1('PUBLISH',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_publish_automation_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_AUTOMATION_PUBLISHED',v_result);
end;
$function$;

create or replace function public.openclaw_pause_automation_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','automationId','expectedAutomationVersion'],
    array['version','organizationId','automationId','expectedAutomationVersion']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','tạm dừng tự động hóa OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_pause_automation_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  v_result := app_private.openclaw_apply_automation_write_v1('PAUSE',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_pause_automation_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_AUTOMATION_PAUSED',v_result);
end;
$function$;

create or replace function app_private.openclaw_apply_schedule_write_v1(
  p_action text, p_organization_id uuid, p_actor_id uuid, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_schedule public.openclaw_schedules%rowtype;
  v_schedule_id uuid := coalesce(nullif(p_request ->> 'scheduleId', '')::uuid, gen_random_uuid());
  v_account uuid := (p_request ->> 'accountId')::uuid;
  v_version bigint;
  v_status text;
  v_snapshot jsonb;
  v_snapshot_bytes bytea;
  v_snapshot_hash text;
begin
  if p_action = 'UPSERT' and nullif(p_request ->> 'scheduleId', '') is null then
    v_version := 1;
    v_status := 'PAUSED';
    insert into public.openclaw_schedules (
      id, organization_id, account_id, automation_version_id, target_id, campaign_id,
      schedule_version, status, timezone, local_recurrence_rule, next_run_at
    ) values (
      v_schedule_id, p_organization_id, v_account,
      (p_request ->> 'automationVersionId')::uuid,
      nullif(p_request ->> 'targetId', '')::uuid,
      nullif(p_request ->> 'campaignId', '')::uuid,
      v_version, v_status, p_request ->> 'timezone', p_request ->> 'localRecurrenceRule',
      nullif(p_request ->> 'nextRunAt', '')::timestamptz
    );
  else
    select schedule.* into strict v_schedule from public.openclaw_schedules schedule
    where schedule.organization_id = p_organization_id
      and schedule.id = (p_request ->> 'scheduleId')::uuid for update;
    if v_schedule.schedule_version <> (p_request ->> 'expectedScheduleVersion')::bigint then
      raise exception 'schedule version mismatch' using errcode = '40001';
    end if;
    v_account := v_schedule.account_id;
    v_version := v_schedule.schedule_version + 1;
    v_status := case p_action when 'PAUSE' then 'PAUSED' when 'CANCEL' then 'CANCELLED' else 'PAUSED' end;
    update public.openclaw_schedules set
      automation_version_id = case when p_action = 'UPSERT'
        then (p_request ->> 'automationVersionId')::uuid else automation_version_id end,
      target_id = case when p_action = 'UPSERT'
        then nullif(p_request ->> 'targetId', '')::uuid else target_id end,
      campaign_id = case when p_action = 'UPSERT'
        then nullif(p_request ->> 'campaignId', '')::uuid else campaign_id end,
      schedule_version = v_version, status = v_status,
      timezone = case when p_action = 'UPSERT' then p_request ->> 'timezone' else timezone end,
      local_recurrence_rule = case when p_action = 'UPSERT'
        then p_request ->> 'localRecurrenceRule' else local_recurrence_rule end,
      next_run_at = case when p_action = 'UPSERT'
        then nullif(p_request ->> 'nextRunAt', '')::timestamptz else next_run_at end,
      updated_at = statement_timestamp()
    where organization_id = p_organization_id and id = v_schedule.id;
    v_schedule_id := v_schedule.id;
  end if;
  select schedule.* into strict v_schedule from public.openclaw_schedules schedule
  where schedule.organization_id = p_organization_id and schedule.id = v_schedule_id;
  v_snapshot := jsonb_build_object(
    'version', 1, 'scheduleId', v_schedule.id, 'scheduleVersion', v_schedule.schedule_version,
    'automationVersionId', v_schedule.automation_version_id, 'targetId', v_schedule.target_id,
    'campaignId', v_schedule.campaign_id, 'status', v_schedule.status,
    'timezone', v_schedule.timezone, 'localRecurrenceRule', v_schedule.local_recurrence_rule,
    'missedOccurrencePolicy', v_schedule.missed_occurrence_policy
  );
  v_snapshot_bytes := app_private.openclaw_jcs_bytes_v1(v_snapshot);
  v_snapshot_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-schedule-snapshot-v1', 'UTF8')
      || decode('00', 'hex') || v_snapshot_bytes, 'sha256'
  ), 'hex');
  insert into public.openclaw_schedule_snapshots (
    organization_id, account_id, schedule_id, schedule_version,
    automation_version_id, target_id, campaign_id, status, timezone,
    local_recurrence_rule, missed_occurrence_policy,
    snapshot, snapshot_bytes, snapshot_hash, created_by
  ) values (
    p_organization_id, v_schedule.account_id, v_schedule.id, v_schedule.schedule_version,
    v_schedule.automation_version_id, v_schedule.target_id, v_schedule.campaign_id,
    v_schedule.status, v_schedule.timezone, v_schedule.local_recurrence_rule,
    v_schedule.missed_occurrence_policy, v_snapshot, v_snapshot_bytes, v_snapshot_hash, p_actor_id
  );
  return jsonb_build_object(
    'version', 1, 'scheduleId', v_schedule.id,
    'scheduleVersion', v_schedule.schedule_version,
    'status', v_schedule.status, 'snapshotHash', v_snapshot_hash
  );
end;
$function$;

create or replace function public.openclaw_upsert_group_allowlist_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_target public.openclaw_targets%rowtype;
  v_version bigint; v_id uuid := gen_random_uuid(); v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','targetId','expectedAllowlistVersion','isAllowed','evidenceHash'],
    array['version','organizationId','targetId','expectedAllowlistVersion','isAllowed','evidenceHash']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','cập nhật nhóm sale OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_upsert_group_allowlist_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash := v_operation->>'requestHash';
  select target.* into strict v_target from public.openclaw_targets target
  where target.organization_id = v_org and target.id = (p_request->>'targetId')::uuid
    and target.kind = 'SALES_GROUP' and target.is_active for update;
  select coalesce(max(entry.allowlist_version),0) into v_version
  from public.openclaw_sales_group_allowlists entry
  where entry.organization_id=v_org and entry.account_id=v_target.account_id
    and entry.sales_group_target_id=v_target.id;
  if v_version <> (p_request->>'expectedAllowlistVersion')::bigint
     or v_target.directory_refreshed_at < statement_timestamp() - interval '24 hours'
     or (p_request->>'evidenceHash') !~ '^[0-9a-f]{64}$'
  then raise exception 'group allowlist CAS or directory freshness failed' using errcode='40001'; end if;
  v_version := v_version + 1;
  insert into public.openclaw_sales_group_allowlists(
    id,organization_id,account_id,sales_group_target_id,allowlist_version,is_allowed,
    directory_refreshed_at,directory_expires_at,evidence_hash,approved_by,approved_at
  ) values (
    v_id,v_org,v_target.account_id,v_target.id,v_version,
    (p_request->>'isAllowed')::boolean,v_target.directory_refreshed_at,
    v_target.directory_refreshed_at+interval '24 hours',p_request->>'evidenceHash',
    case when (p_request->>'isAllowed')::boolean then v_actor else null end,
    case when (p_request->>'isAllowed')::boolean then statement_timestamp() else null end
  );
  v_result:=jsonb_build_object('version',1,'allowlistId',v_id,'targetId',v_target.id,
    'allowlistVersion',v_version,'isAllowed',(p_request->>'isAllowed')::boolean);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_upsert_group_allowlist_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_GROUP_ALLOWLIST_UPDATED',v_result);
end;
$function$;

create or replace function public.openclaw_upsert_schedule_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','scheduleId','expectedScheduleVersion','accountId',
      'automationVersionId','targetId','campaignVersionId','timezone','localRecurrenceRule',
      'occurrenceGraceSeconds','dstFoldPolicy'],
    array['version','organizationId','accountId','automationVersionId','targetId',
      'campaignVersionId','timezone','localRecurrenceRule']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','cập nhật lịch OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_upsert_schedule_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  v_result:=app_private.openclaw_apply_schedule_write_v1('UPSERT',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_upsert_schedule_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_SCHEDULE_UPSERTED',v_result);
end;
$function$;

create or replace function public.openclaw_pause_schedule_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','scheduleId','expectedScheduleVersion'],
    array['version','organizationId','scheduleId','expectedScheduleVersion']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','tạm dừng lịch OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_pause_schedule_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  v_result:=app_private.openclaw_apply_schedule_write_v1('PAUSE',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_pause_schedule_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_SCHEDULE_PAUSED',v_result);
end;
$function$;

create or replace function public.openclaw_cancel_schedule_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','scheduleId','expectedScheduleVersion'],
    array['version','organizationId','scheduleId','expectedScheduleVersion']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_automation','hủy lịch OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_cancel_schedule_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  v_result:=app_private.openclaw_apply_schedule_write_v1('CANCEL',v_org,v_actor,p_request);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_cancel_schedule_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_SCHEDULE_CANCELLED',v_result);
end;
$function$;

create or replace function public.openclaw_request_directory_sync_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_account public.openclaw_accounts%rowtype;
  v_cell public.openclaw_runtime_cells%rowtype; v_lease public.openclaw_runtime_leases%rowtype;
  v_id uuid:=gen_random_uuid(); v_payload jsonb; v_bytes bytea; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','accountId'],array['version','organizationId','accountId']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_connections','đồng bộ danh bạ OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_request_directory_sync_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  select account.* into strict v_account from public.openclaw_accounts account
  where account.organization_id=v_org and account.id=(p_request->>'accountId')::uuid for update;
  select cell.* into strict v_cell from public.openclaw_runtime_cells cell
  where cell.organization_id=v_org and cell.account_id=v_account.id and cell.is_current and cell.state='READY';
  select lease.* into strict v_lease from public.openclaw_runtime_leases lease
  where lease.organization_id=v_org and lease.account_id=v_account.id and lease.cell_id=v_cell.id
    and lease.status='ACTIVE' and lease.expires_at>statement_timestamp();
  v_payload:=jsonb_build_object('version',1,'requestedBy',v_actor);
  v_bytes:=app_private.openclaw_jcs_bytes_v1(v_payload);
  insert into public.openclaw_runtime_commands(id,organization_id,account_id,cell_id,
    command_key,command_kind,source_session_generation,target_session_generation,
    source_connection_generation,target_connection_generation,
    expected_session_generation,expected_connection_generation,
    expected_fencing_token,payload,payload_bytes,payload_hash,created_by)
  values(v_id,v_org,v_account.id,v_cell.id,'directory:'||p_client_operation_id::text,
    'DIRECTORY_SYNC',v_account.session_generation,v_account.session_generation,
    v_account.connection_generation,v_account.connection_generation,
    v_account.session_generation,v_account.connection_generation,
    v_lease.fencing_token,v_payload,v_bytes,encode(extensions.digest(v_bytes,'sha256'),'hex'),v_actor);
  v_result:=jsonb_build_object('version',1,'runtimeCommandId',v_id,'status','PENDING');
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_request_directory_sync_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_DIRECTORY_SYNC_REQUESTED',v_result);
end;
$function$;

create or replace function public.openclaw_set_control_state_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_control public.openclaw_control_states%rowtype;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','expectedControlVersion','globalStop','featureEnabled',
      'limitedAutoReplyEnabled','proactiveEnabled','salesGroupsEnabled','firstContactEnabled','reasonCode'],
    array['version','organizationId','expectedControlVersion','globalStop','reasonCode']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_operations','đổi điều khiển OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_set_control_state_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  select control.* into strict v_control from public.openclaw_control_states control
  where control.organization_id=v_org and control.control_key='GLOBAL_STOP' for update;
  if v_control.control_version<>(p_request->>'expectedControlVersion')::bigint then
    raise exception 'control version mismatch' using errcode='40001'; end if;
  update public.openclaw_control_states set
    global_stop=(p_request->>'globalStop')::boolean,
    feature_enabled=case when (p_request->>'globalStop')::boolean then feature_enabled
      else coalesce((p_request->>'featureEnabled')::boolean,feature_enabled) end,
    limited_auto_reply_enabled=case when (p_request->>'globalStop')::boolean then false
      else coalesce((p_request->>'limitedAutoReplyEnabled')::boolean,limited_auto_reply_enabled) end,
    proactive_enabled=case when (p_request->>'globalStop')::boolean then false
      else coalesce((p_request->>'proactiveEnabled')::boolean,proactive_enabled) end,
    sales_groups_enabled=case when (p_request->>'globalStop')::boolean then false
      else coalesce((p_request->>'salesGroupsEnabled')::boolean,sales_groups_enabled) end,
    first_contact_enabled=case when (p_request->>'globalStop')::boolean then false
      else coalesce((p_request->>'firstContactEnabled')::boolean,first_contact_enabled) end,
    control_version=control_version+1,updated_by=v_actor,updated_at=statement_timestamp()
  where organization_id=v_org and id=v_control.id;
  select jsonb_build_object('version',1,'organizationId',v_org,
    'globalStop',control.global_stop,'featureEnabled',control.feature_enabled,
    'limitedAutoReplyEnabled',control.limited_auto_reply_enabled,
    'proactiveEnabled',control.proactive_enabled,'salesGroupsEnabled',control.sales_groups_enabled,
    'firstContactEnabled',control.first_contact_enabled,'controlVersion',control.control_version)
  into v_result from public.openclaw_control_states control
  where control.organization_id=v_org and control.id=v_control.id;
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_set_control_state_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_CONTROL_STATE_CHANGED',v_result);
end;
$function$;

create or replace function public.openclaw_create_legal_hold_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_hold_id uuid:=gen_random_uuid();
  v_version bigint; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','targetKind','targetId','reason','expiresAt'],
    array['version','organizationId','targetKind','targetId','reason','expiresAt']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_operations','tạo legal hold OpenClaw Zalo');
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.audit','tạo legal hold OpenClaw Zalo');
  if not exists(select 1 from public.organization_memberships membership
    where membership.organization_id=v_org and membership.user_id=v_actor
      and membership.status='ACTIVE' and membership.member_type='OWNER')
  then raise exception 'active organization owner required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    v_org::text||':'||p_request->>'targetKind'||':'||p_request->>'targetId',0));
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_create_legal_hold_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  if exists(select 1 from public.openclaw_retention_holds hold
    where hold.organization_id=v_org and hold.target_kind=p_request->>'targetKind'
      and hold.target_id=(p_request->>'targetId')::uuid and hold.released_at is null)
  then raise exception 'active legal hold already exists' using errcode='23505'; end if;
  select coalesce(max(hold.hold_version),0)+1 into v_version
  from public.openclaw_retention_holds hold where hold.organization_id=v_org
    and hold.target_kind=p_request->>'targetKind' and hold.target_id=(p_request->>'targetId')::uuid;
  insert into public.openclaw_retention_holds(id,organization_id,target_kind,target_id,
    reason,hold_version,created_by,expires_at)
  values(v_hold_id,v_org,p_request->>'targetKind',(p_request->>'targetId')::uuid,
    p_request->>'reason',v_version,v_actor,nullif(p_request->>'expiresAt','')::timestamptz);
  update public.openclaw_retention_delete_authorizations delete_authz
  set revoked_at=statement_timestamp(),revoked_reason='LEGAL_HOLD_CREATED'
  from public.openclaw_retention_tombstones tombstone
  where delete_authz.organization_id=v_org and delete_authz.tombstone_id=tombstone.id
    and tombstone.subject_id=(p_request->>'targetId')::uuid
    and tombstone.subject_kind=p_request->>'targetKind'
    and delete_authz.finalized_at is null and delete_authz.revoked_at is null;
  v_result:=jsonb_build_object('version',1,'holdId',v_hold_id,'targetKind',p_request->>'targetKind',
    'targetId',p_request->>'targetId','holdVersion',v_version,'active',true);
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_create_legal_hold_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_LEGAL_HOLD_CREATED',v_result);
end;
$function$;

create or replace function public.openclaw_release_legal_hold_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_hold public.openclaw_retention_holds%rowtype;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','holdId','expectedHoldVersion','releaseReason'],
    array['version','organizationId','holdId','expectedHoldVersion','releaseReason']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_operations','gỡ legal hold OpenClaw Zalo');
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.audit','gỡ legal hold OpenClaw Zalo');
  if not exists(select 1 from public.organization_memberships membership
    where membership.organization_id=v_org and membership.user_id=v_actor
      and membership.status='ACTIVE' and membership.member_type='OWNER')
  then raise exception 'active organization owner required' using errcode='42501'; end if;
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_release_legal_hold_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  select hold.* into strict v_hold from public.openclaw_retention_holds hold
  where hold.organization_id=v_org and hold.id=(p_request->>'holdId')::uuid for update;
  if v_hold.released_at is not null or v_hold.hold_version<>(p_request->>'expectedHoldVersion')::bigint
  then raise exception 'release legal hold CAS failed' using errcode='40001'; end if;
  update public.openclaw_retention_holds set released_by=v_actor,released_at=statement_timestamp(),
    release_reason=p_request->>'releaseReason',hold_version=hold_version+1
  where organization_id=v_org and id=v_hold.id;
  v_result:=jsonb_build_object('version',1,'holdId',v_hold.id,'holdVersion',v_hold.hold_version+1,
    'active',false,'releasedAt',statement_timestamp());
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_release_legal_hold_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_LEGAL_HOLD_RELEASED',v_result);
end;
$function$;

create or replace function public.openclaw_replay_dead_letter_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_dead public.openclaw_dead_letters%rowtype;
  v_old public.openclaw_outbox%rowtype; v_payload jsonb; v_bytes bytea; v_hash text;
  v_new_outbox uuid; v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(p_request,
    array['version','organizationId','deadLetterId'],array['version','organizationId','deadLetterId']);
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_operations','phát lại dead letter OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_replay_dead_letter_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  select dead.* into strict v_dead from public.openclaw_dead_letters dead
  where dead.organization_id=v_org and dead.id=(p_request->>'deadLetterId')::uuid for update;
  if v_dead.send_work_item_id is not null then
    update public.openclaw_send_work_items set state='QUEUED',claim_token_hash=null,
      claim_generation=claim_generation+1,lease_expires_at=null,retry_not_before=statement_timestamp(),
      terminal_at=null,updated_at=statement_timestamp()
    where organization_id=v_org and id=v_dead.send_work_item_id and state='DEAD_LETTER';
    if not found then raise exception 'send work dead letter is not replayable' using errcode='40001'; end if;
    v_result:=jsonb_build_object('version',1,'deadLetterId',v_dead.id,
      'sendWorkItemId',v_dead.send_work_item_id,'state','QUEUED');
  else
    select outbox.* into strict v_old from public.openclaw_outbox outbox
    where outbox.organization_id=v_org and outbox.id=v_dead.outbox_id and outbox.state='DEAD_LETTER'
    for update;
    v_payload:=jsonb_set(v_old.canonical_payload,'{idempotencyKey}',to_jsonb(p_client_operation_id::text));
    v_bytes:=app_private.openclaw_canonical_send_payload_bytes_v1(v_payload);
    v_hash:=app_private.openclaw_send_payload_hash_v1(v_payload);
    v_new_outbox:=gen_random_uuid();
    insert into public.openclaw_outbox(id,organization_id,account_id,target_id,source_kind,
      actor_id,client_operation_id,idempotency_key,canonical_payload,canonical_payload_bytes,
      payload_hash,session_generation,control_version,takeover_version)
    values(v_new_outbox,v_org,v_old.account_id,v_old.target_id,'MANUAL',v_actor,
      p_client_operation_id,p_client_operation_id::text,v_payload,v_bytes,v_hash,
      v_old.session_generation,v_old.control_version,v_old.takeover_version);
    v_result:=jsonb_build_object('version',1,'deadLetterId',v_dead.id,
      'newOutboxId',v_new_outbox,'state','QUEUED','payloadHash',v_hash);
  end if;
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_replay_dead_letter_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_DEAD_LETTER_REPLAYED',v_result);
end;
$function$;

create or replace function public.openclaw_resolve_unknown_v1(
  p_request jsonb, p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1());
  v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text;
  v_outbox public.openclaw_outbox%rowtype;
  v_authority jsonb; v_authority_hash text;
  v_resolution_id uuid := gen_random_uuid();
  v_new_outbox_id uuid; v_new_intent_result jsonb;
  v_outcome text := p_request ->> 'outcome';
  v_reason text := p_request ->> 'reasonCode';
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','outboxId','expectedResolutionVersion',
      'expectedEvidenceDomain','expectedEvidenceHash','outcome','reasonCode',
      'operatorEvidenceHash','newIntent'],
    array['version','organizationId','outboxId','expectedResolutionVersion',
      'expectedEvidenceDomain','expectedEvidenceHash','outcome','reasonCode',
      'operatorEvidenceHash']
  );
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org,'openclaw_zalo.manage_operations','xử lý UNKNOWN OpenClaw Zalo');
  v_operation:=app_private.openclaw_begin_client_operation_v1(v_org,v_actor,
    'openclaw_resolve_unknown_v1',p_client_operation_id,p_request);
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then return v_operation->'safeResult'; end if;
  v_request_hash:=v_operation->>'requestHash';
  select outbox.* into strict v_outbox from public.openclaw_outbox outbox
  where outbox.organization_id=v_org and outbox.id=(p_request->>'outboxId')::uuid
  for update;
  if v_outbox.state<>'UNKNOWN' or v_outbox.resolution_version<>0
     or (p_request->>'expectedResolutionVersion')::integer<>0
  then raise exception 'UNKNOWN resolution lost CAS' using errcode='40001'; end if;
  -- Computed by the same helper the browser reads from. Two copies of this hash
  -- would drift into a permanent 40001 that nobody could debug, because the caller
  -- would be echoing a correctly-read value that this side no longer produces.
  v_authority:=app_private.openclaw_unknown_authority_v1(v_org,v_outbox.account_id,v_outbox.id);
  if v_authority is null then
    raise exception 'UNKNOWN resolution lost CAS' using errcode='40001';
  end if;
  v_authority_hash:=v_authority->>'hash';
  if p_request->>'expectedEvidenceDomain'<>'ihome-openclaw-unknown-authority-v1\0'
     or p_request->>'expectedEvidenceHash' is distinct from v_authority_hash
     or (p_request->>'operatorEvidenceHash')!~'^[0-9a-f]{64}$'
  then raise exception 'UNKNOWN authority evidence mismatch' using errcode='40001'; end if;
  if (v_outcome='CONFIRMED_SENT' and v_reason<>'OPERATOR_CONFIRMED_SENT')
     or (v_outcome='CONFIRMED_FAILED' and v_reason<>'OPERATOR_CONFIRMED_FAILED')
     or (v_outcome='NEW_INTENT_CREATED' and v_reason<>'OPERATOR_CREATED_NEW_INTENT')
     or v_outcome not in ('CONFIRMED_SENT','CONFIRMED_FAILED','NEW_INTENT_CREATED')
  then raise exception 'UNKNOWN outcome/reason mismatch' using errcode='22023'; end if;
  update public.openclaw_outbox outbox
  set resolution_version=1,updated_at=statement_timestamp()
  where outbox.organization_id=v_org and outbox.id=v_outbox.id
    and outbox.state='UNKNOWN' and outbox.resolution_version = 0;
  if not found then raise exception 'UNKNOWN resolution concurrent winner' using errcode='40001'; end if;
  if v_outcome='NEW_INTENT_CREATED' then
    perform app_private.openclaw_assert_strict_object_v1(p_request->'newIntent',
      array['clientOperationId','targetId','sourceDraftId','expectedDraftVersion','replyToMessageId'],
      array['clientOperationId','targetId','sourceDraftId','expectedDraftVersion','replyToMessageId']);
    v_new_intent_result:=public.openclaw_create_send_intent_v1(
      jsonb_build_object(
        'version',1,'organizationId',v_org,
        'sourceDraftId',p_request#>>'{newIntent,sourceDraftId}',
        'targetId',p_request#>>'{newIntent,targetId}',
        'expectedDraftVersion',(p_request#>>'{newIntent,expectedDraftVersion}')::bigint,
        'replyToMessageId',p_request#>>'{newIntent,replyToMessageId}'
      ),
      (p_request#>>'{newIntent,clientOperationId}')::uuid
    );
    v_new_outbox_id:=(v_new_intent_result->>'outboxId')::uuid;
    if v_new_outbox_id is null then raise exception 'new UNKNOWN intent was not created' using errcode='40001'; end if;
  elsif p_request ? 'newIntent' and p_request->'newIntent'<>'null'::jsonb then
    raise exception 'newIntent must be null unless NEW_INTENT_CREATED' using errcode='22023';
  end if;
  insert into public.openclaw_unknown_resolutions(
    id,organization_id,account_id,outbox_id,outcome,new_outbox_id,
    authoritative_evidence_domain,authoritative_evidence_hash,operator_evidence_hash,
    reason_code,resolved_by,client_operation_id,request_hash
  ) values (
      v_resolution_id,v_org,v_outbox.account_id,v_outbox.id,v_outcome,v_new_outbox_id,
      p_request->>'expectedEvidenceDomain',v_authority_hash,p_request->>'operatorEvidenceHash',
      v_reason,v_actor,p_client_operation_id,v_request_hash
    );
  v_result:=jsonb_build_object(
    'version',1,'resolutionId',v_resolution_id,'organizationId',v_org,
    'accountId',v_outbox.account_id,'outboxId',v_outbox.id,'resolutionVersion',1,
    'outcome',v_outcome,'newOutboxId',v_new_outbox_id,
    'authoritativeEvidenceDomain',p_request->>'expectedEvidenceDomain',
    'authoritativeEvidenceHash',v_authority_hash,'reasonCode',v_reason,
    'resolvedBy',v_actor,'resolvedAt',statement_timestamp()
  );
  return app_private.openclaw_finish_browser_write_v1(v_org,v_actor,
    'openclaw_resolve_unknown_v1',p_client_operation_id,v_request_hash,
    'OPENCLAW_UNKNOWN_RESOLVED',v_result);
end;
$function$;

create or replace function app_private.openclaw_try_finalize_disconnect_v1(
  p_organization_id uuid,
  p_account_id uuid,
  p_runtime_command_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_state text;
begin
  update public.openclaw_accounts account set
    connection_state='DISCONNECTED',effective_mode='DRAFT_ONLY',updated_at=statement_timestamp()
  from public.openclaw_runtime_commands command
  join public.openclaw_generation_revocations revocation
    on revocation.organization_id=command.organization_id
   and revocation.command_id=command.id
   and revocation.account_id=command.account_id
   and revocation.cell_id=command.cell_id
   and revocation.principal_kind='CHANNEL'
   and revocation.revocation_kind='SESSION'
  where account.organization_id=p_organization_id and account.id=p_account_id
    and command.organization_id=account.organization_id and command.account_id=account.id
    and command.id=p_runtime_command_id and command.command_kind='DISCONNECT'
    and command.state='ACKNOWLEDGED'
    and command.effect_disposition='PROVIDER_CONFIRMED'
    and command.target_session_generation=account.session_generation
    and command.target_connection_generation=account.connection_generation
    and revocation.minimum_valid_generation=command.target_session_generation
    and revocation.acknowledgement_hash is not null and revocation.acknowledged_at is not null
    and account.connection_state in ('DISCONNECTING','DISCONNECTED')
  returning account.connection_state into v_state;
  if v_state is null then
    select account.connection_state into strict v_state
    from public.openclaw_accounts account
    where account.organization_id=p_organization_id and account.id=p_account_id
    for update;
  end if;
  return v_state;
end;
$function$;

create or replace function app_private.openclaw_runtime_heartbeat_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_account uuid := (p_principal->>'accountId')::uuid;
  v_cell uuid := (p_principal->>'cellId')::uuid;
  v_current_session bigint := (p_principal->>'sessionGeneration')::bigint;
  v_local_session bigint := coalesce(
    nullif(p_principal->>'localSessionGeneration','')::bigint,
    (p_principal->>'sessionGeneration')::bigint
  );
  v_auth_mode text := coalesce(p_principal->>'authMode','NORMAL');
  v_observed timestamptz := statement_timestamp();
  v_claim_hash text;
  v_item_claim_hash text;
  v_lease_expires timestamptz;
  v_effect_deadline timestamptz;
  v_current_connection bigint;
  v_existing_count integer := 0;
  v_item jsonb;
  v_command public.openclaw_runtime_commands%rowtype;
  v_result_hash text;
  v_commands jsonb := '[]'::jsonb;
  v_result_acks jsonb := '[]'::jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','commandClaimToken','commandLeaseSeconds','commandStarts','commandResults',
      'severity','healthKind','status','fingerprint','contentFreeMetrics'],
    array['version','commandClaimToken','commandLeaseSeconds','commandStarts','commandResults']
  );
  if p_request->>'version'<>'1'
     or char_length(p_request->>'commandClaimToken') not between 32 and 512
     or coalesce(p_request->>'commandLeaseSeconds','') !~ '^[0-9]+$'
     or (p_request->>'commandLeaseSeconds')::integer not between 5 and 60
     or jsonb_typeof(p_request->'commandStarts')<>'array'
     or jsonb_array_length(p_request->'commandStarts')>8
     or jsonb_typeof(p_request->'commandResults')<>'array'
     or jsonb_array_length(p_request->'commandResults')>8
     or v_auth_mode not in ('NORMAL','COMMAND_TRANSITION')
  then raise exception 'heartbeat command envelope is invalid' using errcode='22023'; end if;

  select account.connection_generation into strict v_current_connection
  from public.openclaw_accounts account
  where account.organization_id=v_org and account.id=v_account
    and account.session_generation=v_current_session
  for update;

  v_claim_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-runtime-command-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'commandClaimToken','UTF8'),'sha256'),'hex');
  select least(lease.expires_at,
    v_observed+make_interval(secs=>(p_request->>'commandLeaseSeconds')::integer))
  into v_lease_expires
  from public.openclaw_runtime_leases lease
  where lease.organization_id=v_org and lease.account_id=v_account and lease.cell_id=v_cell
    and lease.lease_generation=(p_principal->>'leaseGeneration')::bigint
    and lease.fencing_token=(p_principal->>'fencingToken')::bigint
    and lease.status='ACTIVE' and lease.expires_at>v_observed;
  if v_lease_expires is null then
    raise exception 'heartbeat runtime lease is stale' using errcode='42501';
  end if;

  update public.openclaw_runtime_commands command set
    lease_expires_at=v_lease_expires,updated_at=v_observed
  where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
    and command.command_kind in ('QR_LOGIN','DISCONNECT')
    and command.state in ('LEASED','STARTED') and command.claim_token_hash=v_claim_hash
    and command.claim_generation>0
    and command.lease_expires_at<=v_observed+interval '30 seconds'
    and command.source_session_generation=v_local_session
    and command.target_session_generation=v_current_session
    and command.target_connection_generation=v_current_connection
    and command.expected_fencing_token=(p_principal->>'fencingToken')::bigint;

  update public.openclaw_runtime_commands command set
    state='EXPIRED',claim_token_hash=null,lease_expires_at=null,
    effect_disposition='NONE',updated_at=v_observed
  where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
    and command.command_kind='QR_LOGIN' and command.state in ('PENDING','LEASED')
    and exists (
      select 1 from public.openclaw_qr_challenges challenge
      where challenge.organization_id=command.organization_id
        and challenge.runtime_command_id=command.id and challenge.expires_at<=v_observed
    );
  update public.openclaw_runtime_commands command set
    state='PENDING',claim_token_hash=null,lease_expires_at=null,updated_at=v_observed
  where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
    and command.command_kind in ('QR_LOGIN','DISCONNECT') and command.state='LEASED'
    and command.lease_expires_at<=v_observed and command.claim_token_hash<>v_claim_hash;

  for v_item in select item from jsonb_array_elements(p_request->'commandStarts') item loop
    perform app_private.openclaw_assert_strict_object_v1(
      v_item,
      array['version','runtimeCommandId','commandKind','claimGeneration','claimToken','payloadHash'],
      array['version','runtimeCommandId','commandKind','claimGeneration','claimToken','payloadHash']
    );
    if v_item->>'version'<>'1' or v_item->>'commandKind' not in ('QR_LOGIN','DISCONNECT')
       or char_length(v_item->>'claimToken') not between 32 and 512
       or coalesce(v_item->>'payloadHash','') !~ '^[0-9a-f]{64}$'
    then raise exception 'runtime command start is invalid' using errcode='22023'; end if;
    v_item_claim_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-runtime-command-claim-v1','UTF8')||decode('00','hex')
        ||convert_to(v_item->>'claimToken','UTF8'),'sha256'),'hex');
    select command.* into v_command
    from public.openclaw_runtime_commands command
    where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
      and command.id=(v_item->>'runtimeCommandId')::uuid
      and command.command_kind=v_item->>'commandKind'
    for update;
    if not found then raise exception 'runtime command start binding not found' using errcode='40001'; end if;
    if v_command.state='STARTED' then
      if v_command.claim_generation<>(v_item->>'claimGeneration')::bigint
         or v_command.claim_token_hash<>v_item_claim_hash
         or v_command.payload_hash<>v_item->>'payloadHash'
      then raise exception 'runtime command start replay mismatch' using errcode='40001'; end if;
      continue;
    end if;
    if v_command.state<>'LEASED'
       or v_command.claim_generation<>(v_item->>'claimGeneration')::bigint
       or v_command.claim_token_hash<>v_item_claim_hash
       or v_command.payload_hash<>v_item->>'payloadHash'
       or v_command.lease_expires_at<=v_observed+interval '15 seconds'
       or v_command.source_session_generation<>v_local_session
       or v_command.target_session_generation<>v_current_session
       or v_command.target_connection_generation<>v_current_connection
       or v_command.expected_fencing_token<>(p_principal->>'fencingToken')::bigint
       or (v_auth_mode='COMMAND_TRANSITION' and v_command.command_kind<>'DISCONNECT')
    then raise exception 'runtime command start ownership CAS failed' using errcode='40001'; end if;
    v_effect_deadline:=least(
      v_command.lease_expires_at,
      coalesce(nullif(p_envelope->>'exp','')::timestamptz,v_command.lease_expires_at)
    );
    if v_effect_deadline<=v_observed+interval '15 seconds' then
      raise exception 'runtime command effect margin is insufficient' using errcode='40001';
    end if;
    update public.openclaw_runtime_commands command set
      state='STARTED',started_at=v_observed,effect_deadline_at=v_effect_deadline,updated_at=v_observed
    where command.organization_id=v_org and command.id=v_command.id
      and command.state='LEASED' and command.claim_generation=v_command.claim_generation
      and command.claim_token_hash=v_item_claim_hash;
    if not found then raise exception 'runtime command start CAS failed' using errcode='40001'; end if;
  end loop;

  for v_item in select item from jsonb_array_elements(p_request->'commandResults') item loop
    perform app_private.openclaw_assert_strict_object_v1(
      v_item,
      array['version','runtimeCommandId','commandKind','claimGeneration','claimToken','outcome','result'],
      array['version','runtimeCommandId','commandKind','claimGeneration','claimToken','outcome','result']
    );
    if v_item->>'version'<>'1' or v_item->>'commandKind' not in ('QR_LOGIN','DISCONNECT')
       or v_item->>'outcome' not in ('PROVIDER_LOGGED_OUT','FAILED')
       or char_length(v_item->>'claimToken') not between 32 and 512
       or (v_item->>'outcome'='PROVIDER_LOGGED_OUT' and v_item->>'commandKind'<>'DISCONNECT')
    then raise exception 'heartbeat command result is invalid' using errcode='22023'; end if;
    if v_item->>'outcome'='PROVIDER_LOGGED_OUT' then
      perform app_private.openclaw_assert_strict_object_v1(
        v_item->'result',
        array['version','revocationId','revokedSessionGeneration','minimumSessionGeneration',
          'channel','accountId','credentialsCleared','loggedOut','status'],
        array['version','revocationId','revokedSessionGeneration','minimumSessionGeneration',
          'channel','accountId','credentialsCleared','loggedOut','status']
      );
      if v_item->'result'->>'version'<>'1'
         or v_item->'result'->>'channel'<>'zalouser'
         or (v_item->'result'->>'accountId')::uuid<>v_account
         or (v_item->'result'->>'credentialsCleared')::boolean
         or not (v_item->'result'->>'loggedOut')::boolean
         or v_item->'result'->>'status'<>'PROVIDER_LOGGED_OUT'
      then raise exception 'disconnect provider result is invalid' using errcode='22023'; end if;
    else
      perform app_private.openclaw_assert_strict_object_v1(
        v_item->'result',array['version','reasonCode','failureFingerprint','status'],
        array['version','reasonCode','failureFingerprint','status']
      );
      if v_item->'result'->>'version'<>'1'
         or v_item->'result'->>'status'<>'FAILED_BEFORE_START'
         or coalesce(v_item->'result'->>'reasonCode','') !~ '^[A-Z][A-Z0-9_]{1,63}$'
         or coalesce(v_item->'result'->>'failureFingerprint','') !~ '^[0-9a-f]{64}$'
      then raise exception 'failed command result is invalid' using errcode='22023'; end if;
    end if;
    v_item_claim_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-runtime-command-claim-v1','UTF8')||decode('00','hex')
        ||convert_to(v_item->>'claimToken','UTF8'),'sha256'),'hex');
    v_result_hash:=encode(extensions.digest(
      app_private.openclaw_jcs_bytes_v1(v_item->'result'),'sha256'),'hex');
    select command.* into v_command
    from public.openclaw_runtime_commands command
    where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
      and command.id=(v_item->>'runtimeCommandId')::uuid
      and command.command_kind=v_item->>'commandKind'
    for update;
    if not found then raise exception 'runtime command result binding not found' using errcode='40001'; end if;
    if v_command.state in ('ACKNOWLEDGED','FAILED') then
      if v_command.completion_claim_generation<>(v_item->>'claimGeneration')::bigint
         or v_command.completion_claim_token_hash<>v_item_claim_hash
         or v_command.result_hash<>v_result_hash
         or v_command.result is distinct from v_item->'result'
      then raise exception 'runtime command result replay mismatch' using errcode='40001'; end if;
    else
      if v_command.claim_generation<>(v_item->>'claimGeneration')::bigint
         or v_command.claim_token_hash<>v_item_claim_hash
         or v_command.source_session_generation<>v_local_session
         or v_command.target_session_generation<>v_current_session
         or v_command.target_connection_generation<>v_current_connection
         or v_command.expected_fencing_token<>(p_principal->>'fencingToken')::bigint
      then raise exception 'runtime command result ownership CAS failed' using errcode='40001'; end if;
      if v_item->>'outcome'='PROVIDER_LOGGED_OUT' then
        if v_command.state<>'STARTED'
           or v_command.payload->>'revocationId' is distinct from v_item->'result'->>'revocationId'
           or v_command.payload->'revokedSessionGeneration' is distinct from
             v_item->'result'->'revokedSessionGeneration'
           or v_command.payload->'minimumSessionGeneration' is distinct from
             v_item->'result'->'minimumSessionGeneration'
        then raise exception 'disconnect provider result payload mismatch' using errcode='40001'; end if;
        update public.openclaw_runtime_commands command set
          state='ACKNOWLEDGED',claim_token_hash=null,lease_expires_at=null,
          result=v_item->'result',result_hash=v_result_hash,
          completion_claim_token_hash=v_item_claim_hash,
          completion_claim_generation=(v_item->>'claimGeneration')::bigint,
          effect_disposition='PROVIDER_CONFIRMED',acknowledged_at=v_observed,updated_at=v_observed
        where command.organization_id=v_org and command.id=v_command.id
          and command.state='STARTED' and command.claim_generation=v_command.claim_generation
          and command.claim_token_hash=v_item_claim_hash;
        if not found then raise exception 'disconnect provider result CAS failed' using errcode='40001'; end if;
        perform app_private.openclaw_try_finalize_disconnect_v1(v_org,v_account,v_command.id);
      else
        if v_command.state<>'LEASED' or v_command.started_at is not null then
          raise exception 'started command cannot be failed without reconciliation' using errcode='40001';
        end if;
        update public.openclaw_runtime_commands command set
          state='FAILED',claim_token_hash=null,lease_expires_at=null,
          result=v_item->'result',result_hash=v_result_hash,
          completion_claim_token_hash=v_item_claim_hash,
          completion_claim_generation=(v_item->>'claimGeneration')::bigint,
          effect_disposition='NONE',updated_at=v_observed
        where command.organization_id=v_org and command.id=v_command.id
          and command.state='LEASED' and command.claim_generation=v_command.claim_generation
          and command.claim_token_hash=v_item_claim_hash;
        if not found then raise exception 'runtime command failure CAS failed' using errcode='40001'; end if;
      end if;
    end if;
    v_result_acks:=v_result_acks||jsonb_build_array(jsonb_build_object(
      'version',1,'runtimeCommandId',v_command.id,'commandKind',v_command.command_kind,
      'claimGeneration',(v_item->>'claimGeneration')::bigint,'outcome',v_item->>'outcome',
      'resultHash',v_result_hash,
      'adoptSessionGeneration',case when v_item->>'outcome'='PROVIDER_LOGGED_OUT'
        then v_command.target_session_generation else null end,
      'status','ACCEPTED'
    ));
  end loop;

  select count(*)::integer into v_existing_count
  from public.openclaw_runtime_commands command
  where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
    and command.command_kind in ('QR_LOGIN','DISCONNECT')
    and command.state in ('LEASED','STARTED') and command.claim_token_hash=v_claim_hash
    and command.source_session_generation=v_local_session
    and command.target_session_generation=v_current_session
    and command.target_connection_generation=v_current_connection
    and command.expected_fencing_token=(p_principal->>'fencingToken')::bigint
    and (v_auth_mode='NORMAL' or command.command_kind='DISCONNECT');
  with candidates as (
    select command.id from public.openclaw_runtime_commands command
    where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
      and command.command_kind in ('QR_LOGIN','DISCONNECT') and command.state='PENDING'
      and command.source_session_generation=v_local_session
      and command.target_session_generation=v_current_session
      and command.target_connection_generation=v_current_connection
      and command.expected_fencing_token=(p_principal->>'fencingToken')::bigint
      and (v_auth_mode='NORMAL' or command.command_kind='DISCONNECT')
    order by command.created_at,command.id for update skip locked
    limit greatest(0,8-v_existing_count)
  )
  update public.openclaw_runtime_commands command set
    state='LEASED',claim_token_hash=v_claim_hash,
    claim_generation=command.claim_generation+1,lease_expires_at=v_lease_expires,
    updated_at=v_observed
  from candidates where command.organization_id=v_org and command.id=candidates.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'version',1,'runtimeCommandId',command.id,'commandKind',command.command_kind,
    'commandVersion',command.command_version,'claimGeneration',command.claim_generation,
    'claimToken',p_request->>'commandClaimToken','leaseExpiresAt',command.lease_expires_at,
    'sourceSessionGeneration',command.source_session_generation,
    'targetSessionGeneration',command.target_session_generation,
    'sourceConnectionGeneration',command.source_connection_generation,
    'targetConnectionGeneration',command.target_connection_generation,
    'expectedFencingToken',command.expected_fencing_token,
    'executionState',command.state,'effectDeadlineAt',command.effect_deadline_at,
    'payload',command.payload,'payloadHash',command.payload_hash
  ) order by command.created_at,command.id),'[]'::jsonb) into v_commands
  from public.openclaw_runtime_commands command
  where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
    and command.command_kind in ('QR_LOGIN','DISCONNECT')
    and command.state in ('LEASED','STARTED') and command.claim_token_hash=v_claim_hash
    and command.source_session_generation=v_local_session
    and command.target_session_generation=v_current_session
    and command.target_connection_generation=v_current_connection
    and command.expected_fencing_token=(p_principal->>'fencingToken')::bigint
    and (v_auth_mode='NORMAL' or command.command_kind='DISCONNECT');
  update public.openclaw_runtime_cells set last_heartbeat_at=v_observed,state='READY'
  where organization_id=v_org and account_id=v_account and id=v_cell and is_current;
  if not found then raise exception 'heartbeat cell is not current' using errcode='40001'; end if;
  insert into public.openclaw_health_events(organization_id,account_id,cell_id,severity,
    health_kind,status,fingerprint,content_free_metrics,observed_at)
  values(v_org,v_account,v_cell,coalesce(p_request->>'severity','INFO'),
    coalesce(p_request->>'healthKind','RUNTIME_HEARTBEAT'),coalesce(p_request->>'status','RECOVERED'),
    coalesce(p_request->>'fingerprint','runtime-heartbeat'),
    coalesce(p_request->'contentFreeMetrics','{}'::jsonb),v_observed);
  return jsonb_build_object('version',1,'organizationId',v_org,'accountId',v_account,
    'cellId',v_cell,'observedAt',v_observed,'accepted',true,'authMode',v_auth_mode,
    'currentSessionGeneration',v_current_session,
    'currentConnectionGeneration',v_current_connection,
    'commandResultAcks',v_result_acks,'commands',v_commands);
end;
$function$;

create or replace function app_private.openclaw_exchange_runtime_credential_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_org uuid;
  v_account uuid;
  v_cell uuid;
  v_iat timestamptz;
  v_exp timestamptz;
  v_request_hash text;
  v_requested_operation text;
  v_expected_requested_operation text;
  v_runtime_timestamp bigint;
  v_local_session_generation bigint;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_principal,
    array['version','principalKind','organizationId','accountId','cellId'],
    array['version','principalKind','organizationId','accountId','cellId']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    p_envelope,
    array['version','operation','nonce','iat','exp','requestHash'],
    array['version','operation','nonce','iat','exp','requestHash']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','credentialProofSha256','requestedOperation','runtimeMethod',
      'runtimePath','runtimeTimestamp','runtimeNonce','runtimeBodySha256','localSessionGeneration'],
    array['version','credentialProofSha256','requestedOperation','runtimeMethod',
      'runtimePath','runtimeTimestamp','runtimeNonce','runtimeBodySha256','localSessionGeneration']
  );

  if p_principal -> 'version' is distinct from '1'::jsonb
     or p_principal ->> 'principalKind' is distinct from 'CHANNEL'
     or jsonb_typeof(p_principal -> 'organizationId') <> 'string'
     or jsonb_typeof(p_principal -> 'accountId') <> 'string'
     or jsonb_typeof(p_principal -> 'cellId') <> 'string'
     or p_principal ->> 'organizationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_principal ->> 'accountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_principal ->> 'cellId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_envelope -> 'version' is distinct from '1'::jsonb
     or p_envelope ->> 'operation' is distinct from 'openclaw_exchange_runtime_credential_v1'
     or jsonb_typeof(p_envelope -> 'nonce') <> 'string'
     or p_envelope ->> 'nonce' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_envelope -> 'iat') <> 'string'
     or jsonb_typeof(p_envelope -> 'exp') <> 'string'
     or jsonb_typeof(p_envelope -> 'requestHash') <> 'string'
     or p_envelope ->> 'requestHash' !~ '^[0-9a-f]{64}$'
     or p_request -> 'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_request -> 'credentialProofSha256') <> 'string'
     or p_request ->> 'credentialProofSha256' !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_request -> 'requestedOperation') <> 'string'
     or p_request ->> 'runtimeMethod' is distinct from 'POST'
     or jsonb_typeof(p_request -> 'runtimePath') <> 'string'
     or p_request ->> 'runtimePath' ~ '[?#]'
     or jsonb_typeof(p_request -> 'runtimeTimestamp') <> 'number'
     or p_request ->> 'runtimeTimestamp' !~ '^(0|[1-9][0-9]*)$'
     or jsonb_typeof(p_request -> 'runtimeNonce') <> 'string'
     or p_request ->> 'runtimeNonce' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_request ->> 'runtimeNonce' = p_envelope ->> 'nonce'
     or jsonb_typeof(p_request -> 'runtimeBodySha256') <> 'string'
     or p_request ->> 'runtimeBodySha256' !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_request -> 'localSessionGeneration') <> 'number'
     or p_request ->> 'localSessionGeneration' !~ '^[1-9][0-9]*$'
  then
    raise exception 'credential exchange request invalid' using errcode = '22023';
  end if;

  v_requested_operation := p_request ->> 'requestedOperation';
  v_expected_requested_operation := case p_request ->> 'runtimePath'
    when '/v1/heartbeat' then 'heartbeat'
    when '/v1/qr/publish' then 'qr.publish'
    when '/v1/qr/result' then 'qr.result'
    when '/v1/inbound/batch' then 'inbound.commit'
    when '/v1/outbox/claim' then 'outbox.claim'
    when '/v1/outbox/preflight' then 'outbox.preflight'
    when '/v1/outbox/authorize-send' then 'outbox.authorize-send'
    when '/v1/outbox/requeue' then 'outbox.requeue'
    when '/v1/outbox/complete' then 'outbox.complete'
    when '/v1/work/claim' then 'work.claim'
    when '/v1/work/context' then 'work.context'
    when '/v1/work/complete' then 'work.complete'
    when '/v1/work/create-outbox' then 'work.complete'
    when '/v1/media/upload-ticket' then 'media.issue'
    when '/v1/media/upload-complete' then 'media.issue'
    else null
  end;
  if v_requested_operation is distinct from v_expected_requested_operation then
    raise exception 'credential exchange request invalid' using errcode = '22023';
  end if;

  begin
    v_org := (p_principal ->> 'organizationId')::uuid;
    v_account := (p_principal ->> 'accountId')::uuid;
    v_cell := (p_principal ->> 'cellId')::uuid;
    v_iat := (p_envelope ->> 'iat')::timestamptz;
    v_exp := (p_envelope ->> 'exp')::timestamptz;
    v_runtime_timestamp := (p_request ->> 'runtimeTimestamp')::bigint;
    v_local_session_generation := (p_request ->> 'localSessionGeneration')::bigint;
  exception when others then
    raise exception 'credential exchange request invalid' using errcode = '22023';
  end;

  v_request_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-service-request-v1', 'UTF8')
      || decode('00', 'hex')
      || convert_to('openclaw_exchange_runtime_credential_v1', 'UTF8')
      || decode('00', 'hex')
      || app_private.openclaw_jcs_bytes_v1(p_request),
    'sha256'
  ), 'hex');
  if p_envelope ->> 'requestHash' is distinct from v_request_hash
     or v_exp <= v_iat
     or v_exp > v_iat + interval '5 minutes'
     or v_now >= v_exp
     or abs(extract(epoch from (v_now - v_iat))) > 60
     or v_runtime_timestamp > 9007199254740991
     or abs(extract(epoch from v_now)::numeric - v_runtime_timestamp::numeric) > 60
  then
    raise exception 'credential exchange denied' using errcode = '42501';
  end if;

  select jsonb_build_object('version',1,'principalKind','CHANNEL',
    'organizationId',credential.organization_id,'accountId',credential.account_id,
    'cellId',credential.cell_id,
    'credentialGeneration',credential.credential_generation::text,
    'leaseGeneration',lease.lease_generation::text,
    'fencingToken',lease.fencing_token::text,
    'sessionGeneration',account.session_generation::text,
    'localSessionGeneration',v_local_session_generation::text,
    'authMode',case when v_local_session_generation=account.session_generation
      then 'NORMAL' else 'COMMAND_TRANSITION' end,
    'requestedOperation',v_requested_operation,
    'runtimeMethod',p_request->>'runtimeMethod',
    'runtimePath',p_request->>'runtimePath',
    'runtimeTimestamp',v_runtime_timestamp,
    'runtimeNonce',p_request->>'runtimeNonce',
    'runtimeBodySha256',p_request->>'runtimeBodySha256',
    'exchangeNonce',p_envelope->>'nonce',
    'exchangeRequestHash',v_request_hash,
    'authenticatedAt',v_now,'leaseExpiresAt',lease.expires_at,
    'operation','openclaw_exchange_runtime_credential_v1','scope','credential.exchange',
    'requestHash',v_request_hash,'iat',v_iat,'exp',v_exp,
    'nonce',p_envelope ->> 'nonce')
  into v_result
  from public.openclaw_runtime_credentials credential
  join public.openclaw_runtime_cells cell
    on cell.organization_id=credential.organization_id
   and cell.account_id=credential.account_id and cell.id=credential.cell_id
  join public.openclaw_runtime_leases lease
    on lease.organization_id=credential.organization_id and lease.account_id=credential.account_id
   and lease.cell_id=credential.cell_id and lease.status='ACTIVE'
  join public.openclaw_accounts account
    on account.organization_id=credential.organization_id and account.id=credential.account_id
  where credential.organization_id=v_org and credential.account_id=v_account
    and credential.cell_id=v_cell
    and credential.enabled_at<=v_now and credential.revoked_at is null
    and 'credential.exchange'=any(credential.allowed_scopes)
    and v_requested_operation=any(credential.allowed_scopes)
    and app_private.openclaw_secure_digest_equal_v1(
      credential.credential_hash,p_request->>'credentialProofSha256')
    and cell.is_current and cell.state='READY'
    and lease.expires_at>v_now
    and account.is_active
    and (
      v_local_session_generation=account.session_generation
      or (
        v_requested_operation='heartbeat'
        and p_request->>'runtimePath'='/v1/heartbeat'
        and account.connection_state='DISCONNECTING'
        and account.session_generation=v_local_session_generation+1
        and exists (
          select 1
          from public.openclaw_runtime_commands command
          where command.organization_id=account.organization_id
            and command.account_id=account.id
            and command.cell_id=cell.id
            and command.command_kind='DISCONNECT'
            and command.source_session_generation=v_local_session_generation
            and command.target_session_generation=account.session_generation
            and command.source_connection_generation+1=command.target_connection_generation
            and command.target_connection_generation=account.connection_generation
            and command.expected_fencing_token=lease.fencing_token
            and command.state in ('PENDING','LEASED','STARTED')
        )
      )
    )
  for share of credential,cell,lease,account;
  if v_result is null then
    raise exception 'credential exchange denied' using errcode = '42501';
  end if;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_exchange_maintenance_credential_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_org uuid;
  v_maintenance uuid;
  v_iat timestamptz;
  v_exp timestamptz;
  v_request_hash text;
  v_requested_operation text;
  v_expected_requested_operation text;
  v_runtime_timestamp bigint;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_principal,
    array['version','principalKind','organizationId','maintenancePrincipalId'],
    array['version','principalKind','organizationId','maintenancePrincipalId']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    p_envelope,
    array['version','operation','nonce','iat','exp','requestHash'],
    array['version','operation','nonce','iat','exp','requestHash']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','credentialProofSha256','requestedOperation','runtimeMethod',
      'runtimePath','runtimeTimestamp','runtimeNonce','runtimeBodySha256'],
    array['version','credentialProofSha256','requestedOperation','runtimeMethod',
      'runtimePath','runtimeTimestamp','runtimeNonce','runtimeBodySha256']
  );

  if p_principal -> 'version' is distinct from '1'::jsonb
     or p_principal ->> 'principalKind' is distinct from 'MAINTENANCE'
     or jsonb_typeof(p_principal -> 'organizationId') <> 'string'
     or jsonb_typeof(p_principal -> 'maintenancePrincipalId') <> 'string'
     or p_principal ->> 'organizationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_principal ->> 'maintenancePrincipalId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_envelope -> 'version' is distinct from '1'::jsonb
     or p_envelope ->> 'operation' is distinct from 'openclaw_exchange_maintenance_credential_v1'
     or jsonb_typeof(p_envelope -> 'nonce') <> 'string'
     or p_envelope ->> 'nonce' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_envelope -> 'iat') <> 'string'
     or jsonb_typeof(p_envelope -> 'exp') <> 'string'
     or jsonb_typeof(p_envelope -> 'requestHash') <> 'string'
     or p_envelope ->> 'requestHash' !~ '^[0-9a-f]{64}$'
     or p_request -> 'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_request -> 'credentialProofSha256') <> 'string'
     or p_request ->> 'credentialProofSha256' !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_request -> 'requestedOperation') <> 'string'
     or p_request ->> 'runtimeMethod' is distinct from 'POST'
     or jsonb_typeof(p_request -> 'runtimePath') <> 'string'
     or p_request ->> 'runtimePath' ~ '[?#]'
     or jsonb_typeof(p_request -> 'runtimeTimestamp') <> 'number'
     or p_request ->> 'runtimeTimestamp' !~ '^(0|[1-9][0-9]*)$'
     or jsonb_typeof(p_request -> 'runtimeNonce') <> 'string'
     or p_request ->> 'runtimeNonce' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_request ->> 'runtimeNonce' = p_envelope ->> 'nonce'
     or jsonb_typeof(p_request -> 'runtimeBodySha256') <> 'string'
     or p_request ->> 'runtimeBodySha256' !~ '^[0-9a-f]{64}$'
  then
    raise exception 'credential exchange request invalid' using errcode = '22023';
  end if;

  v_requested_operation := p_request ->> 'requestedOperation';
  v_expected_requested_operation := case p_request ->> 'runtimePath'
    when '/v1/maintenance/work/claim' then 'maintenance.claim'
    when '/v1/maintenance/work/complete' then 'maintenance.complete'
    when '/v1/maintenance/media/upload-ticket' then 'maintenance.complete'
    when '/v1/maintenance/media/verify-ticket' then 'maintenance.complete'
    when '/v1/maintenance/retention/delete-ticket' then 'maintenance.complete'
    when '/v1/maintenance/retention/authorize-delete' then 'maintenance.complete'
    else null
  end;
  if v_requested_operation is distinct from v_expected_requested_operation then
    raise exception 'credential exchange request invalid' using errcode = '22023';
  end if;

  begin
    v_org := (p_principal ->> 'organizationId')::uuid;
    v_maintenance := (p_principal ->> 'maintenancePrincipalId')::uuid;
    v_iat := (p_envelope ->> 'iat')::timestamptz;
    v_exp := (p_envelope ->> 'exp')::timestamptz;
    v_runtime_timestamp := (p_request ->> 'runtimeTimestamp')::bigint;
  exception when others then
    raise exception 'credential exchange request invalid' using errcode = '22023';
  end;

  v_request_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-service-request-v1', 'UTF8')
      || decode('00', 'hex')
      || convert_to('openclaw_exchange_maintenance_credential_v1', 'UTF8')
      || decode('00', 'hex')
      || app_private.openclaw_jcs_bytes_v1(p_request),
    'sha256'
  ), 'hex');
  if p_envelope ->> 'requestHash' is distinct from v_request_hash
     or v_exp <= v_iat
     or v_exp > v_iat + interval '5 minutes'
     or v_now >= v_exp
     or abs(extract(epoch from (v_now - v_iat))) > 60
     or v_runtime_timestamp > 9007199254740991
     or abs(extract(epoch from v_now)::numeric - v_runtime_timestamp::numeric) > 60
  then
    raise exception 'credential exchange denied' using errcode = '42501';
  end if;

  select jsonb_build_object('version',1,'principalKind','MAINTENANCE',
    'organizationId',credential.organization_id,
    'maintenancePrincipalId',credential.maintenance_principal_id,
    'credentialGeneration',credential.credential_generation::text,
    'leaseGeneration',lease.lease_generation::text,
    'fencingToken',lease.fencing_token::text,
    'requestedOperation',v_requested_operation,
    'runtimeMethod',p_request->>'runtimeMethod',
    'runtimePath',p_request->>'runtimePath',
    'runtimeTimestamp',v_runtime_timestamp,
    'runtimeNonce',p_request->>'runtimeNonce',
    'runtimeBodySha256',p_request->>'runtimeBodySha256',
    'exchangeNonce',p_envelope->>'nonce',
    'exchangeRequestHash',v_request_hash,
    'authenticatedAt',v_now,'leaseExpiresAt',lease.expires_at,
    'operation','openclaw_exchange_maintenance_credential_v1',
    'scope','maintenance.exchange','requestHash',v_request_hash,
    'iat',v_iat,'exp',v_exp,'nonce',p_envelope ->> 'nonce')
  into v_result
  from public.openclaw_maintenance_credentials credential
  join public.openclaw_maintenance_principals principal
    on principal.organization_id=credential.organization_id
   and principal.id=credential.maintenance_principal_id
  join public.openclaw_maintenance_leases lease
    on lease.organization_id=credential.organization_id
   and lease.maintenance_principal_id=credential.maintenance_principal_id
   and lease.status='ACTIVE'
  where credential.organization_id=v_org and credential.maintenance_principal_id=v_maintenance
    and credential.enabled_at<=v_now and credential.revoked_at is null
    and 'maintenance.exchange'=any(credential.allowed_scopes)
    and v_requested_operation=any(credential.allowed_scopes)
    and app_private.openclaw_secure_digest_equal_v1(
      credential.credential_hash,p_request->>'credentialProofSha256')
    and principal.is_current and principal.revoked_at is null
    and lease.expires_at>v_now
  for share of credential,principal,lease;
  if v_result is null then
    raise exception 'credential exchange denied' using errcode = '42501';
  end if;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_submit_qr_result_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_org uuid:=(p_principal->>'organizationId')::uuid;
  v_account uuid:=(p_principal->>'accountId')::uuid;
  v_cell uuid:=(p_principal->>'cellId')::uuid;
  v_challenge public.openclaw_qr_challenges%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_ciphertext bytea;
  v_iv bytea;
  v_tag bytea;
  v_result jsonb;
  v_result_hash text;
  v_claim_hash text;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','challengeId','runtimeCommandId','claimGeneration','claimToken',
      'ciphertextB64','cipherIvB64','authTagB64'],
    array['version','challengeId','runtimeCommandId','claimGeneration','claimToken',
      'ciphertextB64','cipherIvB64','authTagB64']
  );
  if p_request->>'version'<>'1' or char_length(p_request->>'claimToken') not between 32 and 512 then
    raise exception 'QR result version mismatch' using errcode='22023';
  end if;
  v_claim_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-runtime-command-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  begin
    v_ciphertext:=decode(p_request->>'ciphertextB64','base64');
    v_iv:=decode(p_request->>'cipherIvB64','base64');
    v_tag:=decode(p_request->>'authTagB64','base64');
  exception when others then
    raise exception 'QR result ciphertext encoding is invalid' using errcode='22023';
  end;
  if octet_length(v_ciphertext) not between 1 and 1048576
     or octet_length(v_iv)<>12 or octet_length(v_tag)<>16 then
    raise exception 'QR result ciphertext bounds are invalid' using errcode='22023';
  end if;
  select challenge.* into v_challenge from public.openclaw_qr_challenges challenge
  where challenge.organization_id=v_org and challenge.account_id=v_account
    and challenge.cell_id=v_cell and challenge.id=(p_request->>'challengeId')::uuid
    and challenge.runtime_command_id=(p_request->>'runtimeCommandId')::uuid
    and challenge.active_slot and challenge.challenge_status='PENDING'
    and challenge.expires_at>v_now for update;
  if not found then
    raise exception 'QR challenge is not available for publication' using errcode='40001';
  end if;
  v_result:=jsonb_build_object(
    'version',1,'challengeId',v_challenge.id,'materialVersion',1
  );
  v_result_hash:=encode(extensions.digest(
    app_private.openclaw_jcs_bytes_v1(v_result),'sha256'
  ),'hex');
  if v_challenge.material_version=1 then
    if v_challenge.ciphertext is distinct from v_ciphertext
       or v_challenge.cipher_iv is distinct from v_iv
       or v_challenge.auth_tag is distinct from v_tag
       or v_challenge.material_published_at is null
       or not exists (
         select 1 from public.openclaw_runtime_commands command
         where command.organization_id=v_org and command.id=v_challenge.runtime_command_id
           and command.account_id=v_account and command.cell_id=v_cell
           and command.expected_session_generation=(p_principal->>'sessionGeneration')::bigint
            and command.expected_fencing_token=(p_principal->>'fencingToken')::bigint
            and command.state='ACKNOWLEDGED' and command.result=v_result
            and command.result_hash=v_result_hash
            and command.completion_claim_generation=(p_request->>'claimGeneration')::bigint
            and command.completion_claim_token_hash=v_claim_hash
       ) then
      raise exception 'QR result publication replay mismatch' using errcode='40001';
    end if;
    return jsonb_build_object('version',1,'challengeId',v_challenge.id,
      'materialVersion',1,'publishedAt',v_challenge.material_published_at,'accepted',true);
  end if;
  if v_challenge.material_version<>0 then
    raise exception 'QR material version is invalid' using errcode='40001';
  end if;
  update public.openclaw_qr_challenges set
    ciphertext=v_ciphertext,
    cipher_iv=v_iv,
    auth_tag=v_tag,
    material_version=1,material_published_at=v_now
  where organization_id=v_org and id=v_challenge.id and material_version=0;
  if not found then
    raise exception 'QR material publication CAS failed' using errcode='40001';
  end if;
  update public.openclaw_runtime_commands set state='ACKNOWLEDGED',
    claim_token_hash=null,lease_expires_at=null,
    result=v_result,result_hash=v_result_hash,
    completion_claim_token_hash=v_claim_hash,
    completion_claim_generation=(p_request->>'claimGeneration')::bigint,
    effect_disposition='PROVIDER_CONFIRMED',acknowledged_at=v_now,updated_at=v_now
  where organization_id=v_org and id=v_challenge.runtime_command_id
    and account_id=v_account and cell_id=v_cell
    and source_session_generation=(p_principal->>'localSessionGeneration')::bigint
    and target_session_generation=(p_principal->>'sessionGeneration')::bigint
    and expected_fencing_token=(p_principal->>'fencingToken')::bigint
    and state='STARTED' and claim_generation=(p_request->>'claimGeneration')::bigint
    and claim_token_hash=v_claim_hash;
  if not found then raise exception 'QR runtime command acknowledgement CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'challengeId',v_challenge.id,
    'materialVersion',1,'publishedAt',v_now,'accepted',true);
end;
$function$;

create or replace function app_private.openclaw_acquire_cell_lease_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_org uuid:=(p_principal->>'organizationId')::uuid;
  v_account uuid:=(p_principal->>'accountId')::uuid;
  v_cell uuid:=(p_principal->>'cellId')::uuid;
  v_generation bigint; v_fencing bigint; v_id uuid:=gen_random_uuid(); v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_org::text||':'||v_account::text,0));
  select coalesce(max(lease.lease_generation),0)+1,coalesce(max(lease.fencing_token),0)+1
  into v_generation,v_fencing from public.openclaw_runtime_leases lease
  where lease.organization_id=v_org and lease.account_id=v_account;
  update public.openclaw_runtime_leases set status='REVOKED',released_at=statement_timestamp()
  where organization_id=v_org and account_id=v_account and status='ACTIVE';
  v_expires:=statement_timestamp()+least(
    coalesce((p_request->>'ttlSeconds')::integer,60),300)*interval '1 second';
  insert into public.openclaw_runtime_leases(id,organization_id,account_id,cell_id,
    lease_generation,fencing_token,status,acquired_at,expires_at)
  values(v_id,v_org,v_account,v_cell,v_generation,v_fencing,'ACTIVE',statement_timestamp(),v_expires);
  return jsonb_build_object('version',1,'leaseId',v_id,'leaseGeneration',v_generation,
    'fencingToken',v_fencing,'expiresAt',v_expires);
end;
$function$;

create or replace function app_private.openclaw_begin_cell_rebind_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_org uuid:=(p_principal->>'organizationId')::uuid;
  v_account uuid:=(p_principal->>'accountId')::uuid;
  v_old uuid:=(p_request->>'oldCellId')::uuid; v_new uuid:=(p_request->>'newCellId')::uuid;
  v_old_lease public.openclaw_runtime_leases%rowtype;
  v_new_lease public.openclaw_runtime_leases%rowtype;
  v_generation bigint; v_command uuid:=gen_random_uuid(); v_rebind uuid:=gen_random_uuid();
  v_payload jsonb; v_bytes bytea;
begin
  select lease.* into strict v_old_lease from public.openclaw_runtime_leases lease
  where lease.organization_id=v_org and lease.account_id=v_account and lease.cell_id=v_old
  order by lease.lease_generation desc limit 1 for update;
  select lease.* into strict v_new_lease from public.openclaw_runtime_leases lease
  where lease.organization_id=v_org and lease.account_id=v_account and lease.cell_id=v_new
    and lease.status='ACTIVE' and lease.expires_at>statement_timestamp() for update;
  select coalesce(max(rebind.rebind_generation),0)+1 into v_generation
  from public.openclaw_cell_rebinds rebind where rebind.organization_id=v_org and rebind.account_id=v_account;
  v_payload:=jsonb_build_object('version',1,'oldCellId',v_old,'newCellId',v_new,
    'rebindGeneration',v_generation); v_bytes:=app_private.openclaw_jcs_bytes_v1(v_payload);
  insert into public.openclaw_runtime_commands(id,organization_id,account_id,cell_id,
    command_key,command_kind,source_session_generation,target_session_generation,
    source_connection_generation,target_connection_generation,
    expected_session_generation,expected_connection_generation,
    expected_fencing_token,payload,payload_bytes,payload_hash)
  select v_command,v_org,v_account,v_new,'rebind:'||v_generation::text,'CELL_REBIND',
    account.session_generation,account.session_generation,
    account.connection_generation,account.connection_generation,
    account.session_generation,account.connection_generation,v_new_lease.fencing_token,
    v_payload,v_bytes,encode(extensions.digest(v_bytes,'sha256'),'hex')
  from public.openclaw_accounts account where account.organization_id=v_org and account.id=v_account;
  insert into public.openclaw_cell_rebinds(id,organization_id,account_id,old_cell_id,new_cell_id,
    runtime_command_id,rebind_generation,expected_session_generation,old_lease_generation,
    old_fencing_token,new_lease_generation,new_fencing_token)
  select v_rebind,v_org,v_account,v_old,v_new,v_command,v_generation,account.session_generation,
    v_old_lease.lease_generation,v_old_lease.fencing_token,
    v_new_lease.lease_generation,v_new_lease.fencing_token
  from public.openclaw_accounts account where account.organization_id=v_org and account.id=v_account;
  return jsonb_build_object('version',1,'rebindId',v_rebind,'runtimeCommandId',v_command,
    'rebindGeneration',v_generation,'status','PREPARED');
end;
$function$;

create or replace function app_private.openclaw_complete_cell_rebind_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_org uuid:=(p_principal->>'organizationId')::uuid;
  v_rebind public.openclaw_cell_rebinds%rowtype; v_revocation uuid:=gen_random_uuid();
  v_command_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,array['version','rebindId'],array['version','rebindId']
  );
  if p_request->'version' is distinct from '1'::jsonb
     or p_request->>'rebindId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'cell rebind completion request invalid' using errcode='22023'; end if;
  select rebind.* into strict v_rebind from public.openclaw_cell_rebinds rebind
  where rebind.organization_id=v_org and rebind.id=(p_request->>'rebindId')::uuid
    and rebind.account_id=(p_principal->>'accountId')::uuid
    and rebind.old_cell_id=(p_principal->>'cellId')::uuid
    and rebind.old_fencing_token=(p_principal->>'fencingToken')::bigint
    and rebind.expected_session_generation=(p_principal->>'sessionGeneration')::bigint
    and rebind.status='PREPARED' for update;
  perform 1 from public.openclaw_accounts account
  where account.organization_id=v_org and account.id=v_rebind.account_id
    and account.session_generation=v_rebind.expected_session_generation
  for update;
  if not found then raise exception 'cell rebind account generation CAS failed' using errcode='40001'; end if;
  v_command_result:=jsonb_build_object(
    'version',1,'rebindId',v_rebind.id,'status','ACKNOWLEDGED'
  );
  update public.openclaw_runtime_commands command set
    state='ACKNOWLEDGED',claim_token_hash=null,lease_expires_at=null,
    result=v_command_result,
    result_hash=encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_command_result),'sha256'),'hex'),
    acknowledged_at=statement_timestamp(),updated_at=statement_timestamp()
  where command.organization_id=v_org and command.id=v_rebind.runtime_command_id
    and command.account_id=v_rebind.account_id and command.cell_id=v_rebind.new_cell_id
    and command.command_kind='CELL_REBIND'
    and command.expected_session_generation=v_rebind.expected_session_generation
    and command.expected_fencing_token=v_rebind.new_fencing_token
    and command.state in ('PENDING','LEASED');
  if not found then raise exception 'cell rebind command acknowledgement CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_generation_revocations(id,organization_id,principal_kind,
    account_id,cell_id,revocation_kind,revoked_generation,minimum_valid_generation,
    command_id,reason_code)
  values(v_revocation,v_org,'CHANNEL',v_rebind.account_id,v_rebind.old_cell_id,'CELL',
    v_rebind.old_fencing_token,v_rebind.new_fencing_token,v_rebind.runtime_command_id,
    'CELL_REBIND');
  update public.openclaw_cell_rebinds set status='AWAITING_ACK',revocation_id=v_revocation
  where organization_id=v_org and id=v_rebind.id;
  return jsonb_build_object('version',1,'rebindId',v_rebind.id,'revocationId',v_revocation,
    'status','AWAITING_ACK','newCellId',v_rebind.new_cell_id,
    'revocationBody',jsonb_build_object('version',1,'organizationId',v_org,
      'principalKind','CHANNEL','accountId',v_rebind.account_id,'cellId',v_rebind.old_cell_id,
      'maintenancePrincipalId',null,'revocationId',v_revocation,'revocationKind','CELL',
      'revokedGeneration',v_rebind.old_fencing_token,
      'minimumValidGeneration',v_rebind.new_fencing_token));
end;
$function$;

create or replace function app_private.openclaw_ack_generation_revocation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_org uuid:=(p_principal->>'organizationId')::uuid;
  v_hash text:=p_request->>'acknowledgementHash';
  v_minimum bigint;
  v_rebind public.openclaw_cell_rebinds%rowtype;
  v_revocation public.openclaw_generation_revocations%rowtype;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','revocationId','minimumValidGeneration','acknowledgementHash'],
    array['version','revocationId','minimumValidGeneration','acknowledgementHash']
  );
  if p_request->'version' is distinct from '1'::jsonb
     or p_request->>'revocationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_request->'minimumValidGeneration') <> 'number'
     or p_request->>'minimumValidGeneration' !~ '^[1-9][0-9]*$'
     or v_hash !~ '^[0-9a-f]{64}$'
  then raise exception 'generation revocation acknowledgement request invalid' using errcode='22023'; end if;
  begin
    v_minimum:=(p_request->>'minimumValidGeneration')::bigint;
  exception when others then
    raise exception 'generation revocation acknowledgement request invalid' using errcode='22023';
  end;
  select rebind.* into v_rebind
  from public.openclaw_cell_rebinds rebind
  where rebind.organization_id=v_org
    and rebind.revocation_id=(p_request->>'revocationId')::uuid
    and rebind.account_id=(p_principal->>'accountId')::uuid
    and rebind.new_cell_id=(p_principal->>'cellId')::uuid
    and rebind.expected_session_generation=(p_principal->>'sessionGeneration')::bigint
    and rebind.new_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and rebind.new_fencing_token=(p_principal->>'fencingToken')::bigint
    and rebind.status in ('AWAITING_ACK','COMPLETED')
  for update;
  if v_rebind.id is null then
    raise exception 'generation revocation principal binding mismatch' using errcode='42501';
  end if;
  select revocation.* into v_revocation
  from public.openclaw_generation_revocations revocation
  where revocation.organization_id=v_org and revocation.id=v_rebind.revocation_id
    and revocation.principal_kind='CHANNEL'
    and revocation.account_id=v_rebind.account_id and revocation.cell_id=v_rebind.old_cell_id
    and revocation.maintenance_principal_id is null and revocation.revocation_kind='CELL'
    and revocation.revoked_generation=v_rebind.old_fencing_token
    and revocation.minimum_valid_generation=v_rebind.new_fencing_token
    and revocation.minimum_valid_generation=v_minimum
    and revocation.reason_code='CELL_REBIND'
  for update;
  if v_revocation.id is null then
    raise exception 'generation revocation binding mismatch' using errcode='42501';
  end if;
  v_result:=jsonb_build_object(
    'version',1,'revocationId',v_revocation.id,'acknowledged',true
  );
  if v_rebind.status='COMPLETED' then
    if v_revocation.acknowledgement_hash is distinct from v_hash
       or v_rebind.acknowledgement_hash is distinct from v_hash
    then raise exception 'generation revocation acknowledgement CAS failed' using errcode='40001'; end if;
    return v_result;
  end if;
  update public.openclaw_generation_revocations revocation set
    acknowledgement_hash=v_hash,acknowledged_at=statement_timestamp()
  where revocation.organization_id=v_org and revocation.id=v_revocation.id
    and revocation.acknowledgement_hash is null;
  if not found then raise exception 'generation revocation acknowledgement CAS failed' using errcode='40001'; end if;
  update public.openclaw_runtime_cells cell set
    is_current=false,state='FENCED',retired_at=statement_timestamp()
  where cell.organization_id=v_org and cell.account_id=v_rebind.account_id
    and cell.id=v_rebind.old_cell_id and cell.is_current;
  if not found then raise exception 'old CELL cutover CAS failed' using errcode='40001'; end if;
  update public.openclaw_runtime_cells cell set
    is_current=true,state='READY',retired_at=null
  where cell.organization_id=v_org and cell.account_id=v_rebind.account_id
    and cell.id=v_rebind.new_cell_id and not cell.is_current;
  if not found then raise exception 'new CELL cutover CAS failed' using errcode='40001'; end if;
  update public.openclaw_runtime_credentials credential set
    revoked_at=statement_timestamp(),revoked_reason='CELL_REBIND'
  where credential.organization_id=v_org and credential.account_id=v_rebind.account_id
    and credential.cell_id=v_rebind.old_cell_id and credential.revoked_at is null;
  update public.openclaw_runtime_leases lease set
    status='REVOKED',released_at=statement_timestamp()
  where lease.organization_id=v_org and lease.account_id=v_rebind.account_id
    and lease.cell_id=v_rebind.old_cell_id and lease.status='ACTIVE';
  update public.openclaw_cell_rebinds rebind set
    status='COMPLETED',acknowledgement_hash=v_hash,completed_at=statement_timestamp()
  where rebind.organization_id=v_org and rebind.id=v_rebind.id
    and rebind.status='AWAITING_ACK';
  if not found then raise exception 'cell rebind acknowledgement CAS failed' using errcode='40001'; end if;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_ingest_inbound_batch_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_cell uuid := (p_principal ->> 'cellId')::uuid;
  v_session_generation bigint := (p_principal ->> 'sessionGeneration')::bigint;
  v_fencing_token bigint := (p_principal ->> 'fencingToken')::bigint;
  v_request_id uuid := gen_random_uuid();
  v_event jsonb; v_index bigint; v_manifest jsonb; v_manifest_index bigint;
  v_identity record; v_existing record; v_existing_found boolean;
  v_event_id uuid; v_message_id uuid; v_target_id uuid; v_contact_id uuid; v_group_id uuid;
  v_target_version bigint; v_target_directory_refreshed_at timestamptz;
  v_conversation_id uuid; v_decision_id uuid; v_work_id uuid; v_payload_hash text;
  v_event_stable text; v_message_stable text; v_event_kind text; v_pair_kind text; v_pair_value text;
  v_fallback text; v_collision text; v_decision_kind text; v_no_send text;
  v_automation_version uuid; v_policy_version uuid; v_template_version uuid;
  v_knowledge_ids uuid[] := '{}'::uuid[];
  v_frozen jsonb; v_frozen_hash text; v_work_payload jsonb; v_results jsonb := '[]'::jsonb;
  v_audit jsonb; v_media jsonb;
  v_accepted integer := 0; v_deduplicated integer := 0; v_quarantined integer := 0;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cellId','sessionGeneration','events'],
    array['version','organizationId','accountId','cellId','sessionGeneration','events']
  );
  if p_request -> 'version' is distinct from '1'::jsonb
     or p_request ->> 'organizationId' is distinct from p_principal ->> 'organizationId'
     or p_request ->> 'accountId' is distinct from p_principal ->> 'accountId'
     or p_request ->> 'cellId' is distinct from p_principal ->> 'cellId'
     or p_request -> 'sessionGeneration' is distinct from p_principal -> 'sessionGeneration'
  then
    raise exception 'inbound batch principal binding mismatch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_request -> 'events') <> 'array'
     or jsonb_array_length(p_request -> 'events') < 1
     or jsonb_array_length(p_request -> 'events') > 100
  then raise exception 'bounded inbound events array required' using errcode = '22023'; end if;
  perform 1 from public.openclaw_accounts account
  where account.organization_id = v_org and account.id = v_account for update;

  for v_event, v_index in
    select item.value, item.ordinality - 1
    from jsonb_array_elements(p_request -> 'events') with ordinality item(value, ordinality)
  loop
    perform app_private.openclaw_assert_strict_object_v1(
      v_event,
      array['version','eventKind','providerEventId','providerMessageId',
        'providerConversationId','providerSenderId','providerTarget','providerEventType',
        'sourceTimestamp','callbackReceivedAt','rawEnvelope','rawEnvelopeSha256',
        'normalized','normalizedSha256'],
      array['version','eventKind','providerEventId','providerMessageId',
        'providerConversationId','providerSenderId','providerTarget','providerEventType',
        'sourceTimestamp','callbackReceivedAt','rawEnvelope','rawEnvelopeSha256',
        'normalized','normalizedSha256']
    );
    perform app_private.openclaw_assert_strict_object_v1(
      v_event -> 'providerTarget',array['kind','providerId'],array['kind','providerId']
    );
    perform app_private.openclaw_assert_strict_object_v1(
      v_event -> 'normalized',
      array['text','replyToProviderMessageId','mediaManifest'],
      array['text','replyToProviderMessageId','mediaManifest']
    );
    if v_event -> 'version' is distinct from '1'::jsonb
       or v_event ->> 'eventKind' not in (
         'MESSAGE','REACTION','DELIVERY_RECEIPT','SEEN','TYPING','MEMBERSHIP','OTHER'
       )
       or v_event #>> '{providerTarget,kind}' not in ('PEER','SALES_GROUP')
       or jsonb_typeof(v_event #> '{normalized,mediaManifest}') <> 'array'
       or jsonb_array_length(v_event #> '{normalized,mediaManifest}') > 20
       or v_event ->> 'rawEnvelopeSha256' is distinct from encode(extensions.digest(
         app_private.openclaw_jcs_bytes_v1(v_event -> 'rawEnvelope'),'sha256'),'hex')
       or v_event ->> 'normalizedSha256' is distinct from encode(extensions.digest(
         app_private.openclaw_jcs_bytes_v1(v_event -> 'normalized'),'sha256'),'hex')
    then
      raise exception 'inbound event shape or hash invalid' using errcode = '22023';
    end if;
    for v_manifest,v_manifest_index in
      select item.value,item.ordinality-1
      from jsonb_array_elements(v_event #> '{normalized,mediaManifest}')
        with ordinality item(value,ordinality)
    loop
      perform app_private.openclaw_assert_strict_object_v1(
        v_manifest,
        array['version','index','providerMediaId','kind','mime','byteLength',
          'providerChecksum','fetchRef','byteState'],
        array['version','index','providerMediaId','kind','mime','byteLength',
          'providerChecksum','fetchRef','byteState']
      );
      if v_manifest->>'version'<>'1'
         or (v_manifest->>'index')::bigint<>v_manifest_index
         or v_manifest->>'kind' not in ('IMAGE','VIDEO','AUDIO','FILE','STICKER','OTHER')
         or v_manifest->>'byteState'<>'PENDING'
         or (nullif(v_manifest->>'providerChecksum','') is not null
           and (v_manifest->>'providerChecksum') !~ '^[0-9a-f]{64}$')
         or (nullif(v_manifest->>'byteLength','') is not null
           and (v_manifest->>'byteLength')::bigint not between 0 and 52428800)
      then
        raise exception 'inbound media manifest is invalid' using errcode='22023';
      end if;
    end loop;
    v_event_kind := v_event ->> 'eventKind';
    v_event_stable := nullif(v_event ->> 'providerEventId', '');
    v_message_stable := nullif(v_event ->> 'providerMessageId', '');
    v_payload_hash := encode(extensions.digest(
      convert_to('ihome-openclaw-inbound-payload-v1', 'UTF8')
        || decode('00', 'hex')
        || app_private.openclaw_jcs_bytes_v1(v_event - 'callbackReceivedAt'),
      'sha256'
    ), 'hex');

    -- event ID primary, message ID secondary; both stable IDs are null only for fallback.
    for v_identity in
      select identity_input.stable_id_kind, identity_input.stable_id_value
      from (values
        ('PROVIDER_EVENT_ID'::text, v_event_stable),
        ('PROVIDER_MESSAGE_ID'::text, v_message_stable)
      ) identity_input(stable_id_kind, stable_id_value)
      where identity_input.stable_id_value is not null
      order by stable_id_kind, stable_id_value
    loop
      perform pg_advisory_xact_lock(hashtextextended(
        v_org::text || ':' || v_account::text || ':'
          || v_identity.stable_id_kind || ':' || v_identity.stable_id_value,
        0
      ));
    end loop;

    v_existing_found := false;
    if v_event_stable is not null or v_message_stable is not null then
      select identity.*, inbound.event_kind as existing_event_kind,
        inbound.provider_event_id as existing_provider_event_id,
        inbound.provider_message_id as existing_provider_message_id
      into v_existing
      from public.openclaw_inbound_provider_identities identity
      join public.openclaw_inbound_events inbound
        on inbound.organization_id = identity.organization_id
       and inbound.account_id = identity.account_id and inbound.id = identity.inbound_event_id
      where identity.organization_id = v_org and identity.account_id = v_account
        and (
          (identity.stable_id_kind = 'PROVIDER_EVENT_ID'
            and identity.stable_id_value = v_event_stable)
          or (identity.stable_id_kind = 'PROVIDER_MESSAGE_ID'
            and identity.stable_id_value = v_message_stable)
        )
      order by case identity.stable_id_kind when 'PROVIDER_EVENT_ID' then 0 else 1 end
      limit 1;
      v_existing_found := found;
    end if;

    if v_existing_found then
      v_collision := case
        when v_existing.existing_event_kind is distinct from v_event_kind then 'CROSS_KIND'
        when v_existing.existing_provider_event_id is distinct from v_event_stable
          or v_existing.existing_provider_message_id is distinct from v_message_stable then 'PAIR_MISMATCH'
        when v_existing.payload_hash is distinct from v_payload_hash then 'PAYLOAD_MISMATCH'
        else null
      end;
      if v_collision is null then
        v_deduplicated := v_deduplicated + 1;
        select coalesce(jsonb_agg(jsonb_build_object(
          'manifestIndex',media.media_index,'mediaId',media.id
        ) order by media.media_index),'[]'::jsonb) into v_media
        from public.openclaw_messages message
        join public.openclaw_message_media media
          on media.organization_id=message.organization_id
         and media.account_id=message.account_id and media.message_id=message.id
        where message.organization_id=v_org and message.account_id=v_account
          and message.source_inbound_event_id=v_existing.inbound_event_id;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'index', v_index, 'status', 'DUPLICATE', 'inboundEventId', v_existing.inbound_event_id,
          'media',v_media
        ));
        continue;
      end if;
      v_audit := jsonb_build_object(
        'version', 1, 'requestId', v_request_id, 'batchIndex', v_index,
        'collisionKind', v_collision, 'existingInboundEventId', v_existing.inbound_event_id,
        'submittedPayloadHash', v_payload_hash
      );
      insert into public.openclaw_inbound_collisions(
        organization_id, account_id, cell_id, request_id, batch_index,
        existing_inbound_event_id, event_kind, provider_event_id, provider_message_id,
        raw_envelope_hash, normalized_hash, payload_hash, collision_kind,
        quarantined_envelope, evidence_hash
      ) values (
        v_org, v_account, v_cell, v_request_id, v_index, v_existing.inbound_event_id,
        v_event_kind, v_event_stable, v_message_stable,
        v_event ->> 'rawEnvelopeSha256', v_event ->> 'normalizedSha256', v_payload_hash,
        v_collision, v_event,
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_audit), 'sha256'), 'hex')
      );
      perform app_private.append_openclaw_audit_v1(
        v_org, 'OPENCLAW_INBOUND_COLLISION_QUARANTINED', null, 'CHANNEL_RUNTIME',
        v_request_id, v_request_id, v_audit, app_private.openclaw_jcs_bytes_v1(v_audit)
      );
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'status', 'QUARANTINED', 'collisionKind', v_collision
      ));
      v_quarantined := v_quarantined + 1;
      continue;
    end if;

    if v_event_stable is null and v_message_stable is null then
      v_fallback := encode(extensions.digest(
        convert_to('ihome-openclaw-inbound-fallback-v1', 'UTF8')
          || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(v_event),
        'sha256'
      ), 'hex');
      select inbound.id, inbound.payload_hash, inbound.event_kind
      into v_existing
      from public.openclaw_inbound_events inbound
      where inbound.organization_id = v_org and inbound.account_id = v_account
        and inbound.event_kind = v_event_kind and inbound.fallback_fingerprint = v_fallback;
      v_existing_found := found;
      if v_existing_found then
        if v_existing.payload_hash is distinct from v_payload_hash then
          v_collision := 'FINGERPRINT_COLLISION';
          insert into public.openclaw_inbound_collisions(
            organization_id, account_id, cell_id, request_id, batch_index,
            existing_inbound_event_id, event_kind, raw_envelope_hash,
            normalized_hash, payload_hash, collision_kind, quarantined_envelope, evidence_hash
          ) values (
            v_org, v_account, v_cell, v_request_id, v_index, v_existing.id,
            v_event_kind, v_event ->> 'rawEnvelopeSha256', v_event ->> 'normalizedSha256',
            v_payload_hash, v_collision, v_event,
            encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_event), 'sha256'), 'hex')
          );
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'index', v_index, 'status', 'QUARANTINED', 'collisionKind', v_collision
          ));
          v_quarantined := v_quarantined + 1;
        else
          select coalesce(jsonb_agg(jsonb_build_object(
            'manifestIndex',media.media_index,'mediaId',media.id
          ) order by media.media_index),'[]'::jsonb) into v_media
          from public.openclaw_messages message
          join public.openclaw_message_media media
            on media.organization_id=message.organization_id
           and media.account_id=message.account_id and media.message_id=message.id
          where message.organization_id=v_org and message.account_id=v_account
            and message.source_inbound_event_id=v_existing.id;
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'index', v_index, 'status', 'DUPLICATE', 'inboundEventId', v_existing.id,
            'media',v_media
          ));
          v_deduplicated := v_deduplicated + 1;
        end if;
        continue;
      end if;
    else
      v_fallback := null;
    end if;

    v_event_id := gen_random_uuid();
    insert into public.openclaw_inbound_events(
      id, organization_id, account_id, cell_id, session_generation, event_kind,
      provider_event_id, provider_message_id, provider_conversation_id,
      provider_sender_id, target_kind, target_provider_id, provider_event_type,
      source_timestamp, callback_received_at, raw_envelope, raw_envelope_sha256,
      normalized_envelope, normalized_sha256, payload_hash, fallback_fingerprint
    ) values (
      v_event_id, v_org, v_account, v_cell, v_session_generation, v_event_kind,
      v_event_stable, v_message_stable, v_event ->> 'providerConversationId',
      v_event ->> 'providerSenderId', v_event #>> '{providerTarget,kind}',
      v_event #>> '{providerTarget,providerId}', v_event ->> 'providerEventType',
      (v_event ->> 'sourceTimestamp')::timestamptz,
      (v_event ->> 'callbackReceivedAt')::timestamptz,
      v_event -> 'rawEnvelope', v_event ->> 'rawEnvelopeSha256',
      v_event -> 'normalized', v_event ->> 'normalizedSha256', v_payload_hash, v_fallback
    );

    if v_event_stable is not null then
      insert into public.openclaw_inbound_provider_identities(
        organization_id, account_id, event_kind, stable_id_kind, stable_id_value,
        inbound_event_id, payload_hash, paired_stable_id_kind, paired_stable_id_value
      ) values (
        v_org, v_account, v_event_kind, 'PROVIDER_EVENT_ID', v_event_stable,
        v_event_id, v_payload_hash,
        case when v_message_stable is null then null else 'PROVIDER_MESSAGE_ID' end,
        v_message_stable
      );
    end if;
    if v_message_stable is not null then
      insert into public.openclaw_inbound_provider_identities(
        organization_id, account_id, event_kind, stable_id_kind, stable_id_value,
        inbound_event_id, payload_hash, paired_stable_id_kind, paired_stable_id_value
      ) values (
        v_org, v_account, v_event_kind, 'PROVIDER_MESSAGE_ID', v_message_stable,
        v_event_id, v_payload_hash,
        case when v_event_stable is null then null else 'PROVIDER_EVENT_ID' end,
        v_event_stable
      );
    end if;

    if v_event #>> '{providerTarget,kind}' = 'PEER' then
      insert into public.openclaw_contacts(
        organization_id, account_id, provider_id, display_name, directory_refreshed_at
      ) values (
        v_org, v_account, v_event #>> '{providerTarget,providerId}',
        nullif(v_event ->> 'providerSenderId', ''), statement_timestamp()
      ) on conflict (organization_id, account_id, provider_id) do update
        set directory_refreshed_at = excluded.directory_refreshed_at,
            updated_at = statement_timestamp()
      returning id into v_contact_id;
      insert into public.openclaw_targets(
        organization_id, account_id, kind, provider_id, contact_id,
        directory_refreshed_at
      ) values (
        v_org, v_account, 'PEER', v_event #>> '{providerTarget,providerId}',
        v_contact_id, statement_timestamp()
      ) on conflict (organization_id, account_id, kind, provider_id) do update
        set directory_refreshed_at = excluded.directory_refreshed_at,
            updated_at = statement_timestamp()
      returning id,target_version,directory_refreshed_at
      into v_target_id,v_target_version,v_target_directory_refreshed_at;
    else
      insert into public.openclaw_sales_groups(
        organization_id, account_id, provider_id, display_name, directory_refreshed_at
      ) values (
        v_org, v_account, v_event #>> '{providerTarget,providerId}',
        coalesce(v_event #>> '{providerTarget,displayName}', v_event #>> '{providerTarget,providerId}'),
        statement_timestamp()
      ) on conflict (organization_id, account_id, provider_id) do update
        set directory_refreshed_at = excluded.directory_refreshed_at,
            updated_at = statement_timestamp()
      returning id into v_group_id;
      insert into public.openclaw_targets(
        organization_id, account_id, kind, provider_id, sales_group_id,
        directory_refreshed_at
      ) values (
        v_org, v_account, 'SALES_GROUP', v_event #>> '{providerTarget,providerId}',
        v_group_id, statement_timestamp()
      ) on conflict (organization_id, account_id, kind, provider_id) do update
        set directory_refreshed_at = excluded.directory_refreshed_at,
            updated_at = statement_timestamp()
      returning id,target_version,directory_refreshed_at
      into v_target_id,v_target_version,v_target_directory_refreshed_at;
    end if;

    insert into public.openclaw_conversations(
      organization_id, account_id, target_id, provider_conversation_id,
      unread_count, last_received_at
    ) values (
      v_org, v_account, v_target_id, v_event ->> 'providerConversationId',
      case when v_event_kind = 'MESSAGE' then 1 else 0 end,
      (v_event ->> 'callbackReceivedAt')::timestamptz
    ) on conflict (organization_id, account_id, provider_conversation_id) do update
      set target_id = excluded.target_id,
          unread_count = public.openclaw_conversations.unread_count
            + case when v_event_kind = 'MESSAGE' then 1 else 0 end,
          last_received_at = greatest(public.openclaw_conversations.last_received_at, excluded.last_received_at),
          version = public.openclaw_conversations.version + 1,
          updated_at = statement_timestamp()
    returning id into v_conversation_id;

    v_message_id := gen_random_uuid();
    insert into public.openclaw_messages(
      id, organization_id, account_id, conversation_id, source_inbound_event_id,
      direction, event_kind, provider_message_id, provider_sender_id, text_content,
      reply_to_provider_message_id, payload_hash, provider_timestamp, received_at
    ) values (
      v_message_id, v_org, v_account, v_conversation_id, v_event_id,
      'INBOUND', v_event_kind, v_message_stable, v_event ->> 'providerSenderId',
      v_event #>> '{normalized,text}', v_event #>> '{normalized,replyToProviderMessageId}',
      v_payload_hash, (v_event ->> 'sourceTimestamp')::timestamptz,
      (v_event ->> 'callbackReceivedAt')::timestamptz
    );
    update public.openclaw_conversations set last_message_id = v_message_id
    where organization_id = v_org and id = v_conversation_id;

    with manifest as (
      select item.value, item.ordinality-1 manifest_index,gen_random_uuid() media_id
      from jsonb_array_elements(v_event #> '{normalized,mediaManifest}')
        with ordinality item(value,ordinality)
    )
    insert into public.openclaw_message_media(
      id,organization_id,account_id,conversation_id,message_id,media_index,
      provider_media_id,media_kind,mime,byte_length,sha256,object_key,byte_state
    )
    select manifest.media_id,v_org,v_account,v_conversation_id,v_message_id,
      manifest.manifest_index,nullif(manifest.value->>'providerMediaId',''),
      manifest.value->>'kind',nullif(manifest.value->>'mime',''),
      nullif(manifest.value->>'byteLength','')::bigint,
      nullif(manifest.value->>'providerChecksum',''),
      'v1/org/'||v_org||'/account/'||v_account||'/conversation/'||v_conversation_id
        ||'/message/'||v_message_id||'/media/'||manifest.media_id||'/original',
      'PENDING'
    from manifest;
    select coalesce(jsonb_agg(jsonb_build_object(
      'manifestIndex',media.media_index,'mediaId',media.id
    ) order by media.media_index),'[]'::jsonb) into v_media
    from public.openclaw_message_media media
    where media.organization_id=v_org and media.account_id=v_account
      and media.message_id=v_message_id;

    v_decision_kind := 'NO_SEND'; v_no_send := 'TARGET_INELIGIBLE';
    if v_event ->> 'providerEventType' = 'HISTORY_SYNC' then
      v_no_send := 'HISTORY_SYNC';
    elsif v_event #>> '{providerTarget,kind}' = 'SALES_GROUP' then
      v_no_send := 'SALES_GROUP_CHATTER';
    elsif v_event_kind <> 'MESSAGE' then
      v_no_send := 'TARGET_INELIGIBLE';
    elsif not exists (
      select 1 from public.openclaw_accounts account
      where account.organization_id = v_org and account.id = v_account
        and account.effective_mode = 'LIMITED_AUTO_REPLY'
        and account.connection_state = 'CONNECTED' and account.paused_at is null
    ) then
      v_no_send := 'MODE_DISABLED';
    else
      select version.id, version.policy_version_id, version.content_version_id,
        version.knowledge_version_ids
      into v_automation_version, v_policy_version, v_template_version, v_knowledge_ids
      from public.openclaw_automation_versions version
      join public.openclaw_automations automation
        on automation.organization_id = version.organization_id
       and automation.account_id = version.account_id and automation.id = version.automation_id
      where version.organization_id = v_org and version.account_id = v_account
        and automation.automation_kind = 'INBOUND_REPLY'
        and automation.lifecycle_state = 'PUBLISHED'
        and version.lifecycle_state = 'PUBLISHED'
      order by version.published_at desc, version.id desc limit 1;
      if v_automation_version is not null then
        v_decision_kind := 'WORK_ELIGIBLE'; v_no_send := null;
      else
        v_no_send := 'POLICY_BLOCKED';
      end if;
    end if;
    v_decision_id := gen_random_uuid();
    v_frozen := jsonb_build_object(
      'version', 1, 'inboundEventId', v_event_id, 'messageId', v_message_id,
      'conversationId', v_conversation_id, 'targetId', v_target_id,
      'targetVersion',v_target_version,
      'targetDirectoryRefreshedAt',v_target_directory_refreshed_at,
      'automationVersionId', v_automation_version,
      'templateVersionId',v_template_version,
      'policyVersionId', v_policy_version, 'knowledgeVersionIds', to_jsonb(v_knowledge_ids)
    );
    v_frozen_hash := encode(extensions.digest(
      convert_to('ihome-openclaw-inbound-decision-v1', 'UTF8')
        || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(v_frozen), 'sha256'
    ), 'hex');
    insert into public.openclaw_inbound_automation_decisions(
      id, organization_id, account_id, inbound_event_id, decision_kind,
      no_send_reason, eligibility_reason, policy_version_id,
      automation_version_id, knowledge_version_ids, frozen_inputs, frozen_inputs_hash
    ) values (
      v_decision_id, v_org, v_account, v_event_id, v_decision_kind,
      v_no_send, case when v_decision_kind = 'WORK_ELIGIBLE' then 'ALLOWED' end,
      v_policy_version, v_automation_version, v_knowledge_ids, v_frozen, v_frozen_hash
    );
    if v_decision_kind = 'WORK_ELIGIBLE' then
      v_work_id := gen_random_uuid();
      v_work_payload := jsonb_build_object(
        'kind', 'INBOUND_AUTOMATION', 'inboundEventId', v_event_id,
        'messageId', v_message_id, 'conversationId', v_conversation_id,
        'targetId', v_target_id, 'targetVersion',v_target_version,
        'targetDirectoryRefreshedAt',v_target_directory_refreshed_at,
        'automationVersionId', v_automation_version,
        'templateVersionId',v_template_version,
        'knowledgeVersionIds', to_jsonb(v_knowledge_ids),
        'eligibilityDecisionHash', v_frozen_hash
      );
      insert into public.openclaw_send_work_items(
        id, organization_id, account_id, cell_id, work_kind, source_id,
        source_version, source_hash, payload, payload_hash,
        fencing_token, session_generation
      ) values (
        v_work_id, v_org, v_account, v_cell, 'INBOUND_AUTOMATION', v_event_id,
        '1', v_frozen_hash, v_work_payload,
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_work_payload), 'sha256'), 'hex'),
        v_fencing_token, v_session_generation
      );
    else
      v_work_id := null;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'index', v_index, 'status', 'ACCEPTED', 'inboundEventId', v_event_id,
      'messageId', v_message_id, 'decisionId', v_decision_id,
      'decisionKind', v_decision_kind, 'noSendReason', v_no_send,
      'workItemId', v_work_id,'media',v_media
    ));
    v_accepted := v_accepted + 1;
  end loop;
  return jsonb_build_object(
    'version',1,'requestId',v_request_id,
    'accepted',v_accepted,'deduplicated',v_deduplicated,'quarantined',v_quarantined,
    'results',v_results
  );
end;
$function$;

create or replace function app_private.openclaw_claim_inbound_automation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_cell uuid := (p_principal ->> 'cellId')::uuid;
  v_fencing bigint := (p_principal ->> 'fencingToken')::bigint;
  v_session bigint := (p_principal ->> 'sessionGeneration')::bigint;
  v_limit integer := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 10), 50));
  v_lease_seconds integer := greatest(5, least(coalesce((p_request ->> 'leaseSeconds')::integer, 30), 60));
  v_token_hash text;
  v_items jsonb;
begin
  if p_request ->> 'version' <> '1' or nullif(p_request ->> 'claimToken', '') is null then
    raise exception 'version 1 and claimToken required' using errcode = '22023';
  end if;
  v_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-inbound-automation-claim-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_request ->> 'claimToken', 'UTF8'), 'sha256'
  ), 'hex');
  with candidates as (
    select work.id
    from public.openclaw_send_work_items work
    where work.organization_id = v_org and work.account_id = v_account
      and work.cell_id = v_cell and work.work_kind = 'INBOUND_AUTOMATION'
      and work.state = 'QUEUED'
      and (work.retry_not_before is null or work.retry_not_before <= statement_timestamp())
      and work.fencing_token = v_fencing and work.session_generation = v_session
    order by work.created_at, work.id
    for update skip locked
    limit v_limit
  ), claimed as (
    update public.openclaw_send_work_items work
    set state = 'LEASED', claim_token_hash = v_token_hash,
        claim_generation = work.claim_generation + 1,
        lease_expires_at = statement_timestamp() + make_interval(secs => v_lease_seconds),
        attempt_count = work.attempt_count + 1, updated_at = statement_timestamp()
    from candidates where work.organization_id = v_org and work.id = candidates.id
    returning work.id, work.claim_generation, work.lease_expires_at,
      work.source_id, work.source_hash, work.payload, work.payload_hash
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'workItemId', claimed.id, 'claimGeneration', claimed.claim_generation,
    'leaseExpiresAt', claimed.lease_expires_at, 'inboundEventId', claimed.source_id,
    'sourceHash', claimed.source_hash, 'payload', claimed.payload,
    'payloadHash', claimed.payload_hash
  ) order by claimed.id), '[]'::jsonb) into v_items from claimed;
  return jsonb_build_object('version', 1, 'items', v_items, 'databaseTime', statement_timestamp());
end;
$function$;

create or replace function app_private.openclaw_complete_inbound_automation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_cell uuid := (p_principal ->> 'cellId')::uuid;
  v_work uuid := (p_request ->> 'workItemId')::uuid;
  v_claim_generation bigint := (p_request ->> 'claimGeneration')::bigint;
  v_outcome text := p_request ->> 'outcome';
  v_token_hash text;
  v_attempt integer;
  v_updated uuid;
  v_evidence jsonb := coalesce(p_request -> 'evidence', '{}'::jsonb);
begin
  if p_request ->> 'version' <> '1' or v_outcome not in ('COMPLETE','RETRY','FAILED','DEAD_LETTER') then
    raise exception 'invalid inbound automation completion version or outcome' using errcode = '22023';
  end if;
  v_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-inbound-automation-claim-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_request ->> 'claimToken', 'UTF8'), 'sha256'
  ), 'hex');
  select work.attempt_count into v_attempt
  from public.openclaw_send_work_items work
  where work.organization_id = v_org and work.account_id = v_account and work.id = v_work
    and work.cell_id = v_cell and work.work_kind = 'INBOUND_AUTOMATION'
    and work.state = 'LEASED' and work.claim_generation = v_claim_generation
    and work.claim_token_hash = v_token_hash
    and work.fencing_token = (p_principal ->> 'fencingToken')::bigint
    and work.session_generation = (p_principal ->> 'sessionGeneration')::bigint
    and work.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    raise exception 'inbound automation completion CAS failed' using errcode = '40001';
  end if;
  insert into public.openclaw_send_work_attempts(
    organization_id, account_id, cell_id, work_item_id, claim_generation,
    fencing_token, session_generation, attempt_number, outcome, evidence, evidence_hash
  ) values (
    v_org, v_account, v_cell, v_work, v_claim_generation,
    (p_principal ->> 'fencingToken')::bigint,
    (p_principal ->> 'sessionGeneration')::bigint, v_attempt, v_outcome,
    v_evidence, encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence), 'sha256'), 'hex')
  );
  update public.openclaw_send_work_items work
  set state = case when v_outcome = 'RETRY' then 'QUEUED' else v_outcome end,
      claim_token_hash = null, lease_expires_at = null,
      retry_not_before = case when v_outcome = 'RETRY'
        then statement_timestamp() + make_interval(secs => greatest(1, least(coalesce((p_request ->> 'retryAfterSeconds')::integer, 5), 3600)))
        else null end,
      terminal_at = case when v_outcome = 'RETRY' then null else statement_timestamp() end,
      updated_at = statement_timestamp()
  where work.organization_id = v_org and work.id = v_work
    and work.state = 'LEASED' and work.claim_generation = v_claim_generation
  returning work.id into v_updated;
  if v_updated is null then raise exception 'inbound automation completion CAS failed' using errcode = '40001'; end if;
  return jsonb_build_object('version', 1, 'workItemId', v_updated, 'outcome', v_outcome);
end;
$function$;

create or replace function app_private.openclaw_claim_outbox_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_cell uuid := (p_principal ->> 'cellId')::uuid;
  v_limit integer := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 10), 25));
  v_lease_seconds integer := greatest(5, least(coalesce((p_request ->> 'leaseSeconds')::integer, 30), 60));
  v_token_hash text;
  v_items jsonb;
begin
  if p_request ->> 'version' <> '1' or nullif(p_request ->> 'claimToken', '') is null then
    raise exception 'version 1 and claimToken required' using errcode = '22023';
  end if;
  v_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-outbox-claim-v1', 'UTF8') || decode('00', 'hex')
      || convert_to(p_request ->> 'claimToken', 'UTF8'), 'sha256'
  ), 'hex');
  with candidates as (
    select outbox.id
    from public.openclaw_outbox outbox
    where outbox.organization_id = v_org and outbox.account_id = v_account
      and outbox.state = 'QUEUED'
      and (outbox.retry_not_before is null or outbox.retry_not_before <= statement_timestamp())
    order by outbox.created_at, outbox.id
    for update skip locked
    limit v_limit
  ), claimed as (
    update public.openclaw_outbox outbox
    set state = 'LEASED', claim_token_hash = v_token_hash,
        claim_generation = claim_generation + 1, claimed_cell_id = v_cell,
        lease_expires_at = statement_timestamp() + make_interval(secs => v_lease_seconds),
        fencing_token = (p_principal ->> 'fencingToken')::bigint,
        session_generation = (p_principal ->> 'sessionGeneration')::bigint,
        attempt_count = outbox.attempt_count + 1, updated_at = statement_timestamp()
    from candidates where outbox.organization_id = v_org and outbox.id = candidates.id
    returning outbox.id, outbox.organization_id, outbox.account_id,
      outbox.claim_generation, outbox.lease_expires_at, outbox.fencing_token,
      outbox.session_generation, outbox.control_version, outbox.takeover_version,
      outbox.canonical_payload, outbox.payload_hash
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'version', 1,
    'outboxId', claimed.id,
    'organizationId', claimed.organization_id,
    'accountId', claimed.account_id,
    'claimToken', p_request ->> 'claimToken',
    'claimGeneration', claimed.claim_generation,
    'fencingToken', claimed.fencing_token,
    'sessionGeneration', claimed.session_generation,
    'controlVersion', claimed.control_version,
    'takeoverVersion', claimed.takeover_version,
    'leaseExpiresAt', claimed.lease_expires_at,
    'payloadHash', claimed.payload_hash,
    'payload', claimed.canonical_payload
  ) order by claimed.id), '[]'::jsonb) into v_items from claimed;
  return jsonb_build_object('version', 1, 'items', v_items);
end;
$function$;

create or replace function app_private.openclaw_preflight_outbox_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_outbox public.openclaw_outbox%rowtype;
  v_target public.openclaw_targets%rowtype;
  v_reason text := 'ALLOWED';
  v_control_version bigint := 1;
  v_takeover_version bigint := 0;
  v_claim_token_hash text;
  v_marker_nonce text := gen_random_uuid()::text;
  v_marker_hash text;
  v_expires_at timestamptz;
  v_authorization_marker jsonb;
  v_now timestamptz := statement_timestamp();
  v_disposition text := 'HANDOFF_AUTHORIZED';
  v_retry_not_before timestamptz;
  v_transition_applied boolean := false;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','outboxId','claimGeneration','claimToken'],
    array['version','outboxId','claimGeneration','claimToken']
  );
  if p_request ->> 'version' <> '1' or nullif(p_request ->> 'claimToken','') is null then
    raise exception 'preflight version or claim token mismatch' using errcode='22023';
  end if;
  v_claim_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-outbox-claim-v1','UTF8') || decode('00','hex')
      || convert_to(p_request ->> 'claimToken','UTF8'), 'sha256'
  ), 'hex');
  select outbox.* into v_outbox from public.openclaw_outbox outbox
  where outbox.organization_id = v_org and outbox.account_id = v_account
    and outbox.id = (p_request ->> 'outboxId')::uuid
    and outbox.state = 'LEASED'
    and outbox.claim_generation = (p_request ->> 'claimGeneration')::bigint
    and outbox.claim_token_hash = v_claim_token_hash
    and outbox.claimed_cell_id = (p_principal ->> 'cellId')::uuid
    and outbox.fencing_token = (p_principal ->> 'fencingToken')::bigint
    and outbox.session_generation = (p_principal ->> 'sessionGeneration')::bigint
    and outbox.lease_expires_at > v_now
  for update;
  if not found then raise exception 'outbox preflight CAS failed' using errcode='40001'; end if;
  if app_private.openclaw_send_payload_hash_v1(v_outbox.canonical_payload) is distinct from v_outbox.payload_hash then
    raise exception 'outbox payload hash mismatch' using errcode='55000';
  end if;
  select target.* into v_target from public.openclaw_targets target
  where target.organization_id = v_org and target.account_id = v_account and target.id = v_outbox.target_id;
  select control.control_version into v_control_version
  from public.openclaw_control_states control
  where control.organization_id = v_org and control.control_key = 'GLOBAL_STOP';
  if exists (select 1 from public.openclaw_control_states control
      where control.organization_id=v_org and control.global_stop) then v_reason := 'GLOBAL_STOP';
  elsif exists (select 1 from public.openclaw_control_states control
      where control.organization_id=v_org and not control.feature_enabled) then v_reason := 'MODE_PAUSED';
  elsif exists (select 1 from public.openclaw_accounts account
      where account.organization_id=v_org and account.id=v_account and account.paused_at is not null) then v_reason := 'ACCOUNT_PAUSED';
  elsif v_outbox.campaign_id is not null and exists (select 1 from public.openclaw_campaigns campaign
      where campaign.organization_id=v_org and campaign.account_id=v_account
        and campaign.id=v_outbox.campaign_id and campaign.status='CANCELLED') then v_reason := 'CAMPAIGN_CANCELLED';
  elsif exists (select 1 from public.openclaw_takeovers takeover
      join public.openclaw_conversations conversation
        on conversation.organization_id=takeover.organization_id
       and conversation.account_id=takeover.account_id
       and conversation.id=takeover.conversation_id
      where takeover.organization_id=v_org and takeover.account_id=v_account
        and conversation.target_id=v_outbox.target_id
        and takeover.released_at is null and takeover.expires_at > v_now) then v_reason := 'TAKEOVER_ACTIVE';
  elsif exists (select 1 from public.openclaw_suppressions suppression
      where suppression.organization_id=v_org and suppression.account_id=v_account
        and (suppression.target_id is null or suppression.target_id=v_outbox.target_id)
        and suppression.active_from <= v_now and suppression.released_at is null
        and (suppression.expires_at is null or suppression.expires_at > v_now)) then v_reason := 'SUPPRESSED';
  elsif v_target.kind='PEER' and not exists (select 1 from public.openclaw_consents consent
      where consent.organization_id=v_org and consent.account_id=v_account and consent.target_id=v_outbox.target_id
        and consent.consent_status='ACTIVE' and (consent.expires_at is null or consent.expires_at > v_now)) then v_reason := 'CONSENT_MISSING';
  elsif not exists (
    select 1 from public.openclaw_policy_versions policy
    where policy.organization_id=v_org and policy.account_id=v_account
      and policy.id=(v_outbox.canonical_payload ->> 'policyVersionId')::uuid
      and policy.lifecycle_state='PUBLISHED'
      and policy.published_at is not null
      and policy.archived_at is null
  ) then v_reason := 'POLICY_STALE';
  elsif exists (
    select 1 from public.openclaw_policy_versions policy
    where policy.organization_id=v_org and policy.account_id=v_account
      and policy.id=(v_outbox.canonical_payload ->> 'policyVersionId')::uuid
      and (
        (policy.quiet_hours_start < policy.quiet_hours_end
          and (v_now at time zone policy.timezone)::time >= policy.quiet_hours_start
          and (v_now at time zone policy.timezone)::time < policy.quiet_hours_end)
        or (policy.quiet_hours_start > policy.quiet_hours_end
          and ((v_now at time zone policy.timezone)::time >= policy.quiet_hours_start
            or (v_now at time zone policy.timezone)::time < policy.quiet_hours_end))
      )
  ) then v_reason := 'QUIET_HOURS';
  elsif exists (
    select 1 from public.openclaw_policy_versions policy
    where policy.organization_id=v_org and policy.account_id=v_account
      and policy.id=(v_outbox.canonical_payload ->> 'policyVersionId')::uuid
      and (select count(*) from public.openclaw_delivery_attempts attempt
        where attempt.organization_id=v_org and attempt.account_id=v_account
          and attempt.started_at >= v_now-interval '1 minute')
        >= greatest(1,coalesce((policy.rate_limits ->> 'perMinute')::integer,60))
  ) then v_reason := 'RATE_LIMITED';
  elsif v_target.kind='SALES_GROUP' and v_target.directory_refreshed_at <= v_now - interval '24 hours'
    then v_reason := 'GROUP_DIRECTORY_STALE';
  elsif v_target.kind='SALES_GROUP' and not exists (select 1 from public.openclaw_sales_group_allowlists allowlist
      where allowlist.organization_id=v_org and allowlist.account_id=v_account
        and allowlist.sales_group_target_id=v_target.id and allowlist.is_allowed
        and allowlist.directory_expires_at > v_now) then v_reason := 'GROUP_NOT_ALLOWLISTED';
  end if;
  select coalesce(max(takeover.takeover_version),0) into v_takeover_version
  from public.openclaw_takeovers takeover
  join public.openclaw_conversations conversation
    on conversation.organization_id=takeover.organization_id
   and conversation.account_id=takeover.account_id
   and conversation.id=takeover.conversation_id
  where takeover.organization_id=v_org and takeover.account_id=v_account
    and conversation.target_id=v_outbox.target_id;
  if v_reason = 'ALLOWED' then
    v_marker_hash := encode(extensions.digest(convert_to('ihome-openclaw-handoff-marker-v1','UTF8')
      || decode('00','hex') || convert_to(v_marker_nonce,'UTF8'),'sha256'),'hex');
    v_expires_at := least(v_now + interval '15 seconds', v_outbox.lease_expires_at);
    insert into public.openclaw_outbound_authorizations(
      organization_id, account_id, outbox_id, claim_generation, payload_hash,
      fencing_token, session_generation, control_version, takeover_version,
      marker_nonce_hash, issued_at, expires_at, lease_expires_at
    ) values (
      v_org, v_account, v_outbox.id, v_outbox.claim_generation, v_outbox.payload_hash,
      v_outbox.fencing_token, v_outbox.session_generation, v_control_version, v_takeover_version,
      v_marker_hash, v_now, v_expires_at, v_outbox.lease_expires_at
    );
    v_authorization_marker := jsonb_build_object(
      'version',1,
      'outboxId',v_outbox.id,
      'claimGeneration',v_outbox.claim_generation,
      'payloadHash',v_outbox.payload_hash,
      'fencingToken',v_outbox.fencing_token,
      'sessionGeneration',v_outbox.session_generation,
      'controlVersion',v_control_version,
      'takeoverVersion',v_takeover_version,
      'markerNonce',v_marker_nonce,
      'expiresAt',v_expires_at
    );
  elsif v_reason='CAMPAIGN_CANCELLED' then
    update public.openclaw_outbox outbox set
      state='FAILED',claim_token_hash=null,claimed_cell_id=null,lease_expires_at=null,
      retry_not_before=null,terminal_at=v_now,updated_at=v_now
    where outbox.organization_id=v_org and outbox.account_id=v_account
      and outbox.id=v_outbox.id and outbox.state='LEASED'
      and outbox.claim_generation=v_outbox.claim_generation;
    if not found then raise exception 'terminal preflight transition CAS failed' using errcode='40001'; end if;
    v_disposition:='TERMINAL_NO_SEND';
    v_transition_applied:=true;
  else
    v_retry_not_before:=v_now+make_interval(secs=>case
      when v_reason='RATE_LIMITED' then 60
      when v_reason in ('QUIET_HOURS','CONSENT_MISSING','GROUP_DIRECTORY_STALE','GROUP_NOT_ALLOWLISTED') then 300
      else 30 end);
    update public.openclaw_outbox outbox set
      state='QUEUED',claim_token_hash=null,claimed_cell_id=null,lease_expires_at=null,
      retry_not_before=v_retry_not_before,terminal_at=null,updated_at=v_now
    where outbox.organization_id=v_org and outbox.account_id=v_account
      and outbox.id=v_outbox.id and outbox.state='LEASED'
      and outbox.claim_generation=v_outbox.claim_generation;
    if not found then raise exception 'retry preflight transition CAS failed' using errcode='40001'; end if;
    v_disposition:='SAFE_RETRY';
    v_transition_applied:=true;
  end if;
  return jsonb_build_object('version',1,'outboxId',v_outbox.id,'decision',v_reason,
    'disposition',v_disposition,'transitionApplied',v_transition_applied,
    'canonicalPayload',case when v_reason='ALLOWED' then v_outbox.canonical_payload else null end,
    'authorizationMarker',v_authorization_marker,'databaseTime',v_now,
    'retryNotBefore',v_retry_not_before);
end;
$function$;

create or replace function app_private.openclaw_authorize_outbox_send_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_marker jsonb := p_request -> 'authorizationMarker';
  v_authorization public.openclaw_outbound_authorizations%rowtype;
  v_marker_hash text;
  v_claim_token_hash text;
  v_outbox public.openclaw_outbox%rowtype;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','claimToken','authorizationMarker'],
    array['version','claimToken','authorizationMarker']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_marker,
    array['version','outboxId','claimGeneration','payloadHash','fencingToken',
      'sessionGeneration','controlVersion','takeoverVersion','markerNonce','expiresAt'],
    array['version','outboxId','claimGeneration','payloadHash','fencingToken',
      'sessionGeneration','controlVersion','takeoverVersion','markerNonce','expiresAt']
  );
  if p_request ->> 'version' <> '1'
     or v_marker ->> 'version' <> '1'
     or nullif(p_request ->> 'claimToken', '') is null
     or nullif(v_marker ->> 'markerNonce', '') is null
  then
    raise exception 'private outbox authorization contract is invalid' using errcode='42501';
  end if;
  v_marker_hash := encode(extensions.digest(convert_to('ihome-openclaw-handoff-marker-v1','UTF8')
    || decode('00','hex') || convert_to(v_marker ->> 'markerNonce','UTF8'),'sha256'),'hex');
  v_claim_token_hash := encode(extensions.digest(convert_to('ihome-openclaw-outbox-claim-v1','UTF8')
    || decode('00','hex') || convert_to(p_request ->> 'claimToken','UTF8'),'sha256'),'hex');
  update public.openclaw_outbound_authorizations handoff
  set consumed_at = statement_timestamp(), authorized_handoff_at = statement_timestamp()
  where handoff.organization_id=v_org and handoff.account_id=v_account
    and handoff.outbox_id=(v_marker ->> 'outboxId')::uuid
    and handoff.claim_generation=(v_marker ->> 'claimGeneration')::bigint
    and handoff.payload_hash=v_marker ->> 'payloadHash'
    and handoff.fencing_token=(v_marker ->> 'fencingToken')::bigint
    and handoff.session_generation=(v_marker ->> 'sessionGeneration')::bigint
    and handoff.control_version=(v_marker ->> 'controlVersion')::bigint
    and handoff.takeover_version=(v_marker ->> 'takeoverVersion')::bigint
    and handoff.marker_nonce_hash=v_marker_hash
    and handoff.expires_at=(v_marker ->> 'expiresAt')::timestamptz
    and handoff.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and handoff.session_generation=(p_principal ->> 'sessionGeneration')::bigint
    and handoff.consumed_at is null and handoff.expires_at > statement_timestamp()
    and handoff.lease_expires_at > statement_timestamp()
    and exists (
      select 1
      from public.openclaw_outbox outbox
      join public.openclaw_control_states control
        on control.organization_id=outbox.organization_id and control.control_key='GLOBAL_STOP'
      where outbox.organization_id=handoff.organization_id
        and outbox.account_id=handoff.account_id and outbox.id=handoff.outbox_id
        and outbox.state='LEASED' and not control.global_stop and control.feature_enabled
        and outbox.claim_token_hash=v_claim_token_hash
        and outbox.claimed_cell_id=(p_principal ->> 'cellId')::uuid
        and outbox.fencing_token=(p_principal ->> 'fencingToken')::bigint
        and outbox.session_generation=(p_principal ->> 'sessionGeneration')::bigint
        and control.control_version=handoff.control_version
        and coalesce((
          select max(takeover.takeover_version)
          from public.openclaw_takeovers takeover
          join public.openclaw_conversations conversation
            on conversation.organization_id=takeover.organization_id
           and conversation.account_id=takeover.account_id
           and conversation.id=takeover.conversation_id
          where takeover.organization_id=outbox.organization_id
            and takeover.account_id=outbox.account_id and conversation.target_id=outbox.target_id
        ),0)=handoff.takeover_version
    )
  returning handoff.* into v_authorization;
  if not found then raise exception 'outbound authorization CAS failed' using errcode='40001'; end if;
  update public.openclaw_outbox outbox
  set state = 'DISPATCHING', dispatching_at = statement_timestamp(), updated_at = statement_timestamp()
  where outbox.organization_id=v_org and outbox.account_id=v_account and outbox.id=v_authorization.outbox_id
    and outbox.state = 'LEASED' and outbox.claim_generation=v_authorization.claim_generation
    and outbox.payload_hash=v_authorization.payload_hash
    and outbox.claim_token_hash=v_claim_token_hash
    and outbox.claimed_cell_id=(p_principal ->> 'cellId')::uuid
    and outbox.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and outbox.session_generation=(p_principal ->> 'sessionGeneration')::bigint
    and outbox.lease_expires_at > statement_timestamp()
  returning outbox.* into v_outbox;
  if not found then raise exception 'outbox authorize transition CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'outboxId',v_outbox.id,
    'authorizationId',v_authorization.id,'state',v_outbox.state,
    'authorizedHandoffAt',v_authorization.authorized_handoff_at,
    'canonicalPayload',v_outbox.canonical_payload,'payloadHash',v_outbox.payload_hash);
end;
$function$;

create or replace function app_private.openclaw_requeue_pre_handoff_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_authorization jsonb := p_request -> 'authorization';
  v_marker jsonb := p_request -> 'authorization' -> 'authorizationMarker';
  v_evidence jsonb := p_request -> 'preHandoffEvidence';
  v_outbox public.openclaw_outbox%rowtype;
  v_handoff public.openclaw_outbound_authorizations%rowtype;
  v_token_hash text;
  v_marker_hash text;
  v_evidence_hash text;
  v_retry_not_before timestamptz;
  v_now timestamptz := statement_timestamp();
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','authorization','outcome','reasonCode','preHandoffEvidence',
      'preHandoffEvidenceHash','retryNotBefore'],
    array['version','authorization','outcome','reasonCode','preHandoffEvidence',
      'preHandoffEvidenceHash','retryNotBefore']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_authorization,
    array['version','claimToken','authorizationMarker'],
    array['version','claimToken','authorizationMarker']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_marker,
    array['version','outboxId','claimGeneration','payloadHash','fencingToken',
      'sessionGeneration','controlVersion','takeoverVersion','markerNonce','expiresAt'],
    array['version','outboxId','claimGeneration','payloadHash','fencingToken',
      'sessionGeneration','controlVersion','takeoverVersion','markerNonce','expiresAt']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_evidence,
    array['version','evidenceKind','outboxId','claimGeneration','payloadHash',
      'authorizationMarker','reasonCode','authorizedHandoffRecorded'],
    array['version','evidenceKind','outboxId','claimGeneration','payloadHash',
      'authorizationMarker','reasonCode','authorizedHandoffRecorded']
  );
  if p_request ->> 'version' <> '1'
     or v_authorization ->> 'version' <> '1'
     or v_marker ->> 'version' <> '1'
     or v_evidence ->> 'version' <> '1'
     or p_request ->> 'outcome' <> 'SAFE_RETRY'
     or v_evidence ->> 'evidenceKind' <> 'OUTBOX_PRE_HANDOFF'
     or p_request ->> 'reasonCode' not in (
       'AUTHORIZATION_EXPIRED','LEASE_EXPIRED','CELL_FENCED',
       'SESSION_GENERATION_CHANGED','CONTROL_VERSION_CHANGED','TAKEOVER_VERSION_CHANGED',
       'POLICY_CHANGED_BEFORE_HANDOFF','ADAPTER_NOT_READY','EGRESS_BLOCKED_BEFORE_HANDOFF'
     )
     or v_evidence ->> 'reasonCode' is distinct from p_request ->> 'reasonCode'
     or v_evidence -> 'authorizedHandoffRecorded' is distinct from 'false'::jsonb
     or char_length(v_authorization ->> 'claimToken') not between 32 and 512
     or v_evidence -> 'authorizationMarker' is distinct from v_marker
     or v_evidence ->> 'outboxId' is distinct from v_marker ->> 'outboxId'
     or v_evidence ->> 'claimGeneration' is distinct from v_marker ->> 'claimGeneration'
     or v_evidence ->> 'payloadHash' is distinct from v_marker ->> 'payloadHash'
     or coalesce(v_marker ->> 'payloadHash','') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'canonical pre-handoff requeue contract is invalid' using errcode='22023';
  end if;
  v_retry_not_before := (p_request ->> 'retryNotBefore')::timestamptz;
  if v_retry_not_before < v_now or v_retry_not_before > v_now + interval '1 hour' then
    raise exception 'pre-handoff retryNotBefore is outside the bounded window' using errcode='22023';
  end if;
  v_evidence_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-pre-handoff-evidence-v1','UTF8') || decode('00','hex')
      || app_private.openclaw_jcs_bytes_v1(v_evidence),
    'sha256'
  ),'hex');
  if p_request ->> 'preHandoffEvidenceHash' is distinct from v_evidence_hash then
    raise exception 'pre-handoff evidence hash mismatch' using errcode='22023';
  end if;
  v_token_hash := encode(extensions.digest(convert_to('ihome-openclaw-outbox-claim-v1','UTF8')
    || decode('00','hex') || convert_to(v_authorization ->> 'claimToken','UTF8'),'sha256'),'hex');
  v_marker_hash := encode(extensions.digest(convert_to('ihome-openclaw-handoff-marker-v1','UTF8')
    || decode('00','hex') || convert_to(v_marker ->> 'markerNonce','UTF8'),'sha256'),'hex');
  select outbox.* into v_outbox
  from public.openclaw_outbox outbox
  where outbox.organization_id=v_org and outbox.account_id=v_account
    and outbox.id=(v_marker ->> 'outboxId')::uuid
    and outbox.state='LEASED'
    and outbox.claim_generation=(v_marker ->> 'claimGeneration')::bigint
    and outbox.payload_hash=v_marker ->> 'payloadHash'
    and outbox.claim_token_hash=v_token_hash
    and outbox.claimed_cell_id=(p_principal ->> 'cellId')::uuid
    and outbox.fencing_token=(v_marker ->> 'fencingToken')::bigint
    and outbox.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and outbox.session_generation=(v_marker ->> 'sessionGeneration')::bigint
    and outbox.session_generation=(p_principal ->> 'sessionGeneration')::bigint
    and outbox.control_version=(v_marker ->> 'controlVersion')::bigint
    and outbox.takeover_version=(v_marker ->> 'takeoverVersion')::bigint
  for update;
  if not found then raise exception 'pre-handoff requeue CAS failed' using errcode='40001'; end if;
  select handoff.* into v_handoff
  from public.openclaw_outbound_authorizations handoff
  where handoff.organization_id=v_org and handoff.account_id=v_account
    and handoff.outbox_id=v_outbox.id and handoff.claim_generation=v_outbox.claim_generation
    and handoff.payload_hash=v_outbox.payload_hash
    and handoff.fencing_token=v_outbox.fencing_token
    and handoff.session_generation=v_outbox.session_generation
    and handoff.control_version=v_outbox.control_version
    and handoff.takeover_version=v_outbox.takeover_version
    and handoff.marker_nonce_hash=v_marker_hash
    and handoff.expires_at=(v_marker ->> 'expiresAt')::timestamptz
    and handoff.consumed_at is null and handoff.authorized_handoff_at is null
  for update;
  if not found then raise exception 'pre-handoff authorization marker CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_delivery_attempts(
    organization_id,account_id,outbox_id,authorization_id,claim_generation,
    attempt_number,outcome,reason_code,total_part_count,
    possible_handoff_prefix_length,known_provider_message_ids,evidence_kind,
    delivery_evidence,delivery_evidence_hash,started_at,finished_at
  ) values (
    v_org,v_account,v_outbox.id,v_handoff.id,v_outbox.claim_generation,
    v_outbox.attempt_count,'SAFE_RETRY',p_request ->> 'reasonCode',1,
    0,'{}'::text[],'OUTBOX_PRE_HANDOFF',v_evidence,v_evidence_hash,v_now,v_now
  );
  update public.openclaw_outbox outbox
  set state = 'QUEUED', claim_token_hash = null, claimed_cell_id = null,
      claim_generation = outbox.claim_generation + 1,
      lease_expires_at = null, retry_not_before = v_retry_not_before,
      updated_at = statement_timestamp()
  where outbox.organization_id=v_org and outbox.account_id=v_account
    and outbox.id=v_outbox.id and outbox.state='LEASED'
    and outbox.claim_generation=v_outbox.claim_generation;
  if not found then raise exception 'pre-handoff requeue transition CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'outboxId',v_outbox.id,'state','QUEUED',
    'claimGeneration',v_outbox.claim_generation+1,
    'preHandoffEvidenceHash',v_evidence_hash,'retryNotBefore',v_retry_not_before);
end;
$function$;

create or replace function app_private.openclaw_complete_outbox_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_authorization_request jsonb := p_request -> 'authorization';
  v_marker jsonb := p_request -> 'authorization' -> 'authorizationMarker';
  v_evidence jsonb := p_request -> 'deliveryEvidence';
  v_outbox public.openclaw_outbox%rowtype;
  v_authorization public.openclaw_outbound_authorizations%rowtype;
  v_outcome text := p_request ->> 'outcome';
  v_reason text := p_request ->> 'reasonCode';
  v_ids text[];
  v_prefix integer;
  v_parts integer;
  v_claim_token_hash text;
  v_marker_hash text;
  v_evidence_hash text;
  v_now timestamptz := statement_timestamp();
  v_existing record;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','authorization','deliveryEvidence','deliveryEvidenceHash','outcome','reasonCode'],
    array['version','authorization','deliveryEvidence','deliveryEvidenceHash','outcome','reasonCode']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_authorization_request,
    array['version','claimToken','authorizationMarker'],
    array['version','claimToken','authorizationMarker']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_marker,
    array['version','outboxId','claimGeneration','payloadHash','fencingToken',
      'sessionGeneration','controlVersion','takeoverVersion','markerNonce','expiresAt'],
    array['version','outboxId','claimGeneration','payloadHash','fencingToken',
      'sessionGeneration','controlVersion','takeoverVersion','markerNonce','expiresAt']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_evidence,
    array['version','evidenceKind','outboxId','claimGeneration','payloadHash',
      'authorizationMarker','totalPartCount','knownProviderMessageIds',
      'possibleHandoffPrefixLength','outcome','reasonCode'],
    array['version','evidenceKind','outboxId','claimGeneration','payloadHash',
      'authorizationMarker','totalPartCount','knownProviderMessageIds',
      'possibleHandoffPrefixLength','outcome','reasonCode']
  );
  if p_request ->> 'version' <> '1'
     or v_authorization_request ->> 'version' <> '1'
     or v_marker ->> 'version' <> '1'
     or v_evidence ->> 'version' <> '1'
     or v_evidence ->> 'evidenceKind' <> 'OUTBOX_DELIVERY'
     or v_outcome not in ('SENT','FAILED','UNKNOWN')
     or v_evidence ->> 'outcome' is distinct from v_outcome
     or v_evidence ->> 'reasonCode' is distinct from v_reason
     or v_evidence -> 'authorizationMarker' is distinct from v_marker
     or v_evidence ->> 'outboxId' is distinct from v_marker ->> 'outboxId'
     or v_evidence ->> 'claimGeneration' is distinct from v_marker ->> 'claimGeneration'
     or v_evidence ->> 'payloadHash' is distinct from v_marker ->> 'payloadHash'
     or char_length(v_authorization_request ->> 'claimToken') not between 32 and 512
     or coalesce(v_marker ->> 'payloadHash','') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(v_evidence -> 'knownProviderMessageIds') <> 'array'
  then
    raise exception 'canonical outbox completion contract is invalid' using errcode='22023';
  end if;
  v_ids := coalesce(array(select jsonb_array_elements_text(
    v_evidence -> 'knownProviderMessageIds'
  )), '{}'::text[]);
  v_prefix := (v_evidence ->> 'possibleHandoffPrefixLength')::integer;
  v_parts := (v_evidence ->> 'totalPartCount')::integer;
  if v_parts not between 1 and 20 or v_prefix < 0 or v_prefix > v_parts
     or cardinality(v_ids) > v_prefix
     or exists (select 1 from unnest(v_ids) provider_id
       where char_length(provider_id) not between 1 and 255)
     or (v_outcome='SENT' and (
       v_reason<>'ALL_PARTS_ACKNOWLEDGED' or v_prefix<>v_parts or cardinality(v_ids)<>v_parts
     ))
     or (v_outcome='FAILED' and (
       v_reason<>'PROVIDER_REJECTED_BEFORE_ACCEPT' or v_prefix<>0 or cardinality(v_ids)<>0
     ))
     or (v_outcome='UNKNOWN' and (
       v_prefix<1 or v_reason not in (
         'PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF',
         'PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF',
         'ACK_LOST_AFTER_HANDOFF'
       )
     ))
  then
    raise exception 'canonical delivery evidence outcome is inconsistent' using errcode='22023';
  end if;
  v_evidence_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-delivery-evidence-v1','UTF8') || decode('00','hex')
      || app_private.openclaw_jcs_bytes_v1(v_evidence),
    'sha256'
  ),'hex');
  if p_request ->> 'deliveryEvidenceHash' is distinct from v_evidence_hash then
    raise exception 'delivery evidence hash mismatch' using errcode='22023';
  end if;
  v_claim_token_hash := encode(extensions.digest(convert_to('ihome-openclaw-outbox-claim-v1','UTF8')
    || decode('00','hex') || convert_to(v_authorization_request ->> 'claimToken','UTF8'),'sha256'),'hex');
  v_marker_hash := encode(extensions.digest(convert_to('ihome-openclaw-handoff-marker-v1','UTF8')
    || decode('00','hex') || convert_to(v_marker ->> 'markerNonce','UTF8'),'sha256'),'hex');

  select outbox.id,outbox.state,attempt.delivery_evidence_hash,
    attempt.known_provider_message_ids,attempt.possible_handoff_prefix_length
  into v_existing
  from public.openclaw_outbox outbox
  join public.openclaw_delivery_attempts attempt
    on attempt.organization_id=outbox.organization_id and attempt.account_id=outbox.account_id
   and attempt.outbox_id=outbox.id
  join public.openclaw_outbound_authorizations handoff
    on handoff.organization_id=attempt.organization_id and handoff.account_id=attempt.account_id
   and handoff.id=attempt.authorization_id
  where outbox.organization_id=v_org and outbox.account_id=v_account
    and outbox.id=(v_marker ->> 'outboxId')::uuid and outbox.state=v_outcome
    and attempt.claim_generation=(v_marker ->> 'claimGeneration')::bigint
    and attempt.delivery_evidence_hash=v_evidence_hash
    and handoff.marker_nonce_hash=v_marker_hash;
  if found then
    return jsonb_build_object('version',1,'outboxId',v_existing.id,'state',v_existing.state,
      'knownProviderMessageIds',to_jsonb(v_existing.known_provider_message_ids),
      'possibleHandoffPrefixLength',v_existing.possible_handoff_prefix_length,
      'deliveryEvidenceHash',v_existing.delivery_evidence_hash);
  end if;

  select outbox.* into v_outbox from public.openclaw_outbox outbox
  where outbox.organization_id=v_org and outbox.account_id=v_account
    and outbox.id=(v_marker ->> 'outboxId')::uuid
    and outbox.state = 'DISPATCHING'
    and outbox.claim_generation=(v_marker ->> 'claimGeneration')::bigint
    and outbox.payload_hash=v_marker ->> 'payloadHash'
    and outbox.claim_token_hash=v_claim_token_hash
    and outbox.claimed_cell_id=(p_principal ->> 'cellId')::uuid
    and outbox.fencing_token=(v_marker ->> 'fencingToken')::bigint
    and outbox.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and outbox.session_generation=(v_marker ->> 'sessionGeneration')::bigint
    and outbox.session_generation=(p_principal ->> 'sessionGeneration')::bigint
    and outbox.control_version=(v_marker ->> 'controlVersion')::bigint
    and outbox.takeover_version=(v_marker ->> 'takeoverVersion')::bigint
  for update;
  if not found then raise exception 'outbox completion CAS failed' using errcode='40001'; end if;
  select handoff.* into v_authorization
  from public.openclaw_outbound_authorizations handoff
  where handoff.organization_id=v_org and handoff.account_id=v_account
    and handoff.outbox_id=v_outbox.id and handoff.claim_generation=v_outbox.claim_generation
    and handoff.payload_hash=v_outbox.payload_hash
    and handoff.fencing_token=v_outbox.fencing_token
    and handoff.session_generation=v_outbox.session_generation
    and handoff.control_version=v_outbox.control_version
    and handoff.takeover_version=v_outbox.takeover_version
    and handoff.marker_nonce_hash=v_marker_hash
    and handoff.expires_at=(v_marker ->> 'expiresAt')::timestamptz
    and handoff.consumed_at is not null and handoff.authorized_handoff_at is not null;
  if not found then raise exception 'authorized handoff evidence is stale' using errcode='40001'; end if;
  insert into public.openclaw_delivery_attempts(
    organization_id, account_id, outbox_id, authorization_id, claim_generation,
    attempt_number, outcome, reason_code, total_part_count,
    possible_handoff_prefix_length, known_provider_message_ids, evidence_kind,
    delivery_evidence, delivery_evidence_hash, started_at, finished_at
  ) values (
    v_org,v_account,v_outbox.id,v_authorization.id,v_outbox.claim_generation,
    v_outbox.attempt_count,v_outcome,v_reason,v_parts,
    v_prefix,v_ids,'OUTBOX_DELIVERY',v_evidence,v_evidence_hash,
    v_authorization.authorized_handoff_at,v_now
  );
  update public.openclaw_outbox outbox
  set state=v_outcome, claim_token_hash=null, claimed_cell_id=null, lease_expires_at=null,
      dispatching_at=null, terminal_at=statement_timestamp(), updated_at=statement_timestamp()
  where outbox.organization_id=v_org and outbox.id=v_outbox.id
    and outbox.state='DISPATCHING' and outbox.claim_generation=v_outbox.claim_generation;
  return jsonb_build_object('version',1,'outboxId',v_outbox.id,'state',v_outcome,
    'knownProviderMessageIds',to_jsonb(v_ids),'possibleHandoffPrefixLength',v_prefix,
    'deliveryEvidenceHash',v_evidence_hash);
end;
$function$;

create or replace function app_private.openclaw_claim_work_item_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text := p_principal ->> 'principalKind';
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_limit integer := greatest(1,least(coalesce((p_request ->> 'limit')::integer,10),25));
  v_lease_seconds integer := greatest(5,least(coalesce((p_request ->> 'leaseSeconds')::integer,30),60));
  v_token_hash text;
  v_items jsonb;
begin
  if p_request ->> 'version' <> '1' or v_kind not in ('CHANNEL','MAINTENANCE') then
    raise exception 'work claim version or principalKind invalid' using errcode='22023';
  end if;
  v_token_hash := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    || decode('00','hex') || convert_to(p_request ->> 'claimToken','UTF8'),'sha256'),'hex');
  if v_kind = 'CHANNEL' then
    if not exists (
      select 1 from public.openclaw_runtime_credentials credential
      where credential.organization_id=v_org
        and credential.account_id=(p_principal ->> 'accountId')::uuid
        and credential.cell_id=(p_principal ->> 'cellId')::uuid
        and credential.credential_generation=(p_principal ->> 'credentialGeneration')::bigint
        and credential.revoked_at is null
    ) then raise exception 'channel credentialGeneration is stale' using errcode='42501'; end if;
    with candidates as (
      select work.id from public.openclaw_send_work_items work
      where work.organization_id=v_org and work.account_id=(p_principal ->> 'accountId')::uuid
        and work.cell_id=(p_principal ->> 'cellId')::uuid
        and work.work_kind <> 'INBOUND_AUTOMATION' and work.state='QUEUED'
        and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
        and work.session_generation=(p_principal ->> 'sessionGeneration')::bigint
        and (work.retry_not_before is null or work.retry_not_before <= statement_timestamp())
      order by work.created_at,work.id for update skip locked limit v_limit
    ), claimed as (
      update public.openclaw_send_work_items work
      set state='LEASED', claim_token_hash=v_token_hash,
          claim_generation=work.claim_generation+1,
          lease_expires_at=statement_timestamp()+make_interval(secs=>v_lease_seconds),
          attempt_count=work.attempt_count+1, updated_at=statement_timestamp()
      from candidates where work.organization_id=v_org and work.id=candidates.id
      returning work.id,work.work_kind,work.claim_generation,work.lease_expires_at,
        work.source_id,work.source_version,work.source_hash,work.payload,work.payload_hash
    )
    select coalesce(jsonb_agg(jsonb_build_object('workItemId',id,'workKind',work_kind,
      'claimGeneration',claim_generation,'leaseExpiresAt',lease_expires_at,
      'sourceId',source_id,'sourceVersion',source_version,'sourceHash',source_hash,
      'payload',payload,'payloadHash',payload_hash) order by id),'[]'::jsonb)
    into v_items from claimed;
  else
    if not exists (
      select 1 from public.openclaw_maintenance_credentials credential
      where credential.organization_id=v_org
        and credential.maintenance_principal_id=(p_principal ->> 'maintenancePrincipalId')::uuid
        and credential.credential_generation=(p_principal ->> 'credentialGeneration')::bigint
        and credential.revoked_at is null
    ) then raise exception 'maintenance credentialGeneration is stale' using errcode='42501'; end if;
    with candidates as (
      select work.id from public.openclaw_maintenance_work_items work
      where work.organization_id=v_org
        and work.maintenance_principal_id=(p_principal ->> 'maintenancePrincipalId')::uuid
        and work.state='QUEUED'
        and work.maintenance_lease_generation=(p_principal ->> 'leaseGeneration')::bigint
        and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
        and (work.retry_not_before is null or work.retry_not_before <= statement_timestamp())
      order by work.created_at,work.id for update skip locked limit v_limit
    ), claimed as (
      update public.openclaw_maintenance_work_items work
      set state='LEASED',claim_token_hash=v_token_hash,
          claim_generation=work.claim_generation+1,
          lease_expires_at=statement_timestamp()+make_interval(secs=>v_lease_seconds),
          attempt_count=work.attempt_count+1,updated_at=statement_timestamp()
      from candidates where work.organization_id=v_org and work.id=candidates.id
      returning work.id,work.work_kind,work.work_phase,work.claim_generation,
        work.lease_expires_at,work.source_id,work.source_version,work.source_hash,
        work.payload,work.payload_hash
    )
    select coalesce(jsonb_agg(jsonb_build_object('workItemId',id,'workKind',work_kind,
      'workPhase',work_phase,'claimGeneration',claim_generation,'leaseExpiresAt',lease_expires_at,
      'sourceId',source_id,'sourceVersion',source_version,'sourceHash',source_hash,
      'payload',payload,'payloadHash',payload_hash) order by id),'[]'::jsonb)
    into v_items from claimed;
  end if;
  return jsonb_build_object('version',1,'principalKind',v_kind,
    'credentialGeneration',(p_principal ->> 'credentialGeneration')::bigint,
    'fencingToken',(p_principal ->> 'fencingToken')::bigint,'items',v_items);
end;
$function$;

create or replace function app_private.openclaw_complete_work_item_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text := p_principal ->> 'principalKind';
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_work uuid := (p_request ->> 'workItemId')::uuid;
  v_claim bigint := (p_request ->> 'claimGeneration')::bigint;
  v_outcome text := p_request ->> 'outcome';
  v_token_hash text;
  v_evidence jsonb := coalesce(p_request -> 'evidence','{}'::jsonb);
  v_attempt integer;
begin
  if p_request ->> 'version' <> '1' or v_outcome not in ('COMPLETE','RETRY','FAILED','DEAD_LETTER') then
    raise exception 'work completion version or outcome invalid' using errcode='22023';
  end if;
  v_token_hash := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    || decode('00','hex') || convert_to(p_request ->> 'claimToken','UTF8'),'sha256'),'hex');
  if v_kind='CHANNEL' then
    select work.attempt_count into v_attempt from public.openclaw_send_work_items work
    where work.organization_id=v_org and work.account_id=(p_principal ->> 'accountId')::uuid
      and work.id=v_work and work.state='LEASED' and work.claim_generation=v_claim
      and work.claim_token_hash=v_token_hash and work.cell_id=(p_principal ->> 'cellId')::uuid
      and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
      and work.session_generation=(p_principal ->> 'sessionGeneration')::bigint
      and work.lease_expires_at > statement_timestamp() for update;
    if not found then raise exception 'channel work completion CAS failed' using errcode='40001'; end if;
    insert into public.openclaw_send_work_attempts(
      organization_id,account_id,cell_id,work_item_id,claim_generation,fencing_token,
      session_generation,attempt_number,outcome,evidence,evidence_hash
    ) values (
      v_org,(p_principal ->> 'accountId')::uuid,(p_principal ->> 'cellId')::uuid,v_work,v_claim,
      (p_principal ->> 'fencingToken')::bigint,(p_principal ->> 'sessionGeneration')::bigint,
      v_attempt,v_outcome,v_evidence,
      encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex')
    );
    update public.openclaw_send_work_items work
    set state=case when v_outcome='RETRY' then 'QUEUED' else v_outcome end,
        claim_token_hash=null,lease_expires_at=null,
        retry_not_before=case when v_outcome='RETRY' then statement_timestamp()
          + make_interval(secs=>greatest(1,least(coalesce((p_request ->> 'retryAfterSeconds')::integer,5),3600))) end,
        terminal_at=case when v_outcome='RETRY' then null else statement_timestamp() end,
        updated_at=statement_timestamp()
    where work.organization_id=v_org and work.id=v_work and work.state='LEASED' and work.claim_generation=v_claim;
  elsif v_kind='MAINTENANCE' then
    select work.attempt_count into v_attempt from public.openclaw_maintenance_work_items work
    where work.organization_id=v_org
      and work.maintenance_principal_id=(p_principal ->> 'maintenancePrincipalId')::uuid
      and work.id=v_work and work.state='LEASED' and work.claim_generation=v_claim
      and work.claim_token_hash=v_token_hash
      and work.maintenance_lease_generation=(p_principal ->> 'leaseGeneration')::bigint
      and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
      and work.lease_expires_at > statement_timestamp() for update;
    if not found then raise exception 'maintenance work completion CAS failed' using errcode='40001'; end if;
    insert into public.openclaw_maintenance_work_attempts(
      organization_id,maintenance_principal_id,work_item_id,claim_generation,
      maintenance_lease_generation,fencing_token,attempt_number,outcome,evidence,evidence_hash
    ) values (
      v_org,(p_principal ->> 'maintenancePrincipalId')::uuid,v_work,v_claim,
      (p_principal ->> 'leaseGeneration')::bigint,(p_principal ->> 'fencingToken')::bigint,
      v_attempt,v_outcome,v_evidence,
      encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex')
    );
    update public.openclaw_maintenance_work_items work
    set state=case when v_outcome='RETRY' then 'QUEUED' else v_outcome end,
        claim_token_hash=null,lease_expires_at=null,
        retry_not_before=case when v_outcome='RETRY' then statement_timestamp()
          + make_interval(secs=>greatest(1,least(coalesce((p_request ->> 'retryAfterSeconds')::integer,5),3600))) end,
        terminal_at=case when v_outcome='RETRY' then null else statement_timestamp() end,
        updated_at=statement_timestamp()
    where work.organization_id=v_org and work.id=v_work and work.state='LEASED' and work.claim_generation=v_claim;
  else raise exception 'principalKind must be CHANNEL or MAINTENANCE' using errcode='42501';
  end if;
  return jsonb_build_object('version',1,'principalKind',v_kind,'workItemId',v_work,'outcome',v_outcome);
end;
$function$;

create or replace function app_private.openclaw_create_outbox_from_work_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_account uuid := (p_principal ->> 'accountId')::uuid;
  v_work public.openclaw_send_work_items%rowtype;
  v_source_kind text;
  v_payload jsonb := p_request -> 'canonicalPayload';
  v_payload_hash text;
  v_source_snapshot_hash text;
  v_target uuid;
  v_control_version bigint;
  v_takeover_version bigint;
  v_claim_token_hash text;
  v_inbound_token_hash text;
  v_outbox uuid;
begin
  if p_request ->> 'version' <> '1' or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'version 1 canonical payload required' using errcode='22023';
  end if;
  v_claim_token_hash := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    || decode('00','hex') || convert_to(p_request ->> 'claimToken','UTF8'),'sha256'),'hex');
  v_inbound_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-inbound-automation-claim-v1','UTF8')
      || decode('00','hex') || convert_to(p_request ->> 'claimToken','UTF8'),'sha256'
  ),'hex');
  select work.* into v_work from public.openclaw_send_work_items work
  where work.organization_id=v_org and work.account_id=v_account
    and work.id=(p_request ->> 'workItemId')::uuid and work.state='LEASED'
    and work.claim_generation=(p_request ->> 'claimGeneration')::bigint
    and work.claim_token_hash in (v_claim_token_hash,v_inbound_token_hash)
    and work.cell_id=(p_principal ->> 'cellId')::uuid
    and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and work.session_generation=(p_principal ->> 'sessionGeneration')::bigint
    and work.lease_expires_at > statement_timestamp() for update;
  if not found then raise exception 'create outbox work CAS failed' using errcode='40001'; end if;
  v_payload_hash := app_private.openclaw_send_payload_hash_v1(v_payload);
  if v_payload_hash is distinct from p_request ->> 'payloadHash' then
    raise exception 'payload_hash does not match canonical send bytes' using errcode='22023';
  end if;
  if v_payload ->> 'organizationId' is distinct from v_org::text
     or v_payload ->> 'accountId' is distinct from v_account::text
     or not exists (select 1 from public.openclaw_accounts account
       where account.organization_id=v_org and account.id=v_account
         and account.account_profile=(v_payload ->> 'accountProfile')) then
    raise exception 'canonical payload tenant or account profile mismatch' using errcode='42501';
  end if;
  select target.id into v_target from public.openclaw_targets target
  where target.organization_id=v_org and target.account_id=v_account
    and target.kind=(v_payload #>> '{target,kind}')
    and target.provider_id=(v_payload #>> '{target,providerId}') and target.is_active;
  if not found then raise exception 'canonical target is not active in tenant' using errcode='42501'; end if;
  if v_work.work_kind='INBOUND_AUTOMATION' then
    v_source_kind := 'INBOUND_REPLY'; v_source_snapshot_hash := v_work.source_hash;
  elsif v_work.work_kind='SCHEDULE_OCCURRENCE' then
    v_source_kind := 'SCHEDULE';
    select snapshot.snapshot_hash into v_source_snapshot_hash
    from public.openclaw_schedule_snapshots snapshot
    where snapshot.organization_id=v_org and snapshot.account_id=v_account
      and snapshot.schedule_id=(v_work.payload ->> 'scheduleId')::uuid
      and snapshot.schedule_version=(v_work.payload ->> 'scheduleVersion')::bigint;
  elsif v_work.work_kind='CRM_EVENT' then
    v_source_kind := 'CRM_EVENT';
    select snapshot.snapshot_hash into v_source_snapshot_hash
    from public.openclaw_crm_event_subscription_snapshots snapshot
    where snapshot.organization_id=v_org and snapshot.account_id=v_account
      and snapshot.subscription_id=(v_work.payload ->> 'subscriptionId')::uuid
      and snapshot.subscription_version=(v_work.payload ->> 'subscriptionVersion')::bigint;
  else raise exception 'unsupported work kind' using errcode='22023';
  end if;
  if v_source_snapshot_hash is distinct from v_work.source_hash
     or v_source_snapshot_hash is distinct from p_request ->> 'sourceSnapshotHash' then
    raise exception 'source_hash snapshot mismatch' using errcode='40001';
  end if;
  if exists (
    select 1 from public.openclaw_targets target
    where target.organization_id=v_org and target.account_id=v_account
      and target.id=v_target and target.kind='SALES_GROUP'
      and target.directory_refreshed_at <= statement_timestamp()-interval '24 hours'
  ) then raise exception 'GROUP_DIRECTORY_STALE' using errcode='55000'; end if;
  select control.control_version into v_control_version
  from public.openclaw_control_states control
  where control.organization_id=v_org and control.control_key='GLOBAL_STOP';
  if not found then raise exception 'OpenClaw control state is missing' using errcode='42501'; end if;
  select coalesce(max(takeover.takeover_version),0) into v_takeover_version
  from public.openclaw_takeovers takeover
  join public.openclaw_conversations conversation
    on conversation.organization_id=takeover.organization_id
   and conversation.account_id=takeover.account_id and conversation.id=takeover.conversation_id
  where takeover.organization_id=v_org and takeover.account_id=v_account
    and conversation.target_id=v_target;
  insert into public.openclaw_outbox(
    organization_id,account_id,target_id,source_kind,inbound_event_id,automation_version_id,
    schedule_id,schedule_version,subscription_id,subscription_version,occurrence_id,
    campaign_id,campaign_version,idempotency_key,canonical_payload,canonical_payload_bytes,
    payload_hash,fencing_token,session_generation,control_version,takeover_version,smoke_run_id
  ) values (
    v_org,v_account,v_target,v_source_kind,
    case when v_source_kind='INBOUND_REPLY' then v_work.source_id end,
    nullif(v_work.payload ->> 'automationVersionId','')::uuid,
    nullif(v_work.payload ->> 'scheduleId','')::uuid,nullif(v_work.payload ->> 'scheduleVersion','')::bigint,
    nullif(v_work.payload ->> 'subscriptionId','')::uuid,nullif(v_work.payload ->> 'subscriptionVersion','')::bigint,
    nullif(v_work.payload ->> 'occurrenceId','')::uuid,nullif(v_work.payload ->> 'campaignId','')::uuid,
    nullif(v_work.payload ->> 'campaignVersion','')::bigint,
    v_payload ->> 'idempotencyKey',
    v_payload,app_private.openclaw_canonical_send_payload_bytes_v1(v_payload),v_payload_hash,
    v_work.fencing_token,v_work.session_generation,v_control_version,v_takeover_version,
    v_work.smoke_run_id
  ) on conflict (organization_id,account_id,idempotency_key) do update
    set updated_at=public.openclaw_outbox.updated_at
  returning id into v_outbox;
  return jsonb_build_object('version',1,'workItemId',v_work.id,'outboxId',v_outbox,
    'sourceKind',v_source_kind,'sourceSnapshotHash',v_source_snapshot_hash,'payloadHash',v_payload_hash);
end;
$function$;

create or replace function app_private.openclaw_issue_media_ticket_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_kind text := p_principal ->> 'principalKind';
  v_media public.openclaw_message_media%rowtype;
  v_jti uuid := gen_random_uuid();
  v_issued timestamptz := statement_timestamp();
  v_payload jsonb;
  v_ticket_hash text;
begin
  if p_request ->> 'version' <> '1' or p_request ->> 'access' not in ('READ','DELETE') then
    raise exception 'media ticket version or access invalid' using errcode='22023';
  end if;
  select media.* into v_media from public.openclaw_message_media media
  where media.organization_id=v_org and media.id=(p_request ->> 'mediaId')::uuid
    and (v_kind='MAINTENANCE' or media.account_id=(p_principal ->> 'accountId')::uuid)
    and media.object_key is not null
    and ((p_request ->> 'access'='READ' and media.byte_state='AVAILABLE')
      or (p_request ->> 'access'='DELETE' and media.byte_state='QUARANTINED'));
  if not found then raise exception 'media not available for requested access' using errcode='42501'; end if;
  v_payload := jsonb_build_object('version',1,'jti',v_jti,'organizationId',v_org,
    'mediaId',v_media.id,'objectKey',v_media.object_key,'access',p_request ->> 'access',
    'sha256',v_media.sha256,'issuedAt',v_issued,'expiresAt',v_issued+interval '5 seconds',
    'credentialGeneration',(p_principal ->> 'credentialGeneration')::bigint,
    'leaseGeneration',(p_principal ->> 'leaseGeneration')::bigint,
    'fencingToken',(p_principal ->> 'fencingToken')::bigint);
  v_ticket_hash := encode(extensions.digest(convert_to('ihome-openclaw-media-ticket-v1','UTF8')
    || decode('00','hex') || app_private.openclaw_jcs_bytes_v1(v_payload),'sha256'),'hex');
  return jsonb_build_object('version',1,'ticket',v_payload,'ticketHash',v_ticket_hash);
end;
$function$;

create or replace function app_private.openclaw_complete_retention_quarantine_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_maintenance uuid := (p_principal ->> 'maintenancePrincipalId')::uuid;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_tombstone uuid;
  v_subject_kind text := p_request ->> 'subjectKind';
  v_subject uuid := (p_request ->> 'subjectId')::uuid;
  v_quarantined timestamptz := statement_timestamp();
begin
  if p_request ->> 'version' <> '1' then raise exception 'retention quarantine version mismatch' using errcode='22023'; end if;
  select work.* into v_work from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org and work.maintenance_principal_id=v_maintenance
    and work.id=(p_request ->> 'workItemId')::uuid and work.work_kind='RETENTION_DELETE'
    and work.work_phase='QUARANTINE' and work.state='LEASED'
    and work.claim_generation=(p_request ->> 'claimGeneration')::bigint
    and work.maintenance_lease_generation=(p_principal ->> 'leaseGeneration')::bigint
    and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and work.lease_expires_at > statement_timestamp() for update;
  if not found then raise exception 'retention quarantine CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_retention_tombstones(
    organization_id,maintenance_principal_id,work_item_id,subject_kind,subject_id,
    retention_version,hold_version,quarantine_version,object_key,redaction_evidence_hash,
    quarantined_at,final_delete_not_before
  ) values (
    v_org,v_maintenance,v_work.id,v_subject_kind,v_subject,
    (p_request ->> 'retentionVersion')::bigint,(p_request ->> 'holdVersion')::bigint,
    (p_request ->> 'quarantineVersion')::bigint,
    case when v_subject_kind='MEDIA' then p_request ->> 'objectKey' end,
    p_request ->> 'redactionEvidenceHash',v_quarantined,
    case when v_subject_kind='MEDIA' then v_quarantined+interval '7 days' end
  ) returning id into v_tombstone;
  if v_subject_kind='MEDIA' then
    update public.openclaw_message_media media
    set byte_state='QUARANTINED',retention_delete_not_before=v_quarantined+interval '7 days',
        updated_at=statement_timestamp()
    where media.organization_id=v_org and media.id=v_subject and media.object_key=p_request ->> 'objectKey'
      and media.byte_state in ('CACHED','AVAILABLE');
    if not found then raise exception 'media quarantine CAS failed' using errcode='40001'; end if;
  end if;
  update public.openclaw_maintenance_work_items work
  set state='COMPLETE',claim_token_hash=null,lease_expires_at=null,
      terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_work.id and work.state='LEASED';
  return jsonb_build_object('version',1,'tombstoneId',v_tombstone,
    'finalDeleteNotBefore',case when v_subject_kind='MEDIA' then v_quarantined+interval '7 days' end);
end;
$function$;

create or replace function app_private.openclaw_authorize_retention_delete_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_maintenance uuid := (p_principal ->> 'maintenancePrincipalId')::uuid;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_tomb public.openclaw_retention_tombstones%rowtype;
  v_issued timestamptz := statement_timestamp();
  v_expires timestamptz;
  v_payload jsonb;
  v_bytes bytea;
  v_id uuid;
begin
  if p_request ->> 'version' <> '1' then raise exception 'retention authorization version mismatch' using errcode='22023'; end if;
  select work.* into v_work from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org and work.maintenance_principal_id=v_maintenance
    and work.id=(p_request ->> 'workItemId')::uuid and work.work_kind='RETENTION_DELETE'
    and work.work_phase='FINAL_DELETE' and work.state='LEASED'
    and work.claim_generation=(p_request ->> 'claimGeneration')::bigint
    and work.maintenance_lease_generation=(p_principal ->> 'leaseGeneration')::bigint
    and work.fencing_token=(p_principal ->> 'fencingToken')::bigint
    and work.lease_expires_at > v_issued for update;
  if not found then raise exception 'retention delete work CAS failed' using errcode='40001'; end if;
  select tombstone.* into v_tomb from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org and tombstone.id=(p_request ->> 'tombstoneId')::uuid
    and tombstone.subject_kind='MEDIA' and tombstone.final_delete_not_before <= v_issued
    and tombstone.hold_version=(p_request ->> 'holdVersion')::bigint for update;
  if not found then raise exception 'final_delete_not_before or hold_version mismatch' using errcode='40001'; end if;
  if exists (select 1 from public.openclaw_retention_holds hold
    where hold.organization_id=v_org and hold.target_kind='MEDIA' and hold.target_id=v_tomb.subject_id
      and hold.released_at is null and (hold.expires_at is null or hold.expires_at > v_issued)) then
    raise exception 'active legal hold blocks retention delete' using errcode='42501';
  end if;
  v_expires := least(v_issued+interval '5 seconds',v_work.lease_expires_at);
  v_payload := jsonb_build_object('version',1,'organizationId',v_org,'workItemId',v_work.id,
    'tombstoneId',v_tomb.id,'objectKey',v_tomb.object_key,'holdVersion',v_tomb.hold_version,
    'quarantineVersion',v_tomb.quarantine_version,'deleteTicketJti',(p_request ->> 'deleteTicketJti')::uuid,
    'deleteAuthorizationJti',(p_request ->> 'deleteAuthorizationJti')::uuid,
    'issuedAt',v_issued,'expiresAt',v_expires);
  v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  insert into public.openclaw_retention_delete_authorizations(
    organization_id,maintenance_principal_id,work_item_id,tombstone_id,claim_generation,
    fencing_token,object_key,hold_version,quarantine_version,delete_ticket_jti,
    delete_authorization_jti,authorization_payload,authorization_bytes,authorization_hash,
    gateway_signing_key_generation,issued_at,expires_at,work_lease_expires_at
  ) values (
    v_org,v_maintenance,v_work.id,v_tomb.id,v_work.claim_generation,v_work.fencing_token,
    v_tomb.object_key,v_tomb.hold_version,v_tomb.quarantine_version,
    (p_request ->> 'deleteTicketJti')::uuid,(p_request ->> 'deleteAuthorizationJti')::uuid,
    v_payload,v_bytes,encode(extensions.digest(convert_to('ihome-openclaw-retention-authorization-v1','UTF8')
      || decode('00','hex') || v_bytes,'sha256'),'hex'),
    (p_request ->> 'gatewaySigningKeyGeneration')::bigint,v_issued,v_expires,v_work.lease_expires_at
  ) returning id into v_id;
  return jsonb_build_object('version',1,'authorizationId',v_id,'authorization',v_payload,
    'expiresAt',v_expires,'holdVersion',v_tomb.hold_version);
end;
$function$;

create or replace function app_private.openclaw_finalize_retention_delete_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_maintenance uuid := (p_principal ->> 'maintenancePrincipalId')::uuid;
  v_auth public.openclaw_retention_delete_authorizations%rowtype;
  v_receipt jsonb := p_request -> 'gatewayReceipt';
  v_receipt_hash text;
  v_outcome text := p_request ->> 'gatewayOutcome';
  v_attempt integer;
begin
  if p_request ->> 'version' <> '1' or v_outcome not in ('DELETED','NOT_FOUND')
     or jsonb_typeof(v_receipt) <> 'object' then
    raise exception 'retention finalize version, outcome, or gateway_receipt invalid' using errcode='22023';
  end if;
  select delete_authz.* into v_auth
  from public.openclaw_retention_delete_authorizations delete_authz
  where delete_authz.organization_id=v_org and delete_authz.maintenance_principal_id=v_maintenance
    and delete_authz.id=(p_request ->> 'authorizationId')::uuid
    and delete_authz.delete_authorization_jti=(p_request ->> 'deleteAuthorizationJti')::uuid
    and delete_authz.gateway_signing_key_generation=(p_request ->> 'gatewaySigningKeyGeneration')::bigint
    and delete_authz.revoked_at is null and delete_authz.finalized_at is null
    and delete_authz.expires_at > statement_timestamp() for update;
  if not found then raise exception 'retention authorization finalize CAS failed' using errcode='40001'; end if;
  v_receipt_hash := encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_receipt),'sha256'),'hex');
  update public.openclaw_retention_delete_authorizations delete_authz
  set receipt=v_receipt,receipt_hash=v_receipt_hash,finalized_at=statement_timestamp()
  where delete_authz.organization_id=v_org and delete_authz.id=v_auth.id and delete_authz.finalized_at is null;
  update public.openclaw_message_media media set byte_state='DELETED',object_key=null,updated_at=statement_timestamp()
  from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org and tombstone.id=v_auth.tombstone_id
    and media.organization_id=tombstone.organization_id and media.id=tombstone.subject_id
    and media.object_key=v_auth.object_key and media.byte_state='QUARANTINED';
  select work.attempt_count into v_attempt from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org and work.id=v_auth.work_item_id and work.state='LEASED' for update;
  if not found then raise exception 'retention work completion CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_maintenance_work_attempts(
    organization_id,maintenance_principal_id,work_item_id,claim_generation,
    maintenance_lease_generation,fencing_token,attempt_number,outcome,
    gateway_receipt,receipt_hash,evidence,evidence_hash
  ) values (
    v_org,v_maintenance,v_auth.work_item_id,v_auth.claim_generation,
    (p_principal ->> 'leaseGeneration')::bigint,(p_principal ->> 'fencingToken')::bigint,
    v_attempt,'COMPLETE',v_receipt,v_receipt_hash,
    jsonb_build_object('gatewayOutcome',v_outcome,'authorizationId',v_auth.id),v_receipt_hash
  );
  update public.openclaw_maintenance_work_items work
  set state='COMPLETE',claim_token_hash=null,lease_expires_at=null,
      terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_auth.work_item_id and work.state='LEASED';
  return jsonb_build_object('version',1,'authorizationId',v_auth.id,
    'gatewayOutcome',v_outcome,'receiptHash',v_receipt_hash,'finalized',true);
end;
$function$;

create or replace function app_private.openclaw_ack_audit_anchor_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_root uuid := (p_request ->> 'auditRootId')::uuid;
  v_receipt jsonb := p_request -> 'gatewayReceipt';
  v_receipt_hash text;
  v_updated uuid;
begin
  if p_request ->> 'version' <> '1' or nullif(p_request ->> 'verifyTicketJti','') is null
     or jsonb_typeof(v_receipt) <> 'object' then
    raise exception 'audit anchor acknowledgement is invalid' using errcode='22023';
  end if;
  v_receipt_hash := encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_receipt),'sha256'),'hex');
  update public.openclaw_audit_roots root
  set signature_hash=p_request ->> 'signatureHash',gateway_receipt=v_receipt,
      gateway_receipt_hash=v_receipt_hash,anchored_at=statement_timestamp()
  where root.organization_id=v_org and root.id=v_root and root.anchored_at is null
    and root.root_hash=p_request ->> 'rootHash'
    and root.signing_key_generation=(p_request ->> 'auditSigningKeyGeneration')::bigint
  returning root.id into v_updated;
  if v_updated is null then raise exception 'audit anchor CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'auditRootId',v_updated,
    'verifyTicketJti',p_request ->> 'verifyTicketJti','gatewayReceiptHash',v_receipt_hash,
    'auditSigningKeyGeneration',(p_request ->> 'auditSigningKeyGeneration')::bigint);
end;
$function$;

create or replace function app_private.openclaw_record_watchdog_health_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_event jsonb;
  v_count integer := 0;
begin
  if p_request ->> 'version' <> '1' or jsonb_typeof(p_request -> 'events') <> 'array'
     or jsonb_array_length(p_request -> 'events') < 1
     or jsonb_array_length(p_request -> 'events') > 100 then
    raise exception 'bounded watchdog health events required' using errcode='22023';
  end if;
  for v_event in select value from jsonb_array_elements(p_request -> 'events') loop
    insert into public.openclaw_health_events(
      organization_id,account_id,cell_id,severity,health_kind,status,fingerprint,
      content_free_metrics,observed_at
    ) values (
      v_org,nullif(v_event ->> 'accountId','')::uuid,nullif(v_event ->> 'cellId','')::uuid,
      v_event ->> 'severity',v_event ->> 'healthKind',v_event ->> 'status',
      v_event ->> 'fingerprint',coalesce(v_event -> 'contentFreeMetrics','{}'::jsonb),
      coalesce(nullif(v_event ->> 'observedAt','')::timestamptz,statement_timestamp())
    );
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('version',1,'recorded',v_count,'databaseTime',statement_timestamp());
end;
$function$;

create or replace function app_private.openclaw_begin_rollout_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_id uuid;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','reviewedCommitSha','migrationManifestSha256','upstreamSri','upstreamGitHead',
      'patchSeriesSha256','builtTgzSha256','artifactDigests','projectRef'],
    array['version','reviewedCommitSha','migrationManifestSha256','upstreamSri','upstreamGitHead',
      'patchSeriesSha256','builtTgzSha256','artifactDigests','projectRef']
  );
  if p_request ->> 'version' <> '1' then raise exception 'rollout version mismatch' using errcode='22023'; end if;
  insert into public.openclaw_rollout_runs(
    organization_id,reviewed_commit_sha,migration_manifest_sha256,upstream_sri,
    upstream_git_head,patch_series_sha256,built_tgz_sha256,artifact_digests,
    project_ref,stage,stage_version,stage_entered_at,status
  ) values (
    v_org,p_request ->> 'reviewedCommitSha',p_request ->> 'migrationManifestSha256',
    p_request ->> 'upstreamSri',p_request ->> 'upstreamGitHead',
    p_request ->> 'patchSeriesSha256',p_request ->> 'builtTgzSha256',
    p_request -> 'artifactDigests',p_request ->> 'projectRef','FOUNDATION',1,
    statement_timestamp(),'RUNNING'
  ) returning id into v_id;
  return jsonb_build_object('version',1,'rolloutRunId',v_id,'stage','FOUNDATION','stageVersion',1);
end;
$function$;

create or replace function app_private.openclaw_record_rollout_checkpoint_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_run public.openclaw_rollout_runs%rowtype;
  v_id uuid;
begin
  if p_request ->> 'version' <> '1' then raise exception 'checkpoint version mismatch' using errcode='22023'; end if;
  if p_request ->> 'status' not in ('WAITING','COMPLETE','FAILED') then
    raise exception 'checkpoint status invalid' using errcode='22023';
  end if;
  select run.* into v_run from public.openclaw_rollout_runs run
  where run.organization_id=v_org and run.id=(p_request ->> 'rolloutRunId')::uuid
    and run.stage_version=(p_request ->> 'expectedStageVersion')::bigint
    and run.status='RUNNING' for update;
  if not found then raise exception 'rollout checkpoint CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_rollout_checkpoints(
    organization_id,rollout_run_id,checkpoint_name,stage,status,
    trusted_evidence_id,trusted_evidence_hash,completed_at
  ) values (
    v_org,v_run.id,p_request ->> 'checkpointName',v_run.stage,p_request ->> 'status',
    nullif(p_request ->> 'trustedEvidenceId','')::uuid,p_request ->> 'trustedEvidenceHash',
    case when p_request ->> 'status'='COMPLETE' then statement_timestamp() end
  ) on conflict (organization_id,rollout_run_id,checkpoint_name) do update
    set status=excluded.status,trusted_evidence_id=excluded.trusted_evidence_id,
        trusted_evidence_hash=excluded.trusted_evidence_hash,completed_at=excluded.completed_at
    where public.openclaw_rollout_checkpoints.status='WAITING'
      and public.openclaw_rollout_checkpoints.stage=excluded.stage
  returning id into v_id;
  if v_id is null then raise exception 'rollout checkpoint transition CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'checkpointId',v_id,'stage',v_run.stage,
    'stageVersion',v_run.stage_version,'status',p_request ->> 'status');
end;
$function$;

create or replace function app_private.openclaw_record_rollout_observation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_run public.openclaw_rollout_runs%rowtype;
  v_metrics jsonb := p_request -> 'contentFreeMetrics';
  v_hash text;
  v_id uuid;
begin
  if p_request ->> 'version' <> '1' or jsonb_typeof(v_metrics) <> 'object' then
    raise exception 'rollout observation invalid' using errcode='22023';
  end if;
  if (p_request ->> 'windowEndedAt')::timestamptz > statement_timestamp()+interval '30 seconds'
     or (p_request ->> 'windowEndedAt')::timestamptz <= (p_request ->> 'windowStartedAt')::timestamptz then
    raise exception 'rollout observation window is invalid' using errcode='22023';
  end if;
  select run.* into v_run from public.openclaw_rollout_runs run
  where run.organization_id=v_org and run.id=(p_request ->> 'rolloutRunId')::uuid
    and run.stage_version=(p_request ->> 'expectedStageVersion')::bigint
    and run.status='RUNNING';
  if not found then raise exception 'rollout observation CAS failed' using errcode='40001'; end if;
  v_hash := encode(extensions.digest(convert_to('ihome-openclaw-rollout-observation-v1','UTF8')
    || decode('00','hex') || app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
      'stage',v_run.stage,'stageVersion',v_run.stage_version,
      'windowStartedAt',p_request ->> 'windowStartedAt','windowEndedAt',p_request ->> 'windowEndedAt',
      'passed',(p_request ->> 'passed')::boolean,'contentFreeMetrics',v_metrics
    )),'sha256'),'hex');
  insert into public.openclaw_rollout_observations(
    organization_id,rollout_run_id,stage,window_started_at,window_ended_at,
    passed,content_free_metrics,observation_hash
  ) values (
    v_org,v_run.id,v_run.stage,(p_request ->> 'windowStartedAt')::timestamptz,
    (p_request ->> 'windowEndedAt')::timestamptz,(p_request ->> 'passed')::boolean,v_metrics,v_hash
  ) returning id into v_id;
  return jsonb_build_object('version',1,'observationId',v_id,'observationHash',v_hash);
end;
$function$;

create or replace function app_private.openclaw_resume_rollout_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_run public.openclaw_rollout_runs%rowtype;
begin
  if p_request ->> 'version' <> '1' then raise exception 'rollout resume version mismatch' using errcode='22023'; end if;
  update public.openclaw_rollout_runs run
  set status='RUNNING',stage_version=run.stage_version+1,stage_entered_at=statement_timestamp()
  where run.organization_id=v_org and run.id=(p_request ->> 'rolloutRunId')::uuid
    and run.stage_version=(p_request ->> 'expectedStageVersion')::bigint and run.status='PAUSED'
  returning run.* into v_run;
  if not found then raise exception 'rollout resume CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'rolloutRunId',v_run.id,'status',v_run.status,
    'stage',v_run.stage,'stageVersion',v_run.stage_version);
end;
$function$;

create or replace function app_private.openclaw_advance_rollout_stage_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_run public.openclaw_rollout_runs%rowtype;
  v_next text := p_request ->> 'nextStage';
  v_now timestamptz := statement_timestamp();
begin
  if p_request ->> 'version' <> '1' then raise exception 'advance rollout version mismatch' using errcode='22023'; end if;
  select run.* into v_run from public.openclaw_rollout_runs run
  where run.organization_id=v_org and run.id=(p_request ->> 'rolloutRunId')::uuid
    and run.stage_version=(p_request ->> 'expectedStageVersion')::bigint
    and run.status='RUNNING' for update;
  if not found then raise exception 'rollout stage CAS failed' using errcode='40001'; end if;
  if not ((v_run.stage='FOUNDATION' and v_next='INFRASTRUCTURE')
    or (v_run.stage='INFRASTRUCTURE' and v_next='WAITING_OWNER_QR')
    or (v_run.stage='WAITING_OWNER_QR' and v_next='CONNECTION')
    or (v_run.stage='CONNECTION' and v_next='SHADOW')
    or (v_run.stage='SHADOW' and v_next='WAITING_OWNER_INBOUND')
    or (v_run.stage='WAITING_OWNER_INBOUND' and v_next='LIMITED_OBSERVING')
    or (v_run.stage='LIMITED_OBSERVING' and v_next='LIMITED_VERIFIED')
    or (v_run.stage='LIMITED_VERIFIED' and v_next='PROACTIVE')
    or (v_run.stage='PROACTIVE' and v_next='SALES_GROUPS')
    or (v_run.stage='SALES_GROUPS' and v_next='COMPLETE')) then
    raise exception 'invalid rollout stage transition' using errcode='22023';
  end if;
  if v_run.stage in ('WAITING_OWNER_QR','WAITING_OWNER_INBOUND') and not exists (
    select 1 from public.openclaw_rollout_checkpoints checkpoint
    where checkpoint.organization_id=v_org and checkpoint.rollout_run_id=v_run.id
      and checkpoint.checkpoint_name=v_run.stage and checkpoint.status='COMPLETE'
      and checkpoint.trusted_evidence_id is not null
  ) then raise exception 'owner checkpoint has no trusted evidence' using errcode='42501'; end if;
  if v_run.stage='SHADOW' and (
    v_run.shadow_started_at is null or v_run.shadow_started_at > v_now-interval '48 hours'
    or v_run.continuous_green_started_at is null
    or v_run.continuous_green_started_at > v_now-interval '48 hours'
  ) then raise exception 'SHADOW requires 48 continuous green hours' using errcode='42501'; end if;
  if v_run.stage='LIMITED_OBSERVING' and (
    v_run.continuous_green_started_at is null
    or v_run.continuous_green_started_at > v_now-interval '72 hours'
  ) then raise exception 'LIMITED_OBSERVING requires 72 continuous green hours' using errcode='42501'; end if;
  update public.openclaw_rollout_runs run
  set stage=v_next,stage_version=run.stage_version+1,stage_entered_at=v_now,
      shadow_started_at=case when v_next='SHADOW' then v_now else run.shadow_started_at end,
      continuous_green_started_at=case
        when v_next in ('SHADOW','LIMITED_OBSERVING') then v_now
        else run.continuous_green_started_at end,
      status=case when v_next='COMPLETE' then 'COMPLETE' else run.status end,
      completed_at=case when v_next='COMPLETE' then v_now end
  where run.organization_id=v_org and run.id=v_run.id and run.stage_version=v_run.stage_version
  returning run.* into v_run;
  if not found then raise exception 'rollout stage CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'rolloutRunId',v_run.id,'stage',v_run.stage,
    'stageVersion',v_run.stage_version,'status',v_run.status,'shadowStartedAt',v_run.shadow_started_at,
    'continuousGreenStartedAt',v_run.continuous_green_started_at);
end;
$function$;

create or replace function app_private.openclaw_begin_smoke_run_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_run public.openclaw_rollout_runs%rowtype;
  v_scope jsonb := p_request -> 'commandScope';
  v_scope_hash text;
  v_lineage_hash text;
  v_id uuid;
begin
  if p_request ->> 'version' <> '1' or jsonb_typeof(v_scope) <> 'object' then
    raise exception 'smoke run version or command scope invalid' using errcode='22023';
  end if;
  select run.* into v_run from public.openclaw_rollout_runs run
  where run.organization_id=v_org and run.id=(p_request ->> 'rolloutRunId')::uuid
    and run.stage_version=(p_request ->> 'expectedStageVersion')::bigint
    and run.status='RUNNING' for update;
  if not found then raise exception 'smoke rollout identity CAS failed' using errcode='40001'; end if;
  v_scope_hash := encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_scope),'sha256'),'hex');
  v_lineage_hash := encode(extensions.digest(convert_to('ihome-openclaw-smoke-lineage-v1','UTF8')
    || decode('00','hex') || app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
      'projectRef',v_run.project_ref,'reviewedCommitSha',v_run.reviewed_commit_sha,
      'rolloutRunId',v_run.id,'rolloutStage',v_run.stage,
      'rolloutStageVersion',v_run.stage_version,'commandScopeHash',v_scope_hash
    )),'sha256'),'hex');
  insert into public.openclaw_smoke_runs(
    organization_id,rollout_run_id,command_scope,command_scope_hash,status,started_at,
    project_ref,reviewed_commit_sha,rollout_stage,rollout_stage_version,lineage_hash
  ) values (
    v_org,v_run.id,v_scope,v_scope_hash,'RUNNING',statement_timestamp(),v_run.project_ref,
    v_run.reviewed_commit_sha,v_run.stage,v_run.stage_version,v_lineage_hash
  ) returning id into v_id;
  return jsonb_build_object('version',1,'smokeRunId',v_id,'lineageHash',v_lineage_hash,
    'commandScopeHash',v_scope_hash,'rolloutStage',v_run.stage,'rolloutStageVersion',v_run.stage_version);
end;
$function$;

create or replace function app_private.openclaw_record_smoke_observation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_smoke public.openclaw_smoke_runs%rowtype;
  v_ids uuid[] := coalesce(array(select value::text::uuid from jsonb_array_elements_text(p_request -> 'trustedRowIds') value),'{}'::uuid[]);
  v_rows_hash text;
  v_lineage_hash text;
  v_id uuid;
begin
  if p_request ->> 'version' <> '1' or cardinality(v_ids)=0
     or jsonb_typeof(p_request -> 'contentFreeMetrics') <> 'object' then
    raise exception 'smoke observation requires trusted_row_ids and content-free metrics' using errcode='22023';
  end if;
  select smoke.* into v_smoke from public.openclaw_smoke_runs smoke
  where smoke.organization_id=v_org and smoke.id=(p_request ->> 'smokeRunId')::uuid
    and smoke.status='RUNNING' for update;
  if not found then raise exception 'smoke observation run CAS failed' using errcode='40001'; end if;
  v_rows_hash := encode(extensions.digest(convert_to(array_to_string(v_ids,','),'UTF8'),'sha256'),'hex');
  v_lineage_hash := encode(extensions.digest(convert_to('ihome-openclaw-smoke-observation-v1','UTF8')
    || decode('00','hex') || app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
      'smokeLineageHash',v_smoke.lineage_hash,'observationKind',p_request ->> 'observationKind',
      'trustedRowsHash',v_rows_hash,'contentFreeMetrics',p_request -> 'contentFreeMetrics'
    )),'sha256'),'hex');
  insert into public.openclaw_smoke_observations(
    organization_id,smoke_run_id,rollout_run_id,rollout_stage,rollout_stage_version,
    observation_kind,trusted_row_ids,trusted_rows_hash,content_free_metrics,lineage_hash
  ) values (
    v_org,v_smoke.id,v_smoke.rollout_run_id,v_smoke.rollout_stage,v_smoke.rollout_stage_version,
    p_request ->> 'observationKind',v_ids,v_rows_hash,p_request -> 'contentFreeMetrics',v_lineage_hash
  ) returning id into v_id;
  return jsonb_build_object('version',1,'observationId',v_id,'trustedRowIds',to_jsonb(v_ids),
    'trustedRowsHash',v_rows_hash,'lineageHash',v_lineage_hash);
end;
$function$;

create or replace function app_private.openclaw_cleanup_smoke_run_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_smoke uuid := (p_request ->> 'smokeRunId')::uuid;
  v_outbox integer := 0;
  v_work integer := 0;
  v_maintenance integer := 0;
  v_dispatching integer := 0;
  v_generation bigint;
begin
  if p_request ->> 'version' <> '1' then raise exception 'smoke cleanup version mismatch' using errcode='22023'; end if;
  perform 1 from public.openclaw_smoke_runs smoke
  where smoke.organization_id=v_org and smoke.id=v_smoke and smoke.status in ('RUNNING','COMPLETE','FAILED') for update;
  if not found then raise exception 'smoke cleanup CAS failed' using errcode='40001'; end if;
  update public.openclaw_outbox outbox
  set state = 'UNKNOWN',
      claim_token_hash=null,claimed_cell_id=null,lease_expires_at=null,dispatching_at=null,
      terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where outbox.organization_id=v_org and outbox.smoke_run_id=v_smoke
    and outbox.state = 'DISPATCHING';
  get diagnostics v_dispatching = row_count;
  update public.openclaw_outbox outbox
  set state = 'FAILED',claim_token_hash=null,claimed_cell_id=null,lease_expires_at=null,
      terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where outbox.organization_id=v_org and outbox.smoke_run_id=v_smoke
    and outbox.state in ('QUEUED','LEASED');
  get diagnostics v_outbox = row_count;
  v_outbox := v_outbox + v_dispatching;
  update public.openclaw_send_work_items work
  set state='FAILED',claim_token_hash=null,lease_expires_at=null,
      terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.smoke_run_id=v_smoke and work.state in ('QUEUED','LEASED');
  get diagnostics v_work = row_count;
  update public.openclaw_maintenance_work_items work
  set state='FAILED',claim_token_hash=null,lease_expires_at=null,
      terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.smoke_run_id=v_smoke and work.state in ('QUEUED','LEASED');
  get diagnostics v_maintenance = row_count;
  update public.openclaw_smoke_runs smoke
  set status='CLEANED',cleanup_generation=smoke.cleanup_generation+1,finished_at=statement_timestamp()
  where smoke.organization_id=v_org and smoke.id=v_smoke
  returning smoke.cleanup_generation into v_generation;
  return jsonb_build_object('version',1,'smokeRunId',v_smoke,'cleanupGeneration',v_generation,
    'outboxCleaned',v_outbox,'sendWorkCleaned',v_work,'maintenanceWorkCleaned',v_maintenance);
end;
$function$;

create or replace function app_private.openclaw_verify_smoke_cleanup_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_smoke public.openclaw_smoke_runs%rowtype;
  v_residual record;
  v_proof jsonb;
  v_hash text;
  v_id uuid;
begin
  if p_request ->> 'version' <> '1' then raise exception 'smoke verify version mismatch' using errcode='22023'; end if;
  select smoke.* into v_smoke from public.openclaw_smoke_runs smoke
  where smoke.organization_id=v_org and smoke.id=(p_request ->> 'smokeRunId')::uuid
    and smoke.status='CLEANED' and smoke.cleanup_generation=(p_request ->> 'cleanupGeneration')::bigint
  for update;
  if not found then raise exception 'smoke cleanup verification CAS failed' using errcode='40001'; end if;
  select
    (select count(*) from public.openclaw_outbox outbox
      where outbox.organization_id=v_org and outbox.smoke_run_id=v_smoke.id and outbox.state='QUEUED')
      + (select count(*) from public.openclaw_send_work_items work
      where work.organization_id=v_org and work.smoke_run_id=v_smoke.id and work.state='QUEUED')
      + (select count(*) from public.openclaw_maintenance_work_items work
      where work.organization_id=v_org and work.smoke_run_id=v_smoke.id and work.state='QUEUED') as queued_residual,
    (select count(*) from public.openclaw_outbox outbox
      where outbox.organization_id=v_org and outbox.smoke_run_id=v_smoke.id and outbox.state='LEASED')
      + (select count(*) from public.openclaw_send_work_items work
      where work.organization_id=v_org and work.smoke_run_id=v_smoke.id and work.state='LEASED')
      + (select count(*) from public.openclaw_maintenance_work_items work
      where work.organization_id=v_org and work.smoke_run_id=v_smoke.id and work.state='LEASED') as leased_residual,
    (select count(*) from public.openclaw_outbox outbox
      where outbox.organization_id=v_org and outbox.smoke_run_id=v_smoke.id and outbox.state='DISPATCHING') as dispatching_residual
  into v_residual;
  if not (v_residual.queued_residual = 0 and v_residual.leased_residual = 0
      and v_residual.dispatching_residual = 0) then
    raise exception 'smoke cleanup has residual work' using errcode='55000';
  end if;
  v_proof := jsonb_build_object('version',1,'smokeRunId',v_smoke.id,
    'cleanupGeneration',v_smoke.cleanup_generation,'queuedResidual',v_residual.queued_residual,
    'leasedResidual',v_residual.leased_residual,'dispatchingResidual',v_residual.dispatching_residual);
  v_hash := encode(extensions.digest(convert_to('ihome-openclaw-smoke-cleanup-v1','UTF8')
    || decode('00','hex') || app_private.openclaw_jcs_bytes_v1(v_proof),'sha256'),'hex');
  insert into public.openclaw_smoke_cleanup_proofs(
    organization_id,smoke_run_id,cleanup_generation,queued_residual,
    leased_residual,dispatching_residual,proof_hash
  ) values (v_org,v_smoke.id,v_smoke.cleanup_generation,0,0,0,v_hash)
  returning id into v_id;
  return v_proof || jsonb_build_object('proofId',v_id,'proofHash',v_hash);
end;
$function$;

create or replace function app_private.openclaw_sweep_runtime_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text := p_principal ->> 'principalKind';
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_requeued integer := 0;
  v_unknown integer := 0;
  v_work integer := 0;
begin
  if p_request ->> 'version' <> '1' then raise exception 'runtime sweep version mismatch' using errcode='22023'; end if;
  if v_kind='CHANNEL' then
    update public.openclaw_outbox outbox
    set state = 'QUEUED',claim_token_hash=null,claimed_cell_id=null,lease_expires_at=null,
        claim_generation=outbox.claim_generation+1,
        retry_not_before=statement_timestamp(),updated_at=statement_timestamp()
    where outbox.organization_id=v_org and outbox.account_id=(p_principal ->> 'accountId')::uuid
      and outbox.state = 'LEASED' and outbox.lease_expires_at <= statement_timestamp()
      and not exists (select 1 from public.openclaw_outbound_authorizations handoff
        where handoff.organization_id=v_org and handoff.account_id=outbox.account_id
          and handoff.outbox_id=outbox.id and handoff.claim_generation=outbox.claim_generation
          and handoff.authorized_handoff_at is not null);
    get diagnostics v_requeued = row_count;
    update public.openclaw_outbox outbox
    set state = 'UNKNOWN',claim_token_hash=null,claimed_cell_id=null,lease_expires_at=null,
        dispatching_at=null,terminal_at=statement_timestamp(),updated_at=statement_timestamp()
    where outbox.organization_id=v_org and outbox.account_id=(p_principal ->> 'accountId')::uuid
      and outbox.state = 'DISPATCHING' and outbox.lease_expires_at <= statement_timestamp();
    get diagnostics v_unknown = row_count;
    update public.openclaw_send_work_items work
    set state = 'QUEUED',claim_token_hash=null,lease_expires_at=null,
        claim_generation=work.claim_generation+1,
        retry_not_before=statement_timestamp(),updated_at=statement_timestamp()
    where work.organization_id=v_org and work.account_id=(p_principal ->> 'accountId')::uuid
      and work.state = 'LEASED' and work.lease_expires_at <= statement_timestamp();
    get diagnostics v_work = row_count;
  elsif v_kind='MAINTENANCE' then
    update public.openclaw_maintenance_work_items work
    set state = 'QUEUED',claim_token_hash=null,lease_expires_at=null,
        claim_generation=work.claim_generation+1,
        retry_not_before=statement_timestamp(),updated_at=statement_timestamp()
    where work.organization_id=v_org
      and work.maintenance_principal_id=(p_principal ->> 'maintenancePrincipalId')::uuid
      and work.state = 'LEASED' and work.lease_expires_at <= statement_timestamp();
    get diagnostics v_work = row_count;
  else raise exception 'principalKind must be CHANNEL or MAINTENANCE' using errcode='42501';
  end if;
  return jsonb_build_object('version',1,'principalKind',v_kind,'outboxRequeued',v_requeued,
    'outboxUnknown',v_unknown,'workRequeued',v_work,'databaseTime',statement_timestamp());
end;
$function$;

-- Freeze ownership and EXECUTE boundaries after every function exists.
alter function app_private.openclaw_assert_strict_object_v1(jsonb,text[],text[]) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_assert_strict_object_v1(jsonb,text[],text[]) from public, anon, authenticated, service_role;
alter function app_private.openclaw_jcs_text_v1(jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_jcs_text_v1(jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_jcs_bytes_v1(jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_jcs_bytes_v1(jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_secure_digest_equal_v1(text,text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_secure_digest_equal_v1(text,text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_canonical_send_payload_bytes_v1(jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_canonical_send_payload_bytes_v1(jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_send_payload_hash_v1(jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_send_payload_hash_v1(jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_text_chunks_v1(text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_text_chunks_v1(text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_client_request_hash_v1(text,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_client_request_hash_v1(text,jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_begin_client_operation_v1(uuid,uuid,text,uuid,jsonb,text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_begin_client_operation_v1(uuid,uuid,text,uuid,jsonb,text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_complete_client_operation_v1(uuid,uuid,text,uuid,text,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_complete_client_operation_v1(uuid,uuid,text,uuid,text,jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_finish_browser_write_v1(uuid,uuid,text,uuid,text,text,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_finish_browser_write_v1(uuid,uuid,text,uuid,text,text,jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_validate_service_context_v1(jsonb,jsonb,jsonb,text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_validate_service_context_v1(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_consume_service_nonce_v1(jsonb,jsonb,jsonb,text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_consume_service_nonce_v1(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_browser_context_v1(jsonb,text,text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_browser_context_v1(jsonb,text,text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_browser_account_context_v1(jsonb,text,text) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_browser_account_context_v1(jsonb,text,text) from public, anon, authenticated, service_role;
alter function app_private.openclaw_apply_knowledge_write_v1(text,uuid,uuid,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_apply_knowledge_write_v1(text,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_apply_automation_write_v1(text,uuid,uuid,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_apply_automation_write_v1(text,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
alter function app_private.openclaw_apply_schedule_write_v1(text,uuid,uuid,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_apply_schedule_write_v1(text,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_assert_strict_object_v1(jsonb,text[],text[]) to openclaw_runtime_writer, openclaw_maintenance_writer;
grant execute on function app_private.openclaw_jcs_text_v1(jsonb) to openclaw_runtime_writer, openclaw_maintenance_writer;
grant execute on function app_private.openclaw_jcs_bytes_v1(jsonb) to openclaw_runtime_writer, openclaw_maintenance_writer;
grant execute on function app_private.openclaw_secure_digest_equal_v1(text,text) to openclaw_runtime_writer, openclaw_maintenance_writer;
grant execute on function app_private.openclaw_canonical_send_payload_bytes_v1(jsonb) to openclaw_runtime_writer;
grant execute on function app_private.openclaw_send_payload_hash_v1(jsonb) to openclaw_runtime_writer;
grant execute on function app_private.openclaw_text_chunks_v1(text) to openclaw_runtime_writer;
grant execute on function app_private.openclaw_validate_service_context_v1(jsonb,jsonb,jsonb,text) to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_consume_service_nonce_v1(jsonb,jsonb,jsonb,text) to openclaw_service_dispatcher;

alter function public.openclaw_get_bootstrap_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_bootstrap_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_bootstrap_v1(jsonb) to authenticated;
alter function public.openclaw_list_my_organizations_v1() owner to openclaw_function_owner;
revoke all on function public.openclaw_list_my_organizations_v1() from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_my_organizations_v1() to authenticated;
alter function public.openclaw_get_overview_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_overview_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_overview_v1(jsonb) to authenticated;
alter function public.openclaw_list_conversations_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_conversations_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_conversations_v1(jsonb) to authenticated;
alter function public.openclaw_resolve_media_object_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_resolve_media_object_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_resolve_media_object_v1(jsonb) to authenticated;
alter function public.openclaw_list_messages_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_messages_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_messages_v1(jsonb) to authenticated;
alter function public.openclaw_list_unknown_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_unknown_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_unknown_v1(jsonb) to authenticated;
alter function public.openclaw_list_unknown_by_account_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_unknown_by_account_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_unknown_by_account_v1(jsonb) to authenticated;
alter function public.openclaw_get_unknown_resolution_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_unknown_resolution_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_unknown_resolution_v1(jsonb) to authenticated;
alter function public.openclaw_list_knowledge_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_knowledge_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_knowledge_v1(jsonb) to authenticated;
alter function public.openclaw_get_knowledge_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_knowledge_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_knowledge_v1(jsonb) to authenticated;
alter function public.openclaw_preview_knowledge_retrieval_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_preview_knowledge_retrieval_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_preview_knowledge_retrieval_v1(jsonb) to authenticated;
alter function public.openclaw_list_automations_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_automations_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_automations_v1(jsonb) to authenticated;
alter function public.openclaw_get_automation_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_automation_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_automation_v1(jsonb) to authenticated;
alter function public.openclaw_dry_run_automation_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_dry_run_automation_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_dry_run_automation_v1(jsonb) to authenticated;
alter function public.openclaw_list_sales_groups_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_sales_groups_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_sales_groups_v1(jsonb) to authenticated;
alter function public.openclaw_list_schedules_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_schedules_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_schedules_v1(jsonb) to authenticated;
alter function public.openclaw_list_dead_letters_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_dead_letters_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_dead_letters_v1(jsonb) to authenticated;
alter function public.openclaw_list_dead_letters_by_account_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_dead_letters_by_account_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_dead_letters_by_account_v1(jsonb) to authenticated;
alter function public.openclaw_list_audit_events_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_audit_events_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_audit_events_v1(jsonb) to authenticated;
alter function public.openclaw_list_health_events_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_health_events_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_health_events_v1(jsonb) to authenticated;
alter function public.openclaw_list_health_events_by_account_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_health_events_by_account_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_health_events_by_account_v1(jsonb) to authenticated;
alter function public.openclaw_list_legal_holds_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_legal_holds_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_legal_holds_v1(jsonb) to authenticated;
alter function public.openclaw_poll_qr_login_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_poll_qr_login_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_poll_qr_login_v1(jsonb) to authenticated;
alter function public.openclaw_acknowledge_risk_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_acknowledge_risk_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_acknowledge_risk_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_begin_qr_login_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_begin_qr_login_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_begin_qr_login_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_consume_qr_challenge_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_consume_qr_challenge_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_consume_qr_challenge_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_disconnect_account_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_disconnect_account_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_disconnect_account_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_create_send_intent_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_create_send_intent_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_create_send_intent_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_takeover_conversation_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_takeover_conversation_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_takeover_conversation_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_release_takeover_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_release_takeover_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_release_takeover_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_resolve_unknown_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_resolve_unknown_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_resolve_unknown_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_set_control_state_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_set_control_state_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_set_control_state_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_publish_automation_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_publish_automation_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_publish_automation_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_publish_knowledge_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_publish_knowledge_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_publish_knowledge_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_upsert_group_allowlist_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_upsert_group_allowlist_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_upsert_group_allowlist_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_upsert_schedule_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_upsert_schedule_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_upsert_schedule_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_mark_conversation_read_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_mark_conversation_read_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_mark_conversation_read_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_assign_conversation_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_assign_conversation_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_assign_conversation_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_create_knowledge_draft_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_create_knowledge_draft_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_create_knowledge_draft_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_update_knowledge_draft_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_update_knowledge_draft_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_update_knowledge_draft_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_validate_knowledge_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_validate_knowledge_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_validate_knowledge_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_archive_knowledge_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_archive_knowledge_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_archive_knowledge_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_create_automation_draft_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_create_automation_draft_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_create_automation_draft_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_save_automation_step_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_save_automation_step_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_save_automation_step_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_pause_automation_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_pause_automation_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_pause_automation_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_request_directory_sync_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_request_directory_sync_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_request_directory_sync_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_pause_schedule_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_pause_schedule_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_pause_schedule_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_cancel_schedule_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_cancel_schedule_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_cancel_schedule_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_create_legal_hold_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_create_legal_hold_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_create_legal_hold_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_release_legal_hold_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_release_legal_hold_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_release_legal_hold_v1(jsonb,uuid) to authenticated;
alter function public.openclaw_replay_dead_letter_v1(jsonb,uuid) owner to openclaw_function_owner;
revoke all on function public.openclaw_replay_dead_letter_v1(jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_replay_dead_letter_v1(jsonb,uuid) to authenticated;

alter function app_private.openclaw_runtime_heartbeat_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_runtime_heartbeat_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_runtime_heartbeat_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_try_finalize_disconnect_v1(uuid,uuid,uuid) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_try_finalize_disconnect_v1(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_try_finalize_disconnect_v1(uuid,uuid,uuid)
  to openclaw_function_owner;
alter function app_private.openclaw_exchange_runtime_credential_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_exchange_runtime_credential_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_exchange_runtime_credential_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_exchange_maintenance_credential_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_exchange_maintenance_credential_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_exchange_maintenance_credential_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_submit_qr_result_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_submit_qr_result_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_submit_qr_result_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_ingest_inbound_batch_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_ingest_inbound_batch_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_ingest_inbound_batch_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_claim_inbound_automation_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_claim_inbound_automation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_claim_inbound_automation_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_complete_inbound_automation_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_complete_inbound_automation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_complete_inbound_automation_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_claim_outbox_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_claim_outbox_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_claim_outbox_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_preflight_outbox_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_preflight_outbox_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_preflight_outbox_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_authorize_outbox_send_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_authorize_outbox_send_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_authorize_outbox_send_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_requeue_pre_handoff_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_requeue_pre_handoff_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_requeue_pre_handoff_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_complete_outbox_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_complete_outbox_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_complete_outbox_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_claim_work_item_v1(jsonb,jsonb,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_claim_work_item_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_claim_work_item_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_complete_work_item_v1(jsonb,jsonb,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_complete_work_item_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_complete_work_item_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_create_outbox_from_work_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_create_outbox_from_work_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_create_outbox_from_work_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_issue_media_ticket_v1(jsonb,jsonb,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_issue_media_ticket_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_issue_media_ticket_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_complete_retention_quarantine_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_complete_retention_quarantine_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_complete_retention_quarantine_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_authorize_retention_delete_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_authorize_retention_delete_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_authorize_retention_delete_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_finalize_retention_delete_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_finalize_retention_delete_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_finalize_retention_delete_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_ack_audit_anchor_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_ack_audit_anchor_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_ack_audit_anchor_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_acquire_cell_lease_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_acquire_cell_lease_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_acquire_cell_lease_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_begin_cell_rebind_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_begin_cell_rebind_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_begin_cell_rebind_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_complete_cell_rebind_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_complete_cell_rebind_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_complete_cell_rebind_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_ack_generation_revocation_v1(jsonb,jsonb,jsonb) owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_ack_generation_revocation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_ack_generation_revocation_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_record_watchdog_health_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_record_watchdog_health_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_record_watchdog_health_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_begin_rollout_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_begin_rollout_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_begin_rollout_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_record_rollout_checkpoint_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_record_rollout_checkpoint_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_record_rollout_checkpoint_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_record_rollout_observation_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_record_rollout_observation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_record_rollout_observation_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_resume_rollout_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_resume_rollout_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_resume_rollout_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_advance_rollout_stage_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_advance_rollout_stage_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_advance_rollout_stage_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_begin_smoke_run_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_begin_smoke_run_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_begin_smoke_run_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_record_smoke_observation_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_record_smoke_observation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_record_smoke_observation_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_cleanup_smoke_run_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_cleanup_smoke_run_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_cleanup_smoke_run_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_verify_smoke_cleanup_v1(jsonb,jsonb,jsonb) owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_verify_smoke_cleanup_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_verify_smoke_cleanup_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;
alter function app_private.openclaw_sweep_runtime_v1(jsonb,jsonb,jsonb) owner to openclaw_function_owner;
revoke all on function app_private.openclaw_sweep_runtime_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_sweep_runtime_v1(jsonb,jsonb,jsonb) to openclaw_service_dispatcher;

revoke all on all tables in schema public from openclaw_service_dispatcher;
revoke all on all sequences in schema public from openclaw_service_dispatcher;

create or replace function public.openclaw_service_runtime_heartbeat_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_runtime_heartbeat_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_runtime_heartbeat_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_exchange_runtime_credential_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_exchange_runtime_credential_v1(
    p_principal, p_envelope, p_request
  );
  begin
    perform app_private.openclaw_consume_service_nonce_v1(
      v_context, p_envelope, p_request, 'EXCHANGE'
    );
  exception when sqlstate '42501' then
    raise exception 'credential exchange denied' using errcode = '42501';
  end;
  return v_context - array['operation','scope','requestHash','iat','exp','nonce'];
end;
$function$;

create or replace function public.openclaw_service_exchange_maintenance_credential_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_exchange_maintenance_credential_v1(
    p_principal, p_envelope, p_request
  );
  begin
    perform app_private.openclaw_consume_service_nonce_v1(
      v_context, p_envelope, p_request, 'EXCHANGE'
    );
  exception when sqlstate '42501' then
    raise exception 'credential exchange denied' using errcode = '42501';
  end;
  return v_context - array['operation','scope','requestHash','iat','exp','nonce'];
end;
$function$;

create or replace function public.openclaw_service_submit_qr_result_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_submit_qr_result_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_submit_qr_result_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_ingest_inbound_batch_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_ingest_inbound_batch_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_ingest_inbound_batch_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_claim_inbound_automation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_claim_inbound_automation_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_claim_inbound_automation_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_complete_inbound_automation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_complete_inbound_automation_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_complete_inbound_automation_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_claim_outbox_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_claim_outbox_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_claim_outbox_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_preflight_outbox_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_preflight_outbox_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_preflight_outbox_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_authorize_outbox_send_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_authorize_outbox_send_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_authorize_outbox_send_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_requeue_pre_handoff_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_requeue_pre_handoff_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_requeue_pre_handoff_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_complete_outbox_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_complete_outbox_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_complete_outbox_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_claim_work_item_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_claim_work_item_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_claim_work_item_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_complete_work_item_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_complete_work_item_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_complete_work_item_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_create_outbox_from_work_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_create_outbox_from_work_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_create_outbox_from_work_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_issue_media_ticket_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_issue_media_ticket_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_issue_media_ticket_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_complete_retention_quarantine_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_complete_retention_quarantine_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_complete_retention_quarantine_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_authorize_retention_delete_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_authorize_retention_delete_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_authorize_retention_delete_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_finalize_retention_delete_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_finalize_retention_delete_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_finalize_retention_delete_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_ack_audit_anchor_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_ack_audit_anchor_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_ack_audit_anchor_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_acquire_cell_lease_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_acquire_cell_lease_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_acquire_cell_lease_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_begin_cell_rebind_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_begin_cell_rebind_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_begin_cell_rebind_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_complete_cell_rebind_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_complete_cell_rebind_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_complete_cell_rebind_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_ack_generation_revocation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_ack_generation_revocation_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_ack_generation_revocation_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_record_watchdog_health_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_record_watchdog_health_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_record_watchdog_health_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_begin_rollout_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_begin_rollout_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_begin_rollout_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_record_rollout_checkpoint_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_record_rollout_checkpoint_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_record_rollout_checkpoint_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_record_rollout_observation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_record_rollout_observation_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_record_rollout_observation_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_resume_rollout_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_resume_rollout_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_resume_rollout_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_advance_rollout_stage_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_advance_rollout_stage_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_advance_rollout_stage_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_begin_smoke_run_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_begin_smoke_run_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_begin_smoke_run_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_record_smoke_observation_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_record_smoke_observation_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_record_smoke_observation_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_cleanup_smoke_run_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_cleanup_smoke_run_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_cleanup_smoke_run_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_verify_smoke_cleanup_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_verify_smoke_cleanup_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_verify_smoke_cleanup_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_sweep_runtime_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_sweep_runtime_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_sweep_runtime_v1(v_context, p_envelope, p_request);
end;
$function$;

-- Public service facades exist now; expose only to service_role.
alter function public.openclaw_service_runtime_heartbeat_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_runtime_heartbeat_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_runtime_heartbeat_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_exchange_runtime_credential_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_exchange_runtime_credential_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_exchange_runtime_credential_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_exchange_maintenance_credential_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_exchange_maintenance_credential_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_exchange_maintenance_credential_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_submit_qr_result_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_submit_qr_result_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_submit_qr_result_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_ingest_inbound_batch_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_ingest_inbound_batch_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_ingest_inbound_batch_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_claim_inbound_automation_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_claim_inbound_automation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_claim_inbound_automation_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_complete_inbound_automation_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_complete_inbound_automation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_complete_inbound_automation_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_claim_outbox_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_claim_outbox_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_claim_outbox_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_preflight_outbox_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_preflight_outbox_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_preflight_outbox_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_authorize_outbox_send_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_authorize_outbox_send_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_authorize_outbox_send_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_requeue_pre_handoff_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_requeue_pre_handoff_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_requeue_pre_handoff_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_complete_outbox_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_complete_outbox_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_complete_outbox_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_claim_work_item_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_claim_work_item_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_claim_work_item_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_complete_work_item_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_complete_work_item_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_complete_work_item_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_create_outbox_from_work_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_create_outbox_from_work_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_create_outbox_from_work_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_issue_media_ticket_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_issue_media_ticket_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_issue_media_ticket_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_complete_retention_quarantine_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_complete_retention_quarantine_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_complete_retention_quarantine_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_authorize_retention_delete_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_authorize_retention_delete_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_authorize_retention_delete_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_finalize_retention_delete_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_finalize_retention_delete_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_finalize_retention_delete_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_ack_audit_anchor_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_ack_audit_anchor_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_ack_audit_anchor_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_acquire_cell_lease_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_acquire_cell_lease_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_acquire_cell_lease_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_begin_cell_rebind_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_begin_cell_rebind_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_begin_cell_rebind_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_complete_cell_rebind_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_complete_cell_rebind_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_complete_cell_rebind_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_ack_generation_revocation_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_ack_generation_revocation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_ack_generation_revocation_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_record_watchdog_health_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_record_watchdog_health_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_record_watchdog_health_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_begin_rollout_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_begin_rollout_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_begin_rollout_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_record_rollout_checkpoint_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_record_rollout_checkpoint_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_record_rollout_checkpoint_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_record_rollout_observation_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_record_rollout_observation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_record_rollout_observation_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_resume_rollout_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_resume_rollout_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_resume_rollout_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_advance_rollout_stage_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_advance_rollout_stage_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_advance_rollout_stage_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_begin_smoke_run_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_begin_smoke_run_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_begin_smoke_run_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_record_smoke_observation_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_record_smoke_observation_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_record_smoke_observation_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_cleanup_smoke_run_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_cleanup_smoke_run_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_cleanup_smoke_run_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_verify_smoke_cleanup_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_verify_smoke_cleanup_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_verify_smoke_cleanup_v1(jsonb,jsonb,jsonb) to service_role;
alter function public.openclaw_service_sweep_runtime_v1(jsonb,jsonb,jsonb) owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_sweep_runtime_v1(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_service_sweep_runtime_v1(jsonb,jsonb,jsonb) to service_role;

-- The browser-facing consume facade intentionally never returns encrypted
-- material. QR reveal therefore uses this service-only, actor-bound atomic
-- consume: the locked row is copied into the one response while its stored
-- ciphertext is cleared in the same transaction. A replay is a stable
-- unavailable result and can never reveal the same QR twice.
create or replace function public.openclaw_service_consume_qr_challenge_v1(
  p_actor_id uuid,
  p_request jsonb,
  p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_request->>'organizationId')::uuid;
  v_account uuid := (p_request->>'accountId')::uuid;
  v_allowed boolean;
  v_request_hash text;
  v_operation public.openclaw_client_operations%rowtype;
  v_result_hash text;
  v_challenge public.openclaw_qr_challenges%rowtype;
  v_safe_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','challengeId','browserNonceHash','authSessionHash'],
    array['version','organizationId','accountId','challengeId','browserNonceHash','authSessionHash']
  );
  if p_actor_id is null or p_client_operation_id is null or p_request->>'version'<>'1'
     or (p_request->>'browserNonceHash')!~'^[0-9a-f]{64}$'
     or (p_request->>'authSessionHash')!~'^[0-9a-f]{64}$'
  then
    raise exception 'QR challenge is not available' using errcode='P0001';
  end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select decision.allowed into v_allowed
  from app_private.authorize_tenant_action_v3(
    p_actor_id,v_org,'openclaw_zalo.manage_connections',null,null
  ) decision;
  if not coalesce(v_allowed,false) then
    raise exception 'permission denied' using errcode='42501';
  end if;
  v_request_hash:=app_private.openclaw_client_request_hash_v1(
    'openclaw_consume_qr_challenge_v1',p_request
  );
  insert into public.openclaw_client_operations(
    organization_id,actor_id,operation_key,client_operation_id,
    request_hash,replay_policy
  ) values (
    v_org,p_actor_id,'openclaw_consume_qr_challenge_v1',p_client_operation_id,
    v_request_hash,'SINGLE_USE'
  ) on conflict (organization_id,actor_id,operation_key,client_operation_id)
    do nothing;
  select operation_row.* into strict v_operation
  from public.openclaw_client_operations operation_row
  where operation_row.organization_id=v_org
    and operation_row.actor_id=p_actor_id
    and operation_row.operation_key='openclaw_consume_qr_challenge_v1'
    and operation_row.client_operation_id=p_client_operation_id
  for update;
  if v_operation.request_hash is distinct from v_request_hash
     or v_operation.completed_at is not null
  then
    raise exception 'QR challenge is not available' using errcode='P0001';
  end if;
  select challenge.* into strict v_challenge
  from public.openclaw_qr_challenges challenge
  where challenge.organization_id=v_org
    and challenge.account_id=v_account
    and challenge.id=(p_request->>'challengeId')::uuid
    and challenge.actor_id=p_actor_id
    and challenge.active_slot
    and challenge.challenge_status='PENDING'
    and challenge.material_version=1
    and challenge.ciphertext is not null
    and challenge.cipher_iv is not null
    and challenge.auth_tag is not null
    and challenge.expires_at>statement_timestamp()
    and challenge.browser_nonce_hash=p_request->>'browserNonceHash'
    and challenge.auth_session_hash=p_request->>'authSessionHash'
  for update;
  update public.openclaw_qr_challenges challenge set
    challenge_status='CONSUMED',active_slot=false,
    consumed_at=statement_timestamp(),ciphertext=null,cipher_iv=null,auth_tag=null,
    material_version=0,material_published_at=null
  where challenge.organization_id=v_org and challenge.id=v_challenge.id;
  v_safe_result:=jsonb_build_object(
    'version',1,'organizationId',v_org,'accountId',v_account,
    'challengeId',v_challenge.id,
    'status','CONSUMED','materialVersion',v_challenge.material_version
  );
  perform app_private.append_openclaw_audit_v1(
    v_org,'OPENCLAW_QR_CHALLENGE_CONSUMED',p_actor_id,null,
    p_client_operation_id,p_client_operation_id,v_safe_result,
    app_private.openclaw_jcs_bytes_v1(v_safe_result)
  );
  v_result_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-client-result-v1','UTF8') || decode('00','hex')
      || app_private.openclaw_jcs_bytes_v1(v_safe_result),
    'sha256'
  ),'hex');
  update public.openclaw_client_operations operation_row set
    safe_result=v_safe_result,result_hash=v_result_hash,completed_at=statement_timestamp()
  where operation_row.organization_id=v_org
    and operation_row.actor_id=p_actor_id
    and operation_row.operation_key='openclaw_consume_qr_challenge_v1'
    and operation_row.client_operation_id=p_client_operation_id
    and operation_row.request_hash=v_request_hash
    and operation_row.completed_at is null;
  if not found then
    raise exception 'QR challenge is not available' using errcode='P0001';
  end if;
  return v_safe_result || jsonb_build_object(
    'ciphertextB64',encode(v_challenge.ciphertext,'base64'),
    'cipherIvB64',encode(v_challenge.cipher_iv,'base64'),
    'authTagB64',encode(v_challenge.auth_tag,'base64')
  );
exception
  when no_data_found then
    raise exception 'QR challenge is not available' using errcode='P0001';
end;
$function$;

alter function public.openclaw_service_consume_qr_challenge_v1(uuid,jsonb,uuid)
  owner to openclaw_function_owner;
revoke all on function public.openclaw_service_consume_qr_challenge_v1(uuid,jsonb,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.openclaw_service_consume_qr_challenge_v1(uuid,jsonb,uuid)
  to service_role;
revoke execute on function public.openclaw_consume_qr_challenge_v1(jsonb,uuid)
  from authenticated;

create or replace function public.openclaw_acknowledge_disclosure_v1(
  p_request jsonb,
  p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1());
  v_org uuid := (p_request->>'organizationId')::uuid;
  v_operation jsonb;
  v_request_hash text;
  v_account public.openclaw_accounts%rowtype;
  v_acknowledged_at timestamptz;
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','disclosureVersion'],
    array['version','organizationId','accountId','disclosureVersion']
  );
  if v_actor is null or p_request->>'version'<>'1'
     or jsonb_typeof(p_request->'disclosureVersion')<>'number'
     or (p_request->>'disclosureVersion')::integer<1
  then
    raise exception 'disclosure acknowledgement invalid' using errcode='22023';
  end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(
    v_org,'openclaw_zalo.manage_connections','xac nhan cong bo OpenClaw Zalo'
  );
  v_operation:=app_private.openclaw_begin_client_operation_v1(
    v_org,v_actor,'openclaw_acknowledge_disclosure_v1',p_client_operation_id,p_request
  );
  if coalesce((v_operation->>'conflict')::boolean,false) then return v_operation; end if;
  if coalesce((v_operation->>'isReplay')::boolean,false) then
    return (v_operation->'safeResult') || jsonb_build_object('idempotentReplay',true);
  end if;
  v_request_hash:=v_operation->>'requestHash';
  select account.* into strict v_account
  from public.openclaw_accounts account
  where account.organization_id=v_org
    and account.id=(p_request->>'accountId')::uuid
  for update;
  if v_account.disclosure_version<>(p_request->>'disclosureVersion')::integer then
    raise exception 'disclosure version mismatch' using errcode='40001';
  end if;
  update public.openclaw_accounts account set
    disclosure_acknowledged_version=v_account.disclosure_version,
    disclosure_acknowledged_at=statement_timestamp(),
    updated_at=statement_timestamp()
  where account.organization_id=v_org and account.id=v_account.id
  returning account.disclosure_acknowledged_at into v_acknowledged_at;
  v_result:=jsonb_build_object(
    'version',1,'organizationId',v_org,'accountId',v_account.id,
    'disclosureAcknowledgedVersion',v_account.disclosure_version,
    'disclosureAcknowledgedAt',v_acknowledged_at,
    'idempotentReplay',false
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org,v_actor,'openclaw_acknowledge_disclosure_v1',p_client_operation_id,
    v_request_hash,'OPENCLAW_DISCLOSURE_ACKNOWLEDGED',v_result
  );
end;
$function$;

alter function public.openclaw_acknowledge_disclosure_v1(jsonb,uuid)
  owner to openclaw_function_owner;
revoke all on function public.openclaw_acknowledge_disclosure_v1(jsonb,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.openclaw_acknowledge_disclosure_v1(jsonb,uuid)
  to authenticated;

create or replace function public.openclaw_service_resume_disconnect_revocation_v1(
  p_actor_id uuid,
  p_organization_id uuid,
  p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.openclaw_client_operations%rowtype;
  v_result jsonb;
  v_revocation public.openclaw_generation_revocations%rowtype;
begin
  if p_actor_id is null or p_organization_id is null or p_client_operation_id is null then
    raise exception 'disconnect revocation not found' using errcode='P0002';
  end if;
  perform app_private.lock_org_for_decision_v1(p_organization_id);
  select operation_row.* into strict v_operation
  from public.openclaw_client_operations operation_row
  where operation_row.organization_id=p_organization_id
    and operation_row.actor_id=p_actor_id
    and operation_row.operation_key='openclaw_disconnect_account_v1'
    and operation_row.client_operation_id=p_client_operation_id
    and operation_row.completed_at is not null
    and operation_row.safe_result is not null
  for update;
  v_result:=v_operation.safe_result;
  select revocation.* into strict v_revocation
  from public.openclaw_generation_revocations revocation
  join public.openclaw_runtime_commands command
    on command.organization_id=revocation.organization_id
   and command.id=revocation.command_id
   and command.account_id=revocation.account_id
   and command.cell_id=revocation.cell_id
   and command.command_kind='DISCONNECT'
   and command.created_by=p_actor_id
  join public.openclaw_accounts account
    on account.organization_id=revocation.organization_id
   and account.id=revocation.account_id
   and account.connection_state='DISCONNECTING'
   and account.session_generation=revocation.minimum_valid_generation
  where revocation.organization_id=p_organization_id
    and revocation.id=(v_result->>'revocationId')::uuid
    and revocation.account_id=(v_result->>'accountId')::uuid
    and revocation.cell_id=(v_result->>'cellId')::uuid
    and revocation.principal_kind='CHANNEL'
    and revocation.revocation_kind='SESSION'
    and revocation.revoked_generation=(v_result->>'revokedGeneration')::bigint
    and revocation.minimum_valid_generation=(v_result->>'minimumValidGeneration')::bigint
    and revocation.acknowledged_at is null
    and command.id=(v_result->>'runtimeCommandId')::uuid
  for update of revocation;
  return v_result;
exception
  when no_data_found then
    raise exception 'disconnect revocation not found' using errcode='P0002';
end;
$function$;

alter function public.openclaw_service_resume_disconnect_revocation_v1(uuid,uuid,uuid)
  owner to openclaw_function_owner;
revoke all on function public.openclaw_service_resume_disconnect_revocation_v1(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.openclaw_service_resume_disconnect_revocation_v1(uuid,uuid,uuid)
  to service_role;

create or replace function public.openclaw_service_ack_disconnect_revocation_v1(
  p_actor_id uuid,
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_request->>'organizationId')::uuid;
  v_account uuid := (p_request->>'accountId')::uuid;
  v_revocation public.openclaw_generation_revocations%rowtype;
  v_connection_state text;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','revocationId','minimumValidGeneration','acknowledgementHash'],
    array['version','organizationId','accountId','revocationId','minimumValidGeneration','acknowledgementHash']
  );
  if p_actor_id is null or p_request->>'version'<>'1'
     or (p_request->>'acknowledgementHash')!~'^[0-9a-f]{64}$'
  then
    raise exception 'disconnect acknowledgement invalid' using errcode='22023';
  end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select revocation.* into strict v_revocation
  from public.openclaw_generation_revocations revocation
  join public.openclaw_runtime_commands command
    on command.organization_id=revocation.organization_id
   and command.id=revocation.command_id
   and command.account_id=revocation.account_id
   and command.cell_id=revocation.cell_id
   and command.command_kind='DISCONNECT'
   and command.created_by=p_actor_id
  where revocation.organization_id=v_org
    and revocation.id=(p_request->>'revocationId')::uuid
    and revocation.account_id=v_account
    and revocation.principal_kind='CHANNEL'
    and revocation.revocation_kind='SESSION'
    and revocation.minimum_valid_generation=(p_request->>'minimumValidGeneration')::bigint
  for update;
  if v_revocation.acknowledgement_hash is null then
    update public.openclaw_generation_revocations revocation set
      acknowledgement_hash=p_request->>'acknowledgementHash',
      acknowledged_at=statement_timestamp()
    where revocation.organization_id=v_org and revocation.id=v_revocation.id;
  elsif v_revocation.acknowledgement_hash is distinct from p_request->>'acknowledgementHash' then
    raise exception 'disconnect acknowledgement mismatch' using errcode='40001';
  end if;
  v_connection_state:=app_private.openclaw_try_finalize_disconnect_v1(
    v_org,v_account,v_revocation.command_id
  );
  return jsonb_build_object(
    'version',1,'organizationId',v_org,'accountId',v_account,
    'revocationId',v_revocation.id,'minimumValidGeneration',v_revocation.minimum_valid_generation,
    'acknowledged',true,'connectionState',v_connection_state
  );
exception
  when no_data_found then
    raise exception 'disconnect acknowledgement invalid' using errcode='P0002';
end;
$function$;

alter function public.openclaw_service_ack_disconnect_revocation_v1(uuid,jsonb)
  owner to openclaw_function_owner;
revoke all on function public.openclaw_service_ack_disconnect_revocation_v1(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.openclaw_service_ack_disconnect_revocation_v1(uuid,jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Bootstrap carries the disclosure gate the server already enforces
-- ---------------------------------------------------------------------------
-- openclaw_begin_qr_login_v1 refuses with 42501 'current disclosure acknowledgement
-- required' unless disclosure_acknowledged_version equals disclosure_version, and
-- openclaw_acknowledge_disclosure_v1 refuses a version it did not ask for. Neither
-- number reached the browser, so the UI could not tell the operator WHY a QR was
-- refused, nor which version to acknowledge - it could only show the raw error after
-- the fact. Exposing both makes the gate visible before the attempt.
--
-- Read-only additions to a payload the caller already receives under
-- `openclaw_zalo.view`; they carry no session material.
create or replace function public.openclaw_get_bootstrap_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account jsonb;
  v_control jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request, array['version','organizationId'], array['version','organizationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  select jsonb_build_object(
    'accountId', account.id, 'displayName', account.display_name,
    'connectionState', account.connection_state, 'sessionRiskState', account.session_risk_state,
    'configuredMode', account.configured_mode, 'effectiveMode', account.effective_mode,
    'connectionGeneration', account.connection_generation,
    'sessionGeneration', account.session_generation,
    'disclosureVersion', account.disclosure_version,
    'disclosureAcknowledgedVersion', account.disclosure_acknowledged_version,
    -- openclaw_begin_qr_login_v1 takes a cellId and selects it with
    -- `is_current and state = 'READY'` INTO STRICT. Both conditions must be
    -- reproduced here: filtering on is_current alone hands the browser a cell id
    -- during provisioning or after a fence that is guaranteed to raise a bare
    -- P0002 no_data_found, which reaches the operator as an empty error.
    -- Null means "no cell a QR could use", which the UI can state plainly.
    'currentCellId', (
      select cell.id from public.openclaw_runtime_cells cell
      where cell.organization_id = account.organization_id
        and cell.account_id = account.id
        and cell.is_current and cell.state = 'READY'
      limit 1
    )
  ) into v_account
  from public.openclaw_accounts account
  where account.organization_id = v_org and account.is_active
  order by account.created_at desc, account.id desc limit 1;
  select jsonb_build_object(
    'globalStop', control.global_stop, 'featureEnabled', control.feature_enabled,
    'limitedAutoReplyEnabled', control.limited_auto_reply_enabled,
    'proactiveEnabled', control.proactive_enabled,
    'salesGroupsEnabled', control.sales_groups_enabled,
    'controlVersion', control.control_version
  ) into v_control
  from public.openclaw_control_states control
  where control.organization_id = v_org and control.control_key = 'GLOBAL_STOP';
  return jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'account', v_account,
    'control', v_control, 'actorId', v_context ->> 'actorId',
    -- Legal holds require an ACTIVE OWNER membership on top of both permissions,
    -- and nothing else tells the browser whether the caller has one. Without this
    -- the UI could only offer the button and let the server refuse it, which is
    -- the one thing every other control on this screen avoids. A boolean about
    -- the caller's own membership reveals nothing they do not already know.
    'isActiveOwner', exists(
      select 1 from public.organization_memberships membership
      where membership.organization_id = v_org
        and membership.user_id = (v_context ->> 'actorId')::uuid
        and membership.status = 'ACTIVE'
        and membership.member_type = 'OWNER'
    )
  );
end;
$function$;

alter function public.openclaw_get_bootstrap_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_bootstrap_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_bootstrap_v1(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- AI drafts are readable, but never before DLP has cleared them
-- ---------------------------------------------------------------------------
-- The drafts table has existed since 20260727025000 with no way for the browser to
-- read it, so the review-only draft panel had nothing to render. This exposes it
-- under the same `openclaw_zalo.view` gate as messages, with one rule the browser
-- must not be trusted to apply itself:
--
--   `draftText` is withheld unless dlp_decision = 'PASS'.
--
-- A BLOCK/REVIEW draft is exactly the case where the text may carry restricted
-- content, so it never leaves the database. The panel still learns the draft exists
-- and why it is withheld, which is what an operator needs in order to act.
create or replace function public.openclaw_list_ai_drafts_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_conversation uuid;
  v_limit integer;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','conversationId','limit'],
    array['version','organizationId','accountId','conversationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem ban nhap AI OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  v_conversation := (p_request ->> 'conversationId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 20), 50));
  select coalesce(jsonb_agg(item.payload order by item.draft_version desc), '[]'::jsonb)
  into v_items
  from (
    select draft.draft_version,
      jsonb_build_object(
        'draftId', draft.id,
        'conversationId', draft.conversation_id,
        'draftVersion', draft.draft_version,
        'humanEditVersion', draft.human_edit_version,
        'dlpDecision', draft.dlp_decision,
        'publicationState', draft.publication_state,
        -- `citations` is free-form jsonb (only constrained to be an array), so if the
        -- retrieval writer ever puts source EXCERPTS in it, a BLOCKed draft would
        -- ship restricted text through the one field the withholding rule missed.
        -- The count survives for every draft because a reviewer needs to know the
        -- draft was grounded; the contents follow the same rule as the text.
        'citationCount', jsonb_array_length(draft.citations),
        'citations', case when draft.dlp_decision = 'PASS' then draft.citations end,
        -- uuids, not content: safe to expose regardless of the DLP decision.
        'knowledgeVersionIds', to_jsonb(draft.knowledge_version_ids),
        'createdAt', draft.created_at,
        -- Withheld, not redacted in place: an empty string would be
        -- indistinguishable from a draft the model genuinely produced empty.
        'draftText', case when draft.dlp_decision = 'PASS' then draft.draft_text end
      ) as payload
    from public.openclaw_ai_drafts draft
    where draft.organization_id = v_org and draft.account_id = v_account
      and draft.conversation_id = v_conversation
    order by draft.draft_version desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

alter function public.openclaw_list_ai_drafts_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_ai_drafts_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_ai_drafts_v1(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The function owner can read memberships (five existing RPCs already assume it)
-- ---------------------------------------------------------------------------
-- `openclaw_function_owner` is NOLOGIN NOINHERIT NOBYPASSRLS and had no privilege
-- on public.organization_memberships, yet openclaw_takeover_conversation_v1,
-- openclaw_release_takeover_v1, openclaw_assign_conversation_v1 and two more
-- already SELECT from it while running as that owner. Measured on a disposable
-- database by switching into that role and selecting one row from
-- public.organization_memberships: "permission denied for table
-- organization_memberships". Every one of those RPCs would have failed on its first
-- real call. The rest of the SQL suite could not see it because PGlite runs as
-- superuser, which bypasses GRANT entirely. (The measurement lives in
-- scripts/__tests__/openclaw-browser-privileges.test.mjs; it is deliberately not
-- spelled out here, because a migration-hygiene gate scans this file for that
-- role-switching statement and a comment matches it just as well as code would.)
--
-- SELECT only, on a COLUMN LIST, because this role owns ~90 SECURITY DEFINER bodies
-- that would all inherit anything wider. The table carries no row-level security
-- anywhere in the migration chain, so this adds no policy surface.
--
-- `member_type` is in the list and must stay: openclaw_create_legal_hold_v1 and
-- openclaw_release_legal_hold_v1 read `membership.member_type = 'OWNER'`. A first
-- attempt at this grant omitted it and broke both RPCs for every caller - column
-- privileges are checked per referenced column, so the failure is a flat
-- "permission denied for table organization_memberships" with no hint which column
-- was missing. The regression test derives this list from the function bodies
-- rather than restating it.
grant select (id, organization_id, user_id, status, member_type)
  on public.organization_memberships to openclaw_function_owner;

-- ---------------------------------------------------------------------------
-- Who holds a takeover, and until when
-- ---------------------------------------------------------------------------
-- openclaw_takeover_conversation_v1 hands the takeover id, version and expiry back
-- exactly once, to exactly the browser that created it. Nothing could read them
-- afterwards, so a reload - or any other member's session - showed no takeover at
-- all while auto-reply was in fact suspended, and the UI offered "send" on a
-- conversation someone else had taken over.
--
-- Gated on `openclaw_zalo.view`, not `manage_handoff`: the takeover writer already
-- lets the assigned active member take over their own conversation without the
-- elevated action, so gating the READ higher than the WRITE would hide from that
-- member the very state they are allowed to create.
--
-- The active predicate is `released_at is null and expires_at > statement_timestamp()`,
-- verbatim from the send preflight. Filtering on released_at alone would keep the
-- banner up after expiry, claiming auto-reply is suspended when it is not.
create or replace function public.openclaw_list_takeovers_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_viewer uuid;
  v_limit integer;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem tiep quan hoi thoai OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  -- The browser is never told its own membership id anywhere else, so "mine" versus
  -- "someone else's" has to be decided here rather than guessed in the client.
  select membership.id into v_viewer
  from public.organization_memberships membership
  where membership.organization_id = v_org
    and membership.user_id = (v_context ->> 'actorId')::uuid
    and membership.status = 'ACTIVE'
  limit 1;
  select coalesce(
    jsonb_agg(item.payload order by item.expires_at, item.conversation_id), '[]'::jsonb
  )
  into v_items
  from (
    select takeover.conversation_id, takeover.expires_at,
      jsonb_build_object(
        'takeoverId', takeover.id,
        'conversationId', takeover.conversation_id,
        'ownerMembershipId', takeover.owner_membership_id,
        'heldByViewer', (v_viewer is not null and takeover.owner_membership_id = v_viewer),
        'takeoverVersion', takeover.takeover_version,
        'startedAt', takeover.started_at,
        'expiresAt', takeover.expires_at
      ) as payload
    from public.openclaw_takeovers takeover
    join public.openclaw_conversations conversation
      on conversation.organization_id = takeover.organization_id
     and conversation.id = takeover.conversation_id
    where takeover.organization_id = v_org
      and conversation.account_id = v_account
      and takeover.released_at is null
      and takeover.expires_at > statement_timestamp()
    order by takeover.expires_at, takeover.conversation_id
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

alter function public.openclaw_list_takeovers_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_list_takeovers_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.openclaw_list_takeovers_v1(jsonb) to authenticated;


--
-- The authority evidence an operator must echo back to resolve an UNKNOWN.
--
-- `openclaw_resolve_unknown_v1` refuses any request whose `expectedEvidenceHash`
-- differs from what it recomputes, and `openclaw_get_unknown_resolution_v1` only
-- returns that hash AFTER a resolution exists - which is exactly when it is no
-- longer needed. Without this read path an UNKNOWN can never be resolved from a
-- browser at all, because the hash covers delivery-attempt internals no read RPC
-- exposes and a JCS serialization no client can reproduce byte for byte.
--
-- Both sides call this one function, so the value the operator echoes back is by
-- construction the value the resolver will compare against.
create or replace function app_private.openclaw_unknown_authority_v1(
  p_organization_id uuid,
  p_account_id uuid,
  p_outbox_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_outbox public.openclaw_outbox;
  v_authority jsonb;
begin
  -- Only an UNKNOWN that nobody has resolved yet has authority evidence to offer.
  -- Anything else returns null, which the resolver reads as a lost CAS.
  select outbox.* into v_outbox
  from public.openclaw_outbox outbox
  where outbox.organization_id = p_organization_id
    and outbox.account_id = p_account_id
    and outbox.id = p_outbox_id
    and outbox.state = 'UNKNOWN'
    and outbox.resolution_version = 0;
  if not found then return null; end if;

  v_authority := jsonb_build_object(
    'version',1,'outboxId',v_outbox.id,'organizationId',p_organization_id,
    'accountId',v_outbox.account_id,
    'state',v_outbox.state,'resolutionVersion',v_outbox.resolution_version,
    'payloadHash',v_outbox.payload_hash,'claimGeneration',v_outbox.claim_generation,
    'fencingToken',v_outbox.fencing_token,'sessionGeneration',v_outbox.session_generation,
    'controlVersion',v_outbox.control_version,'takeoverVersion',v_outbox.takeover_version,
    'attempts',coalesce((select jsonb_agg(jsonb_build_object(
      'attemptId',attempt.id,'claimGeneration',attempt.claim_generation,
      'outcome',attempt.outcome,'reasonCode',attempt.reason_code,
      'deliveryEvidenceHash',attempt.delivery_evidence_hash,
      'possibleHandoffPrefixLength',attempt.possible_handoff_prefix_length,
      'knownProviderMessageIds',attempt.known_provider_message_ids
    ) order by attempt.attempt_number,attempt.id)
    from public.openclaw_delivery_attempts attempt
    where attempt.organization_id = p_organization_id
      and attempt.account_id = v_outbox.account_id
      and attempt.outbox_id = v_outbox.id),'[]'::jsonb)
  );

  -- Only the domain and the digest leave this function. The authority object itself
  -- carries fencing tokens and provider message ids, which no browser needs.
  return jsonb_build_object(
    'domain','ihome-openclaw-unknown-authority-v1\0',
    'hash',encode(extensions.digest(
      convert_to('ihome-openclaw-unknown-authority-v1','UTF8')
        ||decode('00','hex')||app_private.openclaw_jcs_bytes_v1(v_authority),'sha256'),'hex'),
    'resolutionVersion',v_outbox.resolution_version
  );
end;
$function$;

alter function app_private.openclaw_unknown_authority_v1(uuid, uuid, uuid)
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_unknown_authority_v1(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.openclaw_get_unknown_authority_v1(p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_authority jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','outboxId'],
    array['version','organizationId','accountId','outboxId']
  );
  -- Same permission the resolution itself requires: reading the evidence is only
  -- ever a step towards recording an outcome.
  v_context := app_private.openclaw_browser_account_context_v1(
    p_request, 'openclaw_zalo.manage_operations', 'đọc bằng chứng UNKNOWN OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (v_context ->> 'accountId')::uuid;

  v_authority := app_private.openclaw_unknown_authority_v1(
    v_org, v_account, (p_request ->> 'outboxId')::uuid
  );
  -- Null means there is nothing to resolve - already resolved, or not an UNKNOWN.
  -- The caller must show that rather than offer a choice that would 40001.
  if v_authority is null then return null; end if;

  return jsonb_build_object(
    'version',1,'organizationId',v_org,'accountId',v_account,
    'outboxId',(p_request ->> 'outboxId')::uuid,
    'authorityDomain',v_authority->>'domain',
    'authorityHash',v_authority->>'hash',
    'resolutionVersion',(v_authority->>'resolutionVersion')::integer
  );
end;
$function$;

alter function public.openclaw_get_unknown_authority_v1(jsonb) owner to openclaw_function_owner;
revoke all on function public.openclaw_get_unknown_authority_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.openclaw_get_unknown_authority_v1(jsonb) to authenticated;


-- CREATE was only ever needed to hand ownership over; ownership and SECURITY
-- DEFINER execution both survive the revoke, so no openclaw role keeps the
-- ability to create objects.
revoke create on schema public, app_private from openclaw_function_owner, openclaw_runtime_writer, openclaw_maintenance_writer, openclaw_service_dispatcher;
commit;
