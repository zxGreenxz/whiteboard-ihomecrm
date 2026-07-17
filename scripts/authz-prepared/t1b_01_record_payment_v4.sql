-- ============================================================================
-- T1b PREPARED SQL 01 — public.record_invoice_payment_v4 (hardened).
-- STATUS: PREPARED / non-routed. REVOKED from all client roles. Not a migration.
-- Grounds on: v3 (20260713162000) effects, canonical_write_operations ledger
-- (20260716180000), authorize_tenant_action_v3 + lock_org_for_decision_v1
-- (t2_03), evaluate_feature_route (20260716120200) + set_feature_route_v1 (t5_01).
--
-- Closes the v3 gaps: weak permission → exact thu_tien.collect; idempotency
-- scoped to income_expenses.idempotency_key (misses voucherless payments) →
-- durable ledger keyed org+op+invoice+caller+key+hash; no same-key/diff-payload
-- conflict → 23505; idempotency-before-authz → authz-BEFORE-ledger; untrusted/
-- empty org stamping → derive org from buildings + stamp every effect;
-- unvalidated foreign IDs → each checked same-org FOR SHARE.
-- ============================================================================

begin;

-- Seed the rollout flag row for this operation (OFF, zero caps) so the strict
-- evaluator has a row to read. No behavior until owner CAS-flips it.
insert into app_private.server_feature_flags
  (feature_key, domain, risk_class, mode, config_version,
   max_operation_count, max_single_amount_vnd, max_total_amount_vnd)
values
  ('invoice.record_payment.v1', 'PAYMENT', 'MONEY', 'OFF', 1, 0, 0, 0)
on conflict (feature_key) do nothing;

