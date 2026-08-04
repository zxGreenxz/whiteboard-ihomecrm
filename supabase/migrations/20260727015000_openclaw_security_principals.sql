begin;

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_function_owner') then
    raise exception 'openclaw_function_owner must be created by the catalog foundation';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_runtime_writer') then
    create role openclaw_runtime_writer with NOLOGIN NOINHERIT NOBYPASSRLS;
  else
    alter role openclaw_runtime_writer with NOLOGIN NOINHERIT NOBYPASSRLS;
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_maintenance_writer') then
    create role openclaw_maintenance_writer with NOLOGIN NOINHERIT NOBYPASSRLS;
  else
    alter role openclaw_maintenance_writer with NOLOGIN NOINHERIT NOBYPASSRLS;
  end if;
end
$roles$;

-- Ownership assignment needs two things a superuser has for free and the Supabase
-- `postgres` role does not: SET on the owning role (PostgreSQL 16+ withholds it
-- from role creators) and CREATE for that role on the object's schema. Both are
-- given here and taken back before this file commits.
grant openclaw_function_owner to current_user with set true;
grant openclaw_runtime_writer to current_user with set true;
grant openclaw_maintenance_writer to current_user with set true;
grant create on schema public, app_private to openclaw_function_owner, openclaw_runtime_writer, openclaw_maintenance_writer;

create table public.openclaw_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  provider_account_id text,
  account_profile text not null default 'default'
    check (account_profile ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  display_name text,
  is_active boolean not null default true,
  connection_state text not null default 'DISCONNECTED'
    check (connection_state IN ('DISCONNECTED','QR_PENDING','CONNECTING','CONNECTED','DISCONNECTING','RECONNECT_REQUIRED')),
  session_risk_state text not null default 'HEALTHY'
    check (session_risk_state IN ('HEALTHY','DEGRADED','LIMITED','SUSPECTED_THEFT','INVALID')),
  configured_mode text not null default 'DRAFT_ONLY'
    check (configured_mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')),
  effective_mode text not null default 'DRAFT_ONLY'
    check (effective_mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')),
  session_generation bigint not null default 1 check (session_generation > 0),
  connection_generation bigint not null default 0 check (connection_generation >= 0),
  disclosure_version integer not null default 1 check (disclosure_version > 0),
  disclosure_acknowledged_version integer check (disclosure_acknowledged_version > 0),
  disclosure_acknowledged_at timestamptz,
  paused_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_profile),
  check (
    effective_mode = 'DRAFT_ONLY'
    or (
      is_active
      and connection_state = 'CONNECTED'
      and session_risk_state not in ('LIMITED','SUSPECTED_THEFT','INVALID')
      and paused_at is null
      and disclosure_acknowledged_version = disclosure_version
    )
  )
);

create unique index openclaw_accounts_one_active_per_org_uidx
  on public.openclaw_accounts (organization_id)
  where is_active;
create index openclaw_accounts_org_state_idx
  on public.openclaw_accounts (organization_id, connection_state, effective_mode);

create table public.openclaw_account_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  connection_generation bigint not null check (connection_generation > 0),
  connection_state text not null
    check (connection_state IN ('DISCONNECTED','QR_PENDING','CONNECTING','CONNECTED','DISCONNECTING','RECONNECT_REQUIRED')),
  session_risk_state text not null
    check (session_risk_state IN ('HEALTHY','DEGRADED','LIMITED','SUSPECTED_THEFT','INVALID')),
  configured_mode text not null
    check (configured_mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')),
  effective_mode text not null
    check (effective_mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')),
  reason_code text not null,
  disclosure_version integer not null check (disclosure_version > 0),
  disclosure_acknowledged_version integer check (disclosure_acknowledged_version > 0),
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default clock_timestamp(),
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  check (effective_mode <> 'DRAFT_ONLY' or effective_mode = 'DRAFT_ONLY')
);

create unique index openclaw_connections_one_effective_uidx
  on public.openclaw_account_connections
    (organization_id, account_id, connection_generation);
create index openclaw_connections_account_cursor_idx
  on public.openclaw_account_connections
    (organization_id, account_id, changed_at desc, id desc);

create table public.openclaw_runtime_cells (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_generation bigint not null check (cell_generation > 0),
  state text not null default 'PROVISIONING'
    check (state in ('PROVISIONING','READY','STALE','FENCED','RETIRED')),
  is_current boolean not null default true,
  reviewed_commit_sha text not null check (reviewed_commit_sha ~ '^[0-9a-f]{40}$'),
  image_digest text not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  config_digest text not null check (config_digest ~ '^[0-9a-f]{64}$'),
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  check ((is_current and retired_at is null) or (not is_current))
);

create unique index openclaw_runtime_cells_one_current_uidx
  on public.openclaw_runtime_cells (organization_id, account_id)
  where is_current;
create index openclaw_runtime_cells_health_idx
  on public.openclaw_runtime_cells (organization_id, state, last_heartbeat_at);

create table public.openclaw_runtime_leases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  lease_generation bigint not null check (lease_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','REVOKED','EXPIRED','RELEASED')),
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  released_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, lease_generation),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (expires_at > acquired_at),
  check ((status = 'ACTIVE' and released_at is null) or status <> 'ACTIVE')
);

create unique index openclaw_runtime_leases_one_effective_uidx
  on public.openclaw_runtime_leases (organization_id, account_id)
  where status = 'ACTIVE' and released_at is null;
create index openclaw_runtime_leases_expiry_idx
  on public.openclaw_runtime_leases (expires_at)
  where status = 'ACTIVE';

create table public.openclaw_runtime_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  credential_generation bigint not null check (credential_generation > 0),
  credential_hash text NOT NULL check (credential_hash ~ '^[0-9a-f]{64}$'),
  allowed_scopes text[] NOT NULL,
  enabled_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_reason text,
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, cell_id, credential_generation),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  constraint openclaw_runtime_credentials_allowed_scopes_nonempty_check
    check (cardinality(allowed_scopes) > 0),
  constraint openclaw_runtime_credentials_allowed_scopes_check
    check (allowed_scopes <@ ARRAY['heartbeat','qr.publish','qr.result','inbound.commit','outbox.claim','outbox.preflight','outbox.authorize-send','outbox.requeue','outbox.complete','work.claim','work.complete','media.issue']::text[])
);

