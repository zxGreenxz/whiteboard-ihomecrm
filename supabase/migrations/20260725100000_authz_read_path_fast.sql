-- =============================================================================
-- T1c — TỐI ƯU HIỆU NĂNG đường đọc (cổng chặn cutover)
--
-- ĐO ĐƯỢC (EXPLAIN ANALYZE, 1.070 lời gọi, joey, org thật):
--   public.can_access_org_entity            557 ms   =  0,52 ms/lời gọi
--   app_private.probe_can_access_org_entity 15.541 ms = 14,5 ms/lời gọi  (CHẬM 28×)
--
-- `can_access_org_entity` nằm trong 192 policy. 14,5 ms/lời gọi ⇒ một truy vấn
-- trả 100 dòng tốn ~1,5 giây chỉ để kiểm quyền. Cổng của plan là "không xấu hơn
-- 20%" ⇒ FAIL nặng, không được cutover với bản này.
--
-- NGUYÊN NHÂN
--   has_any_scope_v3 gọi authorized_scope_all_v3 -> authorized_scope_v3, tức dựng
--   NGUYÊN tập phạm vi (nở AREA→BUILDING, liệt kê mọi toà + mọi sổ quỹ, tính cả
--   tập DENY) chỉ để trả lời một câu hỏi CÓ/KHÔNG.
--
-- CÁCH SỬA
--   Viết bản short-circuit: chỉ EXISTS trên cạnh ALLOW khớp scope_kinds, cộng hai
--   guard rẻ (DENY toàn tổ chức, possession). Không dựng mảng, không nở khu khi
--   không cần. Hàm dựng-tập authorized_scope_v3 GIỮ NGUYÊN cho nơi thật sự cần
--   danh sách (buildings_for_v3, tab "Quyền hiệu lực").
--
-- Ngữ nghĩa phải GIỮ NGUYÊN — đã đối chiếu lại sau khi tối ưu (xem cuối commit).
-- =============================================================================

begin;

-- Hàm phủ phạm vi: một cạnh phạm vi có bao mục tiêu (toà/sổ) không.
-- IMMUTABLE không được (đọc area_buildings) -> STABLE. Tách riêng để can_v3 gọn.
create or replace function app_private.scope_covers_v3(
  p_scope_type text, p_scope_building uuid, p_scope_cashbook uuid, p_scope_area uuid,
  p_org uuid, p_target_building uuid, p_target_cashbook uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select case p_scope_type
    when 'ORGANIZATION' then true
    when 'BUILDING'     then p_target_building is not null and p_scope_building = p_target_building
    when 'CASHBOOK'     then p_target_cashbook is not null and p_scope_cashbook = p_target_cashbook
    when 'AREA'         then p_target_building is not null and exists (
                              select 1 from public.area_buildings ab
                               where ab.organization_id = p_org
                                 and ab.area_id = p_scope_area
                                 and ab.building_id = p_target_building)
    else false end;
$$;
revoke all on function app_private.scope_covers_v3(text,uuid,uuid,uuid,uuid,uuid,uuid) from public, anon;
grant execute on function app_private.scope_covers_v3(text,uuid,uuid,uuid,uuid,uuid,uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- "Tôi có quyền này ở đâu đó không" — bản nhanh, không dựng tập.
--
-- Tương đương logic cũ (org_wide OR buildings<>{} OR cashbooks<>{}) vì:
--   * còn ít nhất một cạnh ALLOW khớp scope_kinds  => tập nguồn khác rỗng
--   * DENY toàn tổ chức                            => mọi tập rỗng
--   * quyền cần giữ sổ                             => chỉ cạnh CASHBOOK đang giữ mới tính
-- -----------------------------------------------------------------------------
create or replace function app_private.has_any_scope_v3(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
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
       -- (1) không bị cấm khẩn cấp
       and not exists (
         select 1 from app_private.tenant_emergency_denies d
          where d.organization_id = m.organization_id
            and (d.permission_key is null or d.permission_key = p_permission_key)
            and d.active_from <= now()
            and (d.expires_at is null or d.expires_at > now()))
       -- (2) không có CẤM ở phạm vi toàn tổ chức (cấm hẹp hơn vẫn còn chỗ khác)
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
       -- (3) có ít nhất một cạnh CHO khớp loại phạm vi mà quyền này chấp nhận
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
  );
$fn$;

-- -----------------------------------------------------------------------------
-- "Tôi có quyền này trên toà/sổ cụ thể không" — bản nhanh.
-- Hỏi thẳng một mục tiêu nên không cần dựng tập; theo đúng 12 tầng của bản ghi.
-- -----------------------------------------------------------------------------
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
       -- chiều bắt buộc phải được cung cấp (giống tầng dimensions của bản ghi)
       and not ('BUILDING' = any(pd.required_dimensions) and p_building is null)
       and not ('CASHBOOK' = any(pd.required_dimensions) and p_cashbook is null)
       -- mục tiêu phải cùng tổ chức
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
       -- CẤM: bất kỳ phạm vi nào PHỦ mục tiêu
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
       -- quyền cần giữ sổ: phải đang giữ đúng sổ đó
       and (not pd.requires_cashbook_possession or (
             p_cashbook is not null and exists (
               select 1 from public.cashbook_possession_bindings cp
                where cp.membership_id = m.id and cp.cashbook_id = p_cashbook
                  and cp.possession_kind = any(pd.accepted_possession_kinds)
                  and cp.valid_from <= now()
                  and (cp.valid_to is null or cp.valid_to > now()))))
       -- CHO
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
  );
$fn$;

revoke all on function app_private.has_any_scope_v3(text)   from public, anon;
revoke all on function app_private.can_v3(text, uuid, uuid) from public, anon;
grant execute on function app_private.has_any_scope_v3(text)   to authenticated;
grant execute on function app_private.can_v3(text, uuid, uuid) to authenticated;

commit;
