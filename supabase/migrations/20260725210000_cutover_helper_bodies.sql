-- =============================================================================
-- NGÀY G (phần 2/3) — đổi RUỘT các helper, giữ nguyên chữ ký
--
-- Sau phần 1/3, 74 policy đã gọi thẳng app_private.buildings_for_v3 nên không còn
-- dùng can_do_on_building. Phần này xử lý phần CÒN LẠI: các helper vẫn đọc
-- staff_assignments + roles JSONB, gồm 192 policy qua can_access_org_entity.
--
-- Chữ ký GIỮ NGUYÊN ⇒ policy và 71 hàm gọi chúng không phải sửa gì.
--
-- === QUY TẮC ÁNH XẠ (mỗi dòng là một quyết định ngữ nghĩa) ===
--   can_access_org_entity(res,act)  -> has_any_scope_v3('res.act')
--        "có quyền này ở BẤT KỲ đâu" — KHÔNG map sang can_v3 vì can_v3 chặn cứng
--        khi thiếu required_dimensions, sẽ deny nhầm income_expenses.create/edit.
--   can_access_building(b)          -> can_v3('buildings.view', b)
--   can_do_on_building(res,act,b)   -> can_v3('res.act', b)
--   permitted_building_ids(res,act) -> unnest(buildings_for_v3('res.act'))
--   accessible_building_ids()       -> unnest(buildings_for_v3('buildings.view'))
--   current_visible_owner_ids()     -> user_id của MỌI thành viên trong tổ chức tôi
--        Hàm này trả danh sách NGƯỜI (policy lọc `user_id IN (...)`), nên không
--        map sang can_v3 (boolean) hay buildings_for_v3 (mảng toà) được.
--        Đã đo: đồ thị nhân viên cũ == thành viên tổ chức, khớp 10/10 và 4/4.
--   staff_can(tbl,act,owner)        -> owner thuộc tổ chức tôi VÀ có quyền tbl.act
--   can_view/create_restricted_ie() -> has_any_scope_v3('income_expenses.restricted_*')
--   ie_all_buildings_scope(b)       -> can_v3('income_expenses.all_buildings', b)
--   can_ie_all_buildings(res,b)     -> như trên, kèm quyền res tương ứng
--
-- === CỐ Ý KHÔNG ĐỔI ===
--   same_team(uuid): đọc bảng public.team_members, KHÔNG đọc staff_assignments.
--     Nó trả lời "hai người có cùng đội không", không liên quan phân quyền.
--     Đổi nó sang kiểm quyền là sai ngữ nghĩa hoàn toàn. 3 policy + 3 RPC tiền
--     dùng nó — thuộc hạng mục di trú NHÓM/ĐỘI riêng, không thuộc cutover này.
--   has_full_building_scope(): thân đã chỉ là `SELECT is_super_admin()`,
--     không đọc staff_assignments. Không cần đụng.
--
-- === GIỮ NGUYÊN BYPASS QUẢN TRỊ NỀN TẢNG ===
--   Mọi helper cũ đều có nhánh is_super_admin() (và vài cái có is_admin(), sau
--   hardening 20260710150000 thì is_admin() là bí danh của is_super_admin()).
--   Ruột mới GIỮ NGUYÊN các nhánh đó — cutover đổi cơ chế, không đổi quyền.
--
--   Ngoại lệ ghi rõ: can_access_building cũ loại trừ toà demo khỏi đặc quyền
--   cấp-owner, nhưng nhánh is_super_admin() đứng TRƯỚC nên vẫn cho qua tất cả.
--   Với người KHÔNG phải super admin, toà demo vốn không thuộc tổ chức họ nên
--   can_v3 trả false — cùng kết quả, không cần chép lại luật loại trừ đó.
-- =============================================================================

begin;

