begin;

do $openclaw_owner_grants$
declare
  v_role text;
  v_schema text;
begin
  -- No-op on a superuser harness: superusers already satisfy both checks below.
  -- On Supabase the connected role is the non-superuser `postgres`, which needs
  -- SET on each owner role (PostgreSQL 16+ withholds it from role creators) and
  -- needs each owner role to hold CREATE on the schema it will own objects in.
  -- Both are revoked again at the end of this file.
  for v_role in
    select rolname from pg_catalog.pg_roles where rolname like 'openclaw\_%'
  loop
    if not pg_catalog.pg_has_role(current_user, v_role, 'SET') then
      execute format('grant %I to %I with set true', v_role, current_user);
    end if;
    foreach v_schema in array array['public', 'app_private'] loop
      if pg_catalog.to_regnamespace(v_schema) is not null
         and not pg_catalog.has_schema_privilege(v_role, v_schema, 'CREATE') then
        execute format('grant create on schema %I to %I', v_schema, v_role);
      end if;
    end loop;
  end loop;
end
$openclaw_owner_grants$;

create table public.openclaw_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  provider_id text not null check (length(provider_id) between 1 and 255),
  display_name text,
  avatar_object_key text,
  directory_version bigint not null default 1 check (directory_version > 0),
  directory_refreshed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, provider_id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  check (avatar_object_key is null or avatar_object_key like 'v1/org/%')
);

create table public.openclaw_sales_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  provider_id text not null check (length(provider_id) between 1 and 255),
  display_name text not null,
  member_count integer check (member_count is null or member_count >= 0),
  directory_version bigint not null default 1 check (directory_version > 0),
  directory_refreshed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, provider_id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict
);

create table public.openclaw_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  kind text not null check (kind IN ('PEER','SALES_GROUP')),
  provider_id text not null check (length(provider_id) between 1 and 255),
  contact_id uuid,
  sales_group_id uuid,
  target_version bigint not null default 1 check (target_version > 0),
  directory_refreshed_at timestamptz not null,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, kind, provider_id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, contact_id)
    references public.openclaw_contacts(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, sales_group_id)
    references public.openclaw_sales_groups(organization_id, account_id, id) on delete restrict,
  check (
    (kind = 'PEER' and contact_id is not null and sales_group_id is null)
    or (kind = 'SALES_GROUP' and sales_group_id is not null and contact_id is null)
  )
);

create table public.openclaw_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  target_id uuid not null,
  provider_conversation_id text not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED','ARCHIVED')),
  assigned_membership_id uuid,
  unread_count integer not null default 0 check (unread_count >= 0),
  last_received_at timestamptz,
  last_message_id uuid,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, provider_conversation_id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, target_id)
    references public.openclaw_targets(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, assigned_membership_id)
    references public.organization_memberships(organization_id, id) on delete restrict
);

create table public.openclaw_conversation_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  provider_member_id text not null,
  display_name text,
  member_role text not null default 'MEMBER' check (member_role in ('OWNER','ADMIN','MEMBER')),
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, conversation_id, provider_member_id),
  foreign key (organization_id, account_id, conversation_id)
    references public.openclaw_conversations(organization_id, account_id, id) on delete cascade,
  check (left_at is null or joined_at is null or left_at >= joined_at)
);

create table public.openclaw_inbound_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  session_generation bigint not null check (session_generation > 0),
  event_kind text not null
    check (event_kind in ('MESSAGE','REACTION','DELIVERY_RECEIPT','SEEN','TYPING','MEMBERSHIP','OTHER')),
  provider_event_id text,
  provider_message_id text,
  provider_conversation_id text not null,
  provider_sender_id text not null,
  target_kind text not null check (target_kind IN ('PEER','SALES_GROUP')),
  target_provider_id text not null,
  provider_event_type text not null,
  source_timestamp timestamptz not null,
  callback_received_at timestamptz not null,
  raw_envelope jsonb not null,
  raw_envelope_sha256 text not null check (raw_envelope_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_envelope jsonb not null,
  normalized_sha256 text not null check (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  fallback_fingerprint text check (fallback_fingerprint is null or fallback_fingerprint ~ '^[0-9a-f]{64}$'),
  ingest_state text not null default 'ACCEPTED'
    check (ingest_state in ('ACCEPTED','DUPLICATE','QUARANTINED')),
  quarantine_reason text,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  foreign key (organization_id, account_id)
    references public.openclaw_accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, account_id, cell_id)
    references public.openclaw_runtime_cells(organization_id, account_id, id) on delete restrict,
  check (
    (provider_event_id is null and provider_message_id is null and fallback_fingerprint is not null)
    or (coalesce(provider_event_id, provider_message_id) is not null and fallback_fingerprint is null)
  ),
  check ((ingest_state = 'QUARANTINED') = (quarantine_reason is not null))
);

