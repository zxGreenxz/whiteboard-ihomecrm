-- =============================================================================
-- NGÀY G (phần 3/3) — đổi nguồn hàm quyền của giao diện
--
--   get_my_permissions()   -> đọc mô hình tổ chức, GIỮ NGUYÊN hình dạng JSONB
--   ai_copilot_perms_for() -> gọi chung một nguồn (hết hai bản sao phải giữ đồng bộ tay)
--
-- === VÌ SAO PHẢI VIẾT BẢN GỘP, KHÔNG GỌI has_any_scope_v3 214 LẦN ===
--   Đo: gọi từng khoá một (như get_authorization_context_v1 đang làm) mất 174 ms,
--   trong khi bản cũ chỉ 5,6 ms — chậm 31 lần. Đây là hàm giao diện gọi mỗi phiên
--   và làm mới mỗi 60 giây, nên phải gộp thành MỘT truy vấn.
--   app_private.all_allowed_keys_v3() làm đúng việc đó: một lượt join, trả thẳng
--   mảng khoá được phép.
--
-- === BA THAY ĐỔI HÀNH VI, ĐỀU CÓ CHỦ ĐÍCH ===
--   1. Hết "lấy phân công đầu tiên". Bản cũ ORDER BY ... LIMIT 1 nên người có
--      nhiều phân công chỉ nhận quyền của MỘT dòng. Bản mới HỢP NHẤT tất cả.
--      (AUTHORIZATION-PLAN §11.1 nguyên tắc 8 cấm first-assignment-wins.)
--   2. Hết nhánh legacy_owner_allowlist. Đã xác minh trước đó: 4/5 dòng là code
--      chết, chỉ tài khoản demo thực sự đi qua nhánh này — và nó đã có membership
--      OWNER nên vẫn đủ quyền qua đường mới.
--   3. Cổ đông / quản lý lợi nhuận: bản cũ có nhánh riêng cấp quyền xem trang lợi
--      nhuận. Bản mới KHÔNG có — theo đúng chỉ đạo chủ sở hữu ngày 25/07
--      ("quyền xem trang lợi nhuận khoá hết, chỉ tôi có quyền").
--
--   GIỮ NGUYÊN: sentinel {"__superadmin": true} cho quản trị nền tảng. Giao diện
--   hiện dựa vào nó (hàm can() trong useMyPermissions). Bỏ sentinel là việc của
--   bước chuyển giao diện, không phải bước này.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Bản gộp: mọi khoá quyền người gọi được phép, trong MỘT truy vấn.
-- Ngữ nghĩa sao y has_any_scope_v3 (đã đối chiếu 11.653 quyết định) nhưng thay
-- 214 lời gọi hàm bằng một lượt join.
-- ---------------------------------------------------------------------------
create or replace function app_private.all_allowed_keys_v3()
returns text[]
language sql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  with mem as (
    select m.id, m.organization_id
      from public.organization_memberships m
      join public.organizations o
        on o.id = m.organization_id and o.status = 'ACTIVE'
     where m.user_id = (select auth.uid())
       and m.status = 'ACTIVE'
       and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
       and (m.valid_to is null or m.valid_to > now())
  ),
  -- Cạnh CHO từ vai trò
  role_allow as (
    select rp.permission_key, s.scope_type, s.cashbook_id, m.id as membership_id
      from mem m
      join public.role_bindings rb
        on rb.membership_id = m.id
       and coalesce(rb.valid_from, '-infinity'::timestamptz) <= now()
       and (rb.valid_to is null or rb.valid_to > now())
      join public.organization_roles orl
        on orl.id = rb.role_id and coalesce(orl.status, 'ACTIVE') = 'ACTIVE'
      join public.role_permissions rp
        on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
       and rp.effect = 'ALLOW'
      join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
      join public.authorization_scopes s on s.id = rbs.scope_id
  ),
  -- Cạnh CHO từ ngoại lệ riêng
  ov_allow as (
    select o.permission_key, s.scope_type, s.cashbook_id, m.id as membership_id
      from mem m
      join public.member_permission_overrides o
        on o.membership_id = m.id and o.revoked_at is null and o.effect = 'ALLOW'
       and (o.expires_at is null or o.expires_at > now())
      join public.member_override_scopes mos on mos.override_id = o.id
      join public.authorization_scopes s on s.id = mos.scope_id
  ),
  allow_edge as (
    select * from role_allow union all select * from ov_allow
  ),
  -- CẤM ở phạm vi toàn tổ chức thì triệt tiêu hoàn toàn khoá đó
  deny_org as (
    select rp.permission_key
      from mem m
      join public.role_bindings rb on rb.membership_id = m.id and rb.valid_to is null
      join public.role_permissions rp
        on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
       and rp.effect = 'DENY'
      join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
      join public.authorization_scopes s
        on s.id = rbs.scope_id and s.scope_type = 'ORGANIZATION'
    union
    select o.permission_key
      from mem m
      join public.member_permission_overrides o
        on o.membership_id = m.id and o.revoked_at is null and o.effect = 'DENY'
       and (o.expires_at is null or o.expires_at > now())
      join public.member_override_scopes mos on mos.override_id = o.id
      join public.authorization_scopes s
        on s.id = mos.scope_id and s.scope_type = 'ORGANIZATION'
  ),
  cam_khan_cap as (
    select d.permission_key
      from app_private.tenant_emergency_denies d
      join mem m on m.organization_id = d.organization_id
     where d.active_from <= now()
       and (d.expires_at is null or d.expires_at > now())
  )
  select coalesce(array_agg(distinct pd.key), '{}'::text[])
    from public.permission_definitions pd
    join allow_edge e on e.permission_key = pd.key
   where pd.permission_domain = 'TENANT'
     and pd.is_active
     and e.scope_type = any (pd.scope_kinds)
     -- Quyền cần giữ sổ: chỉ cạnh CASHBOOK mà mình đang thực sự giữ mới tính
     and (not pd.requires_cashbook_possession
          or (e.scope_type = 'CASHBOOK' and exists (
                select 1 from public.cashbook_possession_bindings cp
                 where cp.membership_id = e.membership_id
                   and cp.cashbook_id = e.cashbook_id
                   and cp.possession_kind = any (pd.accepted_possession_kinds)
                   and cp.valid_from <= now()
                   and (cp.valid_to is null or cp.valid_to > now()))))
     and pd.key not in (select permission_key from deny_org)
     and not exists (select 1 from cam_khan_cap c
                      where c.permission_key is null or c.permission_key = pd.key);
