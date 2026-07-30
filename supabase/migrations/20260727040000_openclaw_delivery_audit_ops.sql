begin;

create table public.openclaw_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  target_id uuid not null,
  source_kind text not null check (source_kind in ('MANUAL','INBOUND_REPLY','SCHEDULE','CRM_EVENT')),
  actor_id uuid,
  client_operation_id uuid,
  inbound_event_id uuid,
  automation_version_id uuid,
  schedule_id uuid,
  schedule_version bigint,
  subscription_id uuid,
  subscription_version bigint,
  occurrence_id uuid,
  campaign_id uuid,
  campaign_version bigint,
  idempotency_key text not null,
  canonical_payload jsonb not null,
  canonical_payload_bytes bytea not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'QUEUED'
    check (state IN ('QUEUED','LEASED','DISPATCHING','SENT','FAILED','UNKNOWN','DEAD_LETTER')),
  resolution_version smallint NOT NULL DEFAULT 0 CHECK (resolution_version IN (0,1)),
  claim_token_hash text check (claim_token_hash is null or claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  claimed_cell_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  session_generation bigint not null default 1 check (session_generation > 0),
  control_version bigint not null default 1 check (control_version > 0),
  takeover_version bigint not null default 0 check (takeover_version >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  retry_not_before timestamptz,
  dispatching_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, idempotency_key),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, inbound_event_id)
    references public.openclaw_inbound_events(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, automation_version_id)
    references public.openclaw_automation_versions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, schedule_id)
    references public.openclaw_schedules(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, subscription_id)
    references public.openclaw_crm_event_subscriptions(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, campaign_id)
    references public.openclaw_campaigns(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, claimed_cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (jsonb_typeof(canonical_payload) = 'object'),
  check (octet_length(canonical_payload_bytes) > 0),
  check (convert_from(canonical_payload_bytes, 'UTF8')::jsonb = canonical_payload),
  check (payload_hash = encode(extensions.digest(
    convert_to('ihome-openclaw-' || 'send-v1', 'UTF8')
      || decode('00', 'hex')
      || canonical_payload_bytes,
    'sha256'
  ), 'hex')),
  check (
    (source_kind = 'MANUAL' and actor_id is not null and client_operation_id is not null
      and inbound_event_id is null and schedule_id is null and subscription_id is null)
    or (source_kind = 'INBOUND_REPLY' and inbound_event_id is not null and automation_version_id is not null
      and schedule_id is null and subscription_id is null)
    or (source_kind = 'SCHEDULE' and schedule_id is not null and schedule_version is not null
      and occurrence_id is not null and automation_version_id is not null and subscription_id is null)
    or (source_kind = 'CRM_EVENT' and subscription_id is not null and subscription_version is not null
      and occurrence_id is not null and automation_version_id is not null)
  ),
  check ((state in ('LEASED','DISPATCHING')) = (claim_token_hash is not null)),
  check ((state = 'DISPATCHING') = (dispatching_at is not null)),
  check ((state in ('SENT','FAILED','UNKNOWN','DEAD_LETTER')) = (terminal_at is not null)),
  check (resolution_version = 0 or state = 'UNKNOWN')
);

create unique index openclaw_outbox_manual_idempotency_uidx
  on public.openclaw_outbox (organization_id, actor_id, client_operation_id)
  where source_kind = 'MANUAL';
create unique index openclaw_outbox_inbound_idempotency_uidx
  on public.openclaw_outbox (organization_id, inbound_event_id, automation_version_id)
  where source_kind = 'INBOUND_REPLY';
create unique index openclaw_outbox_schedule_idempotency_uidx
  on public.openclaw_outbox
    (organization_id, schedule_id, schedule_version, occurrence_id, target_id)
  where source_kind = 'SCHEDULE';
create unique index openclaw_outbox_crm_idempotency_uidx
  on public.openclaw_outbox
    (organization_id, subscription_id, subscription_version, occurrence_id, target_id)
  where source_kind = 'CRM_EVENT';
create index openclaw_outbox_claimable_idx
  on public.openclaw_outbox (organization_id, account_id, retry_not_before, created_at, id)
  where state = 'QUEUED';
create index openclaw_outbox_expired_lease_idx
  on public.openclaw_outbox (lease_expires_at, organization_id, account_id)
  where state = 'LEASED';
create index openclaw_outbox_dispatching_sweep_idx
  on public.openclaw_outbox (dispatching_at, organization_id, account_id)
  where state = 'DISPATCHING';
create index openclaw_outbox_unknown_idx
  on public.openclaw_outbox (organization_id, account_id, terminal_at desc, id)
  where state = 'UNKNOWN';

create table public.openclaw_outbound_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  outbox_id uuid not null,
  claim_generation bigint not null check (claim_generation > 0),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  fencing_token bigint not null check (fencing_token > 0),
  session_generation bigint not null check (session_generation > 0),
  control_version bigint not null check (control_version > 0),
  takeover_version bigint not null check (takeover_version >= 0),
  marker_nonce_hash text not null check (marker_nonce_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  lease_expires_at timestamptz not null,
  consumed_at timestamptz,
  authorized_handoff_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, marker_nonce_hash),
  foreign key (organization_id, account_id, outbox_id)
    references public.openclaw_outbox(organization_id, account_id, id) on delete restrict,
  check (expires_at > issued_at),
  check (expires_at <= issued_at + interval '15 seconds'),
  check (expires_at <= lease_expires_at),
  check ((consumed_at is null) = (authorized_handoff_at is null))
);

create unique index openclaw_authorizations_one_success_uidx
  on public.openclaw_outbound_authorizations
    (organization_id, account_id, outbox_id, claim_generation)
  where authorized_handoff_at is not null;
create index openclaw_authorizations_unconsumed_idx
  on public.openclaw_outbound_authorizations (expires_at, organization_id, account_id)
  where consumed_at is null;

