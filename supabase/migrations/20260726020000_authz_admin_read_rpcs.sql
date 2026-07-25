-- =============================================================================
-- T5a — RPC ĐỌC cho 4 màn quản trị phân quyền
--
-- VÌ SAO PHẢI CÓ TẦNG NÀY
--   Đã soi pg_policies: cả 13 bảng của mô hình phân quyền chỉ có ĐÚNG một
--   policy SELECT, điều kiện là is_super_admin(). Nghĩa là một CHỦ SỞ HỮU tổ
--   chức, dù có users.view, vẫn đọc thẳng bảng ra 0 dòng. Không có tầng RPC này
--   thì màn hình quản trị luôn trống — kể cả khi phân quyền hoàn toàn đúng.
--   (Cố ý giữ policy chặt và mở qua SECURITY DEFINER, thay vì nới policy: mỗi
--   hàm dưới đây tự kiểm users.view của người gọi trong ĐÚNG tổ chức của họ.)
--
-- Mọi hàm đều trả jsonb đã gộp sẵn để giao diện không phải nối nhiều truy vấn.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Tổ chức "đang làm việc" của người gọi + chốt chặn quyền đọc.
-- Trả NULL nếu không đủ quyền — hàm gọi tự quyết báo lỗi hay trả rỗng.
-- ---------------------------------------------------------------------------
create or replace function app_private.current_admin_org_v1()
returns uuid
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare v_org uuid;
begin
  if (select auth.uid()) is null then return null; end if;
  select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
   where m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
   order by coalesce(o.is_demo, false), m.organization_id
   limit 1;
  if v_org is null then return null; end if;
  -- Đọc danh sách thành viên là quyền users.view. Quản trị nền tảng luôn qua.
  if public.is_super_admin() or app_private.has_any_scope_v3('users.view') then
    return v_org;
  end if;
  return null;
end
$fn$;

revoke all on function app_private.current_admin_org_v1() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Nhãn tiếng Việt của một phạm vi — dùng chung ở mọi màn.
-- ---------------------------------------------------------------------------
create or replace function app_private.scope_label_v1(p_scope uuid)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select case s.scope_type
           when 'ORGANIZATION' then 'Toàn tổ chức'
           when 'AREA'         then 'Khu vực: ' || coalesce(a.name, '(đã xoá)')
           when 'BUILDING'     then 'Toà: '     || coalesce(b.name, '(đã xoá)')
           when 'CASHBOOK'     then 'Sổ quỹ: '  || coalesce(c.name, '(đã xoá)')
           else s.scope_type
         end
    from public.authorization_scopes s
    left join public.areas a     on a.id = s.area_id
    left join public.buildings b on b.id = s.building_id
    left join public.accounts c on c.id = s.cashbook_id
   where s.id = p_scope;
$fn$;

-- ---------------------------------------------------------------------------
-- 1) MÀN "THÀNH VIÊN" — danh sách người + vai trò + số ngoại lệ + số quyền
-- ---------------------------------------------------------------------------
create or replace function public.list_organization_members_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem danh sách thành viên.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'organizationId', v_org,
    'members', coalesce(jsonb_agg(x.row order by x.sort_key, x.email), '[]'::jsonb))
    into v_out
  from (
    select
      -- Chủ sở hữu lên đầu, rồi tới nhân sự, rồi các loại còn lại.
      case m.member_type when 'OWNER' then 0 when 'STAFF' then 1 else 2 end as sort_key,
      coalesce(p.email, u.email, '') as email,
      jsonb_build_object(
        'membershipId', m.id,
        'userId',       m.user_id,
        'email',        coalesce(p.email, u.email),
        'fullName',     p.full_name,
        'memberType',   m.member_type,
        'status',       m.status,
        'version',      m.version,
        'isSelf',       (m.user_id = (select auth.uid())),
        'roles', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'bindingId', rb.id,
                   'roleId',    orl.id,
                   'roleName',  orl.name,
                   'isSystem',  orl.is_system,
                   'scopes', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'scopeId',   s.id,
                              'scopeType', s.scope_type,
                              'label',     app_private.scope_label_v1(s.id))
                            order by s.scope_type, app_private.scope_label_v1(s.id))
                       from public.role_binding_scopes rbs
                       join public.authorization_scopes s on s.id = rbs.scope_id
                      where rbs.role_binding_id = rb.id), '[]'::jsonb))
                 order by orl.name)
            from public.role_bindings rb
            join public.organization_roles orl on orl.id = rb.role_id
           where rb.membership_id = m.id and rb.valid_to is null), '[]'::jsonb),
        'overrideAllow', (select count(*) from public.member_permission_overrides o
                           where o.membership_id = m.id and o.revoked_at is null
                             and o.effect = 'ALLOW'
                             and (o.expires_at is null or o.expires_at > now())),
        'overrideDeny',  (select count(*) from public.member_permission_overrides o
                           where o.membership_id = m.id and o.revoked_at is null
                             and o.effect = 'DENY'
                             and (o.expires_at is null or o.expires_at > now())),
        'cashbooksHeld', (select count(*) from public.cashbook_possession_bindings cp
                           where cp.membership_id = m.id and cp.valid_from <= now()
                             and (cp.valid_to is null or cp.valid_to > now())),
        'permissionCount',
          coalesce(array_length(app_private.allowed_keys_for_membership_v3(m.id), 1), 0)
      ) as row
    from public.organization_memberships m
    left join public.profiles p on p.id = m.user_id
    left join auth.users u      on u.id = m.user_id
   where m.organization_id = v_org
     and m.status <> 'REVOKED'
  ) x;

  return v_out;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 2) HỘP THOẠI PHÂN QUYỀN — trạng thái đầy đủ của MỘT thành viên
