-- =============================================================================
-- T1 — Evaluator ĐƯỜNG ĐỌC cho mô hình phân quyền tổ chức
--
-- MỤC ĐÍCH
--   Đường GHI (48 RPC tiền) đã dùng app_private.authorize_tenant_action_v3.
--   Đường ĐỌC (624 RLS policy) vẫn đọc staff_assignments + roles JSONB.
--   Migration này dựng bản ĐỌC của cùng một logic, để Ngày G chỉ việc đổi ruột
--   11 helper legacy mà không phải sửa một dòng policy nào.
--
-- VÌ SAO KHÔNG DÙNG THẲNG authorize_tenant_action_v3 TRONG RLS
--   (a) Nó `for share` hàng organizations theo hợp đồng writer-protocol
--       (caller phải gọi lock_org_for_decision_v1 ở statement TRƯỚC). RLS không
--       có statement trước, và khoá theo từng dòng đọc là sai.
--   (b) Nó có thể RAISE qua raise_malformed_override → ném lỗi trong policy làm
--       gãy cả câu đọc thay vì trả rỗng.
--   (c) Nó VOLATILE (SQL không khai STABLE) + dùng clock_timestamp() → RLS gọi
--       lại cho TỪNG DÒNG, không cache được.
--   Bản đọc dưới đây: STABLE, dùng now() (cố định trong transaction), không khoá,
--   không raise. Mọi tầng quyết định còn lại GIỮ NGUYÊN ngữ nghĩa của bản ghi.
--
-- ⚠ NGỮ NGHĨA THEN CHỐT — lý do hàm trả TẬP PHẠM VI chứ không trả boolean
--   `can_access_org_entity(resource, action)` (192 policy) hiện có nghĩa:
--       "tôi có quyền này ở BẤT KỲ phân công nào"  — KHÔNG đòi phạm vi toàn tổ chức.
--   Nếu ánh xạ ngây thơ sang "hỏi evaluator với building = NULL" thì evaluator chỉ
--   trả true khi có ALLOW phạm vi ORGANIZATION. Đo trên org thật: joey, nathan,
--   bosshuy CHỈ có phạm vi BUILDING (8/10/13 scope), KHÔNG ai có ORGANIZATION.
--   ⇒ ánh xạ ngây thơ sẽ khoá sạch 3/4 người dùng org thật khỏi 192 policy.
--   Vì vậy hàm lõi trả (org_wide, building_ids, cashbook_ids) và mỗi helper tự
--   hỏi đúng câu hỏi của nó trên tập đó.
--
-- KHÔNG ai gọi các hàm này sau migration ⇒ không đổi hành vi production.
-- Idempotent: create or replace + create index if not exists.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1) Lõi: "quyền này tôi được dùng Ở ĐÂU trong một tổ chức"
--
-- Trả đúng ba trục mà mô hình phạm vi hỗ trợ:
--   org_wide      : hỏi KHÔNG kèm toà/sổ có được không (tương đương v3 với NULL)
--   building_ids  : tập toà được phép (đã nở AREA→BUILDING, đã trừ DENY)
--   cashbook_ids  : tập sổ quỹ được phép (đã lọc theo possession nếu quyền yêu cầu)
-- -----------------------------------------------------------------------------
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
-- now() STABLE (bản ghi dùng clock_timestamp() VOLATILE — khác biệt có chủ đích).
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
     and coalesce(m.valid_from, '-infinity'::timestamptz) <= at.ts
     and (m.valid_to is null or m.valid_to > at.ts)
),

-- Lệnh cấm khẩn cấp cấp tổ chức: chặn tất cả.
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

-- Cạnh phạm vi từ NGOẠI LỆ riêng của thành viên.
-- Khác bản ghi: override không có cạnh scope nào thì ở đây BỎ QUA (không raise).
-- Bản ghi raise để bắt dữ liệu hỏng lúc ghi; bản đọc phải trả rỗng chứ không
-- được làm gãy câu SELECT. Việc phát hiện override dị dạng do CI/gate lo.
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

-- Cạnh phạm vi từ VAI TRÒ.
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

-- Nở AREA → BUILDING cho cả DENY lẫn ALLOW (giống bản ghi).
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

-- ALLOW phải nằm trong scope_kinds mà registry cho phép với quyền này.
-- Quyền yêu cầu possession: CHỈ cạnh CASHBOOK mới cấp (giống bản ghi).
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

-- Sổ quỹ mà tôi đang thực sự GIỮ, với loại giữ mà quyền này chấp nhận.
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

