-- ============================================================================
-- T2/§11.7 + §11.2 PREPARED SQL — authorization_version auto-bump + last-owner guard.
-- STATUS: APPLIED production 2026-07-18 (audit §3.3 + §3.1 fix-now, additive/safe).
-- LÝ DO:
--  (A) resolver v3 đọc live membership/RBAC nhưng cache key (user,org,version)
--      không invalidate vì authorization_version KHÔNG bao giờ bump (chỉ 1 lần
--      one-off) → client giữ quyền cũ. Thêm AFTER trigger bump khi RBAC đổi.
--  (B) không có guard "owner cuối" → suspend/revoke/xoá OWNER cuối của org ACTIVE
--      không bị chặn (mất quyền quản trị tổ chức). Thêm constraint trigger.
-- An toàn: additive (trigger), 0 dữ liệu hiện tại vi phạm, reversible.
-- ============================================================================

begin;

-- (A) auto-bump authorization_version cho org khi bảng RBAC đổi.
create or replace function app_private.bump_org_authorization_version()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public' as $fn$
declare v_org uuid;
begin
  if tg_op = 'DELETE' then v_org := (to_jsonb(old)->>'organization_id')::uuid;
  else v_org := (to_jsonb(new)->>'organization_id')::uuid; end if;
  if v_org is not null then
    update public.organizations set authorization_version = authorization_version + 1 where id = v_org;
  end if;
  return coalesce(new, old);
end;
$fn$;
revoke all on function app_private.bump_org_authorization_version() from public, anon, authenticated, service_role;

do $mk$
declare t text;
begin
  foreach t in array array['role_permissions','role_bindings','member_permission_overrides',
      'member_override_scopes','role_binding_scopes','organization_memberships','authorization_scopes'] loop
    execute format('drop trigger if exists a10_bump_authz_version on public.%I', t);
    execute format($q$create trigger a10_bump_authz_version
      after insert or update or delete on public.%I
      for each row execute function app_private.bump_org_authorization_version()$q$, t);
  end loop;
end $mk$;

-- (B) last-owner guard: không cho gỡ/suspend/revoke OWNER active cuối của org ACTIVE.
create or replace function app_private.guard_last_owner()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public' as $fn$
declare v_remaining int;
begin
  if old.member_type = 'OWNER' and old.status = 'ACTIVE' then
    select count(*) into v_remaining
      from public.organization_memberships m
     where m.organization_id = old.organization_id
       and m.member_type = 'OWNER' and m.status = 'ACTIVE' and m.id <> old.id;
    if tg_op = 'UPDATE' and new.member_type = 'OWNER' and new.status = 'ACTIVE'
       and (new.valid_to is null or new.valid_to > now()) then
      v_remaining := v_remaining + 1;
    end if;
    if v_remaining < 1
       and exists (select 1 from public.organizations o where o.id = old.organization_id and o.status = 'ACTIVE') then
      raise exception 'Không thể gỡ/tạm ngưng chủ sở hữu CUỐI CÙNG của tổ chức đang hoạt động'
        using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end;
$fn$;
revoke all on function app_private.guard_last_owner() from public, anon, authenticated, service_role;
drop trigger if exists a00_last_owner_guard on public.organization_memberships;
create constraint trigger a00_last_owner_guard
  after update or delete on public.organization_memberships
  deferrable initially immediate
  for each row execute function app_private.guard_last_owner();

commit;