create table public.openclaw_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  outbox_id uuid not null,
  authorization_id uuid,
  claim_generation bigint not null check (claim_generation > 0),
  attempt_number integer not null check (attempt_number > 0),
  outcome text not null check (outcome IN ('SENT','FAILED','UNKNOWN','SAFE_RETRY')),
  reason_code text not null,
  total_part_count integer not null check (total_part_count > 0 and total_part_count <= 20),
  possible_handoff_prefix_length integer not null check (possible_handoff_prefix_length >= 0),
  known_provider_message_ids text[] not null default '{}'::text[],
  evidence_kind text not null check (evidence_kind in ('OUTBOX_DELIVERY','OUTBOX_PRE_HANDOFF')),
  delivery_evidence jsonb not null,
  delivery_evidence_hash text not null check (delivery_evidence_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, outbox_id, claim_generation, attempt_number),
  foreign key (organization_id, account_id, outbox_id)
    references public.openclaw_outbox(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, authorization_id)
    references public.openclaw_outbound_authorizations(organization_id, account_id, id) on delete restrict,
  check (finished_at >= started_at),
  check (possible_handoff_prefix_length <= total_part_count),
  check (cardinality(known_provider_message_ids) <= possible_handoff_prefix_length),
  check (
    (outcome = 'SENT' and possible_handoff_prefix_length = total_part_count
      and cardinality(known_provider_message_ids) = total_part_count and evidence_kind = 'OUTBOX_DELIVERY')
    or (outcome = 'FAILED' and possible_handoff_prefix_length = 0
      and cardinality(known_provider_message_ids) = 0 and evidence_kind = 'OUTBOX_DELIVERY')
    or (outcome = 'UNKNOWN' and evidence_kind = 'OUTBOX_DELIVERY')
    or (outcome = 'SAFE_RETRY' and possible_handoff_prefix_length = 0
      and cardinality(known_provider_message_ids) = 0 and evidence_kind = 'OUTBOX_PRE_HANDOFF')
  )
);

create table public.openclaw_dead_letters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  outbox_id uuid,
  send_work_item_id uuid,
  reason_code text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  foreign key (organization_id, account_id, outbox_id)
    references public.openclaw_outbox(organization_id, account_id, id) on delete restrict,
  check ((outbox_id is null) <> (send_work_item_id is null))
);

create table public.openclaw_unknown_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  outbox_id uuid not null,
  resolution_version smallint not null default 1 check (resolution_version = 1),
  outcome text not null check (outcome IN ('CONFIRMED_SENT','CONFIRMED_FAILED','NEW_INTENT_CREATED')),
  new_outbox_id uuid,
  authoritative_evidence_domain text not null default 'ihome-openclaw-unknown-authority-v1\0'
    check (authoritative_evidence_domain = 'ihome-openclaw-unknown-authority-v1\0'),
  authoritative_evidence_hash text not null check (authoritative_evidence_hash ~ '^[0-9a-f]{64}$'),
  operator_evidence_hash text not null check (operator_evidence_hash ~ '^[0-9a-f]{64}$'),
  reason_code text not null,
  resolved_by uuid not null references auth.users(id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp(),
  client_operation_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, outbox_id),
  unique (organization_id, resolved_by, client_operation_id),
  foreign key (organization_id, account_id, outbox_id)
    references public.openclaw_outbox(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, new_outbox_id)
    references public.openclaw_outbox(organization_id, account_id, id) on delete restrict,
  check (new_outbox_id is null or new_outbox_id <> outbox_id),
  check ((outcome = 'NEW_INTENT_CREATED') = (new_outbox_id is not null))
);

create unique index openclaw_unknown_resolutions_new_outbox_uidx
  on public.openclaw_unknown_resolutions (organization_id, account_id, new_outbox_id)
  where new_outbox_id is not null;

create table public.openclaw_send_work_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  work_kind text not null check (work_kind IN ('INBOUND_AUTOMATION','SCHEDULE_OCCURRENCE','CRM_EVENT')),
  source_id uuid not null,
  source_version text not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'QUEUED' check (state in ('QUEUED','LEASED','COMPLETE','FAILED','DEAD_LETTER')),
  claim_token_hash text check (claim_token_hash is null or claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  lease_expires_at timestamptz,
  fencing_token bigint not null check (fencing_token > 0),
  session_generation bigint not null check (session_generation > 0),
  retry_not_before timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  terminal_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, work_kind, source_id, source_version),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (jsonb_typeof(payload) = 'object'),
  check ((state = 'LEASED') = (claim_token_hash is not null))
);

create index openclaw_send_work_claimable_idx
  on public.openclaw_send_work_items (organization_id, account_id, retry_not_before, created_at, id)
  where state = 'QUEUED';
create index openclaw_send_work_expired_idx
  on public.openclaw_send_work_items (lease_expires_at, organization_id, account_id)
  where state = 'LEASED';

create table public.openclaw_send_work_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  work_item_id uuid not null,
  claim_generation bigint not null check (claim_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  session_generation bigint not null check (session_generation > 0),
  attempt_number integer not null check (attempt_number > 0),
  outcome text not null check (outcome in ('COMPLETE','RETRY','FAILED','DEAD_LETTER')),
  evidence jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, work_item_id, claim_generation, attempt_number),
  foreign key (organization_id, account_id, work_item_id)
    references public.openclaw_send_work_items(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict
);

create table public.openclaw_maintenance_work_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  work_kind text not null check (work_kind IN ('RETENTION_DELETE','AUDIT_ANCHOR')),
  work_phase text not null check (work_phase in ('QUARANTINE','FINAL_DELETE','ANCHOR')),
  source_id uuid not null,
  source_version text not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'QUEUED' check (state in ('QUEUED','LEASED','COMPLETE','FAILED','DEAD_LETTER')),
  claim_token_hash text check (claim_token_hash is null or claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  maintenance_lease_generation bigint not null check (maintenance_lease_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  lease_expires_at timestamptz,
  retry_not_before timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  terminal_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, maintenance_principal_id, id),
  unique (organization_id, work_kind, work_phase, source_id, source_version),
  foreign key (organization_id, maintenance_principal_id)
    references public.openclaw_maintenance_principals(organization_id, id) on delete restrict,
  check (jsonb_typeof(payload) = 'object'),
  check ((work_kind = 'AUDIT_ANCHOR') = (work_phase = 'ANCHOR')),
  check ((state = 'LEASED') = (claim_token_hash is not null))
);

create index openclaw_maintenance_work_claimable_idx
  on public.openclaw_maintenance_work_items (organization_id, retry_not_before, created_at, id)
  where state = 'QUEUED';
create index openclaw_maintenance_work_expired_idx
  on public.openclaw_maintenance_work_items (lease_expires_at, organization_id)
  where state = 'LEASED';

