-- =============================================================================
-- T4c — BỐN RPC GHI cho màn quản trị phân quyền
--
--   update_member_authorization_v1  — nút "Lưu" của hộp thoại phân quyền
--   upsert_organization_role_v1     — tạo/sửa mẫu vai trò
--   invite_organization_member_v1   — mời thành viên
--   accept_organization_invitation_v1 — người được mời tự kích hoạt
--
-- Nền đã có: authorize_tenant_action_v3 (evaluator), append_authz_audit_v1 (nhật
-- ký có chuỗi hash), all_allowed_keys_v3, get_authorization_context_v1.
--
-- === RÀNG BUỘC THẬT ĐÃ KHẢO SÁT (không đoán) ===
--   member_type      : OWNER · STAFF · SHAREHOLDER · PARTNER · SERVICE
--   membership.status: INVITED · ACTIVE · SUSPENDED · REVOKED
--   invitation.status: PENDING · ACCEPTED · EXPIRED · REVOKED
--   override.effect  : ALLOW · DENY      scope_mode: ORGANIZATION · SCOPED
--   Trigger sẵn có   : guard_last_owner (chặn hạ chủ cuối)
--                      bump_org_authorization_version (TỰ tăng, RPC không tự bump)
--                      a90_override_shape / a90_override_edge_shape
--                        DEFERRABLE INITIALLY DEFERRED — kiểm lúc COMMIT
--                          ORGANIZATION => ĐÚNG 1 cạnh, và phải là ORGANIZATION
--                          SCOPED       => >=1 cạnh, KHÔNG cạnh ORGANIZATION
--                          mọi cạnh phải thuộc scope_kinds của khoá quyền
--   organization_memberships.version KHÔNG có trigger tự tăng => RPC tự bump.
--   organization_memberships KHÔNG có UNIQUE(org,user) => chọn dòng phải có thứ tự.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- DDL: bảng lời mời thiếu vai trò và phạm vi dự kiến nên luồng mời không chạy
-- được (khảo sát: 0 dòng, 0 RPC, 0 màn hình dùng).
-- ---------------------------------------------------------------------------
alter table public.organization_invitations
  add column if not exists intended_role_id  uuid references public.organization_roles(id),
  add column if not exists intended_scope_ids uuid[] not null default '{}'::uuid[],
  add column if not exists revoked_at        timestamptz,
  add column if not exists accepted_by       uuid;

