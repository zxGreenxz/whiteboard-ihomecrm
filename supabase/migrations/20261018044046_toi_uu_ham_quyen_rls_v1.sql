-- toi_uu_ham_quyen_rls_v1 — hàm quyền dùng trong RLS: GIỮ NGUYÊN câu truy vấn, đổi cách thực thi.
--
-- VÌ SAO CHẬM (đo TEST: accessible_building_ids ~30–36 ms/lần, can_access_building 4–5 ms/lần,
-- RLS phiếu thu ~3 s). Production chạy PostgreSQL 17: hàm LANGUAGE sql có SECURITY DEFINER/SET
-- search_path không inline được và KHÔNG dùng plan cache (plan cache cho hàm SQL chỉ có từ PG18).
-- Thân hàm được parse + plan lại ở mỗi câu lệnh gọi nó; tệ hơn, hàm SQL gọi LỒNG trong một hàm
-- SQL khác bị plan lại ở MỖI lần hàm ngoài chạy, vì FmgrInfo của nó sống trong executor của hàm
-- ngoài. Nên:
--   * mỗi policy (contracts, rooms, buildings, …) plan lại cả chuỗi buildings_for_v3 →
--     authorized_scope_all_v3 → authorized_scope_v3 (CTE ~20 nhánh) ngay cả khi user không có
--     quyền gì;
--   * can_access_building gọi theo dòng plan lại can_v3 + 6 hàm nhỏ ở MỖI dòng;
--   * income_expenses_restricted_select gọi can_view_restricted_ie() theo dòng (không bọc
--     InitPlan) ⇒ has_any_scope_v3 bị plan lại ở mỗi phiếu có hạng mục hạn chế.
--
-- THAY ĐỔI (không đổi chữ ký, volatility STABLE, SECURITY DEFINER, search_path, owner/ACL/comment):
--  1. 22 hàm trong đồ thị gọi của policy SELECT (contracts, rooms, buildings, contract_customers,
--     customers, invoices, invoice_items, income_expenses) và của can_access_building: LANGUAGE sql
--     → plpgsql, thân là ĐÚNG câu SELECT của bản trước (chỉ đổi thụt lề) bọc trong RETURN (…)/
--     RETURN QUERY. Mọi thân cũ trả đúng một dòng (EXISTS/aggregate/biểu thức) nên RETURN (…) không
--     đổi kết quả; hàm SETOF/TABLE dùng RETURN QUERY. plpgsql giữ plan đã chuẩn bị theo phiên.
--     Hàm STABLE plpgsql dùng snapshot của câu gọi như hàm STABLE SQL.
--  2. buildings_for_v3 và current_visible_owner_ids: lời gọi STABLE không tham số đang chạy THEO
--     DÒNG (my_org_ids trong bộ lọc quét buildings/organization_memberships, is_super_admin/is_admin/
--     demo_user_ids trong bộ lọc từng toà) bọc thành InitPlan `(select …)`. Hàm STABLE trả cùng giá
--     trị trong một câu nên tương đương; InitPlan lười nên nhánh AND ngắn mạch vẫn ngắn mạch.
--  3. sandbox_org_ids() trả hằng mảng, không đọc bảng ⇒ IMMUTABLE là volatility đúng; planner gập nó
--     thành literal trong mọi policy *_hide_sandbox_admin và thân hàm (đổi hàm thì plan bị invalidate).
--  4. income_expenses_restricted_select: bọc `(SELECT auth.uid())` và `(SELECT
--     public.can_view_restricted_ie())`. Chốt kiểm biểu thức hiện hành trước khi ALTER: lệch bản đã
--     review thì dừng.
--
-- ĐO TRÊN PG16 cục bộ (cùng cơ chế hàm SQL như PG17; PGlite là PG18 nên không tái hiện được), baseline
-- + dữ liệu tổng hợp 1080 toà/16.200 HĐ/6000 phiếu, phiên ấm, trung vị:
--   accessible_building_ids (chủ 3 công ty)   112 ms → 1,4 ms;   nhân viên không quyền 16 ms → 0,3 ms
--   SELECT count(*) FROM contracts (chủ)       128 ms → 7,3 ms;   contracts⋈rooms⋈buildings 380 → 15 ms
--   can_access_building × 300 dòng (chủ)       995 ms → 53 ms
--   SELECT count(*) FROM income_expenses       7,7 s → 4,4 ms
-- Số TEST/production do phiên có credential đo lại bằng EXPLAIN ANALYZE.
--
-- Tương đương ngữ nghĩa: src/lib/__tests__/permissionFunctionPlanCacheMigration.test.ts (PGlite, tập
-- id đọc được theo vai TRƯỚC = SAU cho từng bảng, kèm đột biến).
BEGIN;
SET LOCAL lock_timeout = '15s';