create table public.openclaw_maintenance_work_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  work_item_id uuid not null,
  claim_generation bigint not null check (claim_generation > 0),
  maintenance_lease_generation bigint not null check (maintenance_lease_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  attempt_number integer not null check (attempt_number > 0),
  outcome text not null check (outcome in ('COMPLETE','RETRY','FAILED','DEAD_LETTER')),
  gateway_receipt jsonb,
  receipt_hash text check (receipt_hash is null or receipt_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, maintenance_principal_id, id),
  unique (organization_id, maintenance_principal_id, work_item_id, claim_generation, attempt_number),
  foreign key (organization_id, maintenance_principal_id, work_item_id)
    references public.openclaw_maintenance_work_items(organization_id, maintenance_principal_id, id) on delete restrict,
  check ((gateway_receipt is null) = (receipt_hash is null))
);

alter table public.openclaw_dead_letters
  add constraint openclaw_dead_letters_send_work_fkey
  foreign key (organization_id, account_id, send_work_item_id)
  references public.openclaw_send_work_items(organization_id, account_id, id)
  on delete restrict;

create table public.openclaw_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  organization_sequence bigint not null check (organization_sequence > 0),
  event_type text not null,
  actor_id uuid,
  workload_principal text,
  request_id uuid,
  correlation_id uuid,
  redacted_evidence jsonb not null,
  redacted_evidence_bytes bytea not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text not null check (previous_hash ~ '^[0-9a-f]{64}$'),
  event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, organization_sequence),
  unique (organization_id, event_hash),
  check (actor_id is not null or workload_principal is not null),
  check (jsonb_typeof(redacted_evidence) = 'object'),
  check (octet_length(redacted_evidence_bytes) > 0),
  check (convert_from(redacted_evidence_bytes, 'UTF8')::jsonb = redacted_evidence),
  check (evidence_hash = encode(extensions.digest(redacted_evidence_bytes, 'sha256'), 'hex'))
);

create table public.openclaw_audit_roots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  root_date date not null,
  first_sequence bigint not null check (first_sequence > 0),
  last_sequence bigint not null check (last_sequence >= first_sequence),
  root_hash text not null check (root_hash ~ '^[0-9a-f]{64}$'),
  event_count bigint not null check (event_count > 0),
  signing_key_generation bigint not null check (signing_key_generation > 0),
  r2_anchor_key text not null check (r2_anchor_key like 'v1/org/%/audit/%'),
  signature_algorithm text not null default 'Ed25519' check (signature_algorithm = 'Ed25519'),
  signature_hash text check (signature_hash is null or signature_hash ~ '^[0-9a-f]{64}$'),
  gateway_receipt jsonb,
  gateway_receipt_hash text check (gateway_receipt_hash is null or gateway_receipt_hash ~ '^[0-9a-f]{64}$'),
  anchored_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, root_date),
  unique (organization_id, root_hash),
  check (
    (anchored_at is null and signature_hash is null
      and gateway_receipt is null and gateway_receipt_hash is null)
    or (anchored_at is not null and signature_hash is not null
      and gateway_receipt is not null and gateway_receipt_hash is not null)
  ),
  check (gateway_receipt is null or jsonb_typeof(gateway_receipt) = 'object')
);

create table public.openclaw_health_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  account_id uuid,
  cell_id uuid,
  severity text not null check (severity in ('INFO','WARN','ERROR','CRITICAL')),
  health_kind text not null,
  status text not null check (status in ('OPEN','RECOVERED')),
  fingerprint text not null,
  content_free_metrics jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (jsonb_typeof(content_free_metrics) = 'object'),
  check (cell_id is null or account_id is not null)
);

create index openclaw_health_events_dashboard_idx
  on public.openclaw_health_events
    (organization_id, severity, observed_at desc, id desc);

create table public.openclaw_retention_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  target_kind text not null check (target_kind in ('CONVERSATION','MESSAGE','MEDIA','KNOWLEDGE','AUDIT','DELIVERY')),
  target_id uuid not null,
  reason text not null,
  hold_version bigint not null default 1 check (hold_version > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  released_by uuid references auth.users(id) on delete restrict,
  released_at timestamptz,
  release_reason text,
  UNIQUE (organization_id, id),
  unique (organization_id, target_kind, target_id, hold_version),
  check (expires_at is null or expires_at > created_at),
  check ((released_at is null) = (released_by is null))
);

create index openclaw_retention_holds_active_idx
  on public.openclaw_retention_holds (organization_id, target_kind, target_id, expires_at)
  where released_at is null;

create table public.openclaw_rollout_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  reviewed_commit_sha text not null check (reviewed_commit_sha ~ '^[0-9a-f]{40}$'),
  migration_manifest_sha256 text not null check (migration_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  upstream_sri text not null,
  upstream_git_head text not null check (upstream_git_head ~ '^[0-9a-f]{40}$'),
  patch_series_sha256 text not null check (patch_series_sha256 ~ '^[0-9a-f]{64}$'),
  built_tgz_sha256 text not null check (built_tgz_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_digests jsonb not null,
  stage text not null default 'FOUNDATION'
    check (stage in ('FOUNDATION','INFRASTRUCTURE','WAITING_OWNER_QR','CONNECTION','SHADOW','WAITING_OWNER_INBOUND','LIMITED_OBSERVING','LIMITED_VERIFIED','PROACTIVE','SALES_GROUPS','COMPLETE')),
  stage_version bigint not null default 1 check (stage_version > 0),
  continuous_green_started_at timestamptz,
  status text not null default 'RUNNING' check (status in ('RUNNING','PAUSED','FAILED','COMPLETE')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, reviewed_commit_sha, migration_manifest_sha256),
  check (jsonb_typeof(artifact_digests) = 'object'),
  check ((status = 'COMPLETE') = (completed_at is not null))
);

create table public.openclaw_rollout_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  rollout_run_id uuid not null,
  stage text not null,
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  passed boolean not null,
  content_free_metrics jsonb not null,
  observation_hash text not null check (observation_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, rollout_run_id, window_started_at, window_ended_at),
  foreign key (organization_id, rollout_run_id)
    references public.openclaw_rollout_runs(organization_id, id) on delete restrict,
  check (window_ended_at > window_started_at),
  check (jsonb_typeof(content_free_metrics) = 'object'),
  check (stage in ('FOUNDATION','INFRASTRUCTURE','WAITING_OWNER_QR','CONNECTION','SHADOW','WAITING_OWNER_INBOUND','LIMITED_OBSERVING','LIMITED_VERIFIED','PROACTIVE','SALES_GROUPS','COMPLETE'))
);

