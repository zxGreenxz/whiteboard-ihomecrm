-- ============================================================================
-- T3 PREPARED SQL 01 — Canonical-flow provenance: dedicated role, sidecar,
-- claim helper (capability-gated), full freeze triggers.
-- STATUS: PREPARED (compile-tested on disposable PG17 exact-source restore).
-- NOT a migration; production apply gated by owner per T3 doc §A.9.
--
-- Implements the A.9 BLOCKING fixes:
--  #1 CREATE ROLE ie_canonical_writer + wrapper re-own (smallest secure shape)
--  #2 explicit grants package; row lock delegated to a postgres-owned definer
--     sub-helper; ownership INSERTs stay invoker-side (two independent gates)
--  #6/#7 unique index promoted to a declared constraint before the FK
--  #8 claim takes FOR UPDATE via delegate (TOCTOU-safe for visible rows)
--  #9 ledger triggers ENABLE ALWAYS (forward fix)
--  A.3 full freeze: parent/items/truncate/sidecar guards, ENABLE ALWAYS
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Dedicated capability role (idempotent)
-- ---------------------------------------------------------------------------

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'ie_canonical_writer') then
    create role ie_canonical_writer
      nologin noinherit nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end;
$role$;

-- ---------------------------------------------------------------------------
-- 1. Composite unique target on income_expenses (promoted to a constraint)
-- ---------------------------------------------------------------------------

do $orgnull$
begin
  if exists (select 1 from public.income_expenses where organization_id is null) then
    raise exception 'T3 preflight: income_expenses has NULL organization_id'
      using errcode = '23514';
  end if;
end;
$orgnull$;

-- NOTE production apply: build CONCURRENTLY in a separate non-transactional
-- step. On the disposable harness a plain build is acceptable.
create unique index if not exists income_expenses_org_id_uidx
  on public.income_expenses (organization_id, id);

do $promote$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.income_expenses'::regclass
       and conname = 'income_expenses_org_id_key'
  ) then
    alter table public.income_expenses
      add constraint income_expenses_org_id_key
      unique using index income_expenses_org_id_uidx;
  end if;
end;
$promote$;

-- ---------------------------------------------------------------------------
-- 2. Provenance sidecar (private)
-- ---------------------------------------------------------------------------

create table if not exists app_private.income_expense_flow_ownership (
  income_expense_id uuid primary key,
  organization_id uuid not null,
  flow_kind text not null default 'CANONICAL_INCOME_EXPENSE',
  flow_version smallint not null default 1,
  lifecycle_owner text not null default 'APPROVAL_ENGINE_V2',
  lifecycle_state text not null default 'DRAFT',
  writer_operation text not null,
  payload_hash_scheme text not null default 'PG_MD5_JSONB_TEXT_V1'
    check (payload_hash_scheme = 'PG_MD5_JSONB_TEXT_V1'),
  payload_hash_value text not null check (payload_hash_value ~ '^[0-9a-f]{32}$'),
  maker_user_id uuid not null,
  claimed_by_user_id uuid not null,
  correlation_id uuid,
  claimed_at timestamptz not null default clock_timestamp(),
  unique (organization_id, income_expense_id),
  foreign key (organization_id, income_expense_id)
    references public.income_expenses (organization_id, id) on delete restrict
);

create table if not exists app_private.income_expense_flow_ownership_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  income_expense_id uuid not null,
  event_type text not null check (event_type in ('FLOW_CLAIMED')),
  actor_user_id uuid not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

-- review fix (A.9 LOW): index for per-voucher event reads / RI
create index if not exists ie_flow_ownership_events_voucher_idx
  on app_private.income_expense_flow_ownership_events (organization_id, income_expense_id);

revoke all on app_private.income_expense_flow_ownership
  from public, anon, authenticated, service_role;
revoke all on app_private.income_expense_flow_ownership_events
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Marker lookup (DEFINER so ENABLE ALWAYS triggers can always read it)
-- ---------------------------------------------------------------------------

