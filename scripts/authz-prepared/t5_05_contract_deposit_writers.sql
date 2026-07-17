-- ============================================================================
-- T5 PREPARED SQL 05 — Contract + 24h exclusive deposit-hold writers (§4.5).
-- STATUS: PREPARED / flag-OFF / non-routed. Not a migration. No EXECUTE grant.
-- useCreateContract stays on direct DML until canary.
--
-- Grounded:
--  contracts NOT NULL {user_id, signed_date, start_date, end_date, rent_price,
--    public_code}; public_code auto via trg_set_contract_public_code; org auto
--    via trg_autofill_org; contracts has NO building_id — link via room.
--  contract_customers NOT NULL {contract_id, customer_id};
--  contract_services NOT NULL {contract_id, service_id, unit_price}.
--  rooms.status enum AVAILABLE/OCCUPIED/RESERVED/...; recompute_room_reservation
--    (AFTER UPDATE OF status ON rooms) → lock-upgrade deadlock hazard, so we lock
--    the room FOR NO KEY UPDATE and set OCCUPIED as the LAST mutation.
--  24h exclusive hold does NOT exist today (deposits table dead) → additive
--    public.room_reservation_holds with a btree_gist exclusion constraint =
--    at most one live hold-window per room (self-expiring, no sweep needed).
--  First invoice reuses create_invoice_v1 (t5_02). Permissions contracts.create,
--    deposits.create (both applied).
-- ============================================================================

begin;

create extension if not exists btree_gist;

insert into app_private.server_feature_flags
  (feature_key, domain, risk_class, mode, config_version,
   max_operation_count, max_single_amount_vnd, max_total_amount_vnd)
values
  ('contract.create.v1', 'CONTRACT', 'MONEY', 'OFF', 1, 0, 0, 0),
  ('deposit.hold.v1', 'DEPOSIT', 'MONEY', 'OFF', 1, 0, 0, 0)
on conflict (feature_key) do nothing;

-- ---------------------------------------------------------------------------
-- Additive: 24h exclusive room-reservation hold with no-double-hold exclusion.
-- ---------------------------------------------------------------------------
create table if not exists public.room_reservation_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  building_id uuid not null references public.buildings(id),
  room_id uuid not null references public.rooms(id),
  amount numeric(15,2) not null check (amount > 0),
  status text not null default 'PENDING_APPROVAL'
    check (status in ('PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED','EXPIRED')),
  held_by uuid not null,
  held_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  contract_id uuid references public.contracts(id),
  idempotency_key text,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > held_at)
);

-- No double-hold: at most ONE live hold-window per room. Only LIVE holds
-- (PENDING_APPROVAL/APPROVED) participate; a new hold whose window starts after
-- the previous expired does not overlap → self-expiring, no sweep required.
alter table public.room_reservation_holds
  drop constraint if exists room_reservation_holds_no_overlap;
alter table public.room_reservation_holds
  add constraint room_reservation_holds_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(held_at, expires_at) with &&
  ) where (status in ('PENDING_APPROVAL','APPROVED'));

alter table public.room_reservation_holds enable row level security;
drop policy if exists room_holds_select_super on public.room_reservation_holds;
create policy room_holds_select_super on public.room_reservation_holds
  for select to authenticated using (public.is_super_admin());
revoke all on public.room_reservation_holds from public, anon, authenticated, service_role;
grant select on public.room_reservation_holds to authenticated;

-- ---------------------------------------------------------------------------
-- A — create_reservation_deposit_v1: 24h exclusive server-time hold.
-- ---------------------------------------------------------------------------
create or replace function public.create_reservation_deposit_v1(
  p_room_id uuid,
  p_amount numeric,
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_hold uuid; v_resp json;
  c_op constant text := 'deposit.hold.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền cọc không hợp lệ'; end if;

  -- room → building → org; lock the room FOR NO KEY UPDATE (avoid the reconcile
  -- lock-upgrade deadlock).
  select r.building_id into v_building from public.rooms r
   where r.id=p_room_id and r.deleted_at is null for no key update;
  if not found then raise exception 'Không tìm thấy phòng' using errcode='42501'; end if;
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=v_building and b.deleted_at is null for share of o,b;
  if v_org is null then raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'deposits.create', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền đặt cọc giữ chỗ (deposits.create)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('room',p_room_id,'org',v_org,'amount',p_amount)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_room_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_room_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer cọc giữ chỗ chưa bật' using errcode='55000'; end if;

  -- the exclusion constraint enforces no-double-hold; a concurrent live hold on
  -- the same room raises 23P01 (exclusion_violation) → surface as "đã có cọc giữ".
  begin
    insert into public.room_reservation_holds
      (organization_id, building_id, room_id, amount, held_by, expires_at)
    values (v_org, v_building, p_room_id, p_amount, v_actor,
            clock_timestamp() + interval '24 hours')
    returning id into v_hold;
  exception when exclusion_violation then
    raise exception 'Phòng đang có cọc giữ chỗ còn hiệu lực' using errcode='55000';
  end;

  v_resp := json_build_object('hold_id', v_hold, 'room_id', p_room_id,
    'expires_at', (clock_timestamp() + interval '24 hours'));
  update app_private.canonical_write_operations
     set subject_id=v_hold, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_room_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.create_reservation_deposit_v1(uuid, numeric, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- B — create_contract_v1: atomic contract + customers + services + first invoice
-- (via create_invoice_v1) + room OCCUPIED as the LAST mutation.
-- ---------------------------------------------------------------------------
create or replace function public.create_contract_v1(
  p_room_id uuid,
  p_customer_ids uuid[],
  p_signed_date date,
  p_start_date date,
  p_end_date date,
  p_rent_price numeric,
  p_total_deposit numeric,
  p_services jsonb,           -- [{service_id, unit_price}]
  p_first_invoice jsonb,      -- {billing_month, issue_date, due_date, subtotal, total_amount, items:[...]} or null
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
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
      coalesce(nullif(p_first_invoice->>'issue_date','')::date, current_date),
      coalesce(nullif(p_first_invoice->>'due_date','')::date, current_date + 15),
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
$fn$;
revoke all on function public.create_contract_v1(
  uuid, uuid[], date, date, date, numeric, numeric, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

commit;