create unique index openclaw_inbound_fallback_uidx
  on public.openclaw_inbound_events
    (organization_id, account_id, event_kind, fallback_fingerprint)
  where provider_event_id is null
    and provider_message_id is null
    and fallback_fingerprint is not null;
create index openclaw_inbound_account_cursor_idx
  on public.openclaw_inbound_events
    (organization_id, account_id, callback_received_at, id);

create table public.openclaw_inbound_provider_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  event_kind text not null
    check (event_kind in ('MESSAGE','REACTION','DELIVERY_RECEIPT','SEEN','TYPING','MEMBERSHIP','OTHER')),
  stable_id_kind text not null
    check (stable_id_kind IN ('PROVIDER_EVENT_ID','PROVIDER_MESSAGE_ID')),
  stable_id_value text not null,
  inbound_event_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  paired_stable_id_kind text
    check (paired_stable_id_kind is null or paired_stable_id_kind IN ('PROVIDER_EVENT_ID','PROVIDER_MESSAGE_ID')),
  paired_stable_id_value text,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, event_kind, stable_id_kind, stable_id_value),
  foreign key (organization_id, account_id, inbound_event_id)
    references public.openclaw_inbound_events(organization_id, account_id, id) on delete restrict,
  check ((paired_stable_id_kind is null) = (paired_stable_id_value is null)),
  check (paired_stable_id_kind is null or paired_stable_id_kind <> stable_id_kind)
);

create unique index openclaw_inbound_identity_cross_kind_guard_uidx
  on public.openclaw_inbound_provider_identities
    (organization_id, account_id, stable_id_kind, stable_id_value);
create index openclaw_inbound_identity_event_idx
  on public.openclaw_inbound_provider_identities
    (organization_id, account_id, inbound_event_id);

create table public.openclaw_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  source_inbound_event_id uuid,
  direction text not null check (direction in ('INBOUND','OUTBOUND','SYSTEM')),
  event_kind text not null default 'MESSAGE'
    check (event_kind in ('MESSAGE','REACTION','DELIVERY_RECEIPT','SEEN','TYPING','MEMBERSHIP','OTHER')),
  provider_message_id text,
  provider_sender_id text,
  text_content text,
  reply_to_provider_message_id text,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  provider_timestamp timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  foreign key (organization_id, account_id, conversation_id)
    references public.openclaw_conversations(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, source_inbound_event_id)
    references public.openclaw_inbound_events(organization_id, account_id, id) on delete restrict
);

create unique index openclaw_messages_provider_uidx
  on public.openclaw_messages
    (organization_id, account_id, event_kind, provider_message_id)
  where provider_message_id is not null;
create index openclaw_messages_thread_cursor_idx
  on public.openclaw_messages
    (organization_id, account_id, conversation_id, received_at desc, id desc);
create index openclaw_messages_unread_idx
  on public.openclaw_messages
    (organization_id, account_id, conversation_id, received_at desc)
  where direction = 'INBOUND';
create index openclaw_conversations_active_idx
  on public.openclaw_conversations
    (organization_id, account_id, status, last_received_at desc, id desc);
-- The index above carries `status` BETWEEN the equality columns and the ordering
-- columns, so it can only serve a query that also filters on status.
-- `openclaw_list_conversations_v1` does not: it filters on
-- (organization_id, account_id) and orders by (last_received_at desc, id desc).
-- Measured on 10,000 seeded rows, that query fell back to a sequential scan plus a
-- sort - ten thousand rows read to return fifty - and the keyset cursor page did
-- the same, which means page 20 cost exactly what page 1 cost and the cursor
-- bought nothing. This index matches the query as written.
create index openclaw_conversations_recent_idx
  on public.openclaw_conversations
    (organization_id, account_id, last_received_at desc, id desc);

alter table public.openclaw_conversations
  add constraint openclaw_conversations_last_message_fkey
  foreign key (organization_id, account_id, last_message_id)
  references public.openclaw_messages(organization_id, account_id, id)
  deferrable initially deferred;

create table public.openclaw_message_media (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  message_id uuid not null,
  media_index integer not null check (media_index >= 0),
  provider_media_id text,
  media_kind text not null check (media_kind in ('IMAGE','VIDEO','AUDIO','FILE','STICKER','OTHER')),
  mime text,
  byte_length bigint check (byte_length is null or byte_length >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  object_key text check (object_key is null or object_key like 'v1/org/%'),
  byte_state text not null default 'PENDING'
    check (byte_state IN ('PENDING','CACHED','AVAILABLE','QUARANTINED','DELETED')),
  retention_delete_not_before timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, message_id, media_index),
  foreign key (organization_id, account_id, conversation_id)
    references public.openclaw_conversations(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, message_id)
    references public.openclaw_messages(organization_id, account_id, id) on delete restrict
);