-- Chụp lại định nghĩa hiện tại (nhãn riêng cho lần cutover này) để quay lui.
insert into app_private.authz_helper_backup (captured_label, function_sig, definition)
select 'pre-cutover-bodies', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
   and p.proname in ('can_access_org_entity','can_do_on_building','can_access_building',
                     'permitted_building_ids','accessible_building_ids','current_visible_owner_ids',
                     'staff_can','can_view_restricted_ie','can_create_restricted_ie',
                     'ie_all_buildings_scope','can_ie_all_buildings')
   and not exists (select 1 from app_private.authz_helper_backup b
                    where b.captured_label = 'pre-cutover-bodies'
                      and b.function_sig = p.oid::regprocedure::text);

do $$
declare v_n integer;
begin
  select count(*) into v_n from app_private.authz_helper_backup
   where captured_label = 'pre-cutover-bodies';
  if v_n < 11 then
    raise exception 'Bản chụp helper chỉ có % hàm, kỳ vọng >= 11 — dừng', v_n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 192 policy — hàm gánh nhiều nhất toàn hệ
-- ---------------------------------------------------------------------------
create or replace function public.can_access_org_entity(_resource text, _action text)
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select public.is_super_admin()
      or app_private.has_any_scope_v3(_resource || '.' || _action);
$fn$;

-- ---------------------------------------------------------------------------
-- 41 policy — trả danh sách NGƯỜI, không phải quyền
-- ---------------------------------------------------------------------------
create or replace function public.current_visible_owner_ids()
returns uuid[] language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
    from public.organization_memberships m
   where m.status = 'ACTIVE'
     and m.organization_id = any (public.my_org_ids());
$fn$;

-- ---------------------------------------------------------------------------
-- 30 policy
-- ---------------------------------------------------------------------------
create or replace function public.can_access_building(_building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select public.is_super_admin()
      or app_private.can_v3('buildings.view', _building_id);
$fn$;

-- ---------------------------------------------------------------------------
-- Không còn policy nào gọi (phần 1/3 đã thay), nhưng 71 HÀM vẫn gọi —
-- gồm approve_voucher, thanh lý hợp đồng, thu tiền hoá đơn và nhóm báo cáo.
-- ---------------------------------------------------------------------------
create or replace function public.can_do_on_building(_table text, _action text, _building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select not app_private.is_actor_offboarded_v1()
     and (public.is_super_admin()
          or app_private.can_v3(_table || '.' || _action, _building_id));
$fn$;

-- ---------------------------------------------------------------------------
-- 6 + 5 policy — trả tập toà
-- ---------------------------------------------------------------------------
create or replace function public.permitted_building_ids(_table text, _action text)
returns setof uuid language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select b from unnest(app_private.buildings_for_v3(_table || '.' || _action)) as t(b)
   where not app_private.is_actor_offboarded_v1();
$fn$;

create or replace function public.accessible_building_ids()
returns setof uuid language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select b from unnest(app_private.buildings_for_v3('buildings.view')) as t(b);
$fn$;

-- ---------------------------------------------------------------------------
-- 9 policy — "dòng này thuộc người trong tổ chức tôi VÀ tôi có quyền đó"
-- ---------------------------------------------------------------------------
create or replace function public.staff_can(_table text, _action text, _owner uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select public.is_super_admin()
      or (_owner = any (public.current_visible_owner_ids())
          and app_private.has_any_scope_v3(_table || '.' || _action));
$fn$;

-- ---------------------------------------------------------------------------
-- 4 + 2 policy — hạng mục thu chi hạn chế
-- ---------------------------------------------------------------------------
create or replace function public.can_view_restricted_ie()
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select public.is_super_admin()
      or app_private.has_any_scope_v3('income_expenses.restricted_view');
$fn$;

create or replace function public.can_create_restricted_ie()
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select public.is_super_admin()
      or app_private.has_any_scope_v3('income_expenses.restricted_create');
$fn$;

-- ---------------------------------------------------------------------------
-- 2 policy — cờ "thấy thu chi mọi toà"
-- ---------------------------------------------------------------------------
create or replace function public.ie_all_buildings_scope(_building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select app_private.can_v3('income_expenses.all_buildings', _building_id);
$fn$;

create or replace function public.can_ie_all_buildings(_action text, _building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select app_private.can_v3('income_expenses.all_buildings', _building_id)
     and app_private.can_v3('income_expenses.' || _action, _building_id);
$fn$;

commit;
