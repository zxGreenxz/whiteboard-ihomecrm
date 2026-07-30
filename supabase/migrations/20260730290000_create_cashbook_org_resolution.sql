-- =============================================================================
-- create_cashbook_v1: thôi ĐOÁN tổ chức
-- =============================================================================
-- BUG (prod, phát hiện 30/07/2026): hàm suy ra org của sổ quỹ mới bằng
--
--     select m.organization_id into v_org from public.organization_memberships m
--      where m.user_id=v_actor and m.status='ACTIVE'
--      group by m.organization_id having count(*)=1;
--
-- `having count(*)=1` đếm số MEMBERSHIP TRONG TỪNG ORG, không đếm SỐ ORG. Người
-- có 1 membership ở mỗi org × N org thì mọi nhóm đều thoả → query trả N dòng, và
-- `select … into` (không `strict`) lặng lẽ lấy DÒNG ĐẦU do planner trả về.
--
-- Hậu quả đã đo trên prod với tài khoản chủ (2 org ACTIVE: org thật + org DEMO):
--   * v_org bắt được `dddd…0001` (DEMO) trong khi người dùng đang đứng ở org thật.
--   * authorize_tenant_action_v3(actor, DEMO,  'cashbooks.create') → DEFAULT_DENY
--     authorize_tenant_action_v3(actor, THẬT, 'cashbooks.create') → ROLE_ALLOW
--   → UI báo "Không có quyền tạo sổ quỹ (cashbooks.create)" dù quyền ĐỦ. Deny này
--     vô tình chặn được điều tệ hơn: tạo sổ quỹ vào SAI TỔ CHỨC.
--
-- Đây là hàm plpgsql DUY NHẤT trong DB dùng lối đoán này — 23 RPC sổ quỹ còn lại
-- đều nhận `p_cashbook_id` nên lấy org từ chính sổ. Chỉ hàm TẠO không có mốc neo.
--
-- THỨ TỰ QUYẾT ĐỊNH MỚI (không nhánh nào đoán):
--   1) `p_organization_id` truyền tường minh (tham số MỚI, mặc định NULL).
--   2) Đúng MỘT org ACTIVE  → dùng luôn. Giữ nguyên hành vi cho 9/10 người dùng
--      hiện tại nên không có regress.
--   3) Nhiều org ACTIVE     → `profiles.organization_id` ("org đang chọn" theo
--      đúng hợp đồng đã ghi trong app_private.resolve_ie_type_org_for_user_v1),
--      NHƯNG chỉ khi nó khớp một membership ACTIVE.
--   4) Còn nhập nhằng       → RAISE, đòi chỉ rõ org. Không bao giờ chọn bừa.
--
-- ⚠ VÌ SAO KHÔNG TIN `profiles.organization_id` Ở NHÁNH 2: trên prod 6/10 profile
--   có `organization_id` = org THẬT trong khi membership ACTIVE duy nhất của họ ở
--   org DEMO (toàn bộ tài khoản DEMO). Cột đó là giá trị mặc định sót lại, không
--   phải lựa chọn thật của người dùng. Membership phải thắng khi nó không nhập
--   nhằng; profile chỉ dùng để phá thế hoà của người nhiều org.
--
-- Đổi chữ ký nên phải DROP rồi CREATE. Đã kiểm: không có object nào depend
-- (pg_depend rỗng), không hàm nào khác gọi tới, chỉ tồn tại 1 overload → an toàn.
-- Grant được cấp lại nguyên trạng trong cùng transaction.
--
-- Giữ VOLATILE (mặc định plpgsql): thân hàm lấy khoá dòng (`for share`,
-- `for update`, `lock_org_for_decision_v1`) nên khai STABLE sẽ ném 25006 khi gọi
-- qua PostgREST. Xem cảnh báo trong CLAUDE.md.
-- =============================================================================

begin;

drop function if exists public.create_cashbook_v1(
  text, numeric, date, text, text, uuid, text, text, boolean, uuid);

