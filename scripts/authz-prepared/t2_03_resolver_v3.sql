-- ============================================================================
-- T2 PREPARED SQL 03 — authorize_tenant_action_v3 (private elevated resolver)
-- STATUS: PREPARED (compile-tested on disposable PG17 exact-source restore).
-- NOT a migration; production apply gated by owner per T2 doc.
--
-- Fixes ALL resolver defects confirmed by the 2026-07-17 40-stream review:
--  #1  ORGANIZATION-mode overrides match org-wide (branch on scope_mode; the
--      SCOPED branch joins edges). Zero-edge open overrides raise (fail hard).
--  #2  DENY matches broadly (any scope covering the target incl. ORG mode);
--      ALLOW for possession-required keys still needs the exact CASHBOOK edge.
--  #3  Version/witness snapshot skew: callers MUST take the org FOR SHARE in a
--      PRIOR statement (helper lock_org_for_decision_v1 provided); resolver
--      re-reads authorization_version and returns evaluated_at for lease math.
--  #4  Omitted-dimension bypass: required_dimensions enforced (deny + reason).
--  #5  NULL valid_from treated as always-active in BOTH allow and deny paths.
--  #7  Possession fails closed independently when the permission row is absent.
--  #8  Boundary arms filtered to p_organization_id.
--  #11 evaluated_at returned.
--  F5/F8 emergency-deny activation/expiry included in boundaries (was already).
-- ============================================================================

begin;

create or replace function app_private.lock_org_for_decision_v1(p_organization_id uuid)
returns bigint
language sql
volatile
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
  -- Statement 1 of the writer protocol: take the shared org lock FIRST so the
  -- witness statement that follows runs on a snapshot taken AFTER any waiting.
  select o.authorization_version
    from public.organizations o
   where o.id = p_organization_id
     and o.status = 'ACTIVE'
     for share;
$fn$;

revoke all on function app_private.lock_org_for_decision_v1(uuid)
  from public, anon, authenticated, service_role;

-- Malformed-witness escalation: a zero-edge OPEN override is a data defect;
-- never silently drop a DENY. Raising from a scalar function inside the CTE
-- fails the whole decision statement (fail closed). Defined BEFORE the
-- resolver because LANGUAGE SQL bodies are validated at CREATE time.
create or replace function app_private.raise_malformed_override(
  p_organization_id uuid, p_permission_key text)
returns int
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
begin
  raise exception 'authorize_tenant_action_v3: open zero-edge override for % in org %',
    p_permission_key, p_organization_id using errcode = '23514';
end;
$fn$;

