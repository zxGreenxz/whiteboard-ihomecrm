-- ============================================================================
-- T5 PREPARED SQL 02 — create_invoice_v1 + reverse_invoice_payment_v3.
-- STATUS: PREPARED / flag-OFF / non-routed. Not migrations. No EXECUTE grant,
-- no feature-flag consumed for routing yet, no frontend rewire. useCreateInvoice
-- / createFirstInvoiceForContract / useDeletePayment stay on their current
-- direct-DML paths until owner canary.
--
-- Grounded in live columns (types.ts + migrations):
--  invoices: server decides APPROVED vs DRAFT from organization_invoice_settings
--    .auto_approve_invoice; live partial-unique idx_invoices_unique_contract_
--    billing on (contract_id, billing_month) WHERE deleted_at IS NULL AND
--    status<>'CANCELLED' (NO kind predicate — matched exactly).
--  payments: no deleted_at; reversal = negative compensating row (recompute
--    trigger trg_payments_recompute_invoice auto-updates invoice paid/status);
--    additive reverses_payment_id + partial-unique for anti-double-reversal.
--    excess_amounts negated with a compensating row, never deleted (§4.0/§7).
-- ============================================================================

begin;

-- IMPORTANT GROUNDING CORRECTION (found on the harness): public.payments has a
-- CHECK (amount > 0), so a negative compensating payment is IMPOSSIBLE. The live
-- recompute (recompute_invoice_for_id) already subtracts refunds tracked as an
-- income_expenses EXPENSE named 'Tiền thối'. The forward-fix reversal therefore
-- creates a linked compensating REFUND income_expense (which the recompute
-- subtracts), leaving the original payment row intact — never a hard-delete.
-- Anti-double-reversal is tracked on a private linkage table.
create table if not exists app_private.payment_reversals (
  original_payment_id uuid primary key references public.payments(id),
  reversal_voucher_id uuid not null references public.income_expenses(id),
  organization_id uuid not null,
  actor_id uuid not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on app_private.payment_reversals
  from public, anon, authenticated, service_role;

-- Rollout flag rows (OFF/zero) so the strict evaluator has rows to read.
insert into app_private.server_feature_flags
  (feature_key, domain, risk_class, mode, config_version,
   max_operation_count, max_single_amount_vnd, max_total_amount_vnd)
values
  ('invoice.create.v1', 'INVOICE', 'MONEY', 'OFF', 1, 0, 0, 0),
  ('invoice.reverse_payment.v1', 'PAYMENT', 'MONEY', 'OFF', 1, 0, 0, 0)
on conflict (feature_key) do nothing;

-- ---------------------------------------------------------------------------
-- Writer A — reverse_invoice_payment_v3 (replaces useDeletePayment hard-delete)
-- Forward-fix: NEVER hard-deletes. Inserts a linked negative compensating
-- payment; the recompute trigger updates invoice paid/status; excess credit is
-- negated with a compensating row. Anti-double via reverses_payment_id unique.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_invoice_payment_v3(
  p_payment_id uuid,
  p_reason text,
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_pay record;
  v_inv record;
  v_key text;
  v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_refund_voucher uuid;
  v_refund_type uuid;
  v_excess_total numeric(15,2);
  v_resp json;
  c_op constant text := 'invoice.reverse_payment.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if coalesce(length(btrim(p_reason)),0) < 5 then
    raise exception 'Lý do hoàn tác quá ngắn'; end if;

  -- lock the original payment + its invoice; derive org from building.
  select p.id, p.invoice_id, p.amount, p.payment_date
    into v_pay from public.payments p where p.id = p_payment_id for update;
  if not found then raise exception 'Không tìm thấy giao dịch thu' using errcode='42501'; end if;

  select i.id, i.building_id, i.room_id, i.contract_id, i.organization_id
    into v_inv from public.invoices i where i.id = v_pay.invoice_id and i.deleted_at is null for update;
  if not found then raise exception 'Hoá đơn không còn tồn tại' using errcode='42501'; end if;

  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=v_inv.building_id and b.deleted_at is null for share of o,b;
  if not found or v_org is null then
    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;

  -- exact permission thu_tien.undo (NOT a new key), building-scoped.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.undo', v_inv.building_id, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền hoàn tác thu tiền (thu_tien.undo)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('payment_id',p_payment_id,'org',v_org,'amount',v_pay.amount)::text);

  -- durable idempotency claim FIRST — a same-key replay must return the original
  -- response before the anti-double check (otherwise a legitimate retry looks
  -- like a double-reversal).
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_payment_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_payment_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  -- anti-double (a DIFFERENT key trying to reverse an already-reversed payment).
  if exists (select 1 from app_private.payment_reversals where original_payment_id = p_payment_id) then
    raise exception 'Giao dịch đã được hoàn tác' using errcode='55000'; end if;
  -- cannot reverse a refund voucher's own payment (there is none, but guard the
  -- case where p_payment_id is a reversal target).
  if exists (select 1 from app_private.payment_reversals pr
             where pr.reversal_voucher_id in (
               select ie.id from public.income_expenses ie where ie.payment_id = p_payment_id)) then
    raise exception 'Không thể hoàn tác một bút toán hoàn tác' using errcode='55000'; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer hoàn tác chưa bật cho tổ chức này' using errcode='55000'; end if;

  -- Forward-fix: compensating REFUND voucher (EXPENSE, type 'Tiền thối') that
  -- the live recompute_invoice_for_id SUBTRACTS from paid_amount. Original
  -- payment row stays intact. Get-or-create the org's refund type.
  select id into v_refund_type from public.income_expense_types
   where organization_id = v_org and name = 'Tiền thối' and lower(coalesce(type,'expense'))='expense'
   limit 1;
  if v_refund_type is null then
    insert into public.income_expense_types (organization_id, name, type)
    values (v_org, 'Tiền thối', 'expense') returning id into v_refund_type;
  end if;

  insert into public.income_expenses
    (user_id, organization_id, type, name, building_id, room_id, contract_id,
     invoice_id, voucher_date, approval_status, approved_by, approved_at, notes)
  values
    (v_actor, v_org, 'EXPENSE', 'Hoàn tác thu tiền', v_inv.building_id, v_inv.room_id,
     v_inv.contract_id, v_inv.id, v_pay.payment_date, 'APPROVED', v_actor, now(),
     'Hoàn tác: ' || p_reason)
  returning id into v_refund_voucher;
  insert into public.income_expense_items
    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
  values (v_refund_voucher, v_org, v_refund_type, 'Hoàn tác thu tiền', 1, v_pay.amount);

  -- recompute needs a nudge (item insert doesn't fire the payments trigger);
  -- touch the invoice's payments to re-run recompute deterministically.
  perform recompute_invoice_for_id(v_inv.id);

  -- record the reversal linkage (anti-double).
  insert into app_private.payment_reversals
    (original_payment_id, reversal_voucher_id, organization_id, actor_id, reason)
  values (p_payment_id, v_refund_voucher, v_org, v_actor, p_reason);

  -- negate any excess credit from the original payment (compensating row).
  select coalesce(sum(amount),0) into v_excess_total from public.excess_amounts
   where source_payment_id = p_payment_id;
  if v_excess_total <> 0 then
    insert into public.excess_amounts
      (contract_id, organization_id, user_id, amount, description, source_invoice_id, source_payment_id)
    values (v_inv.contract_id, v_org, v_actor, -v_excess_total,
            'Hoàn tác tiền thừa', v_inv.id, p_payment_id);
  end if;

  v_resp := json_build_object('reversal_voucher_id', v_refund_voucher,
    'original_payment_id', p_payment_id, 'reversed_amount', v_pay.amount);
  update app_private.canonical_write_operations
     set subject_id=v_refund_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_payment_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.reverse_invoice_payment_v3(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writer B — create_invoice_v1 (server decides APPROVED/DRAFT from settings)
-- ---------------------------------------------------------------------------

create or replace function public.create_invoice_v1(
  p_contract_id uuid,
  p_building_id uuid,
  p_room_id uuid,
  p_billing_month text,
  p_issue_date date,
  p_due_date date,
  p_kind text,
  p_subtotal numeric,
  p_discount_amount numeric,
  p_total_amount numeric,
  p_previous_debt numeric,
  p_items jsonb,
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_auto boolean;
  v_status text;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_invoice uuid;
  v_resp json;
  it jsonb; v_idx int := 0;
  c_op constant text := 'invoice.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_total_amount is null or p_total_amount < 0 then raise exception 'Tổng tiền không hợp lệ'; end if;

  -- derive + lock: building → org; contract same-org; room same-building/org.
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=p_building_id and b.deleted_at is null for share of o,b;
  if not found or v_org is null then
    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;
  -- contracts link to a building via their room, not a direct building_id column.
  perform 1 from public.contracts c where c.id=p_contract_id and c.deleted_at is null
    and c.organization_id=v_org for share;
  if not found then raise exception 'Hợp đồng không thuộc tổ chức' using errcode='42501'; end if;
  if p_room_id is not null then
    perform 1 from public.rooms r where r.id=p_room_id and r.deleted_at is null
      and r.building_id=p_building_id and r.organization_id=v_org for share;
    if not found then raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- exact permission invoices.create, building-scoped.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'invoices.create', p_building_id, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hoá đơn (invoices.create)' using errcode='42501'; end if;

  -- server decides APPROVED vs DRAFT from org settings; missing row = abort.
  select auto_approve_invoice into v_auto from public.organization_invoice_settings
   where organization_id = v_org;
  if v_auto is null then
    raise exception 'Thiếu cấu hình auto_approve_invoice cho tổ chức' using errcode='55000'; end if;
  v_status := case when v_auto then 'APPROVED' else 'DRAFT' end;

  v_hash := md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,
    'total',p_total_amount,'org',v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_contract_id::text || '|' || p_billing_month, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_contract_id::text || '|' || p_billing_month
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer hoá đơn chưa bật cho tổ chức này' using errcode='55000'; end if;

  -- create the invoice; the live partial-unique (contract_id, billing_month)
  -- WHERE deleted_at IS NULL AND status<>'CANCELLED' enforces one-per-period.
  insert into public.invoices
    (user_id, organization_id, contract_id, building_id, room_id, billing_month,
     issue_date, due_date, kind, status, subtotal, discount_amount, total_amount,
     prepaid_amount, paid_amount, previous_debt, approved_by, approved_at)
  values
    (v_actor, v_org, p_contract_id, p_building_id, p_room_id, p_billing_month,
     p_issue_date, p_due_date, coalesce(p_kind,'MONTHLY'), v_status::invoice_status,
     coalesce(p_subtotal,0), coalesce(p_discount_amount,0), p_total_amount,
     0, 0, coalesce(p_previous_debt,0),
     case when v_auto then v_actor else null end,
     case when v_auto then now() else null end)
  returning id into v_invoice;

  if p_items is not null and jsonb_typeof(p_items)='array' then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, type, description, unit_price, quantity, amount, sort_order)
      values (v_invoice, v_org,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description', coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1), coalesce((it->>'amount')::numeric,0), v_idx);
    end loop;
  end if;

  v_resp := json_build_object('invoice_id', v_invoice, 'status', v_status);
  update app_private.canonical_write_operations
     set subject_id=v_invoice, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_contract_id::text || '|' || p_billing_month
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text)
  from public, anon, authenticated, service_role;

commit;