create or replace function app_private.is_income_expense_flow_owned(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
  select exists (
    select 1 from app_private.income_expense_flow_ownership
     where income_expense_id = p_id);
$fn$;

revoke all on function app_private.is_income_expense_flow_owned(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Row-lock delegate (postgres-owned DEFINER; EXECUTE only for the writer
--    role). Keeps ie_canonical_writer without any business-table privilege.
-- ---------------------------------------------------------------------------

create or replace function app_private.ie_lock_row_for_claim_v1(p_id uuid)
returns public.income_expenses
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
declare
  v_row public.income_expenses;
begin
  select * into v_row from public.income_expenses
   where id = p_id and deleted_at is null
   for update; -- TOCTOU fix: concurrent UPDATE waits, then sees the marker
  if not found then
    raise exception 'income expense not found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$fn$;

revoke all on function app_private.ie_lock_row_for_claim_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function app_private.ie_lock_row_for_claim_v1(uuid)
  to ie_canonical_writer;

-- Actor display-name delegate: auth.users/profiles carry RLS owned by the
-- auth admin; the writer role must not need policies there (A.9 smallest
-- shape). postgres-owned DEFINER bypasses RLS; EXECUTE only for the role.
create or replace function app_private.ie_actor_display_name_v1(p_actor uuid)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog', 'public', 'auth'
as $fn$
  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''),
                  u.email, 'Người dùng')
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = p_actor;
$fn$;

revoke all on function app_private.ie_actor_display_name_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function app_private.ie_actor_display_name_v1(uuid)
  to ie_canonical_writer;

-- Ledger operation lock delegate (same pattern).
create or replace function app_private.ie_lock_operation_for_claim_v1(
  p_organization_id uuid, p_subject_scope text, p_actor uuid,
  p_idempotency_key text, p_payload_hash text)
returns app_private.canonical_write_operations
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
declare
  v_op app_private.canonical_write_operations;
begin
  select * into v_op
    from app_private.canonical_write_operations o
   where o.organization_id = p_organization_id
     and o.operation = 'income_expense.create_draft.v1'
     and o.subject_scope = p_subject_scope
     and o.actor_id = p_actor
     and o.idempotency_key = p_idempotency_key
     and o.subject_id is null
     and o.response_payload is null
     and o.completed_at is null
     and o.payload_hash = p_payload_hash
   for update;
  if not found then
    raise exception 'no matching in-progress canonical operation'
      using errcode = 'P0002';
  end if;
  return v_op;
end;
$fn$;

revoke all on function app_private.ie_lock_operation_for_claim_v1(uuid, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.ie_lock_operation_for_claim_v1(uuid, text, uuid, text, text)
  to ie_canonical_writer;

-- ---------------------------------------------------------------------------
-- 5. Claim helper — SECURITY INVOKER, capability-gated on current_user.
--    Ownership INSERTs run under invoker rights: INSERT privilege on the two
--    sidecar tables is granted ONLY to ie_canonical_writer (second gate).
-- ---------------------------------------------------------------------------

create or replace function app_private.claim_canonical_income_expense_draft_v1(
  p_income_expense_id uuid,
  p_idempotency_key text
) returns void
language plpgsql
volatile
security invoker
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_row public.income_expenses;
  v_op app_private.canonical_write_operations;
  v_actor uuid;
begin
  if current_user <> 'ie_canonical_writer' then
    raise exception 'canonical claim capability required' using errcode = '42501';
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_row := app_private.ie_lock_row_for_claim_v1(p_income_expense_id);

  if v_row.user_id is distinct from v_actor then
    raise exception 'claim actor is not the maker' using errcode = '42501';
  end if;
  if v_row.approval_status is distinct from 'UNAPPROVED'
     or v_row.approval_request_id is not null
     or v_row.posting_id is not null
     or v_row.posted_at_v2 is not null
     or v_row.reversed_by_posting_id is not null
     or v_row.system_source is not null then
    raise exception 'row is not claimable as canonical draft' using errcode = '23514';
  end if;
  if v_row.source_payload_hash is null
     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then
    raise exception 'row lacks canonical payload hash' using errcode = '23514';
  end if;

  v_op := app_private.ie_lock_operation_for_claim_v1(
    v_row.organization_id, v_row.building_id::text, v_actor,
    p_idempotency_key, v_row.source_payload_hash);

  insert into app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, writer_operation,
    payload_hash_scheme, payload_hash_value,
    maker_user_id, claimed_by_user_id, correlation_id)
  values (
    v_row.id, v_row.organization_id, v_op.operation,
    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,
    v_row.user_id, v_actor, null);

  insert into app_private.income_expense_flow_ownership_events (
    organization_id, income_expense_id, event_type, actor_user_id, detail)
  values (
    v_row.organization_id, v_row.id, 'FLOW_CLAIMED', v_actor,
    jsonb_build_object('operation', v_op.operation,
                       'idempotency_key', p_idempotency_key));