create table public.openclaw_rollout_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  rollout_run_id uuid not null,
  checkpoint_name text not null,
  stage text not null,
  status text not null check (status in ('WAITING','COMPLETE','FAILED')),
  trusted_evidence_id uuid,
  trusted_evidence_hash text check (trusted_evidence_hash is null or trusted_evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, rollout_run_id, checkpoint_name),
  foreign key (organization_id, rollout_run_id)
    references public.openclaw_rollout_runs(organization_id, id) on delete restrict,
  check ((status = 'COMPLETE') = (completed_at is not null)),
  check ((trusted_evidence_id is null) = (trusted_evidence_hash is null)),
  check (checkpoint_name not in ('WAITING_OWNER_QR','WAITING_OWNER_INBOUND') or status <> 'COMPLETE'
    or trusted_evidence_id is not null),
  check (stage in ('FOUNDATION','INFRASTRUCTURE','WAITING_OWNER_QR','CONNECTION','SHADOW','WAITING_OWNER_INBOUND','LIMITED_OBSERVING','LIMITED_VERIFIED','PROACTIVE','SALES_GROUPS','COMPLETE'))
);

create table public.openclaw_smoke_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  rollout_run_id uuid not null,
  command_scope jsonb not null,
  command_scope_hash text not null check (command_scope_hash ~ '^[0-9a-f]{64}$'),
  cleanup_generation bigint not null default 0 check (cleanup_generation >= 0),
  status text not null default 'ALLOCATED' check (status in ('ALLOCATED','RUNNING','COMPLETE','FAILED','CLEANED')),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  foreign key (organization_id, rollout_run_id)
    references public.openclaw_rollout_runs(organization_id, id) on delete restrict,
  check (jsonb_typeof(command_scope) = 'object')
);

create table public.openclaw_smoke_cleanup_proofs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  smoke_run_id uuid not null,
  cleanup_generation bigint not null check (cleanup_generation > 0),
  queued_residual integer not null,
  leased_residual integer not null,
  dispatching_residual integer not null,
  proof_hash text not null check (proof_hash ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, smoke_run_id, cleanup_generation),
  foreign key (organization_id, smoke_run_id)
    references public.openclaw_smoke_runs(organization_id, id) on delete restrict,
  constraint openclaw_smoke_cleanup_zero_residual_check
    check (queued_residual = 0 and leased_residual = 0 and dispatching_residual = 0)
);

create index openclaw_dead_letters_idx
  on public.openclaw_dead_letters (organization_id, account_id, created_at desc, id desc);
create index openclaw_rollout_observations_run_idx
  on public.openclaw_rollout_observations
    (organization_id, rollout_run_id, window_ended_at, id);

create or replace function app_private.reject_openclaw_unknown_state_rewrite_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if NEW.canonical_payload is distinct from OLD.canonical_payload
     or NEW.canonical_payload_bytes is distinct from OLD.canonical_payload_bytes
     or NEW.payload_hash is distinct from OLD.payload_hash
     or row(
       NEW.id, NEW.organization_id, NEW.account_id, NEW.target_id, NEW.source_kind,
       NEW.actor_id, NEW.client_operation_id, NEW.inbound_event_id,
       NEW.automation_version_id, NEW.schedule_id, NEW.schedule_version,
       NEW.subscription_id, NEW.subscription_version, NEW.occurrence_id,
       NEW.campaign_id, NEW.campaign_version, NEW.idempotency_key, NEW.created_at
     ) is distinct from row(
       OLD.id, OLD.organization_id, OLD.account_id, OLD.target_id, OLD.source_kind,
       OLD.actor_id, OLD.client_operation_id, OLD.inbound_event_id,
       OLD.automation_version_id, OLD.schedule_id, OLD.schedule_version,
       OLD.subscription_id, OLD.subscription_version, OLD.occurrence_id,
       OLD.campaign_id, OLD.campaign_version, OLD.idempotency_key, OLD.created_at
     )
  then
    raise exception 'outbox intent and canonical payload cannot change' using errcode = '55000';
  end if;
  if OLD.state = 'UNKNOWN' AND NEW.state <> 'UNKNOWN' then
    raise exception 'historical UNKNOWN state cannot be rewritten' using errcode = '55000';
  end if;
  if OLD.state in ('SENT','FAILED','UNKNOWN','DEAD_LETTER')
     and NEW.state is distinct from OLD.state
  then
    raise exception 'terminal outbox state cannot be rewritten' using errcode = '55000';
  end if;
  if NEW.state is distinct from OLD.state and not (
    (OLD.state = 'QUEUED' and NEW.state in ('LEASED','FAILED','DEAD_LETTER'))
    or (OLD.state = 'LEASED' and NEW.state in ('QUEUED','DISPATCHING','FAILED','DEAD_LETTER'))
    or (OLD.state = 'DISPATCHING' and NEW.state in ('SENT','FAILED','UNKNOWN','DEAD_LETTER'))
  ) then
    raise exception 'invalid outbox state transition' using errcode = '55000';
  end if;
  if OLD.state = 'UNKNOWN'
     and (to_jsonb(NEW) - 'resolution_version')
       is distinct from (to_jsonb(OLD) - 'resolution_version')
  then
    raise exception 'historical UNKNOWN evidence cannot be rewritten' using errcode = '55000';
  end if;
  if NEW.resolution_version is distinct from OLD.resolution_version then
    if OLD.state <> 'UNKNOWN' or NEW.state <> 'UNKNOWN'
       or OLD.resolution_version <> 0 or NEW.resolution_version <> 1
    then
      raise exception 'invalid UNKNOWN resolution version transition' using errcode = '55000';
    end if;
  end if;
  return NEW;
end
$function$;

alter function app_private.reject_openclaw_unknown_state_rewrite_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.reject_openclaw_unknown_state_rewrite_v1()
  from public, anon, authenticated, service_role;

create trigger openclaw_outbox_unknown_terminal
before update on public.openclaw_outbox
for each row execute function app_private.reject_openclaw_unknown_state_rewrite_v1();

create or replace function app_private.guard_openclaw_outbound_authorization_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (to_jsonb(NEW) - array['consumed_at','authorized_handoff_at']::text[])
       is distinct from
     (to_jsonb(OLD) - array['consumed_at','authorized_handoff_at']::text[])
  then
    raise exception 'authorization marker binding cannot change' using errcode = '55000';
  end if;
  if OLD.consumed_at is not null and (
    NEW.consumed_at is distinct from OLD.consumed_at
    or NEW.authorized_handoff_at is distinct from OLD.authorized_handoff_at
  ) then
    raise exception 'authorization marker can only be consumed once' using errcode = '55000';
  end if;
  if (NEW.consumed_at is null) <> (NEW.authorized_handoff_at is null) then
    raise exception 'authorization consumption must record the handoff atomically' using errcode = '55000';
  end if;
  if OLD.consumed_at is null and NEW.consumed_at is not null and (
    clock_timestamp() > OLD.expires_at
    or NEW.consumed_at > OLD.expires_at
  ) then
    raise exception 'expired or invalid authorization handoff' using errcode = '55000';
  end if;
  return NEW;