--    Trả cả `version` để giao diện gửi lại làm khoá chống ghi chen.
-- ---------------------------------------------------------------------------
create or replace function public.get_member_authorization_v1(p_membership uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_m   public.organization_memberships%rowtype;
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem phân quyền thành viên.' using errcode = '42501';
  end if;
  select * into v_m from public.organization_memberships
   where id = p_membership and organization_id = v_org;
  if not found then
    raise exception 'Không tìm thấy thành viên này trong tổ chức của bạn.' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'membershipId', v_m.id,
    'userId',       v_m.user_id,
    'email',        coalesce(p.email, u.email),
    'fullName',     p.full_name,
    'memberType',   v_m.member_type,
    'status',       v_m.status,
    'version',      v_m.version,
    'isSelf',       (v_m.user_id = (select auth.uid())),
    'roleBindings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bindingId', rb.id,
               'roleId',    rb.role_id,
               'roleName',  orl.name,
               'scopeIds',  coalesce((select jsonb_agg(rbs.scope_id)
                                        from public.role_binding_scopes rbs
                                       where rbs.role_binding_id = rb.id), '[]'::jsonb))
             order by orl.name)
        from public.role_bindings rb
        join public.organization_roles orl on orl.id = rb.role_id
       where rb.membership_id = v_m.id and rb.valid_to is null), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object(
               'overrideId',    o.id,
               'permissionKey', o.permission_key,
               'effect',        o.effect,
               'scopeMode',     o.scope_mode,
               'reason',        o.reason,
               'expiresAt',     o.expires_at,
               'createdAt',     o.created_at,
               'scopeIds', coalesce((select jsonb_agg(mos.scope_id)
                                       from public.member_override_scopes mos
                                      where mos.override_id = o.id), '[]'::jsonb))
             order by o.permission_key)
        from public.member_permission_overrides o
       where o.membership_id = v_m.id and o.revoked_at is null
         and (o.expires_at is null or o.expires_at > now())), '[]'::jsonb),
    'cashbooksHeld', coalesce((
      select jsonb_agg(jsonb_build_object(
               'cashbookId', cp.cashbook_id, 'name', cb.name, 'kind', cp.possession_kind))
        from public.cashbook_possession_bindings cp
        left join public.accounts cb on cb.id = cp.cashbook_id
       where cp.membership_id = v_m.id and cp.valid_from <= now()
         and (cp.valid_to is null or cp.valid_to > now())), '[]'::jsonb),
    -- Tab "Quyền hiệu lực": danh sách khoá thực sự dùng được, ở BẤT KỲ phạm vi.
    'effectiveKeys', to_jsonb(app_private.allowed_keys_for_membership_v3(v_m.id))
  ) into v_out
  from (select 1) z
  left join public.profiles p on p.id = v_m.user_id
  left join auth.users u      on u.id = v_m.user_id;

  return v_out;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 3) MÀN "MẪU VAI TRÒ"
