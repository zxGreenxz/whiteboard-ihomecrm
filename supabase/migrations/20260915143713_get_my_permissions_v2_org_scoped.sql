-- =============================================================================
-- I2 / D1 · D2 — quyền của giao diện phải BIẾT công ty và TOÀ NHÀ
--
-- LỖ ĐANG VÁ (đo trên 20260725220000:44-56,164-176)
--   `get_my_permissions()` không nhận tham số công ty. Nó gộp MỌI membership
--   của người gọi rồi trả `{resource: {action: true}}`. Hai hệ quả, cả hai đã
--   thấy trên sản phẩm:
--
--   D1. Vứt `scope_type` / `building_ids`. Nhân viên được duyệt phiếu ở ĐÚNG
--       MỘT toà nhận `income_expenses.approve = true` trống trơn, nên nút
--       "Duyệt" / "Thu" / "Chi" hiện ở MỌI toà. Bấm vào thì RPC mới từ chối —
--       `app_private.authorize_tenant_action_v3` vẫn đúng. Giao diện hứa một
--       thứ mà máy chủ không bao giờ cho: người dùng học được rằng nút của
--       phần mềm này hay hỏng.
--
--   D2. Gộp mọi công ty. Chủ có membership ở cả THẬT lẫn DEMO nhận HỢP của
--       hai tập quyền, nên quyền chỉ có ở DEMO lại mở nút trên sổ THẬT.
--
-- CÁCH VÁ
--   Thêm `get_my_permissions_v2(p_org uuid)` trả hình dạng GIÀU HƠN:
--     { resource: { action: { org_wide, building_ids, cashbook_ids } } }
--   và CHỈ cho đúng một công ty. Giao diện gọi kèm công ty đang chọn.
--
--   `get_my_permissions()` (v1) GIỮ NGUYÊN, không đụng một dòng — bản khách
--   đang mở sẵn trong trình duyệt người dùng lúc deploy vẫn gọi nó, và
--   `ai_copilot_perms_for` là đường khác. Thu hồi v1 là việc của đợt sau, sau
--   khi đo không còn ai gọi.
--
-- VÌ SAO KHÔNG GỌI `authorized_scope_v3` MỘT LẦN MỖI KHOÁ
--   Chính xác lý do ghi ở đầu 20260725220000: đo được 174 ms khi hỏi từng khoá
--   một so với 5,6 ms bản gộp — chậm 31 lần, cho một hàm giao diện gọi mỗi
--   phiên. Nên bản này là bản GỘP: cùng ngữ nghĩa, một lượt join.
--
--   `all_scoped_keys_v3` dưới đây là bản gộp của `authorized_scope_v3`
--   (20260908162757) — sao y từng mệnh đề, kể cả luật DENY-có-phạm-vi thắng
--   `org_wide` (bản vá 08/09) và luật CHỈ-ĐANG-GIỮ-SỔ cho quyền
--   `requires_cashbook_possession`. Hai hàm phải đọc song song khi sửa; khác
--   nhau một mệnh đề là giao diện lại hứa sai lần nữa.
--
-- VÌ SAO TRẢ CẢ `cashbook_ids` DÙ PLAN CHỈ NÓI {org_wide, building_ids}
--   `cashbooks.post` và `cashbooks.manage_custody` khai
--   `requires_cashbook_possession = true` + `required_dimensions = {CASHBOOK}`.
--   Với chúng `authorized_scope_v3` trả org_wide = false VÀ building_ids rỗng —
--   đúng theo mô hình. Bỏ `cashbook_ids` đi thì hai khoá đó biến mất khỏi bản
--   đồ quyền và giao diện giữ sổ tắt sạch nút cho chính người đang giữ sổ. Cột
--   thứ ba là thứ giữ cho bản v2 KHÔNG mất quyền so với v1.
-- =============================================================================

begin;