-- ── Lá: danh tính và tập công ty ──────────────────────────────────────────

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN (
    SELECT EXISTS (
      SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()
    )
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN public.is_super_admin();
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.has_full_building_scope()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN public.is_super_admin();
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.my_org_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
BEGIN
  RETURN (
    SELECT COALESCE(array_agg(organization_id), '{}'::uuid[])
    FROM public.organization_memberships
    WHERE user_id = auth.uid() AND status = 'ACTIVE'
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.demo_user_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN (
    SELECT COALESCE(array_agg(id), '{}'::uuid[])
    FROM auth.users
    WHERE email LIKE 'demo.%@username.ihomecrm.local'
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.demo_building_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN (
    SELECT COALESCE(array_agg(id), '{}'::uuid[])
    FROM public.buildings
    WHERE user_id = ANY (public.demo_user_ids())
  );
END
$fn$;

-- ── Lõi phân quyền v3 ─────────────────────────────────────────────────────

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION app_private.scope_covers_v3(p_scope_type text, p_scope_building uuid, p_scope_cashbook uuid, p_scope_area uuid, p_org uuid, p_target_building uuid, p_target_cashbook uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN (
    select case p_scope_type
    when 'ORGANIZATION' then true
    when 'BUILDING'     then p_target_building is not null and p_scope_building = p_target_building
    when 'CASHBOOK'     then p_target_cashbook is not null and p_scope_cashbook = p_target_cashbook
    when 'AREA'         then p_target_building is not null and exists (
                              select 1 from public.area_buildings ab
                               where ab.organization_id = p_org
                                 and ab.area_id = p_scope_area
                                 and ab.building_id = p_target_building)
    else false end
  );
END
$fn$;

-- bản trước: supabase/migrations/20260908162757_authz_scope_org_wide_scoped_deny_v1.sql
CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(p_permission_key text, p_org uuid)
RETURNS table (org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
    with
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
         and m.revoked_at is null
         and coalesce(m.valid_from, '-infinity'::timestamptz) <= at.ts
         and (m.valid_to is null or m.valid_to > at.ts)
    ),
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
    eff_b as (
      select coalesce(array_agg(distinct t.b), '{}'::uuid[]) as v
        from resolved r
       cross join lateral unnest(case when r.a_org then r.all_b else r.a_b end) as t(b)
       where r.pass and not r.d_org and not r.needs_possession and not r.needs_cashbook
         and not (t.b = any(r.d_b))
    ),
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
      case
        when not r.pass then false
        when r.needs_building or r.needs_cashbook then false
        when r.d_org then false
        when coalesce(cardinality(r.d_b), 0) > 0 then false
        when coalesce(cardinality(r.d_c), 0) > 0 then false
        else r.a_org
      end as org_wide,
      (select v from eff_b) as building_ids,
      (select v from eff_c) as cashbook_ids
    from resolved r;
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION app_private.authorized_scope_all_v3(p_permission_key text)
RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
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
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION app_private.can_v3(p_permission_key text, p_building uuid DEFAULT NULL::uuid, p_cashbook uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN (
    select exists (
      select 1
        from public.permission_definitions pd
        join public.organization_memberships m
          on m.user_id = (select auth.uid())
         and m.status = 'ACTIVE'
         and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
         and (m.valid_to is null or m.valid_to > now())
        join public.organizations o
          on o.id = m.organization_id and o.status = 'ACTIVE'
       where pd.key = p_permission_key
         and pd.permission_domain = 'TENANT'
         and pd.is_active
         and not ('BUILDING' = any(pd.required_dimensions) and p_building is null)
         and not ('CASHBOOK' = any(pd.required_dimensions) and p_cashbook is null)
         and (p_building is null or exists (
               select 1 from public.buildings b
                where b.id = p_building and b.organization_id = m.organization_id))
         and (p_cashbook is null or exists (
               select 1 from public.accounts a
                where a.id = p_cashbook and a.organization_id = m.organization_id
                  and a.deleted_at is null))
         and not exists (
           select 1 from app_private.tenant_emergency_denies d
            where d.organization_id = m.organization_id
              and (d.permission_key is null or d.permission_key = p_permission_key)
              and d.active_from <= now()
              and (d.expires_at is null or d.expires_at > now()))
         and not exists (
           select 1
             from public.member_permission_overrides ov
             join public.member_override_scopes mos on mos.override_id = ov.id
             join public.authorization_scopes s on s.id = mos.scope_id
            where ov.membership_id = m.id and ov.permission_key = p_permission_key
              and ov.effect = 'DENY' and ov.revoked_at is null
              and (ov.expires_at is null or ov.expires_at > now())
              and app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id, s.area_id,
                                              m.organization_id, p_building, p_cashbook))
         and not exists (
           select 1
             from public.role_bindings rb
             join public.role_permissions rp
               on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
              and rp.permission_key = p_permission_key and rp.effect = 'DENY'
             join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
             join public.authorization_scopes s on s.id = rbs.scope_id
            where rb.membership_id = m.id and rb.valid_to is null
              and app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id, s.area_id,
                                              m.organization_id, p_building, p_cashbook))
         and (not pd.requires_cashbook_possession or (
               p_cashbook is not null and exists (
                 select 1 from public.cashbook_possession_bindings cp
                  where cp.membership_id = m.id and cp.cashbook_id = p_cashbook
                    and cp.possession_kind = any(pd.accepted_possession_kinds)
                    and cp.valid_from <= now()
                    and (cp.valid_to is null or cp.valid_to > now()))))
         and (
           exists (
             select 1
               from public.member_permission_overrides ov
               join public.member_override_scopes mos on mos.override_id = ov.id
               join public.authorization_scopes s on s.id = mos.scope_id
              where ov.membership_id = m.id and ov.permission_key = p_permission_key
                and ov.effect = 'ALLOW' and ov.revoked_at is null
                and (ov.expires_at is null or ov.expires_at > now())
                and s.scope_type = any(pd.scope_kinds)
                and case when pd.requires_cashbook_possession
                         then s.scope_type = 'CASHBOOK' and s.cashbook_id = p_cashbook
                         else app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id,
                                s.area_id, m.organization_id, p_building, p_cashbook) end)
           or exists (
             select 1
               from public.role_bindings rb
               join public.role_permissions rp
                 on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
                and rp.permission_key = p_permission_key and rp.effect = 'ALLOW'
               join public.organization_roles orl
                 on orl.id = rb.role_id and coalesce(orl.status,'ACTIVE') = 'ACTIVE'
               join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
               join public.authorization_scopes s on s.id = rbs.scope_id
              where rb.membership_id = m.id
                and coalesce(rb.valid_from, '-infinity'::timestamptz) <= now()
                and (rb.valid_to is null or rb.valid_to > now())
                and s.scope_type = any(pd.scope_kinds)
                and case when pd.requires_cashbook_possession
                         then s.scope_type = 'CASHBOOK' and s.cashbook_id = p_cashbook
                         else app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id,
                                s.area_id, m.organization_id, p_building, p_cashbook) end)
         )
    )
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION app_private.has_any_scope_v3(p_permission_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN (
    select exists (
      select 1
        from public.permission_definitions pd
        join public.organization_memberships m
          on m.user_id = (select auth.uid())
         and m.status = 'ACTIVE'
         and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
         and (m.valid_to is null or m.valid_to > now())
        join public.organizations o
          on o.id = m.organization_id and o.status = 'ACTIVE'
       where pd.key = p_permission_key
         and pd.permission_domain = 'TENANT'
         and pd.is_active
         and not exists (
           select 1 from app_private.tenant_emergency_denies d
            where d.organization_id = m.organization_id
              and (d.permission_key is null or d.permission_key = p_permission_key)
              and d.active_from <= now()
              and (d.expires_at is null or d.expires_at > now()))
         and not exists (
           select 1
             from public.member_permission_overrides ov
             join public.member_override_scopes mos on mos.override_id = ov.id
             join public.authorization_scopes s on s.id = mos.scope_id
            where ov.membership_id = m.id and ov.permission_key = p_permission_key
              and ov.effect = 'DENY' and ov.revoked_at is null
              and (ov.expires_at is null or ov.expires_at > now())
              and s.scope_type = 'ORGANIZATION')
         and not exists (
           select 1
             from public.role_bindings rb
             join public.role_permissions rp
               on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
              and rp.permission_key = p_permission_key and rp.effect = 'DENY'
             join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
             join public.authorization_scopes s on s.id = rbs.scope_id
            where rb.membership_id = m.id and rb.valid_to is null
              and s.scope_type = 'ORGANIZATION')
         and (
           exists (
             select 1
               from public.member_permission_overrides ov
               join public.member_override_scopes mos on mos.override_id = ov.id
               join public.authorization_scopes s on s.id = mos.scope_id
              where ov.membership_id = m.id and ov.permission_key = p_permission_key
                and ov.effect = 'ALLOW' and ov.revoked_at is null
                and (ov.expires_at is null or ov.expires_at > now())
                and s.scope_type = any(pd.scope_kinds)
                and (not pd.requires_cashbook_possession or (
                      s.scope_type = 'CASHBOOK' and exists (
                        select 1 from public.cashbook_possession_bindings cp
                         where cp.membership_id = m.id and cp.cashbook_id = s.cashbook_id
                           and cp.possession_kind = any(pd.accepted_possession_kinds)
                           and cp.valid_from <= now()
                           and (cp.valid_to is null or cp.valid_to > now())))))
           or exists (
             select 1
               from public.role_bindings rb
               join public.role_permissions rp
                 on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
                and rp.permission_key = p_permission_key and rp.effect = 'ALLOW'
               join public.organization_roles orl
                 on orl.id = rb.role_id and coalesce(orl.status,'ACTIVE') = 'ACTIVE'
               join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
               join public.authorization_scopes s on s.id = rbs.scope_id
              where rb.membership_id = m.id
                and coalesce(rb.valid_from, '-infinity'::timestamptz) <= now()
                and (rb.valid_to is null or rb.valid_to > now())
                and s.scope_type = any(pd.scope_kinds)
                and (not pd.requires_cashbook_possession or (
                      s.scope_type = 'CASHBOOK' and exists (
                        select 1 from public.cashbook_possession_bindings cp
                         where cp.membership_id = m.id and cp.cashbook_id = s.cashbook_id
                           and cp.possession_kind = any(pd.accepted_possession_kinds)
                           and cp.valid_from <= now()
                           and (cp.valid_to is null or cp.valid_to > now())))))
         )
    )
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION app_private.my_possessed_cashbook_ids_v1()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN QUERY
    SELECT b.cashbook_id
    FROM public.cashbook_possession_bindings b
    JOIN public.organization_memberships m ON m.id = b.membership_id
    WHERE m.user_id = auth.uid()
      AND m.status = 'ACTIVE'
      AND b.valid_from <= now()
      AND (b.valid_to IS NULL OR b.valid_to > now());
END
$fn$;

-- ── Bọc dùng trong policy ─────────────────────────────────────────────────

-- bản trước: supabase/baseline/schema.sql (+3 InitPlan)
CREATE OR REPLACE FUNCTION app_private.buildings_for_v3(p_permission_key text)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN (
    with raw as (
      select case when s.org_wide
               then (select coalesce(array_agg(b.id), '{}'::uuid[])
                       from public.buildings b
                      where b.organization_id = any((select public.my_org_ids())::uuid[])
                        and b.deleted_at is null)
               else s.building_ids
             end as ids
        from app_private.authorized_scope_all_v3(p_permission_key) s
    ),
    scope as (
      select unnest(r.ids) as id from raw r
    )
    select coalesce(
      (select array_agg(b.id)
         from public.buildings b
         join scope s2 on s2.id = b.id
        where b.deleted_at is null
          and not ((select public.is_super_admin())
                   and b.organization_id = any(public.sandbox_org_ids()))
          and not (((select public.is_super_admin()) or (select public.is_admin()))
                   and b.user_id = any((select public.demo_user_ids())::uuid[]))),
      '{}'::uuid[])
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.accessible_building_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  RETURN QUERY
    select b from unnest(app_private.buildings_for_v3('buildings.view')) as t(b);
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.accessible_room_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
    SELECT r.id FROM public.rooms r
    WHERE r.building_id IN (SELECT public.accessible_building_ids());
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.accessible_contract_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
    SELECT c.id FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id
    WHERE r.building_id IN (SELECT public.accessible_building_ids());
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.accessible_invoice_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
    SELECT i.id FROM public.invoices i
    WHERE i.building_id IN (SELECT public.accessible_building_ids());
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.accessible_account_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
    SELECT id FROM public.accounts WHERE user_id = auth.uid()
    UNION
    SELECT app_private.my_possessed_cashbook_ids_v1();
END
$fn$;

-- bản trước: supabase/baseline/schema.sql (+1 InitPlan)
CREATE OR REPLACE FUNCTION public.current_visible_owner_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  RETURN (
    select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
     from public.organization_memberships m
    where m.status = 'ACTIVE'
      and m.organization_id = any ((select public.my_org_ids())::uuid[])
  );
END
$fn$;

-- bản trước: supabase/migrations/20260915145541_bien_gioi_ho_so_va_toa.sql
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  RETURN (
    SELECT NOT EXISTS (
          SELECT 1
          FROM public.buildings b
          WHERE b.id = _building_id
            AND COALESCE(b.organization_id = ANY (public.sandbox_org_ids()), false)
            AND NOT COALESCE(b.organization_id = ANY (public.my_org_ids()), false)
        )
    AND NOT EXISTS (
          SELECT 1
          FROM public.buildings b
          WHERE b.id = _building_id
            AND (public.is_super_admin() OR public.is_admin())
            AND b.user_id = ANY (public.demo_user_ids())
        )
    AND (public.is_super_admin() OR app_private.can_v3('buildings.view', _building_id))
  );
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.can_access_org_entity(_resource text, _action text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  RETURN public.is_super_admin() or app_private.has_any_scope_v3(_resource || '.' || _action);
END
$fn$;

-- bản trước: supabase/baseline/schema.sql
CREATE OR REPLACE FUNCTION public.can_view_restricted_ie()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  RETURN public.is_super_admin() or app_private.has_any_scope_v3('income_expenses.restricted_view');
END
$fn$;

-- ── Volatility đúng cho hằng ──────────────────────────────────────────────────

ALTER FUNCTION public.sandbox_org_ids() IMMUTABLE;

-- ── Policy: bọc InitPlan ──────────────────────────────────────────────────────

DO $chot$
DECLARE
  v_policy record;
  v_qual   text;
BEGIN
  SELECT p.polcmd, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS qual
    INTO v_policy
    FROM pg_policy p
   WHERE p.polrelid = 'public.income_expenses'::regclass
     AND p.polname = 'income_expenses_restricted_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Thiếu policy income_expenses_restricted_select trên public.income_expenses';
  END IF;
  IF v_policy.polcmd <> 'r' OR v_policy.polpermissive THEN
    RAISE EXCEPTION 'income_expenses_restricted_select không còn là RESTRICTIVE FOR SELECT';
  END IF;
  -- Bỏ tiền tố public. (deparse phụ thuộc search_path) và gộp khoảng trắng.
  v_qual := replace(regexp_replace(v_policy.qual, '\s+', ' ', 'g'), 'public.', '');
  IF v_qual NOT IN (
       '((has_restricted_item = false) OR (user_id = auth.uid()) OR can_view_restricted_ie())',
       '((has_restricted_item = false) OR (user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT can_view_restricted_ie() AS can_view_restricted_ie))'
     ) THEN
    RAISE EXCEPTION 'income_expenses_restricted_select lệch bản đã review: %', v_policy.qual;
  END IF;
END
$chot$;

ALTER POLICY income_expenses_restricted_select ON public.income_expenses
  USING (
    has_restricted_item = false
    OR user_id = (SELECT auth.uid())
    OR (SELECT public.can_view_restricted_ie())
  );

-- ── Hậu kiểm ──────────────────────────────────────────────────────────────────

DO $hau_kiem$
DECLARE
  v_sai text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_sai
    FROM pg_proc p
   WHERE p.oid = ANY (ARRAY[
           'public.is_super_admin()', 'public.is_admin()', 'public.has_full_building_scope()',
           'public.my_org_ids()', 'public.demo_user_ids()', 'public.demo_building_ids()',
           'app_private.scope_covers_v3(text,uuid,uuid,uuid,uuid,uuid,uuid)',
           'app_private.authorized_scope_v3(text,uuid)', 'app_private.authorized_scope_all_v3(text)',
           'app_private.can_v3(text,uuid,uuid)', 'app_private.has_any_scope_v3(text)',
           'app_private.my_possessed_cashbook_ids_v1()', 'app_private.buildings_for_v3(text)',
           'public.accessible_building_ids()', 'public.accessible_room_ids()',
           'public.accessible_contract_ids()', 'public.accessible_invoice_ids()',
           'public.accessible_account_ids()', 'public.current_visible_owner_ids()',
           'public.can_access_building(uuid)', 'public.can_access_org_entity(text,text)',
           'public.can_view_restricted_ie()'
         ]::regprocedure[]::oid[])
     AND NOT (p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
              AND p.provolatile = 's'
              AND p.prosecdef
              AND array_to_string(p.proconfig, ',') LIKE 'search_path=%');
  IF v_sai IS NOT NULL THEN
    RAISE EXCEPTION 'Hàm quyền sai thuộc tính sau migration: %', v_sai;
  END IF;

  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'public.sandbox_org_ids()'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'sandbox_org_ids() chưa IMMUTABLE';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = 'public.income_expenses'::regclass
          AND p.polname = 'income_expenses_restricted_select'
          AND replace(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g'), 'public.', '')
              = '((has_restricted_item = false) OR (user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT can_view_restricted_ie() AS can_view_restricted_ie))'
     ) THEN
    RAISE EXCEPTION 'income_expenses_restricted_select chưa được bọc InitPlan';
  END IF;
END
$hau_kiem$;

COMMIT;