-- ---------------------------------------------------------------------------
create or replace function public.list_organization_roles_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem mẫu vai trò.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'roleId',   r.id,
           'name',     r.name,
           'isSystem', r.is_system,
           'status',   coalesce(r.status, 'ACTIVE'),
           'version',  r.version,
           'memberCount', (select count(distinct rb.membership_id)
                             from public.role_bindings rb
                            where rb.role_id = r.id and rb.valid_to is null),
           'allowKeys', coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key)
                                    from public.role_permissions rp
                                   where rp.role_id = r.id and rp.effect = 'ALLOW'), '[]'::jsonb),
           'denyKeys',  coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key)
                                    from public.role_permissions rp
                                   where rp.role_id = r.id and rp.effect = 'DENY'), '[]'::jsonb))
         order by r.is_system desc, r.name), '[]'::jsonb)
    into v_out
    from public.organization_roles r
   where r.organization_id = v_org and coalesce(r.status, 'ACTIVE') <> 'ARCHIVED';

  return v_out;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 4) BỘ CHỌN PHẠM VI + DANH MỤC QUYỀN (dùng ở hộp thoại và màn vai trò)
--
-- Trả kèm scope_kinds/required_dimensions của TỪNG khoá để giao diện chỉ cho
-- chọn phạm vi hợp lệ — thay vì để người dùng chọn bừa rồi ăn lỗi ràng buộc
-- lúc lưu (a90_override_edge_shape báo mã 23514, người dùng không hiểu gì).
-- ---------------------------------------------------------------------------
create or replace function public.list_authorization_catalog_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid := app_private.current_admin_org_v1();
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem danh mục phân quyền.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'scopes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'scopeId',    s.id,
               'scopeType',  s.scope_type,
               'label',      app_private.scope_label_v1(s.id),
               'buildingId', s.building_id,
               'areaId',     s.area_id,
               'cashbookId', s.cashbook_id)
             order by case s.scope_type when 'ORGANIZATION' then 0 when 'AREA' then 1
                                        when 'BUILDING' then 2 else 3 end,
                      app_private.scope_label_v1(s.id))
        from public.authorization_scopes s
       where s.organization_id = v_org), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key',            pd.key,
               'resource',       pd.resource,
               'action',         pd.action,
               'sensitivity',    pd.sensitivity,
               'scopeKinds',     to_jsonb(pd.scope_kinds),
               'requiredDimensions', to_jsonb(coalesce(pd.required_dimensions, '{}'::text[])),
               'requiresCashbookPossession', pd.requires_cashbook_possession)
             order by pd.key)
        from public.permission_definitions pd
       where pd.permission_domain = 'TENANT' and pd.is_active), '[]'::jsonb));
end
$fn$;

-- ---------------------------------------------------------------------------
-- 5) MÀN "TỔ CHỨC" — hồ sơ + sức khoẻ phân quyền + nhật ký
-- ---------------------------------------------------------------------------
create or replace function public.get_organization_profile_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_o   public.organizations%rowtype;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem thông tin tổ chức.' using errcode = '42501';
  end if;
  select * into v_o from public.organizations where id = v_org;

  return jsonb_build_object(
    'organizationId', v_o.id,
    'name',    v_o.name,
    'slug',    v_o.slug,
    'status',  v_o.status,
    'isDemo',  coalesce(v_o.is_demo, false),
    'createdAt', v_o.created_at,
    'authorizationVersion', v_o.authorization_version,
    'canEdit', public.is_super_admin() or app_private.has_any_scope_v3('settings.edit'),
    'counts', jsonb_build_object(
      'members',   (select count(*) from public.organization_memberships m
                     where m.organization_id = v_org and m.status = 'ACTIVE'),
      'owners',    (select count(*) from public.organization_memberships m
                     where m.organization_id = v_org and m.status = 'ACTIVE'
                       and m.member_type = 'OWNER'),
      'roles',     (select count(*) from public.organization_roles r
                     where r.organization_id = v_org and coalesce(r.status,'ACTIVE') = 'ACTIVE'),
      'buildings', (select count(*) from public.authorization_scopes s
                     where s.organization_id = v_org and s.scope_type = 'BUILDING'),
      'areas',     (select count(*) from public.authorization_scopes s
                     where s.organization_id = v_org and s.scope_type = 'AREA'),
      'cashbooks', (select count(*) from public.authorization_scopes s
                     where s.organization_id = v_org and s.scope_type = 'CASHBOOK'),
      'pendingInvitations', (select count(*) from public.organization_invitations i
                              where i.organization_id = v_org and i.status = 'PENDING'
                                and i.expires_at > now()),
      'activeOverrides', (select count(*) from public.member_permission_overrides o
                           where o.organization_id = v_org and o.revoked_at is null
                             and (o.expires_at is null or o.expires_at > now()))),
    'invitations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'invitationId', i.id, 'email', i.email_normalized,
               'memberType', i.intended_member_type, 'status', i.status,
               'expiresAt', i.expires_at, 'createdAt', i.created_at,
               'roleName', r.name,
               'isExpired', (i.status = 'PENDING' and i.expires_at <= now()))
             order by i.created_at desc)
        from public.organization_invitations i
        left join public.organization_roles r on r.id = i.intended_role_id
       where i.organization_id = v_org
         and i.created_at > now() - interval '90 days'), '[]'::jsonb),
    'auditTrail', coalesce((
      select jsonb_agg(jsonb_build_object(
               'eventId', e.id, 'occurredAt', e.occurred_at, 'eventType', e.event_type,
               'resourceType', e.resource_type, 'resourceId', e.resource_id,
               'reason', e.reason,
               'actorEmail', coalesce(pa.email, ua.email),
               'actorName', pa.full_name,
               'newState', e.new_state)
             order by e.occurred_at desc)
        from (select * from public.authorization_audit_events ae
               where ae.organization_id = v_org
               order by ae.occurred_at desc limit 50) e
        left join public.profiles pa on pa.id = e.actor_user_id
        left join auth.users ua      on ua.id = e.actor_user_id), '[]'::jsonb));
