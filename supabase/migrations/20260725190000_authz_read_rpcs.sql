-- =============================================================================
-- T4b — Hai RPC ĐỌC cho màn quản trị phân quyền
--
--   public.get_authorization_context_v1(org?)  -> gói quyền cho frontend
--   public.explain_authorization_v1(...)       -> "vì sao được / vì sao không"
--
-- Cả hai CHỈ ĐỌC. Không ai gọi sau migration ⇒ không đổi hành vi production.
--
-- === BẢY ĐIỀU KHẢO SÁT RA, ẢNH HƯỞNG THIẾT KẾ ===
-- 1. organization_memberships KHÔNG có UNIQUE(organization_id, user_id) — một
--    người CÓ THỂ có nhiều hồ sơ thành viên ACTIVE trong cùng một tổ chức.
--    Mọi chỗ chọn membership phải có thứ tự xác định, nếu không kết quả nhảy múa.
-- 2. Chủ sở hữu (nguyentamca165) là thành viên của CẢ HAI tổ chức (OWNER ở org
--    thật, STAFF ở demo). Hàm phải chọn mặc định ổn định, không được đổi giữa
--    hai lần gọi.
-- 3. authorize_tenant_action_v3 KHÔNG biết is_super_admin() — không có bypass nền
--    tảng. Ở đây chỉ TRẢ CỜ isPlatformAdmin để frontend biết, không tự cấp quyền.
-- 4. Hợp đồng writer: authorize_tenant_action_v3 đòi lock_org_for_decision_v1 ở
--    statement TRƯỚC. Trong RPC đọc vẫn phải tuân thủ — chỉ là `for share` trên
--    một dòng organizations, rẻ và không chặn ai.
-- 5. Ngoại lệ hỏng (không có cạnh phạm vi) làm evaluator RAISE 23514. Trong hàm
--    giải thích phải bắt trước, nếu không cả bảng 219 dòng gãy vì một dòng hỏng.
-- 6. permission_definitions không có nhãn tiếng Việt — trả resource/action thô
--    để frontend tự đặt tên hiển thị.
-- 7. Quyền có required_dimensions (BUILDING/CASHBOOK) luôn bị từ chối nếu hỏi
--    thiếu chiều đó. Hàm giải thích phải nói rõ "thiếu thông tin để xét", không
--    để người dùng tưởng là bị cấm.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) Gói quyền cho frontend
--
-- Thay dần get_my_permissions(). Khác biệt cốt lõi:
--   · Có organizationId / membershipId / authorizationVersion  -> cache đúng khoá
--   · Có scopes  -> frontend biết quyền áp ở TOÀ NÀO, không chỉ có/không
--   · Không sentinel __superadmin cho chủ tổ chức; chủ tổ chức nhận đủ key tường minh
--
-- Không raise khi chưa có membership: trả gói RỖNG đúng hình dạng. Người vừa bị
-- thu hồi vẫn còn org id cũ trong cache trình duyệt — raise sẽ làm màn hình trắng
-- thay vì hiện "bạn không còn quyền truy cập".
-- ---------------------------------------------------------------------------
create or replace function public.get_authorization_context_v1(
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_memb  record;
  v_ket   jsonb;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập. Hãy đăng nhập lại rồi thử lại.'
      using errcode = '42501';
  end if;

  -- Chọn tổ chức. Thứ tự ổn định (điểm 1 + 2 ở header): org được chỉ định trước,
  -- rồi tới org thật (không phải demo), rồi tới tham gia sớm nhất, cuối cùng bám
  -- id để không bao giờ hoà.
  select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
   where m.user_id = v_actor
     and m.status = 'ACTIVE'
     and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
     and (m.valid_to is null or m.valid_to > now())
     and (p_organization_id is null or m.organization_id = p_organization_id)
   order by coalesce(o.is_demo, false) asc,
            coalesce(m.activated_at, m.valid_from, 'infinity'::timestamptz) asc,
            m.organization_id asc
   limit 1;

  -- Không có membership nào (chưa mời / chưa kích hoạt / đã thu hồi), hoặc org chỉ
  -- định không phải của mình: trả gói rỗng, KHÔNG raise và KHÔNG tiết lộ tổ chức
  -- đó có tồn tại hay không.
  if v_org is null then
    return jsonb_build_object(
      'organizationId', null, 'membershipId', null, 'memberType', null,
      'authorizationVersion', null, 'nearestDeadline', null,
      'isPlatformAdmin', exists (select 1 from public.super_admins s where s.user_id = v_actor),
      'isOffboarded', app_private.is_actor_offboarded_v1(),
      'organizations', '[]'::jsonb,
      'permissions', '{}'::jsonb, 'scopeSets', '[]'::jsonb, 'scopes', '{}'::jsonb);
  end if;

  select m.id, m.member_type, o.authorization_version
    into v_memb
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = v_actor and m.organization_id = v_org and m.status = 'ACTIVE'
   order by coalesce(m.activated_at, m.valid_from, 'infinity'::timestamptz) asc, m.id asc
   limit 1;

  -- Chỉ liệt kê quyền ĐƯỢC PHÉP, và GOM PHẠM VI TRÙNG NHAU.
  --
  -- Bản đầu trả nguyên tập phạm vi cho từng quyền: 214 quyền x 21 mã toà nhà lặp
  -- lại => 342 kB cho chủ sở hữu. Frontend gọi mỗi phiên nên không chấp nhận được.
  -- Thực tế chỉ có vài tập phạm vi KHÁC NHAU (org-wide, theo toà, theo sổ quỹ...),
  -- nên tách thành `scopeSets` + `scopes[key]` trỏ CHỈ SỐ vào đó.
  --
  -- Thêm: khi org_wide = true thì KHÔNG liệt kê toà nữa — nó có nghĩa "mọi toà",
  -- liệt kê ra chỉ lặp lại danh sách toà mà frontend vốn đã có.
  with q as (
    select pd.key,
           s.org_wide,
           case when s.org_wide then '{}'::uuid[] else coalesce(s.building_ids,'{}'::uuid[]) end as building_ids,
           coalesce(s.cashbook_ids,'{}'::uuid[]) as cashbook_ids
      from public.permission_definitions pd
      cross join lateral app_private.authorized_scope_v3(pd.key, v_org) s
     where pd.permission_domain = 'TENANT'
       and pd.is_active
       and (s.org_wide
            or coalesce(array_length(s.building_ids, 1), 0) > 0
            or coalesce(array_length(s.cashbook_ids, 1), 0) > 0)
  ),
  tap as (
    select distinct org_wide, building_ids, cashbook_ids from q
  ),
  tap_so as (
    select row_number() over (order by org_wide desc, building_ids, cashbook_ids) - 1 as idx,
           org_wide, building_ids, cashbook_ids
      from tap
  )
  select jsonb_build_object(
           'permissions', coalesce((select jsonb_object_agg(q.key, true) from q), '{}'::jsonb),
           'scopeSets', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'orgWide', t.org_wide,
                      'buildingIds', to_jsonb(t.building_ids),
                      'cashbookIds', to_jsonb(t.cashbook_ids)) order by t.idx)
               from tap_so t), '[]'::jsonb),
           'scopes', coalesce((
             select jsonb_object_agg(q.key, t.idx)
               from q join tap_so t
                 on t.org_wide = q.org_wide
                and t.building_ids = q.building_ids
                and t.cashbook_ids = q.cashbook_ids), '{}'::jsonb))
    into v_ket;

  return jsonb_build_object(
    'organizationId', v_org,
    'membershipId', v_memb.id,
    'memberType', v_memb.member_type,
    'authorizationVersion', v_memb.authorization_version,
    'isPlatformAdmin', exists (select 1 from public.super_admins s where s.user_id = v_actor),
    'isOffboarded', app_private.is_actor_offboarded_v1(),
    -- Danh bạ tổ chức để frontend dựng bộ chọn khi một người thuộc nhiều tổ chức.
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object('id', o2.id, 'name', o2.name,
                                          'isDemo', coalesce(o2.is_demo, false),
                                          'memberType', m2.member_type)
                       order by coalesce(o2.is_demo, false), o2.name)
        from public.organization_memberships m2
        join public.organizations o2 on o2.id = m2.organization_id and o2.status = 'ACTIVE'
       where m2.user_id = v_actor and m2.status = 'ACTIVE'), '[]'::jsonb)
  ) || coalesce(v_ket, jsonb_build_object('permissions','{}'::jsonb,'scopeSets','[]'::jsonb,'scopes','{}'::jsonb));