end
$function$;

alter function app_private.guard_openclaw_outbound_authorization_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_outbound_authorization_v1()
  from public, anon, authenticated, service_role;

create trigger openclaw_outbound_authorizations_consume_once
before update on public.openclaw_outbound_authorizations
for each row execute function app_private.guard_openclaw_outbound_authorization_v1();

create or replace function app_private.guard_openclaw_send_work_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding_changed boolean := row(
    NEW.account_id, NEW.cell_id, NEW.fencing_token, NEW.session_generation
  ) is distinct from row(
    OLD.account_id, OLD.cell_id, OLD.fencing_token, OLD.session_generation
  );
begin
  if row(
       NEW.id, NEW.organization_id, NEW.work_kind, NEW.source_id,
       NEW.source_version, NEW.source_hash, NEW.payload, NEW.payload_hash,
       NEW.created_at
     ) is distinct from row(
       OLD.id, OLD.organization_id, OLD.work_kind, OLD.source_id,
       OLD.source_version, OLD.source_hash, OLD.payload, OLD.payload_hash,
       OLD.created_at
     )
  then
    raise exception 'send work source and frozen payload cannot change' using errcode = '55000';
  end if;

  if v_binding_changed and (
    OLD.state <> 'QUEUED' or NEW.state <> 'QUEUED'
    or OLD.claim_token_hash is not null or NEW.claim_token_hash is not null
    or OLD.lease_expires_at is not null or NEW.lease_expires_at is not null
    or OLD.terminal_at is not null or NEW.terminal_at is not null
    or NEW.claim_generation <> OLD.claim_generation + 1
  ) then
    raise exception 'send work binding can only rebind while unclaimed' using errcode = '55000';
  end if;

  return NEW;
end
$function$;

create or replace function app_private.guard_openclaw_maintenance_work_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding_changed boolean := row(
    NEW.maintenance_principal_id, NEW.maintenance_lease_generation, NEW.fencing_token
  ) is distinct from row(
    OLD.maintenance_principal_id, OLD.maintenance_lease_generation, OLD.fencing_token
  );
begin
  if row(
       NEW.id, NEW.organization_id, NEW.work_kind, NEW.work_phase,
       NEW.source_id, NEW.source_version, NEW.source_hash, NEW.payload,
       NEW.payload_hash, NEW.created_at
     ) is distinct from row(
       OLD.id, OLD.organization_id, OLD.work_kind, OLD.work_phase,
       OLD.source_id, OLD.source_version, OLD.source_hash, OLD.payload,
       OLD.payload_hash, OLD.created_at
     )
  then
    raise exception 'maintenance work source and frozen payload cannot change' using errcode = '55000';
  end if;

  if v_binding_changed and (
    OLD.state <> 'QUEUED' or NEW.state <> 'QUEUED'
    or OLD.claim_token_hash is not null or NEW.claim_token_hash is not null
    or OLD.lease_expires_at is not null or NEW.lease_expires_at is not null
    or OLD.terminal_at is not null or NEW.terminal_at is not null
    or NEW.claim_generation <> OLD.claim_generation + 1
  ) then
    raise exception 'maintenance work binding can only rebind while unclaimed' using errcode = '55000';
  end if;

  return NEW;
end
$function$;

create or replace function app_private.guard_openclaw_audit_root_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (to_jsonb(NEW) - array[
        'signature_hash','gateway_receipt','gateway_receipt_hash','anchored_at'
      ]::text[])
       is distinct from
     (to_jsonb(OLD) - array[
        'signature_hash','gateway_receipt','gateway_receipt_hash','anchored_at'
      ]::text[])
  then
    raise exception 'audit root identity cannot change' using errcode = '55000';
  end if;

  if OLD.anchored_at is not null and to_jsonb(NEW) is distinct from to_jsonb(OLD) then
    raise exception 'audit root can only be anchored once' using errcode = '55000';
  end if;

  if OLD.anchored_at is null and (
    NEW.signature_hash is distinct from OLD.signature_hash
    or NEW.gateway_receipt is distinct from OLD.gateway_receipt
    or NEW.gateway_receipt_hash is distinct from OLD.gateway_receipt_hash
    or NEW.anchored_at is distinct from OLD.anchored_at
  ) and (
    NEW.signature_hash is null or NEW.gateway_receipt is null
    or NEW.gateway_receipt_hash is null or NEW.anchored_at is null
  ) then
    raise exception 'audit root acknowledgement must be atomic' using errcode = '55000';
  end if;

  return NEW;
end
$function$;

alter function app_private.guard_openclaw_send_work_mutation_v1()
  owner to openclaw_function_owner;
alter function app_private.guard_openclaw_maintenance_work_mutation_v1()
  owner to openclaw_function_owner;
alter function app_private.guard_openclaw_audit_root_mutation_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_send_work_mutation_v1()
  from public, anon, authenticated, service_role;
revoke all on function app_private.guard_openclaw_maintenance_work_mutation_v1()
  from public, anon, authenticated, service_role;
revoke all on function app_private.guard_openclaw_audit_root_mutation_v1()
  from public, anon, authenticated, service_role;