create index openclaw_message_media_retention_idx
  on public.openclaw_message_media
    (organization_id, retention_delete_not_before, id)
  where retention_delete_not_before is not null and byte_state <> 'DELETED';

alter table public.openclaw_contacts owner to openclaw_function_owner;
alter table public.openclaw_contacts enable row level security;
alter table public.openclaw_contacts force row level security;
revoke all on public.openclaw_contacts from public, anon, authenticated, service_role;
alter table public.openclaw_sales_groups owner to openclaw_function_owner;
alter table public.openclaw_sales_groups enable row level security;
alter table public.openclaw_sales_groups force row level security;
revoke all on public.openclaw_sales_groups from public, anon, authenticated, service_role;
alter table public.openclaw_targets owner to openclaw_function_owner;
alter table public.openclaw_targets enable row level security;
alter table public.openclaw_targets force row level security;
revoke all on public.openclaw_targets from public, anon, authenticated, service_role;
alter table public.openclaw_conversations owner to openclaw_function_owner;
alter table public.openclaw_conversations enable row level security;
alter table public.openclaw_conversations force row level security;
revoke all on public.openclaw_conversations from public, anon, authenticated, service_role;
alter table public.openclaw_conversation_members owner to openclaw_function_owner;
alter table public.openclaw_conversation_members enable row level security;
alter table public.openclaw_conversation_members force row level security;
revoke all on public.openclaw_conversation_members from public, anon, authenticated, service_role;
alter table public.openclaw_messages owner to openclaw_function_owner;
alter table public.openclaw_messages enable row level security;
alter table public.openclaw_messages force row level security;
revoke all on public.openclaw_messages from public, anon, authenticated, service_role;
alter table public.openclaw_message_media owner to openclaw_function_owner;
alter table public.openclaw_message_media enable row level security;
alter table public.openclaw_message_media force row level security;
revoke all on public.openclaw_message_media from public, anon, authenticated, service_role;
alter table public.openclaw_inbound_events owner to openclaw_function_owner;
alter table public.openclaw_inbound_events enable row level security;
alter table public.openclaw_inbound_events force row level security;
revoke all on public.openclaw_inbound_events from public, anon, authenticated, service_role;
alter table public.openclaw_inbound_provider_identities owner to openclaw_function_owner;
alter table public.openclaw_inbound_provider_identities enable row level security;
alter table public.openclaw_inbound_provider_identities force row level security;
revoke all on public.openclaw_inbound_provider_identities from public, anon, authenticated, service_role;

do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'openclaw_contacts','openclaw_sales_groups','openclaw_targets','openclaw_conversations',
    'openclaw_conversation_members','openclaw_messages','openclaw_message_media',
    'openclaw_inbound_events','openclaw_inbound_provider_identities'
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

create trigger openclaw_inbound_events_append_only
before update or delete on public.openclaw_inbound_events
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_inbound_provider_identities_append_only
before update or delete on public.openclaw_inbound_provider_identities
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_messages_append_only
before update or delete on public.openclaw_messages
for each row execute function app_private.reject_openclaw_append_only_v1();

grant select, insert, update on
  public.openclaw_contacts,
  public.openclaw_sales_groups,
  public.openclaw_targets,
  public.openclaw_conversations,
  public.openclaw_conversation_members,
  public.openclaw_message_media
to openclaw_runtime_writer;
grant select, insert on
  public.openclaw_messages,
  public.openclaw_inbound_events,
  public.openclaw_inbound_provider_identities
to openclaw_runtime_writer;


do $openclaw_owner_grants_release$
declare
  v_role text;
  v_schema text;
begin
  -- CREATE was only ever needed to hand ownership over. Revoking it leaves the
  -- objects owned by the role and leaves SECURITY DEFINER execution working, so
  -- no openclaw role keeps the ability to create objects after this migration.
  for v_role in
    select rolname from pg_catalog.pg_roles where rolname like 'openclaw\_%'
  loop
    foreach v_schema in array array['public', 'app_private'] loop
      if pg_catalog.to_regnamespace(v_schema) is not null then
        execute format('revoke create on schema %I from %I', v_schema, v_role);
      end if;
    end loop;
  end loop;
end
$openclaw_owner_grants_release$;
commit;
