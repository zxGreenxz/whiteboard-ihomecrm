-- ============================================================================
-- T2 PREPARED SQL 02 — Fail-closed backfill: scope edges, TENANT_OWNER seed,
-- possession candidates.
-- STATUS: PREPARED (compile-tested on disposable PG17 exact-source restore).
-- NOT a migration; production apply gated by owner per T2 doc.
-- Review fixes incorporated: allowlist count/hash assert (silent-narrowing),
-- org-scope coverage preflight, window-overlap idempotent owner binding,
-- future-activation memberships kept, deleted-account filter, SCOPED-zero-edge
-- conversion limited to legacy rows.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflights (all fail-closed)
-- ---------------------------------------------------------------------------

do $preflight$
begin
  -- every organization must own an ORGANIZATION authorization scope
  if exists (
    select 1 from public.organizations o
     where not exists (
       select 1 from public.authorization_scopes s
        where s.organization_id = o.id and s.scope_type = 'ORGANIZATION')
  ) then
    -- self-heal additively rather than abort: orgs created after sprint2c
    insert into public.authorization_scopes (organization_id, scope_type)
    select o.id, 'ORGANIZATION'
      from public.organizations o
     where not exists (
       select 1 from public.authorization_scopes s
        where s.organization_id = o.id and s.scope_type = 'ORGANIZATION');
  end if;

  if exists (select 1 from public.accounts a where a.organization_id is null) then
    raise exception 'T2 preflight: account organization unresolved'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.account_shared_users asu
      left join public.accounts a on a.id = asu.account_id
     where asu.organization_id is null
        or a.id is null
        or asu.organization_id is distinct from a.organization_id
  ) then
    raise exception 'T2 preflight: cashbook share organization unresolved/mismatched'
      using errcode = '23514';
  end if;

  -- TENANT_OWNER display-name collision (non-system role already using it)
  if exists (
    select 1 from public.organization_roles r
     where lower(r.name) = lower('Chủ sở hữu tổ chức')
       and (r.system_key is distinct from 'TENANT_OWNER')
  ) then
    raise exception 'T2 preflight: TENANT_OWNER display name collides'
      using errcode = '23505';
  end if;
end;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Legacy override scope-mode + edges (review-safe version)
-- ---------------------------------------------------------------------------

-- Only legacy materialized rows (created by sprint2c/2e before edges existed)
-- may be normalized to ORGANIZATION mode. Anything newer with zero edges is a
-- defect and must abort, not silently widen.
update public.member_permission_overrides o
   set scope_mode = 'ORGANIZATION'
 where o.revoked_at is null
   and o.scope_mode = 'SCOPED'
   and not exists (
     select 1 from public.member_override_scopes mos
      where mos.organization_id = o.organization_id and mos.override_id = o.id)
   and o.created_at < timestamptz '2026-07-14'; -- sprint2c materialization era

do $zero_edge_guard$
begin
  if exists (
    select 1 from public.member_permission_overrides o
     where o.revoked_at is null and o.scope_mode = 'SCOPED'
       and not exists (
         select 1 from public.member_override_scopes mos
          where mos.organization_id = o.organization_id and mos.override_id = o.id)
  ) then
    raise exception 'T2 backfill: non-legacy SCOPED override with zero edges'
      using errcode = '23514';
  end if;
end;
$zero_edge_guard$;

-- Attach the ORGANIZATION edge to every open ORGANIZATION-mode override.
insert into public.member_override_scopes (organization_id, override_id, scope_id)
select o.organization_id, o.id, s.id
  from public.member_permission_overrides o
  join public.authorization_scopes s
    on s.organization_id = o.organization_id and s.scope_type = 'ORGANIZATION'
 where o.revoked_at is null
   and o.scope_mode = 'ORGANIZATION'
   and not exists (
     select 1 from public.member_override_scopes mos
      where mos.organization_id = o.organization_id
        and mos.override_id = o.id and mos.scope_id = s.id)
on conflict do nothing;

-- Post-backfill invariant: zero open overrides without edges.
do $post_edge_guard$
begin
  if exists (
    select 1 from public.member_permission_overrides o
     where o.revoked_at is null
       and not exists (
         select 1 from public.member_override_scopes mos
          where mos.organization_id = o.organization_id and mos.override_id = o.id)
  ) then
    raise exception 'T2 backfill: open override left with zero edges'
      using errcode = '23514';
  end if;
