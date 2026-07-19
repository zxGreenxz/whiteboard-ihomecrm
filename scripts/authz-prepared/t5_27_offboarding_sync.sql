-- t5_27 — P0-3 sau tổng kiểm 2026-07-19: ĐỒNG BỘ 2 HỆ QUYỀN + OFF-BOARDING
--
-- Vấn đề (đã xác minh trên prod):
--  (a) UI sửa quyền chỉ ghi legacy `staff_assignments`; hệ chuẩn hoá
--      (`role_bindings`) KHÔNG có trigger/FK nào theo dõi → gỡ quyền trên UI
--      KHÔNG thu hồi quyền ở writer canonical (fail-OPEN, nguy hiểm).
--      61/64 role_bindings có `legacy_assignment_id` → dùng làm móc đồng bộ.
--  (b) 3 hàm gác đường cũ (can_do_on_building / permitted_building_ids /
--      get_my_permissions) CHỈ đọc staff_assignments, KHÔNG nhìn
--      organization_memberships.status → đình chỉ/thu hồi thành viên KHÔNG
--      chặn được đường cũ.
--  (c) delete_staff_member xoá thẳng auth.users → FK RESTRICT của
--      organization_memberships làm nút "Xoá nhân viên" gãy (23503).
--
-- Nguyên tắc: CHỈ tự động đồng bộ chiều THU HỒI (fail-closed). Chiều cấp thêm
-- quyền vẫn phải qua luồng cấp phép có chủ đích — thiếu quyền là an toàn,
-- thừa quyền mới nguy hiểm.

begin;

-- ========== (a) Trigger đồng bộ THU HỒI: staff_assignments → role_bindings ==========
create or replace function app_private.sync_revoke_role_binding_v1()
returns trigger
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org uuid;
begin
  -- Đóng mọi binding chuẩn hoá gắn với assignment vừa bị xoá / đổi vai trò.
  update public.role_bindings rb
     set valid_to = now(), version = rb.version + 1
   where rb.legacy_assignment_id = old.id
     and rb.valid_to is null
  returning rb.organization_id into v_org;

  if v_org is not null then
    update public.organizations
       set authorization_version = authorization_version + 1
     where id = v_org;
  end if;
  return null;
end;
$fn$;

drop trigger if exists a80_sa_revoke_sync on public.staff_assignments;
create trigger a80_sa_revoke_sync
  after delete on public.staff_assignments
  for each row
  execute function app_private.sync_revoke_role_binding_v1();

drop trigger if exists a81_sa_role_change_sync on public.staff_assignments;
create trigger a81_sa_role_change_sync
  after update of role_id, building_id, area_id, permissions on public.staff_assignments
  for each row
  when (old.role_id is distinct from new.role_id
        or old.building_id is distinct from new.building_id
        or old.area_id is distinct from new.area_id
        or old.permissions is distinct from new.permissions)
  execute function app_private.sync_revoke_role_binding_v1();

comment on function app_private.sync_revoke_role_binding_v1() is
  't5_27: gỡ/đổi assignment legacy ⇒ đóng role_binding chuẩn hoá tương ứng (fail-closed). Cấp lại quyền phải qua luồng cấp phép.';

-- ========== (b) Đường cũ nhận biết thành viên bị đình chỉ/thu hồi ==========
-- Quy tắc an toàn: CHỈ chặn khi người dùng CÓ bản ghi thành viên nhưng KHÔNG
-- còn bản ghi nào ACTIVE. Người chưa từng có membership (owner legacy) không
-- bị ảnh hưởng — giữ nguyên hành vi hiện tại.
create or replace function app_private.is_actor_offboarded_v1()
returns boolean
language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select auth.uid() is not null
     and exists (select 1 from public.organization_memberships m
                  where m.user_id = auth.uid())
     and not exists (select 1 from public.organization_memberships m
                      where m.user_id = auth.uid() and m.status = 'ACTIVE');
$fn$;

create or replace function public.can_do_on_building(_table text, _action text, _building_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'auth', 'app_private'
as $function$
  SELECT
    -- t5_27: thành viên bị đình chỉ/thu hồi ⇒ chặn ngay ở đường cũ.
    NOT app_private.is_actor_offboarded_v1()
    AND (
    public.is_super_admin()
    -- admin cấp-tenant (owner-join): admin làm mọi thứ trong tenant mình
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               JOIN public.roles r ON r.id = sa.role_id
               JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
               WHERE sa.staff_id = auth.uid()
                 AND (r.name = 'Admin' OR r.permissions @> '{"__superadmin": true}'::jsonb))
    -- full-scope + quyền (owner-join): mọi tòa CÙNG owner
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
               WHERE sa.staff_id = auth.uid()
                 AND sa.building_id IS NULL AND sa.area_id IS NULL
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    -- gán tòa cụ thể + quyền (KHÔNG owner-join)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               WHERE sa.staff_id = auth.uid() AND sa.building_id = _building_id
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    -- gán theo khu + quyền (KHÔNG owner-join)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               JOIN public.area_buildings ab ON ab.area_id = sa.area_id
               WHERE sa.staff_id = auth.uid() AND sa.area_id IS NOT NULL AND ab.building_id = _building_id
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    );
$function$;