revoke all on function app_private.raise_malformed_override(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function app_private.authorize_tenant_action_v3(
  p_actor uuid,
  p_organization_id uuid,
  p_permission_key text,
  p_building_id uuid default null,
  p_cashbook_id uuid default null
) returns table (
  allowed boolean,
  authorization_version bigint,
  nearest_deadline timestamptz,
  evaluated_at timestamptz,
  decision_reason text
)
language sql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
with
at as materialized (
  select clock_timestamp() as evaluated_at
),
-- Caller contract: app_private.lock_org_for_decision_v1() was called in a
-- PRIOR statement of this transaction. The FOR SHARE here is then a no-wait
-- re-entrant lock and this statement's snapshot postdates the lock wait.
locked_org as materialized (
  select o.id, o.authorization_version
    from public.organizations o
   where o.id = p_organization_id
     and o.status = 'ACTIVE'
   for share
),
permission as materialized (
  select pd.*
    from public.permission_definitions pd
    join locked_org lo on true
   where pd.key = p_permission_key
     and pd.permission_domain = 'TENANT'
     and pd.is_active
),
-- Fix #4: required dimensions must be supplied.
dimensions as materialized (
  select
    not exists (
      select 1 from permission pd
       where ('BUILDING' = any(pd.required_dimensions) and p_building_id is null)
          or ('CASHBOOK' = any(pd.required_dimensions) and p_cashbook_id is null)
    ) as satisfied
),
membership as materialized (
  select m.*
    from public.organization_memberships m
    join locked_org lo on lo.id = m.organization_id
    cross join at
   where m.user_id = p_actor
     and m.status = 'ACTIVE'
     and coalesce(m.valid_from, '-infinity') <= at.evaluated_at
     and (m.valid_to is null or m.valid_to > at.evaluated_at)
),
target as materialized (
  select
    (p_building_id is null or exists (
       select 1 from public.buildings b
        where b.id = p_building_id and b.organization_id = p_organization_id))
    and
    (p_cashbook_id is null or exists (
       select 1 from public.accounts a
        where a.id = p_cashbook_id and a.organization_id = p_organization_id
          and a.deleted_at is null)) as valid
),
-- Open member overrides for this key: malformed (zero-edge) witnesses raise.
member_overrides as materialized (
  select o.id, o.effect, o.scope_mode, o.expires_at
    from membership m
    join public.member_permission_overrides o
      on o.organization_id = m.organization_id
     and o.membership_id = m.id
     and o.permission_key = p_permission_key
    cross join at
   where o.revoked_at is null
     and (o.expires_at is null or o.expires_at > at.evaluated_at)
),
malformed_guard as materialized (
  select case when exists (
    select 1 from member_overrides mo
     where not exists (
       select 1 from public.member_override_scopes mos
        where mos.organization_id = p_organization_id
          and mos.override_id = mo.id)
  ) then app_private.raise_malformed_override(p_organization_id, p_permission_key)
  else 0 end as ok
),
-- Scope edges of member overrides.
member_edges as materialized (
  select mo.id, mo.effect, mo.scope_mode, s.scope_type,
         s.building_id, s.cashbook_id, s.area_id
    from member_overrides mo
    join public.member_override_scopes mos
      on mos.organization_id = p_organization_id and mos.override_id = mo.id
    join public.authorization_scopes s
      on s.organization_id = p_organization_id and s.id = mos.scope_id
),
-- Role statements: bindings valid now (NULL valid_from = always active, fix #5)
role_edges as materialized (
  select rp.effect, s.scope_type, s.building_id, s.cashbook_id, s.area_id
    from membership m
    join public.role_bindings rb
      on rb.organization_id = m.organization_id and rb.membership_id = m.id
    join public.organization_roles r
      on r.organization_id = rb.organization_id and r.id = rb.role_id
     and coalesce(r.status, 'ACTIVE') = 'ACTIVE'
    join public.role_permissions rp
      on rp.organization_id = rb.organization_id
     and rp.role_id = rb.role_id
     and rp.permission_key = p_permission_key
    join public.role_binding_scopes rbs
      on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id
    join public.authorization_scopes s
      on s.organization_id = rbs.organization_id and s.id = rbs.scope_id
    cross join at
   where coalesce(rb.valid_from, '-infinity') <= at.evaluated_at
     and (rb.valid_to is null or rb.valid_to > at.evaluated_at)
),
-- Fix #2: DENY matches any scope COVERING the target (broad).
-- A scope covers the target when:
--   ORGANIZATION: always
--   BUILDING: p_building_id matches
--   AREA: p_building_id inside the area
--   CASHBOOK: p_cashbook_id matches
scope_cover as materialized (
  select
    exists (
      select 1 from member_edges e
       where e.effect = 'DENY' and (
         e.scope_type = 'ORGANIZATION'
         or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)
         or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)
         or (e.scope_type = 'AREA' and p_building_id is not null and exists (
              select 1 from public.area_buildings ab
               where ab.organization_id = p_organization_id
                 and ab.area_id = e.area_id and ab.building_id = p_building_id)))
    ) as member_deny,
    exists (
      select 1 from role_edges e
       where e.effect = 'DENY' and (
         e.scope_type = 'ORGANIZATION'
         or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)
         or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)
         or (e.scope_type = 'AREA' and p_building_id is not null and exists (
              select 1 from public.area_buildings ab
               where ab.organization_id = p_organization_id
                 and ab.area_id = e.area_id and ab.building_id = p_building_id)))
    ) as role_deny,
    -- ALLOW: possession-required keys need the exact CASHBOOK edge; other keys
    -- accept any covering edge whose kind the registry permits (ANY_MATCH).
    exists (
      select 1 from member_edges e, permission pd
       where e.effect = 'ALLOW'
         and e.scope_type = any(pd.scope_kinds)
         and case
           when pd.requires_cashbook_possession then
             e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id
           else
             e.scope_type = 'ORGANIZATION'
             or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)
             or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)
             or (e.scope_type = 'AREA' and p_building_id is not null and exists (
                  select 1 from public.area_buildings ab
                   where ab.organization_id = p_organization_id
                     and ab.area_id = e.area_id and ab.building_id = p_building_id))
         end
    ) as member_allow,
    exists (
      select 1 from role_edges e, permission pd
       where e.effect = 'ALLOW'
         and e.scope_type = any(pd.scope_kinds)
         and case
           when pd.requires_cashbook_possession then
             e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id
           else
             e.scope_type = 'ORGANIZATION'
             or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)
             or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)
             or (e.scope_type = 'AREA' and p_building_id is not null and exists (
                  select 1 from public.area_buildings ab
                   where ab.organization_id = p_organization_id
                     and ab.area_id = e.area_id and ab.building_id = p_building_id))
         end
    ) as role_allow
),
emergency as materialized (
  select exists (
    select 1 from app_private.tenant_emergency_denies d
      join locked_org lo on lo.id = d.organization_id
      cross join at
     where (d.permission_key is null or d.permission_key = p_permission_key)
       and d.active_from <= at.evaluated_at
       and (d.expires_at is null or d.expires_at > at.evaluated_at)
  ) as denied
),
-- Fix #7: possession is fail-closed on missing permission too.
possession as materialized (
  select case
    when not exists (select 1 from permission) then false
    when not (select requires_cashbook_possession from permission) then true
    when p_cashbook_id is null then false
    else exists (
      select 1
        from public.cashbook_possession_bindings cp
        join membership m
          on m.organization_id = cp.organization_id and m.id = cp.membership_id
        join permission pd
          on cp.possession_kind = any(pd.accepted_possession_kinds)
        cross join at
       where cp.organization_id = p_organization_id
         and cp.cashbook_id = p_cashbook_id
         and cp.valid_from <= at.evaluated_at
         and (cp.valid_to is null or cp.valid_to > at.evaluated_at))
  end as accepted
),
-- Fix #8: all arms org-filtered. Activation AND expiry boundaries.
boundaries as materialized (
  select min(x.boundary) as nearest_deadline
    from (
      select m0.valid_from as boundary
        from public.organization_memberships m0
       where m0.organization_id = p_organization_id and m0.user_id = p_actor
      union all
      select m0.valid_to
        from public.organization_memberships m0
       where m0.organization_id = p_organization_id and m0.user_id = p_actor
      union all
      select rb.valid_from
        from public.role_bindings rb
        join public.organization_memberships m0
          on m0.organization_id = rb.organization_id and m0.id = rb.membership_id
       where m0.user_id = p_actor and rb.organization_id = p_organization_id
      union all
      select rb.valid_to
        from public.role_bindings rb
        join public.organization_memberships m0
          on m0.organization_id = rb.organization_id and m0.id = rb.membership_id
       where m0.user_id = p_actor and rb.organization_id = p_organization_id
      union all
      select o.expires_at
        from public.member_permission_overrides o
        join public.organization_memberships m0
          on m0.organization_id = o.organization_id and m0.id = o.membership_id
       where m0.user_id = p_actor
         and o.organization_id = p_organization_id
         and o.permission_key = p_permission_key
         and o.revoked_at is null
      union all
      select cp.valid_from
        from public.cashbook_possession_bindings cp
        join public.organization_memberships m0
          on m0.organization_id = cp.organization_id and m0.id = cp.membership_id
       where m0.user_id = p_actor
         and cp.organization_id = p_organization_id
         and cp.cashbook_id = p_cashbook_id
      union all
      select cp.valid_to
        from public.cashbook_possession_bindings cp
        join public.organization_memberships m0
          on m0.organization_id = cp.organization_id and m0.id = cp.membership_id
       where m0.user_id = p_actor
         and cp.organization_id = p_organization_id
         and cp.cashbook_id = p_cashbook_id
      union all
      select d.active_from from app_private.tenant_emergency_denies d
       where d.organization_id = p_organization_id
         and (d.permission_key is null or d.permission_key = p_permission_key)
      union all
      select d.expires_at from app_private.tenant_emergency_denies d
       where d.organization_id = p_organization_id
         and (d.permission_key is null or d.permission_key = p_permission_key)
    ) x, at
   where x.boundary is not null and x.boundary > at.evaluated_at
)
select
  case
    when not exists (select 1 from locked_org) then false
    when not exists (select 1 from permission) then false
    when not (select satisfied from dimensions) then false
    when not exists (select 1 from membership) then false
    when not coalesce((select valid from target), false) then false
    when (select denied from emergency) then false
    when (select ok from malformed_guard) < 0 then false -- never taken; forces eval
    when (select member_deny from scope_cover) then false
    when (select role_deny from scope_cover) then false
    when not (select accepted from possession) then false
    when (select member_allow from scope_cover) then true
    when (select role_allow from scope_cover) then true
    else false
  end as allowed,
  (select lo.authorization_version from locked_org lo),
  (select b.nearest_deadline from boundaries b),
  (select a.evaluated_at from at a),
  case
    when not exists (select 1 from locked_org) then 'ORGANIZATION_INACTIVE_OR_MISSING'
    when not exists (select 1 from permission) then 'PERMISSION_INACTIVE_OR_MISSING'
    when not (select satisfied from dimensions) then 'REQUIRED_DIMENSION_MISSING'
    when not exists (select 1 from membership) then 'MEMBERSHIP_INACTIVE_OR_MISSING'
    when not coalesce((select valid from target), false) then 'TARGET_CROSS_ORG_OR_MISSING'
    when (select denied from emergency) then 'EMERGENCY_DENY'
    when (select member_deny from scope_cover) then 'MEMBER_DENY'
    when (select role_deny from scope_cover) then 'ROLE_DENY'
    when not (select accepted from possession) then 'POSSESSION_MISSING'
    when (select member_allow from scope_cover) then 'MEMBER_ALLOW'
    when (select role_allow from scope_cover) then 'ROLE_ALLOW'
    else 'DEFAULT_DENY'
  end as decision_reason
from (select 1) _;
$fn$;

revoke all on function app_private.authorize_tenant_action_v3(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

commit;