set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- Bản GỘP của authorized_scope_v3: mọi khoá người gọi có cạnh, kèm phạm vi
-- hiệu lực đã rút gọn, trong MỘT truy vấn.
-- ---------------------------------------------------------------------------
create or replace function app_private.all_scoped_keys_v3(p_org uuid)
returns table (permission_key text, org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
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

-- Cấm khẩn cấp: dòng có permission_key null là cấm TOÀN BỘ công ty.
emergency as (
  select d.permission_key
    from app_private.tenant_emergency_denies d
   cross join at
   where d.organization_id = p_org
     and d.active_from <= at.ts
     and (d.expires_at is null or d.expires_at > at.ts)
),
emergency_blanket as (
  select exists (select 1 from emergency where permission_key is null) as v
),

member_edges as (
  select o.permission_key, o.effect, s.scope_type, s.building_id, s.cashbook_id, s.area_id
    from membership m
    join public.member_permission_overrides o
      on o.organization_id = m.organization_id
     and o.membership_id   = m.id
    join public.member_override_scopes mos
      on mos.organization_id = p_org and mos.override_id = o.id
    join public.authorization_scopes s
      on s.organization_id = p_org and s.id = mos.scope_id
   cross join at
   where o.revoked_at is null
     and (o.expires_at is null or o.expires_at > at.ts)
),

role_edges as (
  select rp.permission_key, rp.effect, s.scope_type, s.building_id, s.cashbook_id, s.area_id
    from membership m
    join public.role_bindings rb
      on rb.organization_id = m.organization_id and rb.membership_id = m.id
    join public.organization_roles r
      on r.organization_id = rb.organization_id and r.id = rb.role_id
     and coalesce(r.status, 'ACTIVE') = 'ACTIVE'
    join public.role_permissions rp
      on rp.organization_id = rb.organization_id
     and rp.role_id         = rb.role_id
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

-- Chỉ xét khoá NGƯỜI GỌI CÓ CẠNH. Khoá không cạnh là DEFAULT_DENY, đưa vào chỉ
-- tốn công rồi lọc ra ở cuối.
perm as (
  select pd.*
    from public.permission_definitions pd
   where pd.permission_domain = 'TENANT'
     and pd.is_active
     and exists (select 1 from org_ok)
     and pd.key in (select e.permission_key from edges e)
),

edge_buildings as (
  select e.permission_key, e.effect, b.building_id
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
  select distinct e.permission_key
    from edges e
   where e.effect = 'DENY' and e.scope_type = 'ORGANIZATION'
),
deny_b as (
  select eb.permission_key, array_agg(distinct eb.building_id) as v
    from edge_buildings eb
   where eb.effect = 'DENY'
   group by eb.permission_key
),
deny_c as (
  select e.permission_key, array_agg(distinct e.cashbook_id) as v
    from edges e
   where e.effect = 'DENY' and e.scope_type = 'CASHBOOK' and e.cashbook_id is not null
   group by e.permission_key
),

allow_org as (
  select distinct e.permission_key
    from edges e
    join perm pd on pd.key = e.permission_key
   where e.effect = 'ALLOW'
     and e.scope_type = 'ORGANIZATION'
     and e.scope_type = any (pd.scope_kinds)
     and not pd.requires_cashbook_possession
),
allow_b as (
  select eb.permission_key, array_agg(distinct eb.building_id) as v
    from edge_buildings eb
    join perm pd on pd.key = eb.permission_key
   where eb.effect = 'ALLOW'
     and not pd.requires_cashbook_possession
     and ('BUILDING' = any (pd.scope_kinds) or 'AREA' = any (pd.scope_kinds))
   group by eb.permission_key
),
allow_c as (
  select e.permission_key, array_agg(distinct e.cashbook_id) as v
    from edges e
    join perm pd on pd.key = e.permission_key
   where e.effect = 'ALLOW'
     and e.scope_type = 'CASHBOOK'
     and e.cashbook_id is not null
     and 'CASHBOOK' = any (pd.scope_kinds)
   group by e.permission_key
),

-- Sổ ĐANG GIỮ — theo TỪNG khoá, vì `accepted_possession_kinds` khác nhau giữa
-- các khoá (CUSTODIAN / OPERATOR / KNOWER).
possessed as (
  select pd.key as permission_key, array_agg(distinct cp.cashbook_id) as v
    from public.cashbook_possession_bindings cp
    join membership m
      on m.organization_id = cp.organization_id and m.id = cp.membership_id
    join perm pd
      on cp.possession_kind = any (pd.accepted_possession_kinds)
   cross join at
   where cp.organization_id = p_org
     and cp.valid_from <= at.ts
     and (cp.valid_to is null or cp.valid_to > at.ts)
   group by pd.key
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

resolved as (
  select
    pd.key,
    exists (select 1 from membership)
      and not (select v from emergency_blanket)
      and not exists (select 1 from emergency em where em.permission_key = pd.key) as pass,
    coalesce('BUILDING' = any (pd.required_dimensions), false) as needs_building,
    coalesce('CASHBOOK' = any (pd.required_dimensions), false) as needs_cashbook,
    coalesce(pd.requires_cashbook_possession, false)           as needs_possession,
    exists (select 1 from deny_org d  where d.permission_key = pd.key) as d_org,
    coalesce((select x.v from deny_b    x where x.permission_key = pd.key), '{}'::uuid[]) as d_b,
    coalesce((select x.v from deny_c    x where x.permission_key = pd.key), '{}'::uuid[]) as d_c,
    exists (select 1 from allow_org a where a.permission_key = pd.key) as a_org,
    coalesce((select x.v from allow_b   x where x.permission_key = pd.key), '{}'::uuid[]) as a_b,
    coalesce((select x.v from allow_c   x where x.permission_key = pd.key), '{}'::uuid[]) as a_c,
    coalesce((select x.v from possessed x where x.permission_key = pd.key), '{}'::uuid[]) as poss,
    (select v from all_buildings) as all_b,
    (select v from all_cashbooks) as all_c
  from perm pd
)

select
  r.key,
  case
    when not r.pass then false
    when r.needs_building or r.needs_cashbook then false
    when r.d_org then false
    when coalesce(cardinality(r.d_b), 0) > 0 then false
    when coalesce(cardinality(r.d_c), 0) > 0 then false
    else r.a_org
  end as org_wide,
  coalesce((
    select array_agg(distinct t.b)
      from unnest(case when r.a_org then r.all_b else r.a_b end) as t(b)
     where r.pass and not r.d_org and not r.needs_possession and not r.needs_cashbook
       and not (t.b = any (r.d_b))
  ), '{}'::uuid[]) as building_ids,
  coalesce((
    select array_agg(distinct t.c)
      from unnest(
        case
          when r.needs_possession then array(select x from unnest(r.a_c) as u(x) where x = any (r.poss))
          when r.a_org            then r.all_c
          else r.a_c
        end
      ) as t(c)
     where r.pass and not r.d_org and not r.needs_building
       and not (t.c = any (r.d_c))
  ), '{}'::uuid[]) as cashbook_ids
from resolved r;
$fn$;

comment on function app_private.all_scoped_keys_v3(uuid) is
  'Ban GOP cua authorized_scope_v3 cho MOI khoa nguoi goi co canh trong mot cong ty. Cung ngu nghia (DENY co pham vi thang org_wide; quyen requires_cashbook_possession chi tinh so dang giu), mot luot join — vi hoi tung khoa mot do duoc 174 ms so voi 5,6 ms.';

revoke all on function app_private.all_scoped_keys_v3(uuid) from public, anon, authenticated;
grant execute on function app_private.all_scoped_keys_v3(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Hàm quyền của giao diện, bản CÓ CÔNG TY và CÓ PHẠM VI.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_permissions_v2(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_out   jsonb;
begin
  if v_actor is null then
    return '{}'::jsonb;                       -- fail closed
  end if;

  -- Quản trị nền tảng: giữ sentinel như v1. Giao diện đọc nó trước mọi thứ
  -- khác, nên không cần dựng bản đồ phạm vi cho vai này.
  if exists (select 1 from public.super_admins s where s.user_id = v_actor) then
    return '{"__superadmin": true}'::jsonb;
  end if;

  -- Chưa chốt công ty thì KHÔNG đoán. Bản v1 đoán bằng cách gộp mọi công ty —
  -- đó chính là D2. Rỗng ở đây nghĩa là giao diện phải hỏi người dùng chọn.
  if p_org is null then
    return '{}'::jsonb;
  end if;

  select coalesce(jsonb_object_agg(g.resource, g.actions), '{}'::jsonb)
    into v_out
    from (
      select pd.resource,
             jsonb_object_agg(pd.action, jsonb_build_object(
               'org_wide',     k.org_wide,
               'building_ids', to_jsonb(k.building_ids),
               'cashbook_ids', to_jsonb(k.cashbook_ids)
             )) as actions
        from app_private.all_scoped_keys_v3(p_org) k
        join public.permission_definitions pd on pd.key = k.permission_key
       -- Khoá không còn phạm vi nào hiệu lực = KHÔNG được cấp. Để lại trong
       -- bản đồ thì mọi bên đọc bằng phép thử "có khoá không" (kể cả
       -- `canFeature` của registry cũ) sẽ đọc thành CÓ QUYỀN.
       where k.org_wide
          or coalesce(cardinality(k.building_ids), 0) > 0
          or coalesce(cardinality(k.cashbook_ids), 0) > 0
       group by pd.resource
    ) g;

  return coalesce(v_out, '{}'::jsonb);
end
$fn$;

comment on function public.get_my_permissions_v2(uuid) is
  'Quyen giao dien THEO CONG TY, kem pham vi: {resource:{action:{org_wide, building_ids, cashbook_ids}}}. Thay get_my_permissions() von gop moi cong ty va vut pham vi (D1/D2). p_org null => rong, fail-closed. Super admin van nhan sentinel {"__superadmin": true}.';

revoke all on function public.get_my_permissions_v2(uuid) from public, anon, authenticated;
grant execute on function public.get_my_permissions_v2(uuid) to authenticated;

commit;
