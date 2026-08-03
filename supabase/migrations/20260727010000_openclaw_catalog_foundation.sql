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
grant insert, update on public.role_permissions to openclaw_function_owner;

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