end;
$post_edge_guard$;

-- ---------------------------------------------------------------------------
-- 2. CASHBOOK scope materialization (live accounts only)
-- ---------------------------------------------------------------------------

insert into public.authorization_scopes (organization_id, scope_type, cashbook_id)
select a.organization_id, 'CASHBOOK', a.id
  from public.accounts a
 where a.deleted_at is null -- review fix: live rows only, per §4.1 intent
   and not exists (
     select 1 from public.authorization_scopes s
      where s.organization_id = a.organization_id
        and s.scope_type = 'CASHBOOK' and s.cashbook_id = a.id)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. TENANT_OWNER system role + reviewed allowlist (hash-asserted)
-- ---------------------------------------------------------------------------

insert into public.organization_roles
  (organization_id, name, is_system, system_key, status)
select o.id, 'Chủ sở hữu tổ chức', true, 'TENANT_OWNER', 'ACTIVE'
  from public.organizations o
on conflict (organization_id, system_key)
  where system_key is not null do nothing;

do $allowlist$
declare
  c_expected_count constant int := 12;
  -- sha256 over sorted keys joined by \n (no trailing newline), lowercase hex
  c_expected_hash constant text :=
    encode(sha256(convert_to(
      'approvals.emergency_override' || e'\n' ||
      'cashbooks.create' || e'\n' ||
      'cashbooks.manage_custody' || e'\n' ||
      'cashbooks.post' || e'\n' ||
      'income_expenses.approve' || e'\n' ||
      'income_expenses.cancel' || e'\n' ||
      'income_expenses.create' || e'\n' ||
      'income_expenses.edit' || e'\n' ||
      'income_expenses.reverse' || e'\n' ||
      'income_expenses.self_approve_within_limit' || e'\n' ||
      'users.create' || e'\n' ||
      'users.edit', 'UTF8')), 'hex');
  v_count int;
  v_hash text;
  v_verified int;
  v_missing text;
begin
  create temporary table _owner_allowlist (permission_key text primary key)
    on commit drop;
  insert into _owner_allowlist values
    ('income_expenses.create'), ('income_expenses.edit'),
    ('income_expenses.approve'), ('income_expenses.cancel'),
    ('income_expenses.self_approve_within_limit'), ('income_expenses.reverse'),
    ('cashbooks.create'), ('cashbooks.post'), ('cashbooks.manage_custody'),
    ('approvals.emergency_override'), ('users.create'), ('users.edit');

  select count(*),
         encode(sha256(convert_to(
           string_agg(permission_key, e'\n' order by permission_key), 'UTF8')), 'hex')
    into v_count, v_hash from _owner_allowlist;

  if v_count <> c_expected_count or v_hash <> c_expected_hash then
    raise exception 'owner allowlist identity mismatch: count=% hash=%', v_count, v_hash
      using errcode = '23514';
  end if;

  -- silent-narrowing guard: every reviewed key must exist active TENANT
  select count(*) into v_verified
    from _owner_allowlist al
    join public.permission_definitions pd
      on pd.key = al.permission_key
     and pd.permission_domain = 'TENANT' and pd.is_active;
  if v_verified <> c_expected_count then
    select string_agg(al.permission_key, ', ') into v_missing
      from _owner_allowlist al
     where not exists (
       select 1 from public.permission_definitions pd
        where pd.key = al.permission_key
          and pd.permission_domain = 'TENANT' and pd.is_active);
    raise exception 'owner allowlist keys missing from registry: %', v_missing
      using errcode = '23514';
  end if;

  insert into public.role_permissions
    (organization_id, role_id, permission_key, effect)
  select r.organization_id, r.id, al.permission_key, 'ALLOW'
    from public.organization_roles r
    cross join _owner_allowlist al
   where r.system_key = 'TENANT_OWNER' and r.status = 'ACTIVE'
  on conflict (organization_id, role_id, permission_key) do nothing;
end;
$allowlist$;

-- ---------------------------------------------------------------------------
-- 4. Owner bindings (window-copied, window-overlap idempotent)
-- ---------------------------------------------------------------------------

insert into public.role_bindings
  (organization_id, membership_id, role_id, valid_from, valid_to)