create unique index openclaw_runtime_credentials_one_current_uidx
  on public.openclaw_runtime_credentials (organization_id, account_id, cell_id)
  where revoked_at is null;
create index openclaw_runtime_credentials_lookup_idx
  on public.openclaw_runtime_credentials
    (organization_id, account_id, cell_id, credential_generation)
  where revoked_at is null;

create table public.openclaw_maintenance_principals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  principal_generation bigint not null check (principal_generation > 0),
  is_current boolean not null default true,
  enabled_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, principal_generation),
  check ((is_current and revoked_at is null) or not is_current)
);

create unique index openclaw_maintenance_principals_one_current_uidx
  on public.openclaw_maintenance_principals (organization_id)
  where is_current;

create table public.openclaw_maintenance_leases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  lease_generation bigint not null check (lease_generation > 0),
  fencing_token bigint not null check (fencing_token > 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','REVOKED','EXPIRED','RELEASED')),
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  released_at timestamptz,
  UNIQUE (organization_id, id),
  unique (organization_id, maintenance_principal_id, lease_generation),
  foreign key (organization_id, maintenance_principal_id)
    references public.openclaw_maintenance_principals(organization_id, id) on delete restrict,
  check (expires_at > acquired_at),
  check ((status = 'ACTIVE' and released_at is null) or status <> 'ACTIVE')
);

create unique index openclaw_maintenance_leases_one_effective_uidx
  on public.openclaw_maintenance_leases (organization_id, maintenance_principal_id)
  where status = 'ACTIVE' and released_at is null;
create index openclaw_maintenance_leases_expiry_idx
  on public.openclaw_maintenance_leases (expires_at)
  where status = 'ACTIVE';

create table public.openclaw_maintenance_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  credential_generation bigint not null check (credential_generation > 0),
  credential_hash text NOT NULL check (credential_hash ~ '^[0-9a-f]{64}$'),
  allowed_scopes text[] NOT NULL,
  enabled_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_reason text,
  UNIQUE (organization_id, id),
  unique (organization_id, maintenance_principal_id, credential_generation),
  foreign key (organization_id, maintenance_principal_id)
    references public.openclaw_maintenance_principals(organization_id, id) on delete restrict,
  constraint openclaw_maintenance_credentials_allowed_scopes_nonempty_check
    check (cardinality(allowed_scopes) > 0),
  constraint openclaw_maintenance_credentials_allowed_scopes_check
    check (allowed_scopes <@ ARRAY['maintenance.claim','maintenance.complete']::text[])
);

