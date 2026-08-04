begin;

do $role$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'openclaw_function_owner'
  ) then
    create role openclaw_function_owner with NOLOGIN NOINHERIT NOBYPASSRLS;
  else
    alter role openclaw_function_owner with NOLOGIN NOINHERIT NOBYPASSRLS;
  end if;
end
$role$;

-- Ownership assignment needs two things a superuser has for free and the Supabase
-- `postgres` role does not: SET on the owning role (PostgreSQL 16+ withholds it
-- from role creators) and CREATE for that role on the object's schema. Both are
-- given here and taken back before this file commits.
grant openclaw_function_owner to current_user with set true;
grant create on schema public, app_private to openclaw_function_owner;

insert into public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds, is_active,
   requires_cashbook_possession, accepted_possession_kinds, required_dimensions)
values
  ('openclaw_zalo.view', 'openclaw_zalo', 'view', 'VIEW', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.send', 'openclaw_zalo', 'send', 'MANAGE', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.manage_connections', 'openclaw_zalo', 'manage_connections', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.manage_automation', 'openclaw_zalo', 'manage_automation', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.manage_knowledge', 'openclaw_zalo', 'manage_knowledge', 'MANAGE', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.manage_handoff', 'openclaw_zalo', 'manage_handoff', 'MANAGE', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.manage_operations', 'openclaw_zalo', 'manage_operations', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[]),
  ('openclaw_zalo.audit', 'openclaw_zalo', 'audit', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION']::text[], true, false, '{}'::text[], '{}'::text[])
on conflict (key) do update
set resource = excluded.resource,
    action = excluded.action,
    sensitivity = excluded.sensitivity,
    permission_domain = excluded.permission_domain,
    scope_kinds = excluded.scope_kinds,
    is_active = excluded.is_active,
    requires_cashbook_possession = excluded.requires_cashbook_possession,
    accepted_possession_kinds = excluded.accepted_possession_kinds,
    required_dimensions = excluded.required_dimensions;

grant usage on schema public, app_private to openclaw_function_owner;
grant select on public.permission_definitions, public.organization_roles to openclaw_function_owner;
-- SELECT as well as insert/update: the grant function uses
-- `on conflict ... do update`, and that path reads the conflicting row, so
-- without it the whole statement fails with "permission denied for table".
-- What it can actually read is bounded by the row policy below - openclaw rows
-- only - so this adds no visibility beyond this feature's own grants.
grant select, insert, update on public.role_permissions to openclaw_function_owner;

-- Table privileges are not enough: both tables have RLS enabled and their only
-- policies are for `authenticated`. openclaw_function_owner is NOBYPASSRLS, so
-- without these it reads ZERO permission definitions and its insert into
-- role_permissions is refused with 42501 - and the read failure is SILENT,
-- because `insert ... select` over an empty result set inserts nothing and raises
-- nothing. That is why grant_openclaw_owner_permissions_v1 and the owner-role
-- trigger below appeared to succeed on production while granting no permission at
-- all. A superuser harness bypasses RLS and never sees it.
--
-- Both policies are scoped to this one role AND to openclaw rows only, so they
-- cannot widen what any other role sees or writes.
create policy openclaw_function_owner_reads_definitions
  on public.permission_definitions
  for select to openclaw_function_owner
  using (resource = 'openclaw_zalo');

-- The grant function's FIRST statement checks that the target role really is an
-- active system owner role. Without this it reads zero rows and returns early -
-- the quietest failure of the three, because the function then does nothing at
-- all and reports success. Scoped to owner system roles only.
create policy openclaw_function_owner_reads_owner_roles
  on public.organization_roles
  for select to openclaw_function_owner
  using (is_system is true and name = 'Chủ sở hữu tổ chức');

create policy openclaw_function_owner_writes_grants
  on public.role_permissions
  for all to openclaw_function_owner
  using (starts_with(permission_key, 'openclaw_zalo.'))
  with check (starts_with(permission_key, 'openclaw_zalo.'));

create or replace function app_private.grant_openclaw_owner_permissions_v1(
  p_organization_id uuid,
  p_role_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.organization_roles r
    where r.organization_id = p_organization_id
      and r.id = p_role_id
      and r.is_system IS TRUE
      and r.status = 'ACTIVE'
      and r.name = 'Chủ sở hữu tổ chức'
  ) then
    return;
  end if;

  insert into public.role_permissions
    (organization_id, role_id, permission_key, effect)
  select p_organization_id, p_role_id, d.key, 'ALLOW'
  from public.permission_definitions d
  where d.resource = 'openclaw_zalo'
    and d.is_active is true
  on conflict (organization_id, role_id, permission_key) do update
  set effect = 'ALLOW';
end
$function$;

alter function app_private.grant_openclaw_owner_permissions_v1(uuid, uuid)
  owner to openclaw_function_owner;
revoke all on function app_private.grant_openclaw_owner_permissions_v1(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.provision_openclaw_owner_role_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if NEW.is_system IS TRUE
     and NEW.status = 'ACTIVE'
     and NEW.name = 'Chủ sở hữu tổ chức'
  then
    perform app_private.grant_openclaw_owner_permissions_v1(
      NEW.organization_id,
      NEW.id
    );
  end if;
  return NEW;
end
$function$;

alter function app_private.provision_openclaw_owner_role_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.provision_openclaw_owner_role_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists organization_roles_provision_openclaw_owner_v1
  on public.organization_roles;
create trigger organization_roles_provision_openclaw_owner_v1
after insert on public.organization_roles
for each row
execute function app_private.provision_openclaw_owner_role_v1();

do $seed$
declare
  v_role record;
begin
  for v_role in
    select r.organization_id, r.id
    from public.organization_roles r
    where r.is_system IS TRUE
      and r.status = 'ACTIVE'
      and r.name = 'Chủ sở hữu tổ chức'
  loop
    perform app_private.grant_openclaw_owner_permissions_v1(
      v_role.organization_id,
      v_role.id
    );
  end loop;
end
$seed$;


-- CREATE was only ever needed to hand ownership over; ownership and SECURITY
-- DEFINER execution both survive the revoke, so no openclaw role keeps the
-- ability to create objects.
revoke create on schema public, app_private from openclaw_function_owner;
commit;
