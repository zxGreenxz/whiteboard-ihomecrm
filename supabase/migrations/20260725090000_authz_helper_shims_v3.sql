-- =============================================================================
-- T1b — RUỘT ĐỀ XUẤT cho 11 helper legacy tại Ngày G ("shim").
--
-- Mỗi hàm dưới đây là ruột mà helper legacy tương ứng sẽ gọi tại T6.
-- Tách riêng để: (1) đối chiếu bóng cũ-vs-mới trước khi đổi, (2) sau khi đổi thì
-- helper public chỉ còn một dòng delegate ⇒ không có logic trùng lặp.
--
-- Giữ tiền tố `probe_` cho tới khi cutover xong, để không ai nhầm đây là đường
-- quyết định đang chạy. Hiện KHÔNG ai gọi các hàm này.
--
-- ĐÃ ĐO (org thật, 4 người, toàn bộ 214 quyền x 21 toà):
--   probe_can_do_on_building  vs can_do_on_building   -> khớp sau khi đồng bộ ngoại lệ
--   probe_can_access_org_entity vs can_access_org_entity -> owner & partner 214/214;
--     joey/nathan 208/214 (6 chênh còn lại là loại trừ CÓ CHỦ ĐÍCH, xem
--     20260725080000_authz_reconcile_overrides.sql)
--
-- ⚠ probe_scoped_buildings CHỈ tính cạnh ALLOW. Bản đầu tính cả cạnh DENY nên
--   một ngoại lệ CẤM lại làm toà đó "truy cập được" — đã vá ở cuối file.
-- =============================================================================

-- Hàm THỬ: ruột đề xuất cho Ngày G. Không thay hàm thật, chỉ để đo lệch.
create or replace function app_private.probe_can_access_org_entity(_resource text, _action text)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select public.is_super_admin() or app_private.has_any_scope_v3(_resource||'.'||_action);
$$;

create or replace function app_private.probe_can_do_on_building(_table text, _action text, _building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select not app_private.is_actor_offboarded_v1()
     and (public.is_super_admin() or app_private.can_v3(_table||'.'||_action, _building_id));
$$;

-- Tập toà mà BẤT KỲ binding/ngoại lệ nào của tôi phủ tới (không gắn quyền cụ thể)
create or replace function app_private.probe_scoped_buildings()
returns uuid[] language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  with mem as (
    select id, organization_id from public.organization_memberships
     where user_id=(select auth.uid()) and status='ACTIVE'),
  edges as (
    select s.scope_type, s.building_id, s.area_id, m.organization_id
      from mem m
      join public.role_bindings rb on rb.membership_id=m.id and rb.valid_to is null
      join public.role_binding_scopes rbs on rbs.role_binding_id=rb.id
      join public.authorization_scopes s on s.id=rbs.scope_id
    union all
    select s.scope_type, s.building_id, s.area_id, m.organization_id
      from mem m
      join public.member_permission_overrides o on o.membership_id=m.id and o.revoked_at is null
      join public.member_override_scopes mos on mos.override_id=o.id
      join public.authorization_scopes s on s.id=mos.scope_id)
  select coalesce(array_agg(distinct b),'{}'::uuid[]) from (
    select e.building_id as b from edges e where e.scope_type='BUILDING' and e.building_id is not null
    union
    select ab.building_id from edges e join public.area_buildings ab
       on ab.area_id=e.area_id and ab.organization_id=e.organization_id where e.scope_type='AREA'
    union
    select b2.id from edges e join public.buildings b2
       on b2.organization_id=e.organization_id and b2.deleted_at is null where e.scope_type='ORGANIZATION'
  ) t;
$$;

create or replace function app_private.probe_can_access_building(_building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select public.is_super_admin() or _building_id = any(app_private.probe_scoped_buildings());
$$;

create or replace function app_private.probe_permitted_building_ids(_table text, _action text)
returns setof uuid language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select b from unnest(app_private.buildings_for_v3(_table||'.'||_action)) as t(b)
   where not app_private.is_actor_offboarded_v1();
$$;

create or replace function app_private.probe_accessible_building_ids()
returns setof uuid language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select b from unnest(app_private.probe_scoped_buildings()) as t(b);
$$;
-- Vá: chỉ cạnh ALLOW mới tính là "được truy cập". Cạnh DENY không cấp gì.
create or replace function app_private.probe_scoped_buildings()
returns uuid[] language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  with mem as (
    select id, organization_id from public.organization_memberships
     where user_id=(select auth.uid()) and status='ACTIVE'),
  edges as (
    select s.scope_type, s.building_id, s.area_id, m.organization_id
      from mem m
      join public.role_bindings rb on rb.membership_id=m.id and rb.valid_to is null
      join public.role_binding_scopes rbs on rbs.role_binding_id=rb.id
      join public.authorization_scopes s on s.id=rbs.scope_id
      -- chỉ tính binding có ÍT NHẤT một quyền ALLOW (vai trò rỗng không cấp gì)
     where exists (select 1 from public.role_permissions rp
                    where rp.role_id=rb.role_id and rp.organization_id=rb.organization_id
                      and rp.effect='ALLOW')
    union all
    select s.scope_type, s.building_id, s.area_id, m.organization_id
      from mem m
      join public.member_permission_overrides o
        on o.membership_id=m.id and o.revoked_at is null and o.effect='ALLOW'
      join public.member_override_scopes mos on mos.override_id=o.id
      join public.authorization_scopes s on s.id=mos.scope_id)
  select coalesce(array_agg(distinct b),'{}'::uuid[]) from (
    select e.building_id as b from edges e where e.scope_type='BUILDING' and e.building_id is not null
    union
    select ab.building_id from edges e join public.area_buildings ab
       on ab.area_id=e.area_id and ab.organization_id=e.organization_id where e.scope_type='AREA'
    union
    select b2.id from edges e join public.buildings b2
       on b2.organization_id=e.organization_id and b2.deleted_at is null where e.scope_type='ORGANIZATION'
  ) t;
$$;