end
$fn$;

comment on function public.get_authorization_context_v1(uuid) is
  'Gói quyền của chính người gọi cho frontend: quyền + PHẠM VI + phiên bản phân quyền. Thay dần get_my_permissions(). Không có membership -> trả gói rỗng, không raise.';

-- ---------------------------------------------------------------------------
-- 2) Giải thích quyền — ruột của tab "Quyền hiệu lực"
--
-- Nhận MẢNG khoá quyền (NULL = tất cả) để tab không phải gọi 219 lần.
-- Trả kèm NGUỒN quyết định: vai trò nào cho, ngoại lệ nào chặn và lý do ghi trong
-- ngoại lệ đó — thứ khiến màn phân quyền không thể nói dối.
-- ---------------------------------------------------------------------------
create or replace function public.explain_authorization_v1(
  p_membership       uuid,
  p_permission_keys  text[] default null,
  p_building         uuid   default null,
  p_cashbook         uuid   default null
)
returns table (
  permission_key text,
  resource       text,
  action         text,
  sensitivity    text,
  duoc_phep      boolean,
  ly_do_ma       text,
  ly_do          text,
  nguon          text
)
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_user  uuid;
  v_hong  text;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if p_membership is null then
    raise exception 'Thiếu thành viên cần xem quyền.' using errcode = '22023';
  end if;

  select m.organization_id, m.user_id into v_org, v_user
    from public.organization_memberships m
   where m.id = p_membership;
  if v_org is null then
    raise exception 'Không tìm thấy thành viên này.' using errcode = 'P0002';
  end if;

  -- Hợp đồng writer của evaluator (điểm 4 ở header): khoá tổ chức ở statement trước.
  perform app_private.lock_org_for_decision_v1(v_org);

  -- Quyền xem: phải là thành viên cùng tổ chức và có users.view.
  -- Ai cũng được tự xem quyền của CHÍNH MÌNH (rất hữu ích: "vì sao tôi không bấm
  -- được nút này"), nhưng KHÔNG kèm lý do ngoại lệ của người khác.
  if v_user <> v_actor and not app_private.can_v3('users.view') then
    raise exception 'Bạn không có quyền xem phân quyền của người khác.'
      using errcode = '42501';
  end if;

  -- Mục tiêu phải cùng tổ chức, nếu không cả 219 dòng đều nói "khác tổ chức".
  if p_building is not null and not exists (
       select 1 from public.buildings b
        where b.id = p_building and b.organization_id = v_org and b.deleted_at is null) then
    raise exception 'Toà nhà không thuộc tổ chức của thành viên này.' using errcode = '22023';
  end if;
  if p_cashbook is not null and not exists (
       select 1 from public.accounts a
        where a.id = p_cashbook and a.organization_id = v_org and a.deleted_at is null) then
    raise exception 'Sổ quỹ không thuộc tổ chức của thành viên này.' using errcode = '22023';
  end if;

  -- Điểm 5 ở header: ngoại lệ hỏng làm evaluator RAISE và giết cả bảng kết quả.
  -- Bắt trước, báo bằng tiếng Việt chỉ đúng chỗ hỏng.
  select string_agg(distinct o.permission_key, ', ')
    into v_hong
    from public.member_permission_overrides o
   where o.membership_id = p_membership
     and o.revoked_at is null
     and (o.expires_at is null or o.expires_at > now())
     and not exists (select 1 from public.member_override_scopes s where s.override_id = o.id);
  if v_hong is not null then
    raise exception 'Dữ liệu phân quyền của thành viên này bị hỏng: ngoại lệ "%" không có phạm vi nào. Hãy sửa hoặc gỡ ngoại lệ đó trước.', v_hong
      using errcode = '23514';
  end if;

  return query
  with keys as (
    select pd.key, pd.resource, pd.action, pd.sensitivity
      from public.permission_definitions pd
     where pd.permission_domain = 'TENANT'
       and pd.is_active
       and (p_permission_keys is null or pd.key = any(p_permission_keys))
  ),
  quyet_dinh as (
    select k.*, d.allowed, d.decision_reason
      from keys k
      cross join lateral app_private.authorize_tenant_action_v3(
        v_user, v_org, k.key, p_building, p_cashbook) d
  )
  select
    q.key, q.resource, q.action, q.sensitivity, q.allowed, q.decision_reason,
    case q.decision_reason
      when 'ORGANIZATION_INACTIVE_OR_MISSING' then 'Tổ chức đang không hoạt động'
      when 'PERMISSION_INACTIVE_OR_MISSING'   then 'Quyền này không còn được dùng'
      when 'REQUIRED_DIMENSION_MISSING'       then 'Chưa chọn toà nhà hoặc sổ quỹ nên chưa xét được'
      when 'MEMBERSHIP_INACTIVE_OR_MISSING'   then 'Người này không còn là thành viên đang hoạt động'
      when 'TARGET_CROSS_ORG_OR_MISSING'      then 'Toà nhà hoặc sổ quỹ không thuộc tổ chức này'
      when 'EMERGENCY_DENY'                   then 'Đang bị lệnh cấm khẩn cấp của tổ chức'
      when 'MEMBER_DENY'                      then 'Bị chặn bởi ngoại lệ riêng của người này'
      when 'ROLE_DENY'                        then 'Bị chặn bởi vai trò đang gán'
      when 'POSSESSION_MISSING'               then 'Không giữ sổ quỹ này nên không thao tác được'
      when 'MEMBER_ALLOW'                     then 'Được phép nhờ ngoại lệ riêng'
      when 'ROLE_ALLOW'                       then 'Được phép nhờ vai trò'
      else                                         'Không có vai trò hay ngoại lệ nào cấp quyền này'
    end,
    -- Nguồn cụ thể: chỉ tra khi có ý nghĩa, và chỉ cho người có users.view.
    case
      when q.decision_reason = 'ROLE_ALLOW' then coalesce((
        select 'Vai trò: ' || string_agg(distinct r.name, ', ')
          from public.role_bindings rb
          join public.organization_roles r on r.id = rb.role_id
          join public.role_permissions rp
            on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
           and rp.permission_key = q.key and rp.effect = 'ALLOW'
         where rb.membership_id = p_membership and rb.valid_to is null), 'Vai trò')
      when q.decision_reason = 'ROLE_DENY' then coalesce((
        select 'Vai trò chặn: ' || string_agg(distinct r.name, ', ')
          from public.role_bindings rb
          join public.organization_roles r on r.id = rb.role_id
          join public.role_permissions rp
            on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
           and rp.permission_key = q.key and rp.effect = 'DENY'
         where rb.membership_id = p_membership and rb.valid_to is null), 'Vai trò')
      when q.decision_reason in ('MEMBER_ALLOW','MEMBER_DENY') then coalesce((
        select 'Ngoại lệ riêng' ||
               case when v_user = v_actor then ''
                    else coalesce(' — lý do: ' || nullif(btrim(o.reason), ''), '') end
          from public.member_permission_overrides o
         where o.membership_id = p_membership and o.permission_key = q.key
           and o.revoked_at is null and (o.expires_at is null or o.expires_at > now())
         limit 1), 'Ngoại lệ riêng')
      when q.decision_reason = 'POSSESSION_MISSING' then 'Cần được giao giữ sổ quỹ'
      else null
    end
  from quyet_dinh q
  order by q.resource, q.action;
end
$fn$;

comment on function public.explain_authorization_v1(uuid, text[], uuid, uuid) is
  'Giải thích quyền hiệu lực của một thành viên kèm NGUỒN quyết định. Ruột của tab "Quyền hiệu lực". Ai cũng tự xem được của mình; xem người khác cần users.view.';

revoke all on function public.get_authorization_context_v1(uuid) from public, anon;
revoke all on function public.explain_authorization_v1(uuid, text[], uuid, uuid) from public, anon;
grant execute on function public.get_authorization_context_v1(uuid) to authenticated;
grant execute on function public.explain_authorization_v1(uuid, text[], uuid, uuid) to authenticated;

commit;