create or replace function public.permitted_building_ids(_table text, _action text)
 returns setof uuid
 language sql
 stable security definer
 set search_path to 'public', 'auth', 'app_private'
as $function$
  -- t5_27: bị đình chỉ/thu hồi ⇒ không toà nào.
  SELECT sa.building_id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
    AND NOT app_private.is_actor_offboarded_v1()
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true
  UNION
  SELECT ab.building_id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  JOIN public.area_buildings ab ON ab.area_id = sa.area_id
  WHERE sa.staff_id = auth.uid() AND sa.area_id IS NOT NULL
    AND NOT app_private.is_actor_offboarded_v1()
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true
  UNION
  -- full-scope + quyền: mọi tòa của CÙNG owner
  SELECT b.id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  JOIN public.buildings b ON b.user_id = sa.user_id
  WHERE sa.staff_id = auth.uid()
    AND sa.building_id IS NULL AND sa.area_id IS NULL
    AND NOT app_private.is_actor_offboarded_v1()
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true;
$function$;

create or replace function public.get_my_permissions()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'auth', 'app_private'
as $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_perms          jsonb;
  v_is_shareholder boolean;
  v_is_manager     boolean;
  -- Cổ đông / quản lý lợi nhuận: CHỈ trang Phân bổ & chia lợi nhuận.
  v_sh_perms       jsonb := jsonb_build_object(
    'shareholder_profit', jsonb_build_object('view', true)
  );
BEGIN
  IF v_caller IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  -- t5_27: thành viên bị đình chỉ/thu hồi ⇒ không quyền nào (fail closed).
  IF app_private.is_actor_offboarded_v1() THEN
    RETURN '{}'::jsonb;
  END IF;
  -- Super admin bypass
  IF EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = v_caller) THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;
  -- Staff: lấy permissions từ assignment đầu tiên (full-scope ưu tiên)
  SELECT COALESCE(sa.permissions, r.permissions)
    INTO v_perms
  FROM public.staff_assignments sa
  JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;
  v_is_shareholder := EXISTS (
    SELECT 1 FROM public.shareholders
    WHERE auth_user_id = v_caller AND deleted_at IS NULL
  );
  v_is_manager := EXISTS (
    SELECT 1 FROM public.profit_managers
    WHERE auth_user_id = v_caller AND deleted_at IS NULL
  );
  IF v_is_shareholder OR v_is_manager THEN
    IF v_perms IS NULL THEN
      RETURN v_sh_perms;          -- cổ đông THUẦN: đúng 1 quyền
    END IF;
    RETURN v_sh_perms || v_perms; -- kiêm nhân viên: quyền staff + cửa trang LN
  END IF;
  -- Owner thật: CHỈ khi có bằng chứng legacy owner (allowlist tạm Sprint 0).
  -- Orphan (không staff/cổ đông/quản lý/owner) ⇒ FAIL CLOSED, KHÔNG sentinel.
  IF v_perms IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.legacy_owner_allowlist WHERE user_id = v_caller) THEN
      RETURN '{"__superadmin": true}'::jsonb;
    END IF;
    RETURN '{}'::jsonb;
  END IF;
  RETURN v_perms;
END
$function$;

-- ========== (c) Off-boarding RPC + vá delete_staff_member ==========
-- Đình chỉ / thu hồi / phục hồi tư cách thành viên. Chỉ Chủ sở hữu tổ chức
-- hoặc super admin. REVOKE còn xoá assignment legacy (trigger a80 đóng binding).
create or replace function public.set_membership_status_v1(
  p_user_id uuid, p_status text, p_reason text default null)
returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_memb uuid; v_owner_cnt int; v_sa_deleted int := 0;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_status not in ('ACTIVE','SUSPENDED','REVOKED') then
    raise exception 'Trạng thái không hợp lệ (ACTIVE/SUSPENDED/REVOKED)' using errcode='22023';
  end if;
  if p_user_id = v_actor then
    raise exception 'Không thể tự đổi trạng thái của chính mình' using errcode='42501';
  end if;

  -- org: nơi người thao tác giữ role Chủ sở hữu tổ chức và đối tượng là thành viên
  select m.organization_id, m.id into v_org, v_memb
    from public.organization_memberships m
   where m.user_id = p_user_id
     and (
       public.is_super_admin()
       or exists (
         select 1 from public.role_bindings rb
           join public.organization_memberships om
             on om.id = rb.membership_id and om.organization_id = rb.organization_id
            and om.user_id = v_actor and om.status = 'ACTIVE'
           join public.organization_roles r
             on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
          where rb.organization_id = m.organization_id
            and (rb.valid_to is null or rb.valid_to > now())
       )
     )
   order by (m.status = 'ACTIVE') desc
   limit 1;
  if v_memb is null then
    raise exception 'Không có quyền đổi trạng thái thành viên này' using errcode='42501';
  end if;

  -- không hạ cấp người chủ sở hữu cuối cùng
  if p_status <> 'ACTIVE' then
    select count(*) into v_owner_cnt
      from public.role_bindings rb
      join public.organization_memberships om
        on om.id = rb.membership_id and om.organization_id = rb.organization_id
       and om.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     where rb.organization_id = v_org
       and (rb.valid_to is null or rb.valid_to > now())
       and om.user_id <> p_user_id;
    if v_owner_cnt = 0 and exists (
      select 1 from public.role_bindings rb
        join public.organization_memberships om
          on om.id = rb.membership_id and om.organization_id = rb.organization_id
         and om.user_id = p_user_id
        join public.organization_roles r
          on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
       where rb.organization_id = v_org and (rb.valid_to is null or rb.valid_to > now())
    ) then
      raise exception 'Không thể đình chỉ/thu hồi CHỦ SỞ HỮU CUỐI CÙNG của tổ chức' using errcode='42501';
    end if;
  end if;

  update public.organization_memberships
     set status = p_status,
         revoked_at = case when p_status = 'REVOKED' then now() else null end,
         activated_at = case when p_status = 'ACTIVE' then coalesce(activated_at, now()) else activated_at end,
         version = version + 1
   where id = v_memb;

  -- THU HỒI: gỡ luôn assignment legacy (trigger a80 đóng role_binding).
  if p_status = 'REVOKED' then
    delete from public.staff_assignments
     where staff_id = p_user_id and organization_id = v_org;
    get diagnostics v_sa_deleted = row_count;
  end if;

  update public.organizations
     set authorization_version = authorization_version + 1
   where id = v_org;

  return json_build_object('user_id', p_user_id, 'organization_id', v_org,
                           'status', p_status, 'assignments_removed', v_sa_deleted,
                           'reason', nullif(btrim(coalesce(p_reason,'')),''));
end;
$fn$;

-- delete_staff_member: KHÔNG xoá auth.users nữa (FK RESTRICT làm gãy 23503 +
-- xoá danh tính là mất lịch sử). Chuyển thành OFF-BOARDING: thu hồi tư cách
-- thành viên + gỡ assignment (trigger đóng binding) + gỡ vai trò legacy.
create or replace function public.delete_staff_member(p_staff_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'auth', 'app_private'
as $fn$
declare
  v_sa int := 0; v_memb int := 0;
begin
  if auth.uid() is null then
    raise exception 'Bạn chưa đăng nhập' using errcode = '42501';
  end if;
  if p_staff_id = auth.uid() then
    raise exception 'Không thể tự xoá tài khoản của chính bạn' using errcode = '42501';
  end if;
  if not public.is_super_admin() and not exists (
    select 1 from public.staff_assignments
     where staff_id = p_staff_id and user_id = auth.uid()
  ) then
    raise exception 'Bạn không có quyền xoá nhân viên này' using errcode = '42501';
  end if;

  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)
  delete from public.staff_assignments where staff_id = p_staff_id;
  get diagnostics v_sa = row_count;

  -- 2) thu hồi tư cách thành viên (giữ danh tính + lịch sử tiền)
  update public.organization_memberships
     set status = 'REVOKED', revoked_at = now(), version = version + 1
   where user_id = p_staff_id and status <> 'REVOKED';
  get diagnostics v_memb = row_count;

  -- 3) gỡ vai trò legacy
  delete from public.roles where user_id = p_staff_id;

  -- 4) bump cache quyền của mọi tổ chức liên quan
  update public.organizations o
     set authorization_version = o.authorization_version + 1
   where exists (select 1 from public.organization_memberships m
                  where m.organization_id = o.id and m.user_id = p_staff_id);

  if v_sa = 0 and v_memb = 0 then
    raise exception 'Không tìm thấy nhân viên để gỡ (hoặc đã được gỡ trước đó)'
      using errcode = 'P0002';
  end if;
end;
$fn$;

revoke execute on function public.set_membership_status_v1(uuid, text, text) from public, anon;
revoke execute on function app_private.is_actor_offboarded_v1() from public, anon;
revoke execute on function app_private.sync_revoke_role_binding_v1() from public, anon;
grant execute on function public.set_membership_status_v1(uuid, text, text) to authenticated;

commit;