create or replace function public.record_invoice_payment_v4(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method payment_method,
  p_payment_date date,
  p_idempotency_key text,
  p_account_id uuid default null,
  p_notes text default null,
  p_receipt_image_url text default null,
  p_voucher jsonb default null,
  p_items jsonb default null,
  p_receipt_number text default null,
  p_voucher_owner_id uuid default null
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz record;
  v_inv record;
  v_owner uuid;
  v_key text;
  v_amount numeric(15,2);
  v_payload jsonb;
  v_items jsonb := '[]'::jsonb;
  v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_flag app_private.server_feature_flags%rowtype;
  v_payment_id uuid;
  v_voucher_id uuid;
  v_new_paid numeric(15,2);
  v_status text;
  v_paid_date date;
  v_excess numeric(15,2) := 0;
  v_resp json;
  it jsonb; v_idx int := 0; v_type_id uuid;
  v_room uuid; v_chg uuid; v_rnd uuid;
  c_op constant text := 'invoice.record_payment.v1';
  c_max constant numeric := 9999999999999.99;
begin
  -- (0) auth + cheap normalization; NO ledger lookup yet.
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount or p_amount > c_max then
    raise exception 'Số tiền không hợp lệ'; end if;
  v_amount := p_amount;
  if p_payment_date is null or p_payment_date < date '2000-01-01'
     or p_payment_date > date '2100-12-31' then
    raise exception 'Ngày thu không hợp lệ'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;

  -- (1) lock invoice + derive org from its building (invoices.organization_id
  --     untrusted). BEFORE any ledger read.
  select i.id, i.user_id, i.building_id, i.room_id, i.contract_id,
         i.total_amount, i.paid_amount, i.status, i.organization_id, i.invoice_number
    into v_inv from public.invoices i
   where i.id = p_invoice_id and i.deleted_at is null for update;
  if not found then raise exception 'Không tìm thấy hoá đơn' using errcode='42501'; end if;

  select b.organization_id into v_org
    from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status='ACTIVE'
   where b.id = v_inv.building_id and b.deleted_at is null for share of o, b;
  if not found or v_org is null then
    raise exception 'Toà nhà của hoá đơn không thuộc tổ chức đang hoạt động' using errcode='42501';
  end if;
  if v_inv.organization_id is not null and v_inv.organization_id <> v_org then
    raise exception 'Hoá đơn lệch tổ chức' using errcode='42501';
  end if;

  -- (2) authorize BEFORE idempotency: exact thu_tien.collect, server-derived
  --     org + building scope (+ cashbook when an account is used).
  perform app_private.lock_org_for_decision_v1(v_org);
  select * into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_inv.building_id, p_account_id);
  if not coalesce(v_authz.allowed,false) then
    raise exception 'Không có quyền thu tiền (thu_tien.collect)' using errcode='42501';
  end if;

  if p_voucher_owner_id is not null and p_voucher_owner_id <> v_inv.user_id then
    raise exception 'p_voucher_owner_id phải là chủ hoá đơn' using errcode='42501';
  end if;
  v_owner := v_inv.user_id;

  -- (3) validate every foreign resource to the SAME org; build canonical payload.
  if p_account_id is not null then
    perform 1 from public.accounts a
     where a.id = p_account_id and a.deleted_at is null and a.organization_id = v_org for share;
    if not found then raise exception 'Sổ quỹ không thuộc tổ chức của hoá đơn' using errcode='42501'; end if;
  end if;

  perform 1 from public.contracts c
   where c.id = v_inv.contract_id and c.deleted_at is null and c.organization_id = v_org for share;
  if not found then raise exception 'Hợp đồng của hoá đơn không thuộc tổ chức' using errcode='42501'; end if;

  if p_voucher is not null then
    v_room := nullif(p_voucher->>'room_id','')::uuid;
    v_chg  := nullif(p_voucher->>'change_account_id','')::uuid;
    v_rnd  := nullif(p_voucher->>'rounding_account_id','')::uuid;
    if v_room is not null then
      perform 1 from public.rooms r where r.id=v_room and r.deleted_at is null
        and r.building_id=v_inv.building_id and r.organization_id=v_org for share;
      if not found then raise exception 'Phòng của phiếu không thuộc toà/tổ chức' using errcode='42501'; end if;
    end if;
    if v_chg is not null then
      perform 1 from public.accounts a where a.id=v_chg and a.deleted_at is null and a.organization_id=v_org for share;
      if not found then raise exception 'Sổ quỹ tiền thối không thuộc tổ chức' using errcode='42501'; end if;
    end if;
    if v_rnd is not null then
      perform 1 from public.accounts a where a.id=v_rnd and a.deleted_at is null and a.organization_id=v_org for share;
      if not found then raise exception 'Sổ quỹ làm tròn không thuộc tổ chức' using errcode='42501'; end if;
    end if;
  end if;

  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' then raise exception 'items phải là mảng'; end if;
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      v_type_id := nullif(it->>'income_expense_type_id','')::uuid;
      if v_type_id is null then raise exception 'Hạng mục % thiếu loại thu', v_idx; end if;
      perform 1 from public.income_expense_types t
       where t.id=v_type_id and lower(t.type)='income' and t.organization_id=v_org for share;
      if not found then raise exception 'Loại hạng mục % không thuộc tổ chức/sai chiều thu', v_idx using errcode='42501'; end if;
      v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'income_expense_type_id', v_type_id,
        'description', nullif(btrim(it->>'description'),''),
        'quantity', coalesce((it->>'quantity')::numeric,1),
        'unit_price', round((it->>'unit_price')::numeric,2),
        'start_date', nullif(it->>'start_date','')::date,
        'end_date', nullif(it->>'end_date','')::date)));
    end loop;
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'invoice_id', p_invoice_id, 'organization_id', v_org, 'amount', v_amount,
    'payment_method', p_payment_method::text, 'payment_date', p_payment_date,
    'account_id', p_account_id, 'receipt_number', nullif(btrim(p_receipt_number),''),
    'receipt_image_url', nullif(btrim(p_receipt_image_url),''),
    'notes', nullif(p_notes,''), 'voucher_owner_id', v_owner,
    'room_id', v_room, 'change_account_id', v_chg, 'rounding_account_id', v_rnd,
    'items', v_items));
  v_hash := md5(v_payload::text);

  -- (4) durable idempotency claim = linearization point (AFTER authz).
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_invoice_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;

  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_invoice_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if not found then raise exception 'Không nhận diện được operation idempotency' using errcode='55000'; end if;

  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505';
  end if;
  if v_op.completed_at is not null then
    return v_op.response_payload::json; -- replay original; survives OFF/freeze
  end if;

  -- (4b) Cross-ledger guard (route-flip race), NEW CLAIMANTS ONLY — phải đứng
  -- SAU replay-return: voucher do chính v4 tạo cũng stamp idempotency_key, nên
  -- đặt guard trước replay sẽ 23505 nhầm chính op đã hoàn tất của v4 (bắt được
  -- nhờ canary live 2026-07-18, t1b_90 replay-không-voucher không lộ). Với claim
  -- MỚI: key đã bị đường LEGACY v3 tiêu thụ (stamp trên income_expenses) mà
  -- re-execute canonical thì retry vắt qua flip sẽ double-pay → 23505 hiển thị.
  -- Residual: v3 không voucher-mirror không stamp key (gap có sẵn của v3).
  if exists (select 1 from public.income_expenses ie
              where ie.idempotency_key = v_key and ie.deleted_at is null) then
    raise exception 'idempotency_key đã dùng ở đường legacy (v3)' using errcode='23505';
  end if;

  -- (5) rollout admission — new claimant only. Default OFF ⇒ blocked.
  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer thu tiền chưa bật cho tổ chức này' using errcode='55000';
  end if;

  -- (5b) rollout cap accounting + enforcement. FOR UPDATE serializes concurrent
  -- admits per feature; ops row rolls back with the tx nếu effects fail.
  -- Count-cap enforce ở evaluate_feature_route lần gọi SAU (count >= max →
  -- FROZEN → thông điệp "chưa bật" → client coexistence-fallback về legacy).
  -- Amount-caps enforce tại đây cho mode CANARY; thông điệp giữ cụm "chưa bật"
  -- để adapter route giao dịch vượt hạn mức về legacy thay vì fail user.
  select * into v_flag from app_private.server_feature_flags
   where feature_key = c_op for update;
  if v_flag.mode = 'CANARY' then
    if v_amount > v_flag.max_single_amount_vnd then
      raise exception 'Writer thu tiền chưa bật cho giao dịch này (vượt hạn mức đơn lẻ canary)'
        using errcode='55000';
    end if;
    if coalesce((select sum(o.amount_vnd)
                   from app_private.server_feature_flag_operations o
                  where o.feature_key = c_op
                    and o.config_version = v_flag.config_version), 0) + v_amount
       > v_flag.max_total_amount_vnd then
      raise exception 'Writer thu tiền chưa bật cho giao dịch này (vượt tổng hạn mức canary)'
        using errcode='55000';
    end if;
  end if;
  insert into app_private.server_feature_flag_operations
    (feature_key, config_version, operation_key, organization_id, amount_vnd)
  values (c_op, v_flag.config_version, v_key || ':' || p_invoice_id::text, v_org, v_amount)
  on conflict do nothing;

  -- (6) effects — atomic, all org-stamped (v3 omits org).
  insert into public.payments
    (invoice_id, organization_id, user_id, amount, payment_method, payment_date,
     notes, receipt_image_url, receipt_number)
  values (p_invoice_id, v_org, v_owner, v_amount, p_payment_method, p_payment_date,
          p_notes, p_receipt_image_url, p_receipt_number)
  returning id into v_payment_id;

  v_new_paid := coalesce(v_inv.paid_amount,0) + v_amount;
  if v_new_paid >= v_inv.total_amount then
    v_status := 'PAID'; v_paid_date := p_payment_date; v_excess := v_new_paid - v_inv.total_amount;
    if v_excess > 0 then
      insert into public.excess_amounts
        (contract_id, organization_id, user_id, amount, description, source_invoice_id, source_payment_id)
      values (v_inv.contract_id, v_org, v_owner, v_excess,
              'Tiền thừa từ hoá đơn ' || coalesce(v_inv.invoice_number,''), p_invoice_id, v_payment_id);
    end if;
  else
    v_status := 'PARTIAL_PAID'; v_paid_date := null;
  end if;

  update public.invoices set paid_amount=v_new_paid, status=v_status::invoice_status, paid_date=v_paid_date
   where id = p_invoice_id;

  if p_account_id is not null and p_voucher is not null then
    insert into public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, invoice_id, payment_id, voucher_date, payer_name, notes, attachments,
      approval_status, approved_by, approved_at, idempotency_key)
    values (
      v_owner, v_org, 'INCOME', coalesce(p_voucher->>'name','Thu tiền hoá đơn'),
      v_inv.building_id, v_room, v_inv.contract_id, p_account_id, p_invoice_id, v_payment_id,
      p_payment_date, p_voucher->>'payer_name', p_voucher->>'notes',
      coalesce(p_voucher->'attachments','[]'::jsonb),
      'APPROVED', v_actor, now(), v_key)
    returning id into v_voucher_id;
    insert into public.income_expense_items
      (income_expense_id, organization_id, income_expense_type_id, description,
       quantity, unit_price, start_date, end_date)
    select v_voucher_id, v_org, (x->>'income_expense_type_id')::uuid, x->>'description',
      coalesce((x->>'quantity')::numeric,1), (x->>'unit_price')::numeric,
      nullif(x->>'start_date','')::date, nullif(x->>'end_date','')::date
    from jsonb_array_elements(v_items) as x;
  end if;

  -- (7) complete the operation durably.
  v_resp := json_build_object('payment_id', v_payment_id, 'voucher_id', v_voucher_id,
    'new_paid_amount', v_new_paid, 'new_status', v_status, 'excess_amount', v_excess);
  update app_private.canonical_write_operations
     set subject_id=v_payment_id, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_invoice_id::text
     and actor_id=v_actor and idempotency_key=v_key;

  return v_resp;
end;
$fn$;

revoke all on function public.record_invoice_payment_v4(
  uuid, numeric, payment_method, date, text, uuid, text, text, jsonb, jsonb, text, uuid)
  from public, anon, authenticated, service_role;
-- NO grant. Prepared/non-routed until owner-gated cutover.

commit;
