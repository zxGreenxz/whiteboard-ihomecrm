-- ============================================================================
-- T5 PREPARED TEST 91 — create_invoice_v1 + reverse_invoice_payment_v3 (harness).
-- ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid; v_actor uuid; v_membership uuid;
  v_building uuid; v_contract uuid; v_invoice uuid; v_payment uuid;
  v_org_scope uuid; v_ov uuid;
  v_res json; v_res2 json;
  v_paid numeric; v_cnt int; v_status text; v_room uuid;
begin
  -- fixture: an existing invoice gives us a valid (contract, building) pair in
  -- the same org (contracts have no direct building_id; invoices do).
  select i.organization_id, i.contract_id, i.building_id, i.room_id
    into v_org, v_contract, v_building, v_room
    from public.invoices i
    join public.buildings b on b.id=i.building_id and b.deleted_at is null
    join public.contracts c on c.id=i.contract_id and c.deleted_at is null
   where i.deleted_at is null and i.organization_id is not null and i.room_id is not null limit 1;
  select m.user_id, m.id into v_actor, v_membership
    from public.organization_memberships m join auth.users u on u.id=m.user_id
   where m.organization_id=v_org and m.status='ACTIVE' limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  -- grant invoices.create + thu_tien.undo via org-mode overrides
  select id into v_org_scope from public.authorization_scopes
   where organization_id=v_org and scope_type='ORGANIZATION' limit 1;
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_membership, 'invoices.create', 'ALLOW', 'test', 'ORGANIZATION'),
         (v_org, v_membership, 'thu_tien.collect', 'ALLOW', 'test', 'ORGANIZATION'),
         (v_org, v_membership, 'thu_tien.undo', 'ALLOW', 'test', 'ORGANIZATION');
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  select v_org, o.id, v_org_scope from public.member_permission_overrides o
   where o.organization_id=v_org and o.membership_id=v_membership and o.revoked_at is null
     and o.permission_key in ('invoices.create','thu_tien.collect','thu_tien.undo');

  -- flip invoice.create + payment writers ON
  update app_private.server_feature_flags
     set mode='ON', config_version=config_version+1, commit_sha=repeat('a',40),
         migration_sha256=repeat('b',64), maintenance_window_id='W', approval_reference='A',
         updated_at=clock_timestamp()
   where feature_key in ('invoice.create.v1','invoice.record_payment.v1','invoice.reverse_payment.v1');

  -- T1: create_invoice_v1 → APPROVED (org auto_approve=true), approved_by set
  v_res := public.create_invoice_v1(
    v_contract, v_building, v_room, '2099-01', current_date, current_date + 15,
    'MONTHLY', 1000000, 0, 1000000, 0,
    jsonb_build_array(jsonb_build_object('type','RENT','description','Thuê phòng','unit_price',1000000,'quantity',1,'amount',1000000)),
    'inv-key-0001');
  v_invoice := (v_res->>'invoice_id')::uuid;
  if (v_res->>'status') <> 'APPROVED' then raise exception 'T1 FAILED: status %', v_res->>'status'; end if;
  if (select approved_by from public.invoices where id=v_invoice) <> v_actor then
    raise exception 'T1 FAILED: approved_by not server-set'; end if;
  if (select organization_id from public.invoices where id=v_invoice) <> v_org then
    raise exception 'T1 FAILED: not org-stamped'; end if;

  -- T2: duplicate (contract, billing_month) rejected by live partial-unique
  begin
    perform public.create_invoice_v1(
      v_contract, v_building, v_room, '2099-01', current_date, current_date + 15,
      'MONTHLY', 500000, 0, 500000, 0, '[]'::jsonb, 'inv-key-0002');
    raise exception 'T2 FAILED: duplicate period invoice created';
  exception when unique_violation then null;
  end;

  -- T3: create replay same key → same invoice
  v_res2 := public.create_invoice_v1(
    v_contract, v_building, v_room, '2099-01', current_date, current_date + 15,
    'MONTHLY', 1000000, 0, 1000000, 0,
    jsonb_build_array(jsonb_build_object('type','RENT','description','Thuê phòng','unit_price',1000000,'quantity',1,'amount',1000000)),
    'inv-key-0001');
  if (v_res2->>'invoice_id') <> (v_res->>'invoice_id') then
    raise exception 'T3 FAILED: replay made a new invoice'; end if;

  -- pay the invoice fully via v4 so we have a payment to reverse
  v_res := public.record_invoice_payment_v4(
    v_invoice, 1000000, 'TM', current_date, 'pay-rev-0001', null, null, null, null, null, null, null);
  v_payment := (v_res->>'payment_id')::uuid;
  if (select status from public.invoices where id=v_invoice) <> 'PAID' then
    raise exception 'setup FAILED: invoice not PAID'; end if;

  -- T4: reverse via compensating REFUND voucher (payments has CHECK amount>0,
  -- so the forward-fix is a 'Tiền thối' EXPENSE that recompute subtracts).
  v_res := public.reverse_invoice_payment_v3(v_payment, 'khách đổi ý', 'rev-key-0001');
  if (v_res->>'reversal_voucher_id') is null then raise exception 'T4 FAILED: no reversal'; end if;
  -- recompute: paid back to 0 (refund subtracted), original payment intact.
  select paid_amount into v_paid from public.invoices where id=v_invoice;
  if v_paid <> 0 then raise exception 'T4 FAILED: invoice paid_amount=% (recompute)', v_paid; end if;
  if not exists (select 1 from public.payments where id=v_payment) then
    raise exception 'T4 FAILED: original payment hard-deleted'; end if;
  -- reversal linkage recorded
  if not exists (select 1 from app_private.payment_reversals where original_payment_id=v_payment) then
    raise exception 'T4 FAILED: reversal not linked'; end if;

  -- T5: double reversal rejected (55000) or idempotency conflict (23505)
  begin
    perform public.reverse_invoice_payment_v3(v_payment, 'lần 2', 'rev-key-0002');
    raise exception 'T5 FAILED: double reversal';
  exception when others then if sqlstate not in ('55000','23505') then raise; end if;
  end;

  -- T6: replay same reversal key → same voucher (idempotent), no second refund
  v_res2 := public.reverse_invoice_payment_v3(v_payment, 'khách đổi ý', 'rev-key-0001');
  if (v_res2->>'reversal_voucher_id') <> (v_res->>'reversal_voucher_id') then
    raise exception 'T6 FAILED: replay made a new reversal'; end if;

  raise notice 'ALL 6 T5 INVOICE/REVERSAL TESTS PASSED';
end;
$tests$;

rollback;