-- ---------------------------------------------------------------------------
-- Helper dùng chung: đòi quyền trong tổ chức, báo lỗi tiếng Việt tử tế.
-- Tuân thủ hợp đồng writer (khoá tổ chức ở statement trước).
-- ---------------------------------------------------------------------------
create or replace function app_private.require_perm_v1(
  p_org uuid, p_permission_key text, p_viec text
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare v_ok boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  perform app_private.lock_org_for_decision_v1(p_org);
  select a.allowed into v_ok
    from app_private.authorize_tenant_action_v3(
      (select auth.uid()), p_org, p_permission_key, null, null) a;
  if not coalesce(v_ok, false) then
    raise exception 'Bạn không có quyền %.', p_viec using errcode = '42501';
  end if;
end
$fn$;

revoke all on function app_private.require_perm_v1(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ảnh chụp quyền của MỘT thành viên, dùng cho phần "được thêm / mất đi" mà hộp
-- thoại hiện sau khi lưu.
--
-- VÌ SAO KHÔNG DÙNG authorize_tenant_action_v3(user, org, key, null, null)
--   Với khoá có required_dimensions=['BUILDING'], evaluator từ chối khi không
--   truyền toà — đúng cho đường GHI, nhưng sai cho câu hỏi ở đây. Đo kiểu đó thì
--   một người được gán vai trò theo TOÀ sẽ hiện ra là "0 quyền", và màn hình sẽ
--   báo "mất 34 quyền" ngay khi vừa cấp thêm quyền. Đã dựng lại và thấy đúng vậy.
--   Câu hỏi đúng là "có quyền này ở BẤT KỲ phạm vi nào không" — chính là ngữ
--   nghĩa của has_any_scope_v3, nhưng theo membership chỉ định thay vì auth.uid().
--
-- Thân sao y all_allowed_keys_v3 (đã đối chiếu 11.653 quyết định), chỉ đổi điểm
-- vào: một membership cho trước thay vì mọi membership của người đang đăng nhập.
-- ---------------------------------------------------------------------------
create or replace function app_private.allowed_keys_for_membership_v3(p_membership uuid)
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
     where m.id = p_membership
       and m.status = 'ACTIVE'
       and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
       and (m.valid_to is null or m.valid_to > now())
  ),
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
  ov_allow as (
    select o.permission_key, s.scope_type, s.cashbook_id, m.id as membership_id
      from mem m
      join public.member_permission_overrides o
        on o.membership_id = m.id and o.revoked_at is null and o.effect = 'ALLOW'
       and (o.expires_at is null or o.expires_at > now())
      join public.member_override_scopes mos on mos.override_id = o.id
      join public.authorization_scopes s on s.id = mos.scope_id
  ),
  allow_edge as (select * from role_allow union all select * from ov_allow),
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

revoke all on function app_private.allowed_keys_for_membership_v3(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1) NÚT "LƯU" — một đường ghi duy nhất cho vai trò + phạm vi + ngoại lệ
--
-- Ngữ nghĩa THAY THẾ, không cộng dồn: truyền vào trạng thái ĐÍCH, hàm tự đóng
-- cái không còn và mở cái mới. NULL = không đụng lớp đó.
--
--   p_role_bindings: [{"role_id": "...", "scope_ids": ["...","..."]}, ...]
--   p_overrides    : [{"permission_key":"...","effect":"ALLOW|DENY",
--                      "scope_mode":"ORGANIZATION|SCOPED","scope_ids":[...],
--                      "reason":"...","expires_at":null}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.update_member_authorization_v1(
  p_membership       uuid,
  p_expected_version bigint,
  p_role_bindings    jsonb default null,
  p_overrides        jsonb default null,
  p_reason           text  default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid;
  v_user     uuid;
  v_ver      bigint;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_truoc    text[];
  v_sau      text[];
  v_them     text[];
  v_mat      text[];
  v_b        jsonb;
  v_o        jsonb;
  v_id       uuid;
  v_n_bind   int := 0;
  v_n_ov     int := 0;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if p_membership is null or p_expected_version is null then
    raise exception 'Thiếu thành viên hoặc số phiên bản. Hãy tải lại trang rồi thử lại.'
      using errcode = '22023';
  end if;
  if p_role_bindings is null and p_overrides is null then
    raise exception 'Không có gì để lưu.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Hãy ghi lý do thay đổi phân quyền.' using errcode = '22023';
  end if;

  select m.organization_id, m.user_id into v_org, v_user
    from public.organization_memberships m where m.id = p_membership;
  if v_org is null then
    raise exception 'Không tìm thấy thành viên này.' using errcode = 'P0002';
  end if;

  -- So bằng user_id, KHÔNG bằng membership_id: người có nhiều hồ sơ thành viên
  -- trong cùng tổ chức sẽ lách được nếu chỉ so membership.
  if v_user = v_actor then
    raise exception 'Bạn không thể tự sửa quyền của chính mình. Hãy nhờ chủ sở hữu thực hiện.'
      using errcode = '42501';
  end if;

  perform app_private.require_perm_v1(v_org, 'users.edit', 'sửa phân quyền thành viên');

  -- Khoá dòng RỒI mới so phiên bản (đọc trước khi khoá là sai — hai người cùng
  -- lưu có thể cùng đọc đúng version rồi cùng ghi).
  select m.version into v_ver
    from public.organization_memberships m where m.id = p_membership for update;
  if v_ver <> p_expected_version then
    raise exception 'Có người vừa đổi phân quyền của thành viên này. Hãy tải lại trang để xem thay đổi mới nhất.'
      using errcode = '40001';
  end if;

  -- Ảnh chụp quyền TRƯỚC, để trả về "mất gì / được thêm gì".
  v_truoc := app_private.allowed_keys_for_membership_v3(p_membership);

  -- ---- Lớp VAI TRÒ ----
  if p_role_bindings is not null then
    -- role_bindings_check đòi valid_to > valid_from NGHIÊM NGẶT. now() là mốc đầu
    -- giao dịch, nên nếu một binding vừa được tạo rồi bị đóng TRONG CÙNG giao dịch
    -- (lưu hai lần liên tiếp, hoặc kịch bản kiểm thử) thì hai mốc bằng nhau và
    -- ràng buộc nổ. Đẩy thêm 1 micro giây để luôn hợp lệ.
    update public.role_bindings
       set valid_to = greatest(now(), valid_from + interval '1 microsecond'),
           version = version + 1
     where membership_id = p_membership and valid_to is null;

    for v_b in select * from jsonb_array_elements(p_role_bindings) loop
      if not exists (select 1 from public.organization_roles r
                      where r.id = (v_b->>'role_id')::uuid and r.organization_id = v_org) then
        raise exception 'Vai trò không thuộc tổ chức này.' using errcode = '22023';
      end if;
      v_id := gen_random_uuid();
      insert into public.role_bindings (id, organization_id, membership_id, role_id, valid_from, version)
      values (v_id, v_org, p_membership, (v_b->>'role_id')::uuid, now(), 1);

      insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
      select v_org, v_id, s.id
        from jsonb_array_elements_text(coalesce(v_b->'scope_ids', '[]'::jsonb)) as t(sid)
        join public.authorization_scopes s on s.id = t.sid::uuid and s.organization_id = v_org;

      if not exists (select 1 from public.role_binding_scopes x where x.role_binding_id = v_id) then
        raise exception 'Vai trò phải kèm ít nhất một phạm vi (toàn tổ chức, khu vực hoặc toà nhà).'
          using errcode = '22023';
      end if;
      v_n_bind := v_n_bind + 1;
    end loop;
  end if;

  -- ---- Lớp NGOẠI LỆ ----
  if p_overrides is not null then
    -- Thu hồi bằng revoked_at, KHÔNG xoá dòng: giữ dấu vết ai từng được cấp gì.
    update public.member_permission_overrides
       set revoked_at = now()
     where membership_id = p_membership and revoked_at is null;

    for v_o in select * from jsonb_array_elements(p_overrides) loop
      if nullif(btrim(coalesce(v_o->>'reason','')), '') is null then
        raise exception 'Ngoại lệ "%": phải ghi lý do.', v_o->>'permission_key'
          using errcode = '22023';
      end if;
      if not exists (select 1 from public.permission_definitions pd
                      where pd.key = v_o->>'permission_key' and pd.is_active
                        and pd.permission_domain = 'TENANT') then
        raise exception 'Quyền "%" không tồn tại hoặc không dùng được.', v_o->>'permission_key'
          using errcode = '22023';
      end if;

      v_id := gen_random_uuid();
      insert into public.member_permission_overrides
        (id, organization_id, membership_id, permission_key, effect, reason,
         expires_at, created_by, created_at, scope_mode)
      values (v_id, v_org, p_membership, v_o->>'permission_key',
              upper(coalesce(v_o->>'effect','ALLOW')), btrim(v_o->>'reason'),
              nullif(v_o->>'expires_at','')::timestamptz, v_actor, now(),
              upper(coalesce(v_o->>'scope_mode','ORGANIZATION')));

      insert into public.member_override_scopes (organization_id, override_id, scope_id)
      select v_org, v_id, s.id
        from jsonb_array_elements_text(coalesce(v_o->'scope_ids','[]'::jsonb)) as t(sid)
        join public.authorization_scopes s on s.id = t.sid::uuid and s.organization_id = v_org;

      -- Kiểm hình dạng ở ĐÂY để báo lỗi tiếng Việt, thay vì để ràng buộc ném lỗi
      -- thô lúc COMMIT (lúc đó người dùng chỉ thấy mã 23514 khó hiểu).
      if upper(coalesce(v_o->>'scope_mode','ORGANIZATION')) = 'ORGANIZATION' then
        if (select count(*) from public.member_override_scopes x
             join public.authorization_scopes s2 on s2.id = x.scope_id
            where x.override_id = v_id and s2.scope_type = 'ORGANIZATION') <> 1
           or (select count(*) from public.member_override_scopes x where x.override_id = v_id) <> 1 then
          raise exception 'Ngoại lệ "%" áp cho toàn tổ chức thì chỉ được chọn đúng phạm vi "toàn tổ chức".',
            v_o->>'permission_key' using errcode = '22023';
        end if;
      else
        if (select count(*) from public.member_override_scopes x where x.override_id = v_id) = 0 then
          raise exception 'Ngoại lệ "%" phải chọn ít nhất một toà nhà, khu vực hoặc sổ quỹ.',
            v_o->>'permission_key' using errcode = '22023';
        end if;
        if exists (select 1 from public.member_override_scopes x
                    join public.authorization_scopes s2 on s2.id = x.scope_id
                   where x.override_id = v_id and s2.scope_type = 'ORGANIZATION') then
          raise exception 'Ngoại lệ "%" theo phạm vi hẹp thì không được chọn "toàn tổ chức".',
            v_o->>'permission_key' using errcode = '22023';
        end if;
      end if;
      v_n_ov := v_n_ov + 1;
    end loop;
  end if;

  update public.organization_memberships
     set version = version + 1
   where id = p_membership;

  -- Ảnh chụp quyền SAU.
  v_sau := app_private.allowed_keys_for_membership_v3(p_membership);

  select coalesce(array_agg(k order by k), '{}'::text[]) into v_them
    from (select unnest(v_sau) except select unnest(v_truoc)) t(k);
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_mat
    from (select unnest(v_truoc) except select unnest(v_sau)) t(k);

  perform app_private.append_authz_audit_v1(
    v_org, 'MEMBER_AUTHORIZATION_UPDATED', 'organization_membership', p_membership,
    jsonb_build_object('permissions', to_jsonb(v_truoc), 'version', v_ver),
    jsonb_build_object('permissions', to_jsonb(v_sau), 'version', v_ver + 1,
                       'role_bindings', v_n_bind, 'overrides', v_n_ov),
    v_reason);

  return jsonb_build_object(
    'membershipId', p_membership, 'version', v_ver + 1,
    'roleBindings', v_n_bind, 'overrides', v_n_ov,
    'permissionsBefore', coalesce(array_length(v_truoc, 1), 0),
    'permissionsAfter', coalesce(array_length(v_sau, 1), 0),
    'gained', to_jsonb(v_them), 'lost', to_jsonb(v_mat));
end
$fn$;

-- ---------------------------------------------------------------------------
-- 2) Mẫu vai trò
-- ---------------------------------------------------------------------------
create or replace function public.upsert_organization_role_v1(
  p_role_id          uuid    default null,
  p_name             text    default null,
  p_permissions      jsonb   default null,   -- [{"permission_key":"...","effect":"ALLOW|DENY"}]
  p_expected_version bigint  default null,
  p_reason           text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_id    uuid := p_role_id;
  v_row   public.organization_roles%rowtype;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_tao   boolean := (p_role_id is null);
  v_xau   text;
  v_nguoi int;
  v_cu    jsonb;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;

  if v_tao then
    -- Tổ chức của người tạo (thứ tự ổn định vì không có UNIQUE(org,user)).
    select m.organization_id into v_org
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
     where m.user_id = v_actor and m.status = 'ACTIVE'
     order by coalesce(o.is_demo,false), m.organization_id limit 1;
    if v_org is null then
      raise exception 'Bạn không thuộc tổ chức nào đang hoạt động.' using errcode = '42501';
    end if;
    if v_name is null then
      raise exception 'Hãy đặt tên cho vai trò.' using errcode = '22023';
    end if;
    if p_permissions is null then
      raise exception 'Vai trò mới phải chọn ít nhất một quyền (hoặc gửi danh sách rỗng nếu cố ý).'
        using errcode = '22023';
    end if;
  else
    select * into v_row from public.organization_roles where id = p_role_id;
    if not found then
      raise exception 'Không tìm thấy vai trò này.' using errcode = 'P0002';
    end if;
    v_org := v_row.organization_id;
  end if;

  perform app_private.require_perm_v1(v_org, 'users.edit', 'quản lý mẫu vai trò');

  if not v_tao then
    select * into v_row from public.organization_roles where id = p_role_id for update;
    if v_row.is_system then
      raise exception 'Vai trò hệ thống "%" không sửa được. Hãy nhân bản rồi sửa bản sao.', v_row.name
        using errcode = '42501';
    end if;
    if p_expected_version is null or v_row.version <> p_expected_version then
      raise exception 'Có người vừa đổi vai trò này. Hãy tải lại trang.' using errcode = '40001';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('permission_key', rp.permission_key, 'effect', rp.effect)
                              order by rp.permission_key), '[]'::jsonb)
      into v_cu from public.role_permissions rp where rp.role_id = p_role_id;
  end if;

  -- Kiểm khoá quyền TRƯỚC khi ghi, để báo lỗi rõ thay vì để FK/trigger ném lỗi thô.
  if p_permissions is not null then
    select string_agg(x.k, ', ') into v_xau
      from (select e->>'permission_key' as k from jsonb_array_elements(p_permissions) e) x
     where not exists (select 1 from public.permission_definitions pd
                        where pd.key = x.k and pd.is_active and pd.permission_domain = 'TENANT');
    if v_xau is not null then
      raise exception 'Các quyền sau không dùng được: %', v_xau using errcode = '22023';
    end if;
  end if;

  if v_tao then
    v_id := gen_random_uuid();
    insert into public.organization_roles (id, organization_id, name, is_system, version, created_at, status)
    values (v_id, v_org, v_name, false, 1, now(), 'ACTIVE');
  else
    update public.organization_roles
       set name = coalesce(v_name, name), version = version + 1
     where id = v_id;
  end if;

  if p_permissions is not null then
    delete from public.role_permissions where role_id = v_id;
    insert into public.role_permissions (organization_id, role_id, permission_key, effect)
    select distinct v_org, v_id, e->>'permission_key', upper(coalesce(e->>'effect','ALLOW'))
      from jsonb_array_elements(p_permissions) e;
  end if;

  select count(distinct rb.membership_id) into v_nguoi
    from public.role_bindings rb where rb.role_id = v_id and rb.valid_to is null;

  perform app_private.append_authz_audit_v1(
    v_org, case when v_tao then 'ROLE_CREATED' else 'ROLE_UPDATED' end,
    'organization_role', v_id, v_cu,
    jsonb_build_object('name', coalesce(v_name, v_row.name), 'permissions', p_permissions,
                       'affected_members', v_nguoi),
    nullif(btrim(coalesce(p_reason,'')), ''));

  return jsonb_build_object('roleId', v_id, 'created', v_tao,
    'version', (select version from public.organization_roles where id = v_id),
    'permissions', coalesce(jsonb_array_length(p_permissions), 0),
    'affectedMembers', v_nguoi);
end
$fn$;

-- ---------------------------------------------------------------------------
-- 3) Mời thành viên
--
-- Token: sinh ngẫu nhiên, chỉ lưu HASH. Trả token thô ĐÚNG MỘT LẦN để người gọi
-- gửi đi. Hệ thống hiện CHƯA có chỗ gửi email (đã grep: không edge function nào)
-- nên bước gửi phải làm thủ công hoặc bổ sung sau.
-- ---------------------------------------------------------------------------
create or replace function public.invite_organization_member_v1(
  p_email        text,
  p_member_type  text default 'STAFF',
  p_role_id      uuid default null,
  p_scope_ids    uuid[] default null,
  p_expires_days int  default 7
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private', 'extensions'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_type  text := upper(btrim(coalesce(p_member_type, 'STAFF')));
  v_token text;
  v_id    uuid := gen_random_uuid();
  v_days  int  := coalesce(p_expires_days, 7);
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Địa chỉ email không hợp lệ.' using errcode = '22023';
  end if;
  if v_type not in ('OWNER','STAFF','SHAREHOLDER','PARTNER','SERVICE') then
    raise exception 'Loại thành viên "%" không hợp lệ. Chọn: Chủ sở hữu, Nhân sự, Cổ đông, Đối tác hoặc Dịch vụ.', p_member_type
      using errcode = '22023';
  end if;
  if v_days < 1 or v_days > 30 then
    raise exception 'Hạn lời mời phải từ 1 đến 30 ngày.' using errcode = '22023';
  end if;

  select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
   where m.user_id = v_actor and m.status = 'ACTIVE'
   order by coalesce(o.is_demo,false), m.organization_id limit 1;
  if v_org is null then
    raise exception 'Bạn không thuộc tổ chức nào đang hoạt động.' using errcode = '42501';
  end if;

  perform app_private.require_perm_v1(v_org, 'users.create', 'mời thành viên');

  if p_role_id is not null and not exists (
       select 1 from public.organization_roles r where r.id = p_role_id and r.organization_id = v_org) then
    raise exception 'Vai trò không thuộc tổ chức này.' using errcode = '22023';
  end if;
  if p_scope_ids is not null and exists (
       select 1 from unnest(p_scope_ids) as t(sid)
        where not exists (select 1 from public.authorization_scopes s
                           where s.id = t.sid and s.organization_id = v_org)) then
    raise exception 'Có phạm vi không thuộc tổ chức này.' using errcode = '22023';
  end if;
  if exists (select 1 from public.organization_memberships m
               join auth.users u on u.id = m.user_id
              where m.organization_id = v_org and m.status = 'ACTIVE' and lower(u.email) = v_email) then
    raise exception 'Người này đã là thành viên của tổ chức.' using errcode = '23505';
  end if;

  -- Lời mời cũ còn hiệu lực: thu hồi rồi phát cái mới, tránh hai token cùng sống.
  update public.organization_invitations
     set status = 'REVOKED', revoked_at = now()
   where organization_id = v_org and email_normalized = v_email and status = 'PENDING';

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.organization_invitations
    (id, organization_id, email_normalized, token_hash, intended_member_type,
     intended_role_id, intended_scope_ids, invited_by, status, expires_at, created_at)
  values (v_id, v_org, v_email, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_type,
          p_role_id, coalesce(p_scope_ids, '{}'::uuid[]), v_actor, 'PENDING',
          now() + make_interval(days => v_days), now());

  perform app_private.append_authz_audit_v1(
    v_org, 'MEMBER_INVITED', 'organization_invitation', v_id, null,
    jsonb_build_object('member_type', v_type, 'role_id', p_role_id, 'expires_days', v_days), null);

  -- Token thô chỉ xuất hiện ở đây, đúng một lần.
  return jsonb_build_object('invitationId', v_id, 'token', v_token,
    'expiresAt', now() + make_interval(days => v_days),
    'note', 'Hệ thống chưa có chỗ gửi email — hãy gửi đường dẫn này cho người được mời.');
end
$fn$;

-- ---------------------------------------------------------------------------
-- 4) Chấp nhận lời mời
-- ---------------------------------------------------------------------------
create or replace function public.accept_organization_invitation_v1(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private', 'extensions'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_email text;
  v_inv   public.organization_invitations%rowtype;
  v_memb  uuid := gen_random_uuid();
  v_bind  uuid;
begin
  if v_actor is null then
    raise exception 'Hãy đăng nhập bằng đúng email đã nhận lời mời, rồi mở lại đường dẫn.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_token,'')), '') is null then
    raise exception 'Thiếu mã lời mời.' using errcode = '22023';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_actor;
  if v_email is null then
    raise exception 'Tài khoản của bạn chưa có email nên không nhận lời mời được.' using errcode = '42501';
  end if;

  select * into v_inv from public.organization_invitations
   where token_hash = encode(extensions.digest(btrim(p_token), 'sha256'), 'hex')
   for update;
  if not found then
    raise exception 'Lời mời không tồn tại. Hãy sao chép lại đường dẫn hoặc xin mời lại.'
      using errcode = 'P0002';
  end if;

  -- Kiểm email TRƯỚC vòng đời: không tiết lộ trạng thái lời mời cho người lạ.
  if v_inv.email_normalized <> v_email then
    raise exception 'Lời mời này dành cho một địa chỉ email khác.' using errcode = '42501';
  end if;
  if v_inv.status <> 'PENDING' then
    raise exception 'Lời mời này đã được dùng hoặc đã bị thu hồi.' using errcode = '55000';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'Lời mời đã hết hạn. Hãy xin người quản lý mời lại.' using errcode = '55000';
  end if;
  if exists (select 1 from public.organization_memberships m
              where m.organization_id = v_inv.organization_id
                and m.user_id = v_actor and m.status = 'ACTIVE') then
    raise exception 'Bạn đã là thành viên của tổ chức này rồi.' using errcode = '23505';
  end if;

  insert into public.organization_memberships
    (id, organization_id, user_id, member_type, status, valid_from, invited_by, activated_at, version)
  values (v_memb, v_inv.organization_id, v_actor, v_inv.intended_member_type, 'ACTIVE',
          now(), v_inv.invited_by, now(), 1);

  if v_inv.intended_role_id is not null then
    v_bind := gen_random_uuid();
    insert into public.role_bindings (id, organization_id, membership_id, role_id, valid_from, version)
    values (v_bind, v_inv.organization_id, v_memb, v_inv.intended_role_id, now(), 1);
    insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
    select v_inv.organization_id, v_bind, s.id
      from unnest(v_inv.intended_scope_ids) as t(sid)
      join public.authorization_scopes s on s.id = t.sid and s.organization_id = v_inv.organization_id;
  end if;

  update public.organization_invitations
     set status = 'ACCEPTED', accepted_by = v_actor
   where id = v_inv.id;

  perform app_private.append_authz_audit_v1(
    v_inv.organization_id, 'INVITATION_ACCEPTED', 'organization_membership', v_memb, null,
    jsonb_build_object('member_type', v_inv.intended_member_type, 'role_id', v_inv.intended_role_id), null);

  return jsonb_build_object('membershipId', v_memb, 'organizationId', v_inv.organization_id,
                            'memberType', v_inv.intended_member_type);
end
$fn$;

revoke all on function public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text) from public, anon;
revoke all on function public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text) from public, anon;
revoke all on function public.invite_organization_member_v1(text,text,uuid,uuid[],int) from public, anon;
revoke all on function public.accept_organization_invitation_v1(text) from public, anon;
grant execute on function public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text) to authenticated;
grant execute on function public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text) to authenticated;
grant execute on function public.invite_organization_member_v1(text,text,uuid,uuid[],int) to authenticated;
grant execute on function public.accept_organization_invitation_v1(text) to authenticated;

commit;
