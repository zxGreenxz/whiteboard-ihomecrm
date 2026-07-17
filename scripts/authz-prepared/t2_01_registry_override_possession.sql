-- ============================================================================
-- T2 PREPARED SQL 01 — Registry metadata, override lifecycle model,
-- cashbook possession, emergency denies.
-- STATUS: PREPARED (compile-tested on disposable PG17 exact-source restore).
-- NOT a migration. NOT applied to production. Extraction into a timestamped
-- migration requires owner gate per docs/authorization/T2-RBAC-SOURCE-OF-TRUTH.md.
-- Incorporates the 2026-07-17 40-stream review fixes:
--   registry: required_dimensions, ANY_MATCH-only CHECK
--   override: revoked_at lifecycle + partial unique + deferrable invariant
--   possession: RLS enabled, live-account filter documented
--   emergency: version bump coupling documented (canonical RPC duty)
-- ============================================================================

begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Registry metadata
-- ---------------------------------------------------------------------------

alter table public.permission_definitions
  add column if not exists scope_match_mode text not null default 'ANY_MATCH',
  add column if not exists requires_cashbook_possession boolean not null default false,
  add column if not exists accepted_possession_kinds text[] not null default array[]::text[],
  -- review fix #4 (omitted-dimension bypass): a key may declare dimensions the
  -- caller MUST supply; resolver denies when a required dimension is NULL.
  add column if not exists required_dimensions text[] not null default array[]::text[];

alter table public.permission_definitions
  drop constraint if exists permission_definitions_scope_match_mode_check,
  -- review fix #6: resolver only implements ANY_MATCH; forbid ALL_PRESENT at
  -- the constraint level (not just migration preflight) until implemented.
  add constraint permission_definitions_scope_match_mode_check
    check (scope_match_mode = 'ANY_MATCH'),
  drop constraint if exists permission_definitions_possession_contract_check,
  add constraint permission_definitions_possession_contract_check check (
    (not requires_cashbook_possession and cardinality(accepted_possession_kinds) = 0)
    or (
      requires_cashbook_possession
      and 'CASHBOOK' = any(scope_kinds)
      and cardinality(accepted_possession_kinds) > 0
      and accepted_possession_kinds <@ array['CUSTODIAN','OPERATOR']::text[]
    )
  ),
  drop constraint if exists permission_definitions_required_dimensions_check,
  add constraint permission_definitions_required_dimensions_check
    check (required_dimensions <@ array['BUILDING','CASHBOOK']::text[]);

-- Registry corrections (reviewed): cashbooks.create is org-scoped only;
-- cashbooks.post is exact-cashbook + possession; manage_custody is CUSTODIAN.
update public.permission_definitions
   set scope_kinds = array['ORGANIZATION']::text[]
 where key = 'cashbooks.create';

update public.permission_definitions
   set scope_kinds = array['CASHBOOK']::text[],
       scope_match_mode = 'ANY_MATCH',
       requires_cashbook_possession = true,
       accepted_possession_kinds = array['CUSTODIAN','OPERATOR']::text[],
       required_dimensions = array['CASHBOOK']::text[]
 where key = 'cashbooks.post';

insert into public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds,
   scope_match_mode, requires_cashbook_possession, accepted_possession_kinds,
   required_dimensions, is_active)
values
  ('cashbooks.manage_custody', 'cashbooks', 'manage_custody', 'ELEVATED', 'TENANT',
   array['CASHBOOK']::text[], 'ANY_MATCH', true,
   array['CUSTODIAN']::text[], array['CASHBOOK']::text[], true)
on conflict (key) do update
   set scope_kinds = excluded.scope_kinds,
       requires_cashbook_possession = excluded.requires_cashbook_possession,
       accepted_possession_kinds = excluded.accepted_possession_kinds,
       required_dimensions = excluded.required_dimensions;

-- income/expense building-scoped keys must declare BUILDING as required.
update public.permission_definitions
   set required_dimensions = array['BUILDING']::text[]
 where key in ('income_expenses.create', 'income_expenses.edit',
               'income_expenses.approve', 'income_expenses.cancel')
   and 'BUILDING' = any(scope_kinds);

-- ---------------------------------------------------------------------------
-- 2. Tenant-role PLATFORM permission guard (unchanged from review draft)
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_tenant_role_permission_domain()
returns trigger
language plpgsql
security definer -- review fix: INVOKER would see zero registry rows under RLS
set search_path to 'pg_catalog', 'public'
as $fn$
begin
  if not exists (
    select 1 from public.permission_definitions pd
     where pd.key = new.permission_key
       and pd.permission_domain = 'TENANT'
  ) then
    raise exception 'role_permissions: % is not a TENANT permission', new.permission_key
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

revoke all on function app_private.guard_tenant_role_permission_domain()
  from public, anon, authenticated, service_role;

