-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.create_contract_v1(p_room_id uuid, p_customer_ids uuid[], p_signed_date date, p_start_date date, p_end_date date, p_rent_price numeric, p_total_deposit numeric, p_services jsonb, p_first_invoice jsonb, p_idempotency_key text) md5(prosrc)=8352f91f7aea53188674f7fbd75d7813
CREATE OR REPLACE FUNCTION public.create_contract_v1(p_room_id uuid, p_customer_ids uuid[], p_signed_date date, p_start_date date, p_end_date date, p_rent_price numeric, p_total_deposit numeric, p_services jsonb, p_first_invoice jsonb, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_contract uuid; v_cust uuid; v_svc jsonb; v_inv json := null;
  v_resp json;
  c_op constant text := 'contract.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
    raise exception 'Ngày hợp đồng không hợp lệ'; end if;
  if p_rent_price is null or p_rent_price < 0 then raise exception 'Giá thuê không hợp lệ'; end if;
  if p_customer_ids is null or array_length(p_customer_ids,1) is null then
    raise exception 'Cần ít nhất một khách hàng'; end if;

  -- room → building → org; room locked FOR NO KEY UPDATE.
  select r.building_id into v_building from public.rooms r
   where r.id=p_room_id and r.deleted_at is null for no key update;
  if not found then raise exception 'Không tìm thấy phòng' using errcode='42501'; end if;
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=v_building and b.deleted_at is null for share of o,b;
  if v_org is null then raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'contracts.create', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hợp đồng (contracts.create)' using errcode='42501'; end if;

  -- validate customers same-org.
  foreach v_cust in array p_customer_ids loop
    perform 1 from public.customers cu where cu.id=v_cust
      and (cu.organization_id is null or cu.organization_id=v_org) for share;
    if not found then raise exception 'Khách hàng không thuộc tổ chức' using errcode='42501'; end if;
  end loop;

  v_hash := md5(jsonb_build_object('room',p_room_id,'org',v_org,'start',p_start_date,
    'rent',p_rent_price)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_room_id::text || '|' || p_start_date::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_room_id::text || '|' || p_start_date::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  -- idempotency replay BEFORE the business guard, so a legitimate retry returns
  -- the original contract instead of tripping "room already has a contract".
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  -- guard: room must not already be OCCUPIED by an ACTIVE contract (a NEW claim).
  if exists (select 1 from public.contracts c
             where c.room_id=p_room_id and c.deleted_at is null and c.status='ACTIVE') then
    raise exception 'Phòng đã có hợp đồng đang hiệu lực' using errcode='55000'; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer hợp đồng chưa bật' using errcode='55000'; end if;

  -- create the contract (org auto-fills via trigger; public_code auto).
  insert into public.contracts
    (user_id, organization_id, room_id, signed_date, start_date, end_date,
     rent_price, total_deposit, status)
  values (v_actor, v_org, p_room_id, coalesce(p_signed_date,p_start_date),
          p_start_date, p_end_date, p_rent_price, coalesce(p_total_deposit,0), 'ACTIVE')
  returning id into v_contract;

  foreach v_cust in array p_customer_ids loop
    insert into public.contract_customers (contract_id, customer_id)
    values (v_contract, v_cust) on conflict do nothing;
  end loop;

  if p_services is not null and jsonb_typeof(p_services)='array' then
    for v_svc in select value from jsonb_array_elements(p_services) loop
      insert into public.contract_services (contract_id, service_id, unit_price)
      values (v_contract, (v_svc->>'service_id')::uuid, coalesce((v_svc->>'unit_price')::numeric,0));
    end loop;
  end if;

  -- optional first invoice via the canonical invoice writer (reuse t5_02).
  if p_first_invoice is not null then
    v_inv := public.create_invoice_v1(
      v_contract, v_building, p_room_id,
      p_first_invoice->>'billing_month',
      coalesce(nullif(p_first_invoice->>'issue_date','')::date, public.org_today_v1(NULL)),
      coalesce(nullif(p_first_invoice->>'due_date','')::date, public.org_today_v1(NULL) + 15),
      'MONTHLY',
      coalesce((p_first_invoice->>'subtotal')::numeric,0), 0,
      coalesce((p_first_invoice->>'total_amount')::numeric,0), 0,
      coalesce(p_first_invoice->'items','[]'::jsonb),
      v_key || '-inv');
  end if;

  -- consume any live 24h hold on the room (link it to the contract).
  update public.room_reservation_holds
     set status='APPROVED', contract_id=v_contract
   where room_id=p_room_id and status='PENDING_APPROVAL';

  -- room OCCUPIED as the LAST mutation (dominates recompute_room_reservation).
  update public.rooms set status='OCCUPIED' where id=p_room_id;

  v_resp := json_build_object('contract_id', v_contract, 'first_invoice', v_inv);
  update app_private.canonical_write_operations
     set subject_id=v_contract, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_room_id::text || '|' || p_start_date::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$

