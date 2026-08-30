-- Forward-only correction for revoked organization memberships.
BEGIN;
SET LOCAL lock_timeout = '15s';

create or replace function app_private.authorized_scope_v3(
  p_permission_key text,
  p_org            uuid
)
returns table (org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
with

at as (select now() as ts),

org_ok as (
  select o.id
    from public.organizations o
   where o.id = p_org
     and o.status = 'ACTIVE'
),

permission as (
  select pd.*
    from public.permission_definitions pd
    join org_ok on true
   where pd.key = p_permission_key
     and pd.permission_domain = 'TENANT'
     and pd.is_active
),

membership as (
  select m.id, m.organization_id
    from public.organization_memberships m
    join org_ok o on o.id = m.organization_id
   cross join at
   where m.user_id = (select auth.uid())
     and m.status = 'ACTIVE'
     and m.revoked_at is null
     and coalesce(m.valid_from, '-infinity'::timestamptz) <= at.ts
     and (m.valid_to is null or m.valid_to > at.ts)
),

emergency as (
  select exists (
    select 1
      from app_private.tenant_emergency_denies d
     cross join at
     where d.organization_id = p_org
       and (d.permission_key is null or d.permission_key = p_permission_key)
       and d.active_from <= at.ts
       and (d.expires_at is null or d.expires_at > at.ts)
  ) as denied
),

member_edges as (
  select o.effect, s.scope_type, s.building_id, s.cashbook_id, s.area_id
    from membership m
    join public.member_permission_overrides o
      on o.organization_id = m.organization_id
     and o.membership_id   = m.id
     and o.permission_key  = p_permission_key
    join public.member_override_scopes mos
      on mos.organization_id = p_org and mos.override_id = o.id
    join public.authorization_scopes s
      on s.organization_id = p_org and s.id = mos.scope_id
   cross join at
   where o.revoked_at is null
     and (o.expires_at is null or o.expires_at > at.ts)
),

role_edges as (
  select rp.effect, s.scope_type, s.building_id, s.cashbook_id, s.area_id
    from membership m
    join public.role_bindings rb
      on rb.organization_id = m.organization_id and rb.membership_id = m.id
    join public.organization_roles r
      on r.organization_id = rb.organization_id and r.id = rb.role_id
     and coalesce(r.status, 'ACTIVE') = 'ACTIVE'
    join public.role_permissions rp
      on rp.organization_id = rb.organization_id
     and rp.role_id         = rb.role_id
     and rp.permission_key  = p_permission_key
    join public.role_binding_scopes rbs
      on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id
    join public.authorization_scopes s
      on s.organization_id = rbs.organization_id and s.id = rbs.scope_id
   cross join at
   where coalesce(rb.valid_from, '-infinity'::timestamptz) <= at.ts
     and (rb.valid_to is null or rb.valid_to > at.ts)
),

edges as (
  select * from member_edges
  union all
  select * from role_edges
),

edge_buildings as (
  select e.effect, b.building_id
    from edges e
    join lateral (
      select e.building_id as building_id where e.scope_type = 'BUILDING'
      union all
      select ab.building_id
        from public.area_buildings ab
       where e.scope_type = 'AREA'
         and ab.organization_id = p_org
         and ab.area_id = e.area_id
    ) b on true
   where b.building_id is not null
),

deny_org as (
  select exists (select 1 from edges where effect = 'DENY' and scope_type = 'ORGANIZATION') as v
),
deny_b as (
  select coalesce(array_agg(distinct building_id), '{}'::uuid[]) as v
    from edge_buildings where effect = 'DENY'
),
deny_c as (
  select coalesce(array_agg(distinct cashbook_id), '{}'::uuid[]) as v
    from edges where effect = 'DENY' and scope_type = 'CASHBOOK' and cashbook_id is not null
),

allow_org as (
  select exists (
    select 1 from edges e, permission pd
     where e.effect = 'ALLOW'
       and e.scope_type = 'ORGANIZATION'
       and e.scope_type = any(pd.scope_kinds)
       and not pd.requires_cashbook_possession
  ) as v
),
allow_b as (
  select coalesce(array_agg(distinct eb.building_id), '{}'::uuid[]) as v
    from edge_buildings eb, permission pd
   where eb.effect = 'ALLOW'
     and not pd.requires_cashbook_possession
     and ('BUILDING' = any(pd.scope_kinds) or 'AREA' = any(pd.scope_kinds))
),
allow_c as (
  select coalesce(array_agg(distinct e.cashbook_id), '{}'::uuid[]) as v
    from edges e, permission pd
   where e.effect = 'ALLOW'
     and e.scope_type = 'CASHBOOK'
     and e.cashbook_id is not null
     and 'CASHBOOK' = any(pd.scope_kinds)
),

possessed as (
  select coalesce(array_agg(distinct cp.cashbook_id), '{}'::uuid[]) as v
    from public.cashbook_possession_bindings cp
    join membership m
      on m.organization_id = cp.organization_id and m.id = cp.membership_id
    join permission pd
      on cp.possession_kind = any(pd.accepted_possession_kinds)
   cross join at
   where cp.organization_id = p_org
     and cp.valid_from <= at.ts
     and (cp.valid_to is null or cp.valid_to > at.ts)
),

all_buildings as (
  select coalesce(array_agg(b.id), '{}'::uuid[]) as v
    from public.buildings b
   where b.organization_id = p_org and b.deleted_at is null
),
all_cashbooks as (
  select coalesce(array_agg(a.id), '{}'::uuid[]) as v
    from public.accounts a
   where a.organization_id = p_org and a.deleted_at is null
),

gates as (
  select
    exists (select 1 from org_ok)     as org_active,
    exists (select 1 from permission) as perm_ok,
    exists (select 1 from membership) as member_ok,
    (select denied from emergency)    as emergency_denied,
    coalesce((select 'BUILDING' = any(pd.required_dimensions) from permission pd), false) as needs_building,
    coalesce((select 'CASHBOOK' = any(pd.required_dimensions) from permission pd), false) as needs_cashbook,
    coalesce((select pd.requires_cashbook_possession from permission pd), false)          as needs_possession
),

resolved as (
  select
    g.org_active and g.perm_ok and g.member_ok and not g.emergency_denied as pass,
    g.needs_building, g.needs_cashbook, g.needs_possession,
    (select v from deny_org)      as d_org,
    (select v from deny_b)        as d_b,
    (select v from deny_c)        as d_c,
    (select v from allow_org)     as a_org,
    (select v from allow_b)       as a_b,
    (select v from allow_c)       as a_c,
    (select v from possessed)     as poss,
    (select v from all_buildings) as all_b,
    (select v from all_cashbooks) as all_c
  from gates g
),

eff_b as (
  select coalesce(array_agg(distinct t.b), '{}'::uuid[]) as v
    from resolved r
   cross join lateral unnest(case when r.a_org then r.all_b else r.a_b end) as t(b)
   where r.pass and not r.d_org and not r.needs_possession and not r.needs_cashbook
     and not (t.b = any(r.d_b))
),

eff_c_src as (
  select r.pass, r.d_org, r.d_c, r.needs_building,
         case
           when r.needs_possession then array(select x from unnest(r.a_c) as u(x) where x = any(r.poss))
           when r.a_org            then r.all_c
           else r.a_c
         end as src
    from resolved r
),
eff_c as (
  select coalesce(array_agg(distinct t.c), '{}'::uuid[]) as v
    from eff_c_src s
   cross join lateral unnest(s.src) as t(c)
   where s.pass and not s.d_org and not s.needs_building
     and not (t.c = any(s.d_c))
)

select
  
  
  case
    when not r.pass then false
    when r.needs_building or r.needs_cashbook then false
    when r.d_org then false
    else r.a_org
  end as org_wide,
  (select v from eff_b) as building_ids,
  (select v from eff_c) as cashbook_ids
from resolved r;
$fn$;

comment on function app_private.authorized_scope_v3(text, uuid) is
  'Read scope resolver excludes active memberships with revoked_at set.';

revoke all on function app_private.authorized_scope_v3(text, uuid) from public, anon;
grant execute on function app_private.authorized_scope_v3(text, uuid) to authenticated;

COMMIT;