drop trigger if exists a00_guard_tenant_role_permission_domain on public.role_permissions;
create trigger a00_guard_tenant_role_permission_domain
before insert or update of permission_key on public.role_permissions
for each row execute function app_private.guard_tenant_role_permission_domain();
alter table public.role_permissions
  enable always trigger a00_guard_tenant_role_permission_domain;

-- ---------------------------------------------------------------------------
-- 3. organization_roles system identity
-- ---------------------------------------------------------------------------

alter table public.organization_roles
  add column if not exists system_key text,
  add column if not exists status text not null default 'ACTIVE';

alter table public.organization_roles
  drop constraint if exists organization_roles_system_key_check,
  add constraint organization_roles_system_key_check check (
    system_key is null
    or (is_system and system_key ~ '^[A-Z][A-Z0-9_]{2,63}$')
  ),
  drop constraint if exists organization_roles_status_check,
  add constraint organization_roles_status_check
    check (status in ('ACTIVE','RETIRED'));

create unique index if not exists organization_roles_system_key_uidx
  on public.organization_roles (organization_id, system_key)
  where system_key is not null;

-- Canonical (nonlegacy) open-binding uniqueness — live-compatible.
create unique index if not exists role_bindings_one_open_canonical_role_uidx
  on public.role_bindings (organization_id, membership_id, role_id)
  where legacy_assignment_id is null and valid_to is null;

-- ---------------------------------------------------------------------------
-- 4. Member override lifecycle model (review defects a–e closed)
-- ---------------------------------------------------------------------------

alter table public.member_permission_overrides
  add column if not exists scope_mode text not null default 'ORGANIZATION',
  -- (a) append-only lifecycle: revoked_at closes a row without deleting history
  add column if not exists revoked_at timestamptz;

alter table public.member_permission_overrides
  drop constraint if exists member_permission_overrides_scope_mode_check,
  add constraint member_permission_overrides_scope_mode_check
    check (scope_mode in ('ORGANIZATION','SCOPED')),
  drop constraint if exists member_permission_overrides_revoked_after_created_check,
  add constraint member_permission_overrides_revoked_after_created_check
    check (revoked_at is null or revoked_at >= created_at);

drop index if exists public.member_overrides_unique_uidx;
drop index if exists public.member_overrides_effect_scope_mode_uidx;
-- (a) partial uniqueness over OPEN rows only: grant→revoke→re-grant works.
create unique index if not exists member_overrides_open_uidx
  on public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, scope_mode)
  where revoked_at is null;

-- (b) scope_mode enforced against edges by deferrable constraint trigger.
create or replace function app_private.assert_override_scope_shape()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
declare
  v_override_id uuid;
  v_bad record;
begin
  -- Branch on table BEFORE touching record fields: member_override_scopes has
  -- no `id` column and plpgsql raises on missing record fields at runtime.
  if tg_table_name = 'member_override_scopes' then
    if tg_op = 'DELETE' then
      v_override_id := old.override_id;
    else
      v_override_id := new.override_id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_override_id := old.id;
    else
      v_override_id := new.id;
    end if;
  end if;

  select o.id, o.scope_mode, o.permission_key, o.organization_id,
         count(mos.scope_id) as edge_count,
         count(*) filter (where s.scope_type = 'ORGANIZATION') as org_edges,
         count(*) filter (
           where s.scope_type is not null
             and not (s.scope_type = any(pd.scope_kinds))
         ) as illegal_kind_edges
    into v_bad
    from public.member_permission_overrides o
    left join public.member_override_scopes mos
      on mos.organization_id = o.organization_id and mos.override_id = o.id
    left join public.authorization_scopes s
      on s.organization_id = o.organization_id and s.id = mos.scope_id
    left join public.permission_definitions pd on pd.key = o.permission_key
   where o.id = v_override_id
     and o.revoked_at is null
   group by o.id, o.scope_mode, o.permission_key, o.organization_id;

  if v_bad.id is null then
    return null; -- row deleted or already revoked; nothing to assert
  end if;

  if v_bad.scope_mode = 'ORGANIZATION'
     and not (v_bad.edge_count = 1 and v_bad.org_edges = 1) then
    raise exception 'override %: ORGANIZATION mode requires exactly one ORGANIZATION edge (has % edges, % org)',
      v_bad.id, v_bad.edge_count, v_bad.org_edges using errcode = '23514';
  end if;
  if v_bad.scope_mode = 'SCOPED'
     and not (v_bad.edge_count >= 1 and v_bad.org_edges = 0) then
    raise exception 'override %: SCOPED mode requires >=1 non-ORGANIZATION edge (has % edges, % org)',
      v_bad.id, v_bad.edge_count, v_bad.org_edges using errcode = '23514';
  end if;
  if v_bad.illegal_kind_edges > 0 then
    raise exception 'override %: % edge(s) outside permitted scope_kinds of %',
      v_bad.id, v_bad.illegal_kind_edges, v_bad.permission_key using errcode = '23514';
  end if;
  return null;