end
$fn$;

-- ---------------------------------------------------------------------------
-- 6) Sửa hồ sơ tổ chức (chỉ tên — slug là khoá kỹ thuật, không cho đổi)
-- ---------------------------------------------------------------------------
create or replace function public.update_organization_profile_v1(p_name text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org  uuid := app_private.current_admin_org_v1();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_cu   text;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền sửa thông tin tổ chức.' using errcode = '42501';
  end if;
  perform app_private.require_perm_v1(v_org, 'settings.edit', 'sửa thông tin tổ chức');
  if v_name is null then
    raise exception 'Tên tổ chức không được để trống.' using errcode = '22023';
  end if;
  if length(v_name) > 200 then
    raise exception 'Tên tổ chức tối đa 200 ký tự.' using errcode = '22023';
  end if;

  select name into v_cu from public.organizations where id = v_org;
  update public.organizations set name = v_name, updated_at = now() where id = v_org;

  perform app_private.append_authz_audit_v1(
    v_org, 'ORGANIZATION_UPDATED', 'organization', v_org,
    jsonb_build_object('name', v_cu), jsonb_build_object('name', v_name), null);

  return jsonb_build_object('organizationId', v_org, 'name', v_name);
end
$fn$;

-- ---------------------------------------------------------------------------
-- 7) Thu hồi lời mời
-- ---------------------------------------------------------------------------
create or replace function public.revoke_organization_invitation_v1(p_invitation uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_i   public.organization_invitations%rowtype;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền thu hồi lời mời.' using errcode = '42501';
  end if;
  perform app_private.require_perm_v1(v_org, 'users.create', 'thu hồi lời mời');

  select * into v_i from public.organization_invitations
   where id = p_invitation and organization_id = v_org for update;
  if not found then
    raise exception 'Không tìm thấy lời mời này.' using errcode = 'P0002';
  end if;
  if v_i.status <> 'PENDING' then
    raise exception 'Lời mời này không còn ở trạng thái chờ.' using errcode = '55000';
  end if;

  update public.organization_invitations
     set status = 'REVOKED', revoked_at = now() where id = p_invitation;

  perform app_private.append_authz_audit_v1(
    v_org, 'INVITATION_REVOKED', 'organization_invitation', p_invitation,
    jsonb_build_object('email', v_i.email_normalized, 'status', 'PENDING'),
    jsonb_build_object('status', 'REVOKED'), null);

  return jsonb_build_object('invitationId', p_invitation, 'status', 'REVOKED');
end
$fn$;

revoke all on function public.list_organization_members_v1() from public, anon;
revoke all on function public.get_member_authorization_v1(uuid) from public, anon;
revoke all on function public.list_organization_roles_v1() from public, anon;
revoke all on function public.list_authorization_catalog_v1() from public, anon;
revoke all on function public.get_organization_profile_v1() from public, anon;
revoke all on function public.update_organization_profile_v1(text) from public, anon;
revoke all on function public.revoke_organization_invitation_v1(uuid) from public, anon;
grant execute on function public.list_organization_members_v1() to authenticated;
grant execute on function public.get_member_authorization_v1(uuid) to authenticated;
grant execute on function public.list_organization_roles_v1() to authenticated;
grant execute on function public.list_authorization_catalog_v1() to authenticated;
grant execute on function public.get_organization_profile_v1() to authenticated;
grant execute on function public.update_organization_profile_v1(text) to authenticated;
grant execute on function public.revoke_organization_invitation_v1(uuid) to authenticated;

commit;