-- Toàn bộ toà của tổ chức — dùng khi ALLOW ở mức ORGANIZATION.
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

-- Tập toà hiệu lực: nguồn ALLOW (org-wide ⇒ mọi toà) trừ đi DENY.
--
-- ⚠ `needs_cashbook`: quyền khai required_dimensions=['CASHBOOK'] (vd cashbooks.post)
--   thì MỌI câu hỏi phải kèm sổ quỹ. Hỏi "được làm ở toà X không" (không kèm sổ)
--   luôn bị bản GHI từ chối ở tầng dimensions ⇒ bản ĐỌC phải trả rỗng cho trục toà,
--   nếu không đường đọc sẽ nới hơn đường ghi.
eff_b as (
  select coalesce(array_agg(distinct t.b), '{}'::uuid[]) as v
    from resolved r
   cross join lateral unnest(case when r.a_org then r.all_b else r.a_b end) as t(b)
   where r.pass and not r.d_org and not r.needs_possession and not r.needs_cashbook
     and not (t.b = any(r.d_b))
),

-- Tập sổ quỹ hiệu lực. Quyền cần giữ sổ: phải có cạnh ALLOW CASHBOOK **và**
-- đang thực sự giữ sổ đó (bản ghi cũng đòi đúng hai điều kiện này).
--
-- ⚠ `needs_building`: đối xứng với trên — quyền khai required_dimensions=['BUILDING']
--   (income_expenses.create/edit/approve/cancel, reports_finance.analysis) thì câu hỏi
--   chỉ-kèm-sổ luôn bị bản GHI từ chối ⇒ trục sổ phải rỗng.
--   Bỏ sót điều này từng làm đường đọc nới hơn đường ghi 105 cặp (owner) và 42 cặp (partner).
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
  -- org_wide: hỏi KHÔNG kèm chiều nào mà vẫn được phép.
  -- Quyền có required_dimensions thì câu hỏi trống luôn thất bại (giống bản ghi).
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
  'Bản ĐỌC của authorize_tenant_action_v3: trả TẬP phạm vi (org_wide, buildings, cashbooks) thay vì 1 quyết định. STABLE, không khoá, không raise — an toàn dùng trong RLS.';

-- -----------------------------------------------------------------------------
-- 2) Hợp nhất trên MỌI tổ chức mà tôi là thành viên.
--    Cần thiết vì chủ sở hữu đang là thành viên của cả org thật lẫn org demo,
--    còn helper legacy không nhận tham số tổ chức.
-- -----------------------------------------------------------------------------
create or replace function app_private.authorized_scope_all_v3(p_permission_key text)
returns table (org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  with per_org as (
    select s.org_wide, s.building_ids, s.cashbook_ids
      from unnest(public.my_org_ids()) as o(org)
      cross join lateral app_private.authorized_scope_v3(p_permission_key, o.org) s
  )
  select
    (select coalesce(bool_or(p.org_wide), false) from per_org p),
    (select coalesce(array_agg(distinct t.b), '{}'::uuid[])
       from per_org p cross join lateral unnest(p.building_ids) as t(b)),
    (select coalesce(array_agg(distinct t.c), '{}'::uuid[])
       from per_org p cross join lateral unnest(p.cashbook_ids) as t(c));
$fn$;

-- -----------------------------------------------------------------------------
-- 3) Ba hàm tiện dụng — mỗi helper legacy sẽ hỏi đúng câu hỏi của nó.
-- -----------------------------------------------------------------------------