end;
$fn$;

revoke all on function app_private.claim_canonical_income_expense_draft_v1(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.claim_canonical_income_expense_draft_v1(uuid, text)
  to ie_canonical_writer;

-- ---------------------------------------------------------------------------
-- 6. Grants package for the writer role (A.9 blocking #2)
-- ---------------------------------------------------------------------------

grant usage on schema app_private to ie_canonical_writer;
grant insert on app_private.income_expense_flow_ownership to ie_canonical_writer;
grant insert on app_private.income_expense_flow_ownership_events to ie_canonical_writer;
do $auth_grant$
begin
  execute 'grant usage on schema auth to ie_canonical_writer';
  execute 'grant execute on function auth.uid() to ie_canonical_writer';
exception when undefined_function or invalid_schema_name then
  null; -- non-Supabase harness variants
end;
$auth_grant$;

-- ---------------------------------------------------------------------------
-- 7. Full-freeze guards (A.3) — ENABLE ALWAYS, no identity bypass
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_income_expense_owned_payload()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  if tg_op = 'DELETE' then
    if app_private.is_income_expense_flow_owned(old.id) then
      raise exception 'canonical income expense % is frozen (delete rejected)', old.id
        using errcode = '55000';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if app_private.is_income_expense_flow_owned(old.id)
       or (new.id is distinct from old.id
           and app_private.is_income_expense_flow_owned(new.id)) then
      raise exception 'canonical income expense % is frozen (update rejected)', old.id
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$fn$;

create or replace function app_private.guard_income_expense_owned_items()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op = 'DELETE' then
    v_old := old.income_expense_id;
    if app_private.is_income_expense_flow_owned(v_old) then
      raise exception 'items of canonical income expense % are frozen', v_old
        using errcode = '55000';
    end if;
    return old;
  end if;
  v_new := new.income_expense_id;
  if tg_op = 'UPDATE' then
    v_old := old.income_expense_id;
    if v_old is distinct from v_new
       and app_private.is_income_expense_flow_owned(v_old) then
      raise exception 'items of canonical income expense % are frozen', v_old
        using errcode = '55000';
    end if;
  end if;
  if app_private.is_income_expense_flow_owned(v_new) then
    raise exception 'items of canonical income expense % are frozen', v_new
      using errcode = '55000';
  end if;
  return new;
end;
$fn$;

create or replace function app_private.guard_income_expense_truncate()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  if exists (select 1 from app_private.income_expense_flow_ownership) then
    raise exception 'TRUNCATE rejected: canonical income expenses exist'
      using errcode = '55000';
  end if;
  return null;
end;
$fn$;

create or replace function app_private.reject_income_expense_flow_mutation()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $fn$
begin
  raise exception 'canonical flow ownership records are immutable'
    using errcode = '55000';
end;
$fn$;

create or replace function app_private.reject_income_expense_flow_truncate()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $fn$
begin
  raise exception 'canonical flow ownership tables cannot be truncated'
    using errcode = '55000';
end;
$fn$;

revoke all on function app_private.guard_income_expense_owned_payload()   from public, anon, authenticated, service_role;
revoke all on function app_private.guard_income_expense_owned_items()    from public, anon, authenticated, service_role;
revoke all on function app_private.guard_income_expense_truncate()       from public, anon, authenticated, service_role;
revoke all on function app_private.reject_income_expense_flow_mutation() from public, anon, authenticated, service_role;
revoke all on function app_private.reject_income_expense_flow_truncate() from public, anon, authenticated, service_role;

-- Parent freeze (UPDATE/DELETE only per A.9 LOW: INSERT can never be owned).
drop trigger if exists a00_ie_owned_payload_freeze on public.income_expenses;
create trigger a00_ie_owned_payload_freeze
before update or delete on public.income_expenses
for each row execute function app_private.guard_income_expense_owned_payload();
alter table public.income_expenses enable always trigger a00_ie_owned_payload_freeze;

drop trigger if exists a00_ie_truncate_freeze on public.income_expenses;
create trigger a00_ie_truncate_freeze
before truncate on public.income_expenses
for each statement execute function app_private.guard_income_expense_truncate();
alter table public.income_expenses enable always trigger a00_ie_truncate_freeze;

-- Item freeze (INSERT too: adding items to a frozen parent must fail).
drop trigger if exists a00_ie_item_owned_payload_freeze on public.income_expense_items;
create trigger a00_ie_item_owned_payload_freeze
before insert or update or delete on public.income_expense_items
for each row execute function app_private.guard_income_expense_owned_items();
alter table public.income_expense_items enable always trigger a00_ie_item_owned_payload_freeze;

drop trigger if exists a00_ie_item_truncate_freeze on public.income_expense_items;
create trigger a00_ie_item_truncate_freeze
before truncate on public.income_expense_items
for each statement execute function app_private.guard_income_expense_truncate();
alter table public.income_expense_items enable always trigger a00_ie_item_truncate_freeze;

-- Sidecar immutability.
drop trigger if exists a00_flow_ownership_immutable on app_private.income_expense_flow_ownership;
create trigger a00_flow_ownership_immutable
before update or delete on app_private.income_expense_flow_ownership
for each row execute function app_private.reject_income_expense_flow_mutation();
alter table app_private.income_expense_flow_ownership
  enable always trigger a00_flow_ownership_immutable;

drop trigger if exists a00_flow_ownership_no_truncate on app_private.income_expense_flow_ownership;
create trigger a00_flow_ownership_no_truncate
before truncate on app_private.income_expense_flow_ownership
for each statement execute function app_private.reject_income_expense_flow_truncate();
alter table app_private.income_expense_flow_ownership
  enable always trigger a00_flow_ownership_no_truncate;

drop trigger if exists a00_flow_events_immutable on app_private.income_expense_flow_ownership_events;
create trigger a00_flow_events_immutable
before update or delete on app_private.income_expense_flow_ownership_events
for each row execute function app_private.reject_income_expense_flow_mutation();
alter table app_private.income_expense_flow_ownership_events
  enable always trigger a00_flow_events_immutable;

drop trigger if exists a00_flow_events_no_truncate on app_private.income_expense_flow_ownership_events;
create trigger a00_flow_events_no_truncate
before truncate on app_private.income_expense_flow_ownership_events
for each statement execute function app_private.reject_income_expense_flow_truncate();
alter table app_private.income_expense_flow_ownership_events
  enable always trigger a00_flow_events_no_truncate;

-- A.9 #9 forward fix: ledger triggers must survive replica mode.
alter table app_private.canonical_write_operations
  enable always trigger canonical_write_operations_immutable;
alter table app_private.canonical_write_operations
  enable always trigger canonical_write_operations_no_truncate;

-- Catalog assertion: no BEFORE row trigger sorts before a00_ (C collation).
do $order_assert$
begin
  if exists (
    select 1 from pg_trigger
     where tgrelid in ('public.income_expenses'::regclass,
                       'public.income_expense_items'::regclass)
       and not tgisinternal
       and (tgtype & 2) = 2  -- BEFORE
       and (tgtype & (4|8|16)) <> 0 -- INSERT/DELETE/UPDATE
       and tgname < 'a00_'
  ) then
    raise exception 'trigger ordering violated: a BEFORE trigger sorts before a00_'
      using errcode = '55000';
  end if;
end;
$order_assert$;

commit;
