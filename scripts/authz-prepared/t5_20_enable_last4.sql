-- t5_20 — BẬT NỐT 4 WRITER CUỐI (go-live đợt 2, 2026-07-19)
--   1) GRANT EXECUTE 3 writer đã sẵn nhưng chưa cấp: contract.create /
--      deposit.hold / invoice.reverse_payment (opening_adjust đã granted từ trước).
--   2) Possession infra cho cashbooks.post (requires_cashbook_possession):
--      owner ("Chủ sở hữu tổ chức") của MỖI org được edge CASHBOOK
--      (member_permission_overrides SCOPED + authorization_scopes) + binding
--      CUSTODIAN trên MỌI sổ quỹ live hiện có → mở khoá
--      request_opening_balance_adjustment_v1 (trước đây 42501 với mọi user vì
--      bảng possession trống).
--   3) create_cashbook_v1: auto-bind CUSTODIAN + edge cho NGƯỜI PHỤ TRÁCH sổ
--      (v_owner) ngay khi tạo sổ mới — sổ tương lai không cần seed tay.
--   4) Flip 4 flag → ON làm ở bước CAS riêng (set_feature_route_v1), không nằm
--      trong file này.
-- An toàn: chỉ CỘNG quyền hẹp (edge scoped từng sổ + possession), không đổi
-- role rộng; mọi INSERT đều idempotent (kiểm tra tồn tại trước).

begin;

-- ========== 1) GRANTS ==========
grant execute on function public.create_contract_v1(uuid,uuid[],date,date,date,numeric,numeric,jsonb,jsonb,text) to authenticated;
grant execute on function public.create_reservation_deposit_v1(uuid,numeric,text) to authenticated;
grant execute on function public.reverse_invoice_payment_v3(uuid,text,text) to authenticated;

-- ========== 2) POSSESSION SEED: owner = CUSTODIAN mọi sổ hiện có ==========
do $$
declare
  r record; v_scope uuid; v_ovr uuid;
begin
  for r in
    select a.id as cashbook_id, a.organization_id, m.membership_id, m.user_id
      from public.accounts a
      join lateral (
        select om.id as membership_id, om.user_id
          from public.organization_memberships om
          join public.role_bindings rb
            on rb.organization_id = om.organization_id and rb.membership_id = om.id
          join public.organization_roles orr
            on orr.id = rb.role_id and orr.name = 'Chủ sở hữu tổ chức'
         where om.organization_id = a.organization_id and om.status = 'ACTIVE'
         order by om.id limit 1
      ) m on true
     where a.deleted_at is null and a.organization_id is not null
  loop
    select s.id into v_scope from public.authorization_scopes s
     where s.organization_id = r.organization_id
       and s.scope_type = 'CASHBOOK' and s.cashbook_id = r.cashbook_id
     limit 1;
    if v_scope is null then
      insert into public.authorization_scopes (organization_id, scope_type, cashbook_id)
      values (r.organization_id, 'CASHBOOK', r.cashbook_id)
      returning id into v_scope;
    end if;

    select o.id into v_ovr from public.member_permission_overrides o
     where o.organization_id = r.organization_id and o.membership_id = r.membership_id
       and o.permission_key = 'cashbooks.post' and o.effect = 'ALLOW'
       and o.revoked_at is null
     limit 1;
    if v_ovr is null then
      insert into public.member_permission_overrides
        (organization_id, membership_id, permission_key, effect, scope_mode, reason)
      values (r.organization_id, r.membership_id, 'cashbooks.post', 'ALLOW', 'SCOPED',
              't5_20: owner giữ quỹ — điều chỉnh đầu kỳ sổ quỹ')
      returning id into v_ovr;
    end if;

    insert into public.member_override_scopes (organization_id, override_id, scope_id)
    select r.organization_id, v_ovr, v_scope
     where not exists (select 1 from public.member_override_scopes x
                        where x.organization_id = r.organization_id
                          and x.override_id = v_ovr and x.scope_id = v_scope);

    insert into public.cashbook_possession_bindings
      (organization_id, cashbook_id, membership_id, possession_kind, valid_from, granted_by, reason)
    select r.organization_id, r.cashbook_id, r.membership_id, 'CUSTODIAN', now(), r.user_id,
           't5_20 seed: owner là người giữ quỹ mặc định'
     where not exists (select 1 from public.cashbook_possession_bindings b
                        where b.cashbook_id = r.cashbook_id
                          and b.membership_id = r.membership_id and b.valid_to is null);
  end loop;
end $$;

-- ========== 3) create_cashbook_v1: auto-bind possession cho người phụ trách ==========
create or replace function public.create_cashbook_v1(
  p_name text, p_initial_amount numeric, p_initial_date date, p_bank_name text,
  p_account_number text, p_quick_default_building_id uuid, p_idempotency_key text,
  p_description text default null, p_is_default boolean default false,
  p_owner_user_id uuid default null)
 returns json language plpgsql security definer
 set search_path to 'pg_catalog', 'public', 'app_private'
as $function$
declare
  v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_owner uuid;
  v_key text; v_hash text; v_op app_private.canonical_write_operations%rowtype;
  v_route text; v_id uuid; v_resp json;
  v_memb uuid; v_scope uuid; v_ovr uuid;
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

  select m.organization_id into v_org from public.organization_memberships m
   where m.user_id=v_actor and m.status='ACTIVE' group by m.organization_id having count(*)=1;
  if v_org is null then raise exception 'Không xác định được tổ chức duy nhất của người dùng' using errcode='42501'; end if;

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

commit;