create function public.create_cashbook_v1(
  p_name text,
  p_initial_amount numeric,
  p_initial_date date,
  p_bank_name text,
  p_account_number text,
  p_quick_default_building_id uuid,
  p_idempotency_key text,
  p_description text default null::text,
  p_is_default boolean default false,
  p_owner_user_id uuid default null::uuid,
  p_organization_id uuid default null::uuid
) returns json
  language plpgsql
  security definer
  set search_path to 'pg_catalog', 'public', 'app_private'
as $function$
declare
  v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_owner uuid;
  v_key text; v_hash text; v_op app_private.canonical_write_operations%rowtype;
  v_route text; v_id uuid; v_resp json;
  v_memb uuid; v_scope uuid; v_ovr uuid;
  v_org_count int;
  c_op constant text := 'cashbook.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if coalesce(length(btrim(p_name)),0)=0 then raise exception 'Tên sổ quỹ trống'; end if;
  if p_initial_amount is null or round(p_initial_amount,2) <> p_initial_amount then
    raise exception 'Số dư đầu không hợp lệ'; end if;
  if p_initial_date is null then raise exception 'Ngày đầu kỳ trống'; end if;

  -- Org của sổ mới — xem đầu file. Không nhánh nào được chọn bừa.
  select count(distinct m.organization_id) into v_org_count
    from public.organization_memberships m
   where m.user_id=v_actor and m.status='ACTIVE';
  if coalesce(v_org_count,0) = 0 then
    raise exception 'Người dùng không thuộc tổ chức nào đang hoạt động' using errcode='42501'; end if;

  if p_organization_id is not null then
    v_org := p_organization_id;
  elsif v_org_count = 1 then
    select distinct m.organization_id into v_org
      from public.organization_memberships m
     where m.user_id=v_actor and m.status='ACTIVE';
  else
    -- Nhiều org: chỉ profiles.organization_id được phá thế hoà, và phải khớp
    -- một membership ACTIVE — profile org sai/mốc thì coi như không có.
    select p.organization_id into v_org
      from public.profiles p
     where p.id=v_actor
       and p.organization_id is not null
       and exists (select 1 from public.organization_memberships m
                    where m.user_id=v_actor and m.status='ACTIVE'
                      and m.organization_id=p.organization_id);
    if v_org is null then
      raise exception 'Bạn thuộc % tổ chức đang hoạt động; phải chỉ rõ tổ chức tạo sổ quỹ (p_organization_id)',
        v_org_count using errcode='42501'; end if;
  end if;

  -- Chốt chặn chung: dù org đến từ nhánh nào, actor phải là member ACTIVE của nó.
  -- Đây là thứ khiến p_organization_id không thành đường ghi chéo tổ chức.
  perform 1 from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE';
  if not found then
    raise exception 'Bạn không thuộc tổ chức được chỉ định' using errcode='42501'; end if;

  -- owner: admin có thể gán người phụ trách khác, phải là member ACTIVE cùng org.
  v_owner := coalesce(p_owner_user_id, v_actor);
  if v_owner <> v_actor then
    perform 1 from public.organization_memberships m
      where m.user_id=v_owner and m.organization_id=v_org and m.status='ACTIVE';
    if not found then raise exception 'Người phụ trách không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  if p_quick_default_building_id is not null then
    perform 1 from public.buildings b where b.id=p_quick_default_building_id
      and b.deleted_at is null and b.organization_id=v_org for share;
    if not found then raise exception 'Toà nhà mặc định không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.create', null, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo sổ quỹ (cashbooks.create)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('name',p_name,'org',v_org,'init',p_initial_amount,'date',p_initial_date,'owner',v_owner)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, v_org::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=v_org::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer sổ quỹ chưa bật' using errcode='55000'; end if;

  -- default duy nhất: nếu tạo sổ default, bỏ default các sổ khác cùng org.
  if coalesce(p_is_default,false) then
    update public.accounts set is_default=false
     where organization_id=v_org and is_default=true and deleted_at is null;
  end if;

  insert into public.accounts
    (user_id, organization_id, name, description, initial_amount, initial_date,
     is_default, is_virtual, bank_name, account_number, quick_default_building_id)
  values (v_owner, v_org, btrim(p_name), nullif(btrim(p_description),''),
          p_initial_amount, p_initial_date, coalesce(p_is_default,false), false,
          nullif(btrim(p_bank_name),''), nullif(btrim(p_account_number),''),
          p_quick_default_building_id)
  returning id into v_id;

  -- t5_20 auto-bind: người phụ trách sổ = CUSTODIAN + edge CASHBOOK (mở khoá
  -- cashbooks.post/điều chỉnh đầu kỳ cho sổ MỚI mà không cần seed tay).
  select m.id into v_memb from public.organization_memberships m
   where m.user_id=v_owner and m.organization_id=v_org and m.status='ACTIVE' limit 1;
  if v_memb is not null then
    insert into public.authorization_scopes (organization_id, scope_type, cashbook_id)
    values (v_org, 'CASHBOOK', v_id) returning id into v_scope;

    select o.id into v_ovr from public.member_permission_overrides o
     where o.organization_id=v_org and o.membership_id=v_memb
       and o.permission_key='cashbooks.post' and o.effect='ALLOW' and o.revoked_at is null
     limit 1;
    if v_ovr is null then
      insert into public.member_permission_overrides
        (organization_id, membership_id, permission_key, effect, scope_mode, reason)
      values (v_org, v_memb, 'cashbooks.post', 'ALLOW', 'SCOPED',
              'auto-bind khi tạo sổ quỹ (người phụ trách)')
      returning id into v_ovr;
    end if;
    insert into public.member_override_scopes (organization_id, override_id, scope_id)
    select v_org, v_ovr, v_scope
     where not exists (select 1 from public.member_override_scopes x
                        where x.organization_id=v_org and x.override_id=v_ovr and x.scope_id=v_scope);

    insert into public.cashbook_possession_bindings
      (organization_id, cashbook_id, membership_id, possession_kind, valid_from, granted_by, reason)
    values (v_org, v_id, v_memb, 'CUSTODIAN', now(), v_actor, 'auto-bind khi tạo sổ quỹ');
  end if;

  v_resp := json_build_object('cashbook_id', v_id);
  update app_private.canonical_write_operations
     set completed_at=now(), subject_id=v_id, response_payload=v_resp::jsonb
   where organization_id=v_org and operation=c_op and subject_scope=v_org::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