-- "Tôi có quyền này Ở ĐÂU ĐÓ không" → thay cho can_access_org_entity.
create or replace function app_private.has_any_scope_v3(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  select coalesce(
    (select s.org_wide
         or coalesce(array_length(s.building_ids, 1), 0) > 0
         or coalesce(array_length(s.cashbook_ids, 1), 0) > 0
       from app_private.authorized_scope_all_v3(p_permission_key) s),
    false);
$fn$;

-- "Tôi có quyền này trên toà/sổ cụ thể không" → thay cho can_do_on_building.
create or replace function app_private.can_v3(
  p_permission_key text,
  p_building       uuid default null,
  p_cashbook       uuid default null
)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  select coalesce(
    (select case
       when p_cashbook is not null then p_cashbook = any(s.cashbook_ids)
       when p_building is not null then s.org_wide or p_building = any(s.building_ids)
       else s.org_wide
     end
     from app_private.authorized_scope_all_v3(p_permission_key) s),
    false);
$fn$;

-- "Những toà nào tôi được dùng quyền này" → thay cho permitted_building_ids.
create or replace function app_private.buildings_for_v3(p_permission_key text)
returns uuid[]
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  select coalesce(
    (select case when s.org_wide
              then (select coalesce(array_agg(b.id), '{}'::uuid[])
                      from public.buildings b
                     where b.organization_id = any(public.my_org_ids())
                       and b.deleted_at is null)
              else s.building_ids
            end
       from app_private.authorized_scope_all_v3(p_permission_key) s),
    '{}'::uuid[]);
$fn$;

-- ACL: policy đánh giá dưới quyền caller ⇒ authenticated cần EXECUTE.
-- anon KHÔNG được cấp: trang công khai đi qua RPC SECURITY DEFINER riêng.
revoke all on function app_private.authorized_scope_v3(text, uuid)      from public, anon;
revoke all on function app_private.authorized_scope_all_v3(text)        from public, anon;
revoke all on function app_private.has_any_scope_v3(text)               from public, anon;
revoke all on function app_private.can_v3(text, uuid, uuid)             from public, anon;
revoke all on function app_private.buildings_for_v3(text)               from public, anon;

grant execute on function app_private.authorized_scope_v3(text, uuid)   to authenticated;
grant execute on function app_private.authorized_scope_all_v3(text)     to authenticated;
grant execute on function app_private.has_any_scope_v3(text)            to authenticated;
grant execute on function app_private.can_v3(text, uuid, uuid)          to authenticated;
grant execute on function app_private.buildings_for_v3(text)            to authenticated;

-- -----------------------------------------------------------------------------
-- 4) Index cho đường đọc. can_access_org_entity nằm trong 192 policy nên các
--    join dưới đây sẽ chạy rất nhiều lần — phải có index trước khi cutover.
-- -----------------------------------------------------------------------------
create index if not exists idx_role_bindings_membership_open
  on public.role_bindings (membership_id, organization_id) where valid_to is null;

create index if not exists idx_role_binding_scopes_binding
  on public.role_binding_scopes (role_binding_id, organization_id);

create index if not exists idx_role_permissions_lookup
  on public.role_permissions (organization_id, role_id, permission_key, effect);

create index if not exists idx_member_overrides_lookup
  on public.member_permission_overrides (membership_id, permission_key)
  where revoked_at is null;

create index if not exists idx_member_override_scopes_override
  on public.member_override_scopes (override_id, organization_id);

create index if not exists idx_authorization_scopes_org_type
  on public.authorization_scopes (organization_id, scope_type);

create index if not exists idx_area_buildings_area
  on public.area_buildings (organization_id, area_id, building_id);

create index if not exists idx_cashbook_possession_open
  on public.cashbook_possession_bindings (membership_id, cashbook_id, organization_id)
  where valid_to is null;

create index if not exists idx_org_memberships_user_active
  on public.organization_memberships (user_id, organization_id) where status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 5) Bảng sao lưu định nghĩa helper — hạ tầng rollback cho Ngày G.
--    Chụp NGUYÊN VĂN định nghĩa hiện tại để có thể khôi phục trong < 1 phút.
-- -----------------------------------------------------------------------------
create table if not exists app_private.authz_helper_backup (
  id             bigserial primary key,
  captured_at    timestamptz not null default now(),
  captured_label text        not null,
  function_sig   text        not null,
  definition     text        not null
);

comment on table app_private.authz_helper_backup is
  'Sao lưu nguyên văn định nghĩa helper phân quyền trước khi đổi ruột. Rollback Ngày G = chạy lại các definition ở đây.';

insert into app_private.authz_helper_backup (captured_label, function_sig, definition)
select 'pre-T6-baseline', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and p.proname in (
     'can_access_org_entity','can_do_on_building','current_visible_owner_ids',
     'can_access_building','permitted_building_ids','accessible_building_ids',
     'staff_can','same_team','ie_all_buildings_scope','can_view_restricted_ie',
     'can_create_restricted_ie','has_full_building_scope','is_staff_of',
     'is_tenant_admin','staff_building_scope','staff_in_building',
     'can_ie_all_buildings','customer_in_my_scope','get_my_permissions',
     'ai_copilot_perms_for','is_admin','is_super_admin')
   and not exists (
     select 1 from app_private.authz_helper_backup b
      where b.captured_label = 'pre-T6-baseline'
        and b.function_sig = p.oid::regprocedure::text);

revoke all on table app_private.authz_helper_backup from public, anon, authenticated;

commit;