end;
$fn$;

revoke all on function app_private.assert_override_scope_shape()
  from public, anon, authenticated, service_role;

drop trigger if exists a90_override_shape on public.member_permission_overrides;
create constraint trigger a90_override_shape
after insert or update on public.member_permission_overrides
deferrable initially deferred
for each row execute function app_private.assert_override_scope_shape();

drop trigger if exists a90_override_edge_shape on public.member_override_scopes;
create constraint trigger a90_override_edge_shape
after insert or update or delete on public.member_override_scopes
deferrable initially deferred
for each row execute function app_private.assert_override_scope_shape();

-- ---------------------------------------------------------------------------
-- 5. Cashbook possession (business custody, independent of permission scope)
-- ---------------------------------------------------------------------------

create table if not exists public.cashbook_possession_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  cashbook_id uuid not null,
  membership_id uuid not null,
  possession_kind text not null
    check (possession_kind in ('CUSTODIAN','OPERATOR')),
  valid_from timestamptz not null default clock_timestamp(),
  valid_to timestamptz,
  version bigint not null default 1,
  granted_by uuid,
  reason text,
  created_at timestamptz not null default clock_timestamp(),
  check (valid_to is null or valid_to > valid_from),
  foreign key (organization_id, cashbook_id)
    references public.accounts (organization_id, id) on delete restrict,
  foreign key (organization_id, membership_id)
    references public.organization_memberships (organization_id, id) on delete restrict
);

create unique index if not exists cashbook_possession_one_open_kind_uidx
  on public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind)
  where valid_to is null;

create index if not exists cashbook_possession_resolver_idx
  on public.cashbook_possession_bindings
    (organization_id, membership_id, cashbook_id, valid_from, valid_to);

-- review fix: RLS backstop like every sprint2a RBAC table (grants-only is fragile)
alter table public.cashbook_possession_bindings enable row level security;
drop policy if exists cashbook_possession_select_super on public.cashbook_possession_bindings;
create policy cashbook_possession_select_super
  on public.cashbook_possession_bindings
  for select to authenticated using (public.is_super_admin());
revoke all on public.cashbook_possession_bindings from public, anon, authenticated, service_role;
grant select on public.cashbook_possession_bindings to authenticated;

-- Candidate review queue (private).
create table if not exists app_private.cashbook_possession_candidates (
  candidate_key text primary key,
  organization_id uuid not null,
  cashbook_id uuid not null,
  membership_id uuid,
  proposed_kind text not null check (proposed_kind in ('CUSTODIAN','OPERATOR')),
  source_kind text not null,
  source_relation text not null,
  source_row_id uuid,
  source_user_id uuid,
  status text not null default 'PENDING_REVIEW'
    check (status in ('PENDING_REVIEW','APPROVED','REJECTED','AMBIGUOUS')),
  evidence jsonb not null default '{}'::jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  -- review fix: exactly-once materialization is verifiable from data model
  materialized_binding_id uuid references public.cashbook_possession_bindings(id),
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  check (
    -- PENDING_REVIEW: awaiting a human; no review columns.
    (status = 'PENDING_REVIEW' and reviewed_at is null)
    -- AMBIGUOUS: SYSTEM-detected (e.g. owner without ACTIVE membership); it has
    -- a machine review_reason + timestamp but NO human reviewer (F13 fix — the
    -- backfill inserts these with reviewed_by NULL by design).
    or (status = 'AMBIGUOUS' and reviewed_at is not null and review_reason is not null)
    -- APPROVED/REJECTED: a human reviewer is mandatory.
    or (status in ('APPROVED','REJECTED') and reviewed_at is not null
        and reviewed_by is not null and review_reason is not null)
  ),
  -- APPROVED must be materializable and maker-checker'd
  check (status <> 'APPROVED' or membership_id is not null),
  check (reviewed_by is null or source_user_id is null or reviewed_by <> source_user_id)
);

create index if not exists cashbook_possession_candidates_review_idx
  on app_private.cashbook_possession_candidates (organization_id, cashbook_id, status);

revoke all on app_private.cashbook_possession_candidates
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Emergency denies (instantaneous org-wide or per-key deny)
-- ---------------------------------------------------------------------------

create table if not exists app_private.tenant_emergency_denies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  permission_key text,
  active_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at is null or expires_at > active_from)
);

create index if not exists tenant_emergency_denies_active_idx
  on app_private.tenant_emergency_denies (organization_id, active_from, expires_at);

revoke all on app_private.tenant_emergency_denies
  from public, anon, authenticated, service_role;

-- NOTE (review fix #9/#10): every INSERT/early-revoke on tenant_emergency_denies,
-- every organizations.status transition, organization_roles create/RETIRE and
-- every registry flip MUST bump organizations.authorization_version in the same
-- transaction. That is a canonical-RPC duty; t2_04 installs a verify trigger.

commit;