select m.organization_id, m.id, r.id, m.valid_from, m.valid_to
  from public.organization_memberships m
  join public.organization_roles r
    on r.organization_id = m.organization_id
   and r.system_key = 'TENANT_OWNER' and r.status = 'ACTIVE'
 where m.member_type = 'OWNER'
   and m.status = 'ACTIVE'
   and not exists (
     select 1 from public.role_bindings rb
      where rb.organization_id = m.organization_id
        and rb.membership_id = m.id
        and rb.role_id = r.id
        and rb.legacy_assignment_id is null
        and rb.valid_from < coalesce(m.valid_to, 'infinity'::timestamptz)
        and coalesce(rb.valid_to, 'infinity'::timestamptz) > m.valid_from
   );

-- Owner binding scope edges: ORGANIZATION + all live CASHBOOK scopes.
insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
select rb.organization_id, rb.id, s.id
  from public.role_bindings rb
  join public.organization_roles r
    on r.organization_id = rb.organization_id and r.id = rb.role_id
  join public.authorization_scopes s
    on s.organization_id = rb.organization_id
   and s.scope_type in ('ORGANIZATION','CASHBOOK')
 where r.system_key = 'TENANT_OWNER'
   and rb.legacy_assignment_id is null
   and not exists (
     select 1 from public.role_binding_scopes rbs
      where rbs.organization_id = rb.organization_id
        and rbs.role_binding_id = rb.id and rbs.scope_id = s.id)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. Possession candidates (PENDING_REVIEW only; never auto-materialize)
-- ---------------------------------------------------------------------------

insert into app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id,
  proposed_kind, source_kind, source_relation, source_row_id, source_user_id,
  status, evidence)
select
  md5(concat_ws('|','ACCOUNT_OWNER',a.organization_id::text,a.id::text,a.user_id::text)),
  a.organization_id, a.id, m.id,
  'CUSTODIAN', 'ACCOUNT_OWNER', 'accounts', a.id, a.user_id,
  'PENDING_REVIEW',
  jsonb_build_object('source_created_at', a.created_at)
from public.accounts a
join public.organization_memberships m
  on m.organization_id = a.organization_id
 and m.user_id = a.user_id and m.status = 'ACTIVE'
where a.deleted_at is null and a.user_id is not null
on conflict (candidate_key) do nothing;

insert into app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id,
  proposed_kind, source_kind, source_relation, source_row_id, source_user_id,
  status, evidence)
select
  md5(concat_ws('|','LEGACY_SHARE',asu.organization_id::text,
    asu.account_id::text,asu.id::text,asu.user_id::text)),
  asu.organization_id, asu.account_id, m.id,
  'OPERATOR', 'LEGACY_SHARE', 'account_shared_users', asu.id, asu.user_id,
  'PENDING_REVIEW',
  jsonb_build_object('source_created_at', asu.created_at)
from public.account_shared_users asu
join public.accounts a
  on a.organization_id = asu.organization_id
 and a.id = asu.account_id and a.deleted_at is null
join public.organization_memberships m
  on m.organization_id = asu.organization_id
 and m.user_id = asu.user_id and m.status = 'ACTIVE'
on conflict (candidate_key) do nothing;

-- Ambiguity: owner/share user without an ACTIVE membership → AMBIGUOUS record
insert into app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id,
  proposed_kind, source_kind, source_relation, source_row_id, source_user_id,
  status, evidence, reviewed_by, reviewed_at, review_reason)
select
  md5(concat_ws('|','ACCOUNT_OWNER_NO_MEMBERSHIP',a.organization_id::text,a.id::text,a.user_id::text)),
  a.organization_id, a.id, null,
  'CUSTODIAN', 'ACCOUNT_OWNER', 'accounts', a.id, a.user_id,
  'AMBIGUOUS',
  jsonb_build_object('defect','owner has no ACTIVE membership'),
  null, clock_timestamp(), 'auto: unresolvable without membership'
from public.accounts a
where a.deleted_at is null and a.user_id is not null
  and not exists (
    select 1 from public.organization_memberships m
     where m.organization_id = a.organization_id
       and m.user_id = a.user_id and m.status = 'ACTIVE')
on conflict (candidate_key) do nothing;

commit;
