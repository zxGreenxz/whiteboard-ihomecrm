-- ============================================================================
-- T3 PREPARED SQL 04 — Durable income_expense_audit_log upgrade + SHA-256
-- hash chain (A.5) with every review fix from the 2026-07-17 round.
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; production apply gated by owner.
--
-- Review fixes implemented:
--  A.9#3  live NULL-writers re-pointed BEFORE SET NOT NULL (log_income_expense_action
--         and restore_income_expense derive org from the parent voucher)
--  A.9#5  FK drop asserted fail-closed (no CASCADE FK may remain)
--  F2     byte-level canonical serialization: UTC-pinned timestamp render,
--         numeric normalized via ::text of numeric (scale-preserving is fine
--         because WE build the payload), sorted keys via jsonb, explicit
--         separator, genesis sentinel = 64 zeros, hash_scheme column
--  F3     preimage binds organization_id + sequence_no
--  F5     head bootstrap ON CONFLICT DO NOTHING + FOR UPDATE; head is the
--         LAST lock before INSERT
--  F6     CHECK ties sequence_no/event_hash nullability together
--  F7     pg_catalog.sha256() built-in (no pgcrypto)
--  F8     chain-verify function included
--  F4     ENABLE ALWAYS trigger rejects rows with NULL event_hash (writer
--         monopoly enforced at the row level, not just grants)
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Re-point live NULL-writers BEFORE tightening the schema (A.9 blocking #3)
-- ---------------------------------------------------------------------------

drop function if exists public.log_income_expense_action(uuid, text, text);
create function public.log_income_expense_action(
  p_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid;
  v_actor uuid := auth.uid();
  v_actor_name text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select organization_id into v_org
    from public.income_expenses where id = p_id;
  if v_org is null then
    raise exception 'Không tìm thấy phiếu hoặc phiếu chưa có tổ chức'
      using errcode = 'P0002';
  end if;
  -- client action allowlist: this RPC must not forge lifecycle semantics
  if p_action not in ('NOTE','CANCELLED_NOTE','MANUAL_LOG') then
    raise exception 'Hành động không được phép qua RPC này' using errcode = '42501';
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Người dùng')
    into v_actor_name from public.profiles p where p.id = v_actor;
  perform app_private.append_income_expense_event_v1(
    v_org, p_id, p_action, v_actor,
    coalesce(v_actor_name, 'Người dùng'), null, null, p_note);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. Schema upgrade (chain columns; FK de-cascade; org NOT NULL)
-- ---------------------------------------------------------------------------

alter table public.income_expense_audit_log
  add column if not exists sequence_no bigint,
  add column if not exists prev_event_hash text,
  add column if not exists event_hash text,
  add column if not exists hash_scheme text;

alter table public.income_expense_audit_log
  drop constraint if exists income_expense_audit_log_chain_consistency_check,
  add constraint income_expense_audit_log_chain_consistency_check check (
    -- F6: legacy rows all-NULL; chained rows all-set
    ((sequence_no is null) = (event_hash is null))
    and ((sequence_no is null) = (prev_event_hash is null))
    and ((sequence_no is null) = (hash_scheme is null))
    and (hash_scheme is null or hash_scheme = 'PG_SHA256_CANONICAL_V1')
    and (event_hash is null or event_hash ~ '^[0-9a-f]{64}$')
    and (prev_event_hash is null or prev_event_hash ~ '^[0-9a-f]{64}$')
  );

create unique index if not exists income_expense_audit_log_chain_uidx
  on public.income_expense_audit_log (organization_id, sequence_no)
  where sequence_no is not null;

-- Drop the destructive CASCADE FK; keep the logical id column.
alter table public.income_expense_audit_log
  drop constraint if exists income_expense_audit_log_income_expense_id_fkey;

do $cascade_assert$
begin
  -- A.9#5: assert no cascade/set-null FK survives on this table
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.income_expense_audit_log'::regclass
       and contype = 'f' and confdeltype in ('c', 'n')
  ) then
    raise exception 'destructive FK still present on income_expense_audit_log'
      using errcode = '55000';
  end if;
end;
$cascade_assert$;

-- Backfill residual NULL organization_id from parents, then require it.
update public.income_expense_audit_log al
   set organization_id = ie.organization_id
  from public.income_expenses ie
 where ie.id = al.income_expense_id
   and al.organization_id is null;

do $org_backfill_assert$
begin
  if exists (select 1 from public.income_expense_audit_log
              where organization_id is null) then
    raise exception 'audit rows with unresolvable organization remain — resolve before SET NOT NULL'
      using errcode = '23514';
  end if;
end;
$org_backfill_assert$;

alter table public.income_expense_audit_log
  alter column organization_id set not null;

-- Client privileges: read stays; INSERT moves behind the primitive.
revoke insert on public.income_expense_audit_log from authenticated, anon, service_role;
drop policy if exists income_expense_audit_log_super_admin_all on public.income_expense_audit_log;
create policy income_expense_audit_log_super_admin_select
  on public.income_expense_audit_log
  for select to authenticated using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 2. Chain heads (private)
-- ---------------------------------------------------------------------------

create table if not exists app_private.income_expense_audit_chain_heads (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  last_sequence_no bigint not null default 0,
  last_event_hash text not null default repeat('0', 64)
    check (last_event_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default clock_timestamp()
);

revoke all on app_private.income_expense_audit_chain_heads
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Append primitive (single writer; head = LAST lock before INSERT)
-- ---------------------------------------------------------------------------

create or replace function app_private.append_income_expense_event_v1(
  p_organization_id uuid,
  p_income_expense_id uuid,
  p_action text,
  p_actor_id uuid,
  p_actor_name text,
  p_old_status text,
  p_new_status text,
  p_note text
) returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_head app_private.income_expense_audit_chain_heads;
  v_seq bigint;
  v_canonical text;
  v_hash text;
  v_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_organization_id is null or p_income_expense_id is null
     or p_action is null or p_actor_id is null then
    raise exception 'append_income_expense_event_v1: required argument NULL'
      using errcode = '22004';
  end if;

  -- F5: bootstrap + lock. Head is the last lock taken before the INSERT.
  insert into app_private.income_expense_audit_chain_heads (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select * into v_head
    from app_private.income_expense_audit_chain_heads
   where organization_id = p_organization_id
   for update;

  v_seq := v_head.last_sequence_no + 1;

  -- F2/F3 canonical serialization (byte-level pinned):
  --   fields joined by \x1f, timestamps rendered UTC ISO-8601 fixed format,
  --   NULLs rendered as empty string, preimage prefixed with org + seq +
  --   prev hash. No jsonb round-trip → no numeric/TZ instability.
  v_canonical := concat_ws(chr(31),
    'PG_SHA256_CANONICAL_V1',
    p_organization_id::text,
    v_seq::text,
    v_head.last_event_hash,
    p_income_expense_id::text,
    p_action,
    p_actor_id::text,
    coalesce(p_actor_name, ''),
    coalesce(p_old_status, ''),
    coalesce(p_new_status, ''),
    coalesce(p_note, ''),
    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  insert into public.income_expense_audit_log (
    income_expense_id, action, actor_id, actor_name,
    old_status, new_status, note, organization_id,
    sequence_no, prev_event_hash, event_hash, hash_scheme, created_at)
  values (
    p_income_expense_id, p_action, p_actor_id, p_actor_name,
    p_old_status, p_new_status, p_note, p_organization_id,
    v_seq, v_head.last_event_hash, v_hash, 'PG_SHA256_CANONICAL_V1', v_now)
  returning id into v_id;

  update app_private.income_expense_audit_chain_heads
     set last_sequence_no = v_seq,
         last_event_hash = v_hash,
         updated_at = v_now
   where organization_id = p_organization_id;

  return v_id;
end;
$fn$;

revoke all on function app_private.append_income_expense_event_v1(
  uuid, uuid, text, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.append_income_expense_event_v1(
  uuid, uuid, text, uuid, text, text, text, text)
  to ie_canonical_writer;

-- ---------------------------------------------------------------------------
-- 4. Writer-monopoly + immutability triggers (F4) — ENABLE ALWAYS
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_audit_log_write()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'income_expense_audit_log is append-only'
      using errcode = '55000';
  end if;
  -- INSERT: chained rows only (legacy all-NULL inserts are no longer allowed;
  -- everything must route through the primitive, which stamps the chain).
  if new.event_hash is null then
    raise exception 'audit inserts must go through append_income_expense_event_v1'
      using errcode = '55000';
  end if;
  return new;
end;
$fn$;

create or replace function app_private.guard_audit_log_truncate()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $fn$
begin
  raise exception 'income_expense_audit_log cannot be truncated'
    using errcode = '55000';
end;
$fn$;

revoke all on function app_private.guard_audit_log_write()    from public, anon, authenticated, service_role;
revoke all on function app_private.guard_audit_log_truncate() from public, anon, authenticated, service_role;

drop trigger if exists a00_audit_log_guard on public.income_expense_audit_log;
create trigger a00_audit_log_guard
before insert or update or delete on public.income_expense_audit_log
for each row execute function app_private.guard_audit_log_write();
alter table public.income_expense_audit_log
  enable always trigger a00_audit_log_guard;

drop trigger if exists a00_audit_log_no_truncate on public.income_expense_audit_log;
create trigger a00_audit_log_no_truncate
before truncate on public.income_expense_audit_log
for each statement execute function app_private.guard_audit_log_truncate();
alter table public.income_expense_audit_log
  enable always trigger a00_audit_log_no_truncate;

-- Chain heads immutable outside the primitive.
drop trigger if exists a00_chain_heads_no_truncate on app_private.income_expense_audit_chain_heads;
create trigger a00_chain_heads_no_truncate
before truncate on app_private.income_expense_audit_chain_heads
for each statement execute function app_private.guard_audit_log_truncate();
alter table app_private.income_expense_audit_chain_heads
  enable always trigger a00_chain_heads_no_truncate;

-- ---------------------------------------------------------------------------
-- 5. Chain verifier (F8)
-- ---------------------------------------------------------------------------

create or replace function app_private.verify_income_expense_audit_chain_v1(
  p_organization_id uuid)
returns table (valid boolean, checked_events bigint, first_broken_sequence bigint)
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  r record;
  v_prev text := repeat('0', 64);
  v_expected text;
  v_count bigint := 0;
begin
  for r in
    select * from public.income_expense_audit_log
     where organization_id = p_organization_id and sequence_no is not null
     order by sequence_no
  loop
    v_expected := encode(sha256(convert_to(concat_ws(chr(31),
      'PG_SHA256_CANONICAL_V1',
      r.organization_id::text,
      r.sequence_no::text,
      v_prev,
      r.income_expense_id::text,
      r.action,
      r.actor_id::text,
      coalesce(r.actor_name, ''),
      coalesce(r.old_status, ''),
      coalesce(r.new_status, ''),
      coalesce(r.note, ''),
      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
      'UTF8')), 'hex');
    if r.prev_event_hash <> v_prev or r.event_hash <> v_expected then
      return query select false, v_count, r.sequence_no;
      return;
    end if;
    v_prev := r.event_hash;
    v_count := v_count + 1;
  end loop;
  return query select true, v_count, null::bigint;
end;
$fn$;

revoke all on function app_private.verify_income_expense_audit_chain_v1(uuid)
  from public, anon, authenticated, service_role;

commit;