-- Cấp lại y nguyên ACL cũ (postgres=X, authenticated=X) sau khi DROP.
--
-- ⚠ BẮT BUỘC REVOKE anon/service_role: `create or replace` giữ ACL cũ, nhưng
--   DROP + CREATE tạo hàm MỚI nên nó hứng `ALTER DEFAULT PRIVILEGES` của Supabase
--   trên schema public (grant execute cho anon, authenticated, service_role). Nếu
--   không dọn, hàm ghi tiền này lộ EXECUTE cho `anon` — thực tế chưa khai thác được
--   vì auth.uid() null sẽ ném 'Chưa đăng nhập', nhưng vẫn lệch khỏi ACL đã chốt.
--   `revoke ... from public` KHÔNG dọn được vì đây là grant cho role cụ thể.
revoke all on function public.create_cashbook_v1(
  text, numeric, date, text, text, uuid, text, text, boolean, uuid, uuid) from public;
revoke all on function public.create_cashbook_v1(
  text, numeric, date, text, text, uuid, text, text, boolean, uuid, uuid) from anon;
revoke all on function public.create_cashbook_v1(
  text, numeric, date, text, text, uuid, text, text, boolean, uuid, uuid) from service_role;
grant execute on function public.create_cashbook_v1(
  text, numeric, date, text, text, uuid, text, text, boolean, uuid, uuid) to authenticated;

commit;
