-- =============================================================================
-- Vá gốc: sửa/đổi phân công legacy phải ĐỒNG BỘ role_binding canonical
--         (revoke + RE-GRANT), thay vì revoke-only.
--
-- BỐI CẢNH (sự cố prod 2026-07-20 → phát hiện 2026-07-22)
--   t5_27 cài trigger a81_sa_role_change_sync (AFTER UPDATE OF
--   role_id/building_id/area_id/permissions) gọi sync_revoke_role_binding_v1()
--   -> ĐÓNG mọi role_binding của assignment (valid_to=now()) NHƯNG KHÔNG cấp lại.
--   Mô hình mới không có luồng cấp (chỉ materialize 1 lần ở Sprint 2c) nên mỗi
--   lần UI sửa phân quyền staff = staff mất SẠCH quyền ghi phía server, trong khi
--   FE (đọc legacy staff_assignments) vẫn thấy có quyền -> nút "Lưu" bật nhưng
--   server ném 42501 "Không đủ quyền". Ngày 20/07 một batch UPDATE staff_assignments
--   của cả 2 STAFF (nathan, joey) đã khoá họ suốt 2 ngày.
--
-- QUYẾT ĐỊNH
--   • Đường UPDATE (a81): revoke binding cũ + RE-GRANT binding mới soi CHÍNH XÁC
--     trạng thái assignment hiện tại (role + scope). Canonical == legacy sau mỗi
--     lần sửa. Chỉ cấp trong phạm vi role cho phép (role_permissions) -> KHÔNG
--     "thừa quyền" ngoài role. Thiếu membership/role active -> KHÔNG cấp (fail-closed).
--   • Đường DELETE (a80): GIỮ NGUYÊN revoke-only (xoá phân công = thu hồi, đúng cho
--     off-boarding; không có state để cấp lại).
--   • KHÔNG đụng member_permission_overrides (lớp diff per-staff). Không trigger nào
--     từng đồng bộ lớp này; giữ nguyên để tránh malformed override (authz RAISE).
--     Đồng bộ override thuộc luồng quản lý mô hình mới sau này.
--
-- Idempotent (CREATE OR REPLACE + DROP/CREATE TRIGGER).
-- =============================================================================

begin;

-- Trigger fn cho ĐƯỜNG UPDATE: revoke + re-grant.
create or replace function app_private.sync_regrant_role_binding_v1()
returns trigger
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_org         uuid;   -- org suy từ binding bị đóng (fallback để bump version)
  v_org_grant   uuid;   -- org khớp (membership ACTIVE + org_role) để cấp lại
  v_membership  uuid;
  v_binding     uuid;
  v_scope       uuid;
begin
  -- 1) REVOKE: đóng mọi binding đang mở gắn với assignment vừa đổi.
  update public.role_bindings rb
     set valid_to = now(), version = rb.version + 1
   where rb.legacy_assignment_id = new.id
     and rb.valid_to is null
  returning rb.organization_id into v_org;

  -- 2) RE-GRANT: dựng binding mới soi trạng thái assignment HIỆN TẠI.
  --    Chỉ cấp khi có membership ACTIVE + org_role tương ứng trong CÙNG org
  --    (giống ánh xạ Sprint 2c). Không có -> bỏ qua (fail-closed: thiếu quyền
  --    là an toàn).
  select m.organization_id, m.id
    into v_org_grant, v_membership
    from public.organization_memberships m
    join public.organization_roles orl
      on orl.organization_id = m.organization_id
     and orl.id = new.role_id
     and coalesce(orl.status, 'ACTIVE') = 'ACTIVE'
   where m.user_id = new.staff_id
     and m.status = 'ACTIVE'
   limit 1;

  if v_membership is not null then
    v_org := v_org_grant;

    v_binding := gen_random_uuid();
    insert into public.role_bindings
      (id, organization_id, membership_id, role_id, legacy_assignment_id,
       valid_from, valid_to, version)
    values
      (v_binding, v_org, v_membership, new.role_id, new.id, now(), null, 1);

    -- Bảo đảm + nối canonical scope theo building / area / full (Sprint 2c bước 5).
    -- Guard theo org để tránh FK lỗi làm gãy thao tác sửa staff của admin;
    -- scope không dựng được -> binding không scope -> deny (fail-closed, không RAISE).
    if new.building_id is not null then
      if exists (select 1 from public.buildings b
                  where b.id = new.building_id and b.organization_id = v_org) then
        insert into public.authorization_scopes (organization_id, scope_type, building_id)
        values (v_org, 'BUILDING', new.building_id)
        on conflict do nothing;
        select s.id into v_scope from public.authorization_scopes s
         where s.organization_id = v_org and s.scope_type = 'BUILDING'
           and s.building_id = new.building_id;
      end if;
    elsif new.area_id is not null then
      if exists (select 1 from public.areas a
                  where a.id = new.area_id and a.organization_id = v_org) then
        insert into public.authorization_scopes (organization_id, scope_type, area_id)
        values (v_org, 'AREA', new.area_id)
        on conflict do nothing;
        select s.id into v_scope from public.authorization_scopes s
         where s.organization_id = v_org and s.scope_type = 'AREA'
           and s.area_id = new.area_id;
      end if;
    else
      insert into public.authorization_scopes (organization_id, scope_type)
      values (v_org, 'ORGANIZATION')
      on conflict do nothing;
      select s.id into v_scope from public.authorization_scopes s
       where s.organization_id = v_org and s.scope_type = 'ORGANIZATION';
    end if;

    if v_scope is not null then
      insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
      values (v_org, v_binding, v_scope)
      on conflict do nothing;
    end if;
  end if;

  -- 3) Bump cache quyền của org (kể cả khi chỉ revoke được, để không lỡ nhịp).
  if v_org is not null then
    update public.organizations
       set authorization_version = authorization_version + 1
     where id = v_org;
  end if;

  return null;
end;
$fn$;

comment on function app_private.sync_regrant_role_binding_v1() is
  '20260722140000: sửa/đổi assignment legacy => đóng binding cũ + CẤP LẠI binding chuẩn hoá soi trạng thái hiện tại (role+scope). Thay revoke-only (t5_27) trên đường UPDATE. DELETE vẫn revoke-only qua sync_revoke_role_binding_v1.';

revoke execute on function app_private.sync_regrant_role_binding_v1() from public, anon;

-- Trỏ trigger UPDATE sang hàm revoke+regrant. Giữ nguyên điều kiện cột & WHEN.
drop trigger if exists a81_sa_role_change_sync on public.staff_assignments;
create trigger a81_sa_role_change_sync
  after update of role_id, building_id, area_id, permissions on public.staff_assignments
  for each row
  when (old.role_id is distinct from new.role_id
        or old.building_id is distinct from new.building_id
        or old.area_id is distinct from new.area_id
        or old.permissions is distinct from new.permissions)
  execute function app_private.sync_regrant_role_binding_v1();

-- a80 (AFTER DELETE) giữ nguyên sync_revoke_role_binding_v1 — xoá phân công =
-- thu hồi, đúng cho off-boarding. Không đổi ở migration này.

commit;