create or replace function app_private.append_openclaw_audit_v1(
  p_organization_id uuid,
  p_event_type text,
  p_actor_id uuid,
  p_workload_principal text,
  p_request_id uuid,
  p_correlation_id uuid,
  p_redacted_evidence jsonb,
  p_redacted_evidence_bytes bytea
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid := gen_random_uuid();
  v_sequence bigint;
  v_previous_hash text;
  v_evidence_hash text;
  v_event_hash text;
begin
  if p_actor_id is null and p_workload_principal is null then
    raise exception 'audit actor or workload principal is required' using errcode = '23514';
  end if;
  if jsonb_typeof(p_redacted_evidence) <> 'object'
     or p_redacted_evidence_bytes is null
     or octet_length(p_redacted_evidence_bytes) = 0
     or convert_from(p_redacted_evidence_bytes, 'UTF8')::jsonb <> p_redacted_evidence
  then
    raise exception 'invalid audit evidence' using errcode = '23514';
  end if;
  v_evidence_hash := encode(
    extensions.digest(p_redacted_evidence_bytes, 'sha256'),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
  select e.organization_sequence + 1, e.event_hash
    into v_sequence, v_previous_hash
    from public.openclaw_audit_events e
   where e.organization_id = p_organization_id
   order by e.organization_sequence desc
   limit 1
   for update;

  v_sequence := coalesce(v_sequence, 1);
  v_previous_hash := coalesce(v_previous_hash, repeat('0', 64));
  v_event_hash := encode(extensions.digest(
    convert_to(v_previous_hash, 'UTF8') || decode('00', 'hex')
      || convert_to(v_sequence::text, 'UTF8') || decode('00', 'hex')
      || convert_to(p_event_type, 'UTF8') || decode('00', 'hex')
      || convert_to(v_evidence_hash, 'UTF8'),
    'sha256'
  ), 'hex');

  insert into public.openclaw_audit_events (
    id, organization_id, organization_sequence, event_type, actor_id,
    workload_principal, request_id, correlation_id, redacted_evidence,
    redacted_evidence_bytes, evidence_hash, previous_hash, event_hash
  ) values (
    v_id, p_organization_id, v_sequence, p_event_type, p_actor_id,
    p_workload_principal, p_request_id, p_correlation_id, p_redacted_evidence,
    p_redacted_evidence_bytes, v_evidence_hash, v_previous_hash, v_event_hash
  );
  return v_id;
end
$function$;

create or replace function app_private.verify_openclaw_audit_chain_v1(
  p_organization_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $function$
declare
  v_previous_hash text := repeat('0', 64);
  v_expected_sequence bigint := 1;
  v_expected_hash text;
  v_event record;
begin
  for v_event in
    select organization_sequence, event_type, redacted_evidence_bytes,
           evidence_hash, previous_hash, event_hash
      from public.openclaw_audit_events
     where organization_id = p_organization_id
     order by organization_sequence
  loop
    if v_event.organization_sequence <> v_expected_sequence
       or v_event.previous_hash <> v_previous_hash
    then
      return false;
    end if;
    if encode(extensions.digest(v_event.redacted_evidence_bytes, 'sha256'), 'hex')
         <> v_event.evidence_hash
    then
      return false;
    end if;
    v_expected_hash := encode(extensions.digest(
      convert_to(v_previous_hash, 'UTF8') || decode('00', 'hex')
        || convert_to(v_expected_sequence::text, 'UTF8') || decode('00', 'hex')
        || convert_to(v_event.event_type, 'UTF8') || decode('00', 'hex')
        || convert_to(v_event.evidence_hash, 'UTF8'),
      'sha256'
    ), 'hex');
    if v_event.event_hash <> v_expected_hash then
      return false;
    end if;
    v_previous_hash := v_event.event_hash;
    v_expected_sequence := v_expected_sequence + 1;
  end loop;
  return true;
end
$function$;

alter function app_private.append_openclaw_audit_v1(uuid,text,uuid,text,uuid,uuid,jsonb,bytea)
  owner to openclaw_function_owner;
alter function app_private.verify_openclaw_audit_chain_v1(uuid)
  owner to openclaw_function_owner;
revoke all on function app_private.append_openclaw_audit_v1(uuid,text,uuid,text,uuid,uuid,jsonb,bytea)
  from public, anon, authenticated, service_role;
revoke all on function app_private.verify_openclaw_audit_chain_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function app_private.append_openclaw_audit_v1(uuid,text,uuid,text,uuid,uuid,jsonb,bytea)
  to openclaw_runtime_writer, openclaw_maintenance_writer;
grant execute on function app_private.verify_openclaw_audit_chain_v1(uuid)
  to openclaw_maintenance_writer;

create or replace function app_private.guard_openclaw_rollout_transition_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_stages constant text[] := array[
    'FOUNDATION','INFRASTRUCTURE','WAITING_OWNER_QR','CONNECTION','SHADOW',
    'WAITING_OWNER_INBOUND','LIMITED_OBSERVING','LIMITED_VERIFIED',
    'PROACTIVE','SALES_GROUPS','COMPLETE'
  ];
  v_old_position integer;
  v_new_position integer;
  v_green_started_at timestamptz;
  v_green_ended_at timestamptz;
  v_green_has_gap boolean;
  v_green_has_failure boolean;
begin
  if row(
       NEW.id, NEW.organization_id, NEW.reviewed_commit_sha,
       NEW.migration_manifest_sha256, NEW.upstream_sri, NEW.upstream_git_head,
       NEW.patch_series_sha256, NEW.built_tgz_sha256, NEW.artifact_digests,
       NEW.started_at
     ) is distinct from row(
       OLD.id, OLD.organization_id, OLD.reviewed_commit_sha,
       OLD.migration_manifest_sha256, OLD.upstream_sri, OLD.upstream_git_head,
       OLD.patch_series_sha256, OLD.built_tgz_sha256, OLD.artifact_digests,
       OLD.started_at
     )
  then
    raise exception 'rollout deployment identity cannot change' using errcode = '55000';
  end if;

  if NEW.stage is distinct from OLD.stage then
    v_old_position := array_position(v_stages, OLD.stage);
    v_new_position := array_position(v_stages, NEW.stage);
    if v_new_position <> v_old_position + 1 or NEW.stage_version <> OLD.stage_version + 1 then
      raise exception 'invalid rollout stage transition' using errcode = '55000';
    end if;
    if NEW.stage = 'LIMITED_VERIFIED' then
      if OLD.continuous_green_started_at is null
         or NEW.continuous_green_started_at is distinct from OLD.continuous_green_started_at
         or clock_timestamp() < OLD.continuous_green_started_at + interval '72 hours'
      then
        raise exception 'LIMITED_VERIFIED requires 72 continuous green hours' using errcode = '55000';
      end if;

      with ordered_green as (
        select
          o.window_started_at,
          o.window_ended_at,
          max(o.window_ended_at) over (
            order by o.window_started_at, o.window_ended_at, o.id
            rows between unbounded preceding and 1 preceding
          ) as previous_coverage_end
        from public.openclaw_rollout_observations o
        where o.organization_id = OLD.organization_id
          and o.rollout_run_id = OLD.id
          and o.stage = OLD.stage
          and o.passed
          and o.window_ended_at > OLD.continuous_green_started_at
          and o.window_started_at < OLD.continuous_green_started_at + interval '72 hours'
      )
      select
        min(window_started_at),
        max(window_ended_at),
        coalesce(bool_or(
          previous_coverage_end is not null and window_started_at > previous_coverage_end
        ), false)
      into v_green_started_at, v_green_ended_at, v_green_has_gap
      from ordered_green;

      select exists (
        select 1
        from public.openclaw_rollout_observations o
        where o.organization_id = OLD.organization_id
          and o.rollout_run_id = OLD.id
          and o.stage = OLD.stage
          and not o.passed
          and o.window_ended_at > OLD.continuous_green_started_at
          and o.window_started_at < OLD.continuous_green_started_at + interval '72 hours'
      ) into v_green_has_failure;

      if v_green_started_at is null
         or v_green_started_at > OLD.continuous_green_started_at
         or v_green_ended_at < OLD.continuous_green_started_at + interval '72 hours'
         or v_green_has_gap
         or v_green_has_failure
      then
        raise exception 'LIMITED_VERIFIED requires gap-free persisted observations' using errcode = '55000';
      end if;
    end if;
  elsif NEW.stage_version is distinct from OLD.stage_version then
    raise exception 'rollout stage_version cannot change without a stage transition' using errcode = '55000';
  end if;
  return NEW;
end
$function$;

alter function app_private.guard_openclaw_rollout_transition_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_rollout_transition_v1()
  from public, anon, authenticated, service_role;

create or replace function app_private.guard_openclaw_smoke_run_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if row(
       NEW.id, NEW.organization_id, NEW.rollout_run_id,
       NEW.command_scope, NEW.command_scope_hash
     ) is distinct from row(
       OLD.id, OLD.organization_id, OLD.rollout_run_id,
       OLD.command_scope, OLD.command_scope_hash
     )
  then
    raise exception 'smoke command scope cannot change' using errcode = '55000';
  end if;
  return NEW;
end
$function$;

alter function app_private.guard_openclaw_smoke_run_mutation_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_smoke_run_mutation_v1()
  from public, anon, authenticated, service_role;

create trigger openclaw_rollout_runs_transition_guard
before update on public.openclaw_rollout_runs
for each row execute function app_private.guard_openclaw_rollout_transition_v1();
create trigger openclaw_audit_roots_anchor_once
before update on public.openclaw_audit_roots
for each row execute function app_private.guard_openclaw_audit_root_mutation_v1();
create trigger openclaw_smoke_runs_command_scope_guard
before update on public.openclaw_smoke_runs
for each row execute function app_private.guard_openclaw_smoke_run_mutation_v1();

create trigger openclaw_delivery_attempts_append_only
before update or delete on public.openclaw_delivery_attempts
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_dead_letters_append_only
before update or delete on public.openclaw_dead_letters
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_unknown_resolutions_append_only
before update or delete on public.openclaw_unknown_resolutions
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_send_work_attempts_append_only
before update or delete on public.openclaw_send_work_attempts
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_maintenance_work_attempts_append_only
before update or delete on public.openclaw_maintenance_work_attempts
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_audit_events_append_only
before update or delete on public.openclaw_audit_events
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_health_events_append_only
before update or delete on public.openclaw_health_events
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_rollout_observations_append_only
before update or delete on public.openclaw_rollout_observations
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_rollout_checkpoints_append_only
before update or delete on public.openclaw_rollout_checkpoints
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_smoke_cleanup_proofs_append_only
before update or delete on public.openclaw_smoke_cleanup_proofs
for each row execute function app_private.reject_openclaw_append_only_v1();

alter table public.openclaw_outbox owner to openclaw_function_owner;
alter table public.openclaw_outbox enable row level security;
alter table public.openclaw_outbox force row level security;
revoke all on public.openclaw_outbox from public, anon, authenticated, service_role;

alter table public.openclaw_outbound_authorizations owner to openclaw_function_owner;
alter table public.openclaw_outbound_authorizations enable row level security;
alter table public.openclaw_outbound_authorizations force row level security;
revoke all on public.openclaw_outbound_authorizations from public, anon, authenticated, service_role;

alter table public.openclaw_delivery_attempts owner to openclaw_function_owner;
alter table public.openclaw_delivery_attempts enable row level security;
alter table public.openclaw_delivery_attempts force row level security;
revoke all on public.openclaw_delivery_attempts from public, anon, authenticated, service_role;

alter table public.openclaw_dead_letters owner to openclaw_function_owner;
alter table public.openclaw_dead_letters enable row level security;
alter table public.openclaw_dead_letters force row level security;
revoke all on public.openclaw_dead_letters from public, anon, authenticated, service_role;

alter table public.openclaw_unknown_resolutions owner to openclaw_function_owner;
alter table public.openclaw_unknown_resolutions enable row level security;
alter table public.openclaw_unknown_resolutions force row level security;
revoke all on public.openclaw_unknown_resolutions from public, anon, authenticated, service_role;

alter table public.openclaw_send_work_items owner to openclaw_function_owner;
alter table public.openclaw_send_work_items enable row level security;
alter table public.openclaw_send_work_items force row level security;
revoke all on public.openclaw_send_work_items from public, anon, authenticated, service_role;

alter table public.openclaw_send_work_attempts owner to openclaw_function_owner;
alter table public.openclaw_send_work_attempts enable row level security;
alter table public.openclaw_send_work_attempts force row level security;
revoke all on public.openclaw_send_work_attempts from public, anon, authenticated, service_role;

alter table public.openclaw_maintenance_work_items owner to openclaw_function_owner;
alter table public.openclaw_maintenance_work_items enable row level security;
alter table public.openclaw_maintenance_work_items force row level security;
revoke all on public.openclaw_maintenance_work_items from public, anon, authenticated, service_role;

alter table public.openclaw_maintenance_work_attempts owner to openclaw_function_owner;
alter table public.openclaw_maintenance_work_attempts enable row level security;
alter table public.openclaw_maintenance_work_attempts force row level security;
revoke all on public.openclaw_maintenance_work_attempts from public, anon, authenticated, service_role;

alter table public.openclaw_audit_events owner to openclaw_function_owner;
alter table public.openclaw_audit_events enable row level security;
alter table public.openclaw_audit_events force row level security;
revoke all on public.openclaw_audit_events from public, anon, authenticated, service_role;

alter table public.openclaw_audit_roots owner to openclaw_function_owner;
alter table public.openclaw_audit_roots enable row level security;
alter table public.openclaw_audit_roots force row level security;
revoke all on public.openclaw_audit_roots from public, anon, authenticated, service_role;

alter table public.openclaw_health_events owner to openclaw_function_owner;
alter table public.openclaw_health_events enable row level security;
alter table public.openclaw_health_events force row level security;
revoke all on public.openclaw_health_events from public, anon, authenticated, service_role;

alter table public.openclaw_retention_holds owner to openclaw_function_owner;
alter table public.openclaw_retention_holds enable row level security;
alter table public.openclaw_retention_holds force row level security;
revoke all on public.openclaw_retention_holds from public, anon, authenticated, service_role;

alter table public.openclaw_rollout_runs owner to openclaw_function_owner;
alter table public.openclaw_rollout_runs enable row level security;
alter table public.openclaw_rollout_runs force row level security;
revoke all on public.openclaw_rollout_runs from public, anon, authenticated, service_role;

alter table public.openclaw_rollout_observations owner to openclaw_function_owner;
alter table public.openclaw_rollout_observations enable row level security;
alter table public.openclaw_rollout_observations force row level security;
revoke all on public.openclaw_rollout_observations from public, anon, authenticated, service_role;

alter table public.openclaw_rollout_checkpoints owner to openclaw_function_owner;
alter table public.openclaw_rollout_checkpoints enable row level security;
alter table public.openclaw_rollout_checkpoints force row level security;
revoke all on public.openclaw_rollout_checkpoints from public, anon, authenticated, service_role;

alter table public.openclaw_smoke_runs owner to openclaw_function_owner;
alter table public.openclaw_smoke_runs enable row level security;
alter table public.openclaw_smoke_runs force row level security;
revoke all on public.openclaw_smoke_runs from public, anon, authenticated, service_role;

alter table public.openclaw_smoke_cleanup_proofs owner to openclaw_function_owner;
alter table public.openclaw_smoke_cleanup_proofs enable row level security;
alter table public.openclaw_smoke_cleanup_proofs force row level security;
revoke all on public.openclaw_smoke_cleanup_proofs from public, anon, authenticated, service_role;

create trigger openclaw_outbox_immutable_tenant
before update on public.openclaw_outbox
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_outbound_authorizations_immutable_tenant
before update on public.openclaw_outbound_authorizations
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_send_work_items_immutable_tenant
before update on public.openclaw_send_work_items
for each row execute function app_private.guard_openclaw_send_work_mutation_v1();
create trigger openclaw_maintenance_work_items_immutable_tenant
before update on public.openclaw_maintenance_work_items
for each row execute function app_private.guard_openclaw_maintenance_work_mutation_v1();
create trigger openclaw_audit_roots_immutable_tenant
before update on public.openclaw_audit_roots
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_retention_holds_immutable_tenant
before update on public.openclaw_retention_holds
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_rollout_runs_immutable_tenant
before update on public.openclaw_rollout_runs
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_smoke_runs_immutable_tenant
before update on public.openclaw_smoke_runs
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();

do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'openclaw_outbox','openclaw_outbound_authorizations','openclaw_delivery_attempts',
    'openclaw_dead_letters','openclaw_unknown_resolutions','openclaw_send_work_items',
    'openclaw_send_work_attempts','openclaw_maintenance_work_items',
    'openclaw_maintenance_work_attempts','openclaw_audit_events','openclaw_audit_roots',
    'openclaw_health_events','openclaw_retention_holds','openclaw_rollout_runs',
    'openclaw_rollout_observations','openclaw_rollout_checkpoints','openclaw_smoke_runs',
    'openclaw_smoke_cleanup_proofs'
  ] loop
    execute format(
      'create policy %I on public.%I for all to openclaw_function_owner using (true) with check (true)',
      v_table || '_function_owner_all', v_table
    );
  end loop;

  foreach v_table in array array[
    'openclaw_outbox','openclaw_outbound_authorizations','openclaw_send_work_items'
  ] loop
    execute format(
      'create policy %I on public.%I for all to openclaw_runtime_writer using (true) with check (true)',
      v_table || '_runtime_writer_all', v_table
    );
  end loop;

  foreach v_table in array array[
    'openclaw_delivery_attempts','openclaw_dead_letters','openclaw_send_work_attempts',
    'openclaw_health_events'
  ] loop
    execute format(
      'create policy %I on public.%I for select to openclaw_runtime_writer using (true)',
      v_table || '_runtime_writer_select', v_table
    );
    execute format(
      'create policy %I on public.%I for insert to openclaw_runtime_writer with check (true)',
      v_table || '_runtime_writer_insert', v_table
    );
  end loop;

  foreach v_table in array array[
    'openclaw_maintenance_work_items','openclaw_audit_roots','openclaw_rollout_runs',
    'openclaw_smoke_runs'
  ] loop
    execute format(
      'create policy %I on public.%I for all to openclaw_maintenance_writer using (true) with check (true)',
      v_table || '_maintenance_writer_all', v_table
    );
  end loop;

  foreach v_table in array array[
    'openclaw_maintenance_work_attempts','openclaw_health_events',
    'openclaw_rollout_observations','openclaw_rollout_checkpoints',
    'openclaw_smoke_cleanup_proofs'
  ] loop
    execute format(
      'create policy %I on public.%I for select to openclaw_maintenance_writer using (true)',
      v_table || '_maintenance_writer_select', v_table
    );
    execute format(
      'create policy %I on public.%I for insert to openclaw_maintenance_writer with check (true)',
      v_table || '_maintenance_writer_insert', v_table
    );
  end loop;
end
$policies$;

create policy openclaw_audit_events_maintenance_writer_select
  on public.openclaw_audit_events for select to openclaw_maintenance_writer
  using (true);
create policy openclaw_retention_holds_maintenance_writer_select
  on public.openclaw_retention_holds for select to openclaw_maintenance_writer
  using (true);

grant select, insert, update on
  public.openclaw_outbox,
  public.openclaw_outbound_authorizations,
  public.openclaw_send_work_items
to openclaw_runtime_writer;
grant select, insert on
  public.openclaw_delivery_attempts,
  public.openclaw_dead_letters,
  public.openclaw_send_work_attempts,
  public.openclaw_health_events
to openclaw_runtime_writer;

grant select, insert, update on
  public.openclaw_maintenance_work_items,
  public.openclaw_audit_roots,
  public.openclaw_rollout_runs,
  public.openclaw_smoke_runs
to openclaw_maintenance_writer;
grant select, insert on
  public.openclaw_maintenance_work_attempts,
  public.openclaw_health_events,
  public.openclaw_rollout_observations,
  public.openclaw_rollout_checkpoints,
  public.openclaw_smoke_cleanup_proofs
to openclaw_maintenance_writer;
grant select on
  public.openclaw_audit_events,
  public.openclaw_retention_holds
to openclaw_maintenance_writer;

commit;