$fn$;

revoke all on function app_private.all_allowed_keys_v3() from public, anon;
grant execute on function app_private.all_allowed_keys_v3() to authenticated;

-- ---------------------------------------------------------------------------
-- Hàm quyền của giao diện — GIỮ NGUYÊN hình dạng {module: {action: true}}
-- ---------------------------------------------------------------------------
create or replace function public.get_my_permissions()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_keys  text[];
  v_out   jsonb;
begin
  if v_actor is null then
    return '{}'::jsonb;                       -- fail closed
  end if;

  -- Quản trị nền tảng: giữ sentinel vì giao diện hiện dựa vào nó.
  if exists (select 1 from public.super_admins s where s.user_id = v_actor) then
    return '{"__superadmin": true}'::jsonb;
  end if;

  v_keys := app_private.all_allowed_keys_v3();
  if coalesce(array_length(v_keys, 1), 0) = 0 then
    return '{}'::jsonb;                       -- không thành viên / bị thu hồi
  end if;

  select coalesce(jsonb_object_agg(g.resource, g.actions), '{}'::jsonb)
    into v_out
    from (
      select pd.resource, jsonb_object_agg(pd.action, true) as actions
        from public.permission_definitions pd
       where pd.key = any (v_keys)
       group by pd.resource
    ) g;

  return coalesce(v_out, '{}'::jsonb);
end
$fn$;

-- ---------------------------------------------------------------------------
-- Bản sao cho AI-copilot: gộp về CÙNG một nguồn.
-- Trước đây là bản chép tay, kèm chú thích "phải giữ đồng bộ cả 2 nơi" — đúng
-- kiểu drift mà AUTHORIZATION-PLAN §5.2 cảnh báo. Nay chỉ còn một đường.
-- Lưu ý: hàm này nhận p_user (được gọi từ reserve_ai_usage dưới service role),
-- nên không dùng auth.uid() được — phải tự dựng theo p_user.
-- ---------------------------------------------------------------------------
create or replace function public.ai_copilot_perms_for(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_out jsonb;
begin
  if p_user is null then
    return '{}'::jsonb;
  end if;
  if exists (select 1 from public.super_admins s where s.user_id = p_user) then
    return '{"__superadmin": true}'::jsonb;
  end if;

  select coalesce(jsonb_object_agg(g.resource, g.actions), '{}'::jsonb)
    into v_out
    from (
      select pd.resource, jsonb_object_agg(pd.action, true) as actions
        from public.permission_definitions pd
       where pd.permission_domain = 'TENANT'
         and pd.is_active
         and exists (
           select 1
             from public.organization_memberships m
             join public.organizations o
               on o.id = m.organization_id and o.status = 'ACTIVE'
             join public.role_bindings rb
               on rb.membership_id = m.id and rb.valid_to is null
             join public.organization_roles orl
               on orl.id = rb.role_id and coalesce(orl.status,'ACTIVE') = 'ACTIVE'
             join public.role_permissions rp
               on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
              and rp.permission_key = pd.key and rp.effect = 'ALLOW'
             join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
             join public.authorization_scopes s
               on s.id = rbs.scope_id and s.scope_type = any (pd.scope_kinds)
            where m.user_id = p_user and m.status = 'ACTIVE')
       group by pd.resource
    ) g;

  return coalesce(v_out, '{}'::jsonb);
end
$fn$;

commit;