create unique index openclaw_maintenance_credentials_one_current_uidx
  on public.openclaw_maintenance_credentials (organization_id, maintenance_principal_id)
  where revoked_at is null;
create index openclaw_maintenance_credentials_lookup_idx
  on public.openclaw_maintenance_credentials
    (organization_id, maintenance_principal_id, credential_generation)
  where revoked_at is null;

create table public.openclaw_qr_challenges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  challenge_version integer not null default 1 check (challenge_version > 0),
  challenge_status text not null default 'PENDING'
    check (challenge_status IN ('PENDING','CONSUMED','EXPIRED','REVOKED')),
  active_slot boolean not null default true,
  ciphertext bytea not null,
  cipher_iv bytea not null check (octet_length(cipher_iv) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  actor_id uuid not null references auth.users(id) on delete restrict,
  auth_session_hash text not null check (auth_session_hash ~ '^[0-9a-f]{64}$'),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (organization_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (expires_at = issued_at + interval '120 seconds'),
  check ((active_slot and challenge_status = 'PENDING' and consumed_at is null and revoked_at is null) or not active_slot),
  check ((challenge_status = 'CONSUMED') = (consumed_at is not null))
);

create unique index openclaw_qr_challenges_one_pending_uidx
  on public.openclaw_qr_challenges (organization_id, account_id)
  where active_slot;
create index openclaw_qr_challenges_expiry_idx
  on public.openclaw_qr_challenges (expires_at)
  where active_slot;

alter table public.openclaw_accounts owner to openclaw_function_owner;
alter table public.openclaw_accounts enable row level security;
alter table public.openclaw_accounts force row level security;
revoke all on public.openclaw_accounts from public, anon, authenticated, service_role;

alter table public.openclaw_account_connections owner to openclaw_function_owner;
alter table public.openclaw_account_connections enable row level security;
alter table public.openclaw_account_connections force row level security;
revoke all on public.openclaw_account_connections from public, anon, authenticated, service_role;

alter table public.openclaw_runtime_cells owner to openclaw_function_owner;
alter table public.openclaw_runtime_cells enable row level security;
alter table public.openclaw_runtime_cells force row level security;
revoke all on public.openclaw_runtime_cells from public, anon, authenticated, service_role;

alter table public.openclaw_runtime_leases owner to openclaw_function_owner;
alter table public.openclaw_runtime_leases enable row level security;
alter table public.openclaw_runtime_leases force row level security;
revoke all on public.openclaw_runtime_leases from public, anon, authenticated, service_role;

alter table public.openclaw_runtime_credentials owner to openclaw_function_owner;
alter table public.openclaw_runtime_credentials enable row level security;
alter table public.openclaw_runtime_credentials force row level security;
revoke all on public.openclaw_runtime_credentials from public, anon, authenticated, service_role;

alter table public.openclaw_maintenance_principals owner to openclaw_function_owner;
alter table public.openclaw_maintenance_principals enable row level security;
alter table public.openclaw_maintenance_principals force row level security;
revoke all on public.openclaw_maintenance_principals from public, anon, authenticated, service_role;

alter table public.openclaw_maintenance_leases owner to openclaw_function_owner;
alter table public.openclaw_maintenance_leases enable row level security;
alter table public.openclaw_maintenance_leases force row level security;
revoke all on public.openclaw_maintenance_leases from public, anon, authenticated, service_role;

alter table public.openclaw_maintenance_credentials owner to openclaw_function_owner;
alter table public.openclaw_maintenance_credentials enable row level security;
alter table public.openclaw_maintenance_credentials force row level security;
revoke all on public.openclaw_maintenance_credentials from public, anon, authenticated, service_role;

alter table public.openclaw_qr_challenges owner to openclaw_function_owner;
alter table public.openclaw_qr_challenges enable row level security;
alter table public.openclaw_qr_challenges force row level security;
revoke all on public.openclaw_qr_challenges from public, anon, authenticated, service_role;

create or replace function app_private.reject_openclaw_tenant_identity_update_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
begin
  if OLD.organization_id is distinct from NEW.organization_id then
    raise exception 'organization_id cannot change' using errcode = '23514';
  end if;
  if v_old ? 'account_id' and v_old -> 'account_id' is distinct from v_new -> 'account_id' then
    raise exception 'account_id cannot change' using errcode = '23514';
  end if;
  if v_old ? 'cell_id' and v_old -> 'cell_id' is distinct from v_new -> 'cell_id' then
    raise exception 'cell_id cannot change' using errcode = '23514';
  end if;
  if v_old ? 'maintenance_principal_id'
     and v_old -> 'maintenance_principal_id' is distinct from v_new -> 'maintenance_principal_id'
  then
    raise exception 'maintenance_principal_id cannot change' using errcode = '23514';
  end if;
  return NEW;
end
$function$;

alter function app_private.reject_openclaw_tenant_identity_update_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.reject_openclaw_tenant_identity_update_v1()
  from public, anon, authenticated, service_role;

create or replace function app_private.reject_openclaw_append_only_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception '% is append-only', TG_TABLE_NAME using errcode = '55000';
end
$function$;

alter function app_private.reject_openclaw_append_only_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.reject_openclaw_append_only_v1()
  from public, anon, authenticated, service_role;

create trigger openclaw_account_connections_append_only
before update or delete on public.openclaw_account_connections
for each row execute function app_private.reject_openclaw_append_only_v1();

do $security$
declare
  v_table text;
begin
  foreach v_table in array array[
    'openclaw_accounts',
    'openclaw_account_connections',
    'openclaw_runtime_cells',
    'openclaw_runtime_leases',
    'openclaw_runtime_credentials',
    'openclaw_maintenance_principals',
    'openclaw_maintenance_leases',
    'openclaw_maintenance_credentials',
    'openclaw_qr_challenges'
  ]
  loop
    execute format(
      'create policy %I on public.%I for all to openclaw_function_owner using (true) with check (true)',
      v_table || '_function_owner_all',
      v_table
    );
    execute format(
      'create trigger %I before update on public.%I for each row execute function app_private.reject_openclaw_tenant_identity_update_v1()',
      v_table || '_immutable_tenant',
      v_table
    );
  end loop;
end
$security$;

create policy openclaw_accounts_runtime_writer_all
  on public.openclaw_accounts for all to openclaw_runtime_writer
  using (true) with check (true);
create policy openclaw_account_connections_runtime_writer_select
  on public.openclaw_account_connections for select to openclaw_runtime_writer
  using (true);
create policy openclaw_account_connections_runtime_writer_insert
  on public.openclaw_account_connections for insert to openclaw_runtime_writer
  with check (true);
create policy openclaw_runtime_cells_runtime_writer_all
  on public.openclaw_runtime_cells for all to openclaw_runtime_writer
  using (true) with check (true);
create policy openclaw_runtime_leases_runtime_writer_all
  on public.openclaw_runtime_leases for all to openclaw_runtime_writer
  using (true) with check (true);
create policy openclaw_runtime_credentials_runtime_writer_all
  on public.openclaw_runtime_credentials for all to openclaw_runtime_writer
  using (true) with check (true);
create policy openclaw_qr_challenges_runtime_writer_all
  on public.openclaw_qr_challenges for all to openclaw_runtime_writer
  using (true) with check (true);

create policy openclaw_maintenance_principals_writer_all
  on public.openclaw_maintenance_principals for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_maintenance_leases_writer_all
  on public.openclaw_maintenance_leases for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_maintenance_credentials_writer_all
  on public.openclaw_maintenance_credentials for all to openclaw_maintenance_writer
  using (true) with check (true);

grant usage on schema public, app_private to openclaw_runtime_writer, openclaw_maintenance_writer;
grant select, insert on public.openclaw_account_connections to openclaw_runtime_writer;
grant select, insert, update on
  public.openclaw_accounts,
  public.openclaw_runtime_cells,
  public.openclaw_runtime_leases,
  public.openclaw_runtime_credentials,
  public.openclaw_qr_challenges
to openclaw_runtime_writer;
grant select, insert, update on
  public.openclaw_maintenance_principals,
  public.openclaw_maintenance_leases,
  public.openclaw_maintenance_credentials
to openclaw_maintenance_writer;


-- CREATE was only ever needed to hand ownership over; ownership and SECURITY
-- DEFINER execution both survive the revoke, so no openclaw role keeps the
-- ability to create objects.
revoke create on schema public, app_private from openclaw_function_owner, openclaw_runtime_writer, openclaw_maintenance_writer;
commit;
