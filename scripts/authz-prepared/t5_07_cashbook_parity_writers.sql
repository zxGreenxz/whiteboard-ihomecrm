-- ============================================================================
-- T5 §domain-cashbook PREPARED SQL — parity extend create + update metadata + share.
-- STATUS: APPLIED production 2026-07-18 (cashbook-domain cutover).
-- LÝ DO: create_cashbook_v1 âm thầm bỏ description/is_default/user_id (silent data
--   loss nếu wire). Thiếu update_cashbook_metadata_v1 + set_cashbook_shared_users_v1.
--   Extend create parity + viết 2 writer. Permission theo mẫu lock_cashbook_period_v1
--   (cashbooks.edit + possession scope). initial_amount: giữ hành vi legacy (cập
--   nhật trực tiếp) — faithful cutover, KHÔNG đổi thành compensating-voucher ở đây.
-- ============================================================================

begin;

-- 1. Extend create_cashbook_v1 với description/is_default/owner_user_id (parity).
--    Writer cũ chưa wire (flag OFF) nên drop+recreate an toàn.
drop function if exists public.create_cashbook_v1(text,numeric,date,text,text,uuid,text);
create or replace function public.create_cashbook_v1(
  p_name text, p_initial_amount numeric, p_initial_date date, p_bank_name text,
  p_account_number text, p_quick_default_building_id uuid, p_idempotency_key text,
  p_description text default null, p_is_default boolean default false,
  p_owner_user_id uuid default null
) returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private' as $fn$
declare
  v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_owner uuid;
  v_key text; v_hash text; v_op app_private.canonical_write_operations%rowtype;
  v_route text; v_id uuid; v_resp json;
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

  v_resp := json_build_object('cashbook_id', v_id);
  update app_private.canonical_write_operations
     set completed_at=now(), subject_id=v_id, response_payload=v_resp::jsonb
   where organization_id=v_org and operation=c_op and subject_scope=v_org::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid) from public, anon, authenticated, service_role;

-- 2. update_cashbook_metadata_v1 — sửa metadata (name/description/initial/owner/
--    is_default/quick-default). cashbooks.edit + possession (mẫu lock).
create or replace function public.update_cashbook_metadata_v1(
  p_cashbook_id uuid, p_name text, p_description text, p_initial_amount numeric,
  p_initial_date date, p_quick_default_building_id uuid, p_is_default boolean,
  p_owner_user_id uuid
) returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private' as $fn$
declare v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_owner uuid;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select organization_id into v_org from public.accounts where id=p_cashbook_id and deleted_at is null;
  if v_org is null then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.edit', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền sửa sổ quỹ (cashbooks.edit)' using errcode='42501'; end if;
  if p_name is not null and length(btrim(p_name))=0 then raise exception 'Tên sổ quỹ trống'; end if;

  v_owner := p_owner_user_id;
  if v_owner is not null and v_owner <> (select user_id from public.accounts where id=p_cashbook_id) then
    perform 1 from public.organization_memberships m
      where m.user_id=v_owner and m.organization_id=v_org and m.status='ACTIVE';
    if not found then raise exception 'Người phụ trách không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  if coalesce(p_is_default,false) then
    update public.accounts set is_default=false
     where organization_id=v_org and is_default=true and deleted_at is null and id<>p_cashbook_id;
  end if;

  update public.accounts set
    name = coalesce(nullif(btrim(p_name),''), name),
    description = case when p_description is null then description else nullif(btrim(p_description),'') end,
    initial_amount = coalesce(p_initial_amount, initial_amount),
    initial_date = coalesce(p_initial_date, initial_date),
    quick_default_building_id = p_quick_default_building_id,
    is_default = coalesce(p_is_default, is_default),
    user_id = coalesce(v_owner, user_id),
    updated_at = now()
  where id = p_cashbook_id;
  return json_build_object('cashbook_id', p_cashbook_id);
end;
$fn$;
revoke all on function public.update_cashbook_metadata_v1(uuid,text,text,numeric,date,uuid,boolean,uuid) from public, anon, authenticated, service_role;

-- 3. set_cashbook_shared_users_v1 — đặt danh sách user được chia sẻ sổ (set-semantics).
--    cashbooks.share + possession. Mọi user phải là member ACTIVE cùng org.
create or replace function public.set_cashbook_shared_users_v1(
  p_cashbook_id uuid, p_user_ids uuid[]
) returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private' as $fn$
declare v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_uid uuid; v_bad int;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select organization_id into v_org from public.accounts where id=p_cashbook_id and deleted_at is null;
  if v_org is null then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.share', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chia sẻ sổ quỹ (cashbooks.share)' using errcode='42501'; end if;

  -- validate mọi user cùng org
  select count(*) into v_bad from unnest(coalesce(p_user_ids,array[]::uuid[])) u(id)
    where not exists (select 1 from public.organization_memberships m
                       where m.user_id=u.id and m.organization_id=v_org and m.status='ACTIVE');
  if v_bad > 0 then raise exception 'Có % người dùng không thuộc tổ chức', v_bad using errcode='42501'; end if;

  delete from public.account_shared_users
   where account_id=p_cashbook_id
     and user_id <> all(coalesce(p_user_ids, array[]::uuid[]));
  foreach v_uid in array coalesce(p_user_ids, array[]::uuid[]) loop
    insert into public.account_shared_users (account_id, user_id, created_by, organization_id)
    values (p_cashbook_id, v_uid, v_actor, v_org)
    on conflict do nothing;
  end loop;
  return json_build_object('cashbook_id', p_cashbook_id, 'shared_count', coalesce(array_length(p_user_ids,1),0));
end;
$fn$;
revoke all on function public.set_cashbook_shared_users_v1(uuid,uuid[]) from public, anon, authenticated, service_role;

commit;
