-- ============================================================================
-- T1b PREPARED TEST 90 — record_invoice_payment_v4 (harness). ROLLBACK at end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid; v_actor uuid; v_membership uuid;
  v_building uuid; v_invoice uuid; v_account uuid;
  v_org_scope uuid; v_ov uuid;
  v_res json; v_res2 json;
  v_total numeric; v_cnt int;
begin
  -- pick an org with an active membership and an invoice
  select i.organization_id, i.id, i.building_id, i.total_amount
    into v_org, v_invoice, v_building, v_total
    from public.invoices i
   where i.deleted_at is null and i.organization_id is not null
     and i.status in ('APPROVED','PARTIAL_PAID') and coalesce(i.paid_amount,0) = 0
   limit 1;
  if v_invoice is null then
    -- fall back: derive org from building
    select i.id, i.building_id, i.total_amount, b.organization_id
      into v_invoice, v_building, v_total, v_org
      from public.invoices i join public.buildings b on b.id=i.building_id
     where i.deleted_at is null and coalesce(i.paid_amount,0)=0 limit 1;
  end if;
  select m.user_id, m.id into v_actor, v_membership
    from public.organization_memberships m
    join auth.users u on u.id=m.user_id
   where m.organization_id=v_org and m.status='ACTIVE' limit 1;
  select id into v_account from public.accounts
   where organization_id=v_org and deleted_at is null limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  -- T1: writer is revoked → default deny even before authz (function ACL).
  --     We call as the definer/superuser here (harness) so ACL is bypassed;
  --     the ACL deny is covered by the security matrix. Proceed to behavior.

  -- T2: without thu_tien.collect permission → 42501
  begin
    perform public.record_invoice_payment_v4(
      v_invoice, 100000, 'TM', current_date, 'pay-key-0001', null, null, null, null, null, null, null);
    raise exception 'T2 FAILED: paid without thu_tien.collect';
  exception when insufficient_privilege then null;
  end;

  -- grant thu_tien.collect via org-mode member ALLOW override
  select id into v_org_scope from public.authorization_scopes
   where organization_id=v_org and scope_type='ORGANIZATION' limit 1;
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_membership, 'thu_tien.collect', 'ALLOW', 'test', 'ORGANIZATION')
  returning id into v_ov;
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  values (v_org, v_ov, v_org_scope);

  -- T3: with permission but flag OFF → 55000 (rollout not enabled)
  begin
    perform public.record_invoice_payment_v4(
      v_invoice, 100000, 'TM', current_date, 'pay-key-0002', null, null, null, null, null, null, null);
    raise exception 'T3 FAILED: paid with flag OFF';
  exception when others then
    if sqlstate <> '55000' then raise; end if;
  end;

  -- flip the flag ON with release identity
  update app_private.server_feature_flags
     set mode='ON', config_version=config_version+1,
         commit_sha=repeat('a',40), migration_sha256=repeat('b',64),
         maintenance_window_id='W', approval_reference='A', updated_at=clock_timestamp()
   where feature_key='invoice.record_payment.v1';

  -- T4: successful partial payment → payment row + invoice status, org-stamped
  v_res := public.record_invoice_payment_v4(
    v_invoice, 100000, 'TM', current_date, 'pay-key-0003', null, null, null, null, null, null, null);
  if (v_res->>'payment_id') is null then raise exception 'T4 FAILED: no payment id'; end if;
  if (select organization_id from public.payments where id=(v_res->>'payment_id')::uuid) <> v_org then
    raise exception 'T4 FAILED: payment not org-stamped';
  end if;

  -- T5: replay same key + same payload → same response, no second payment
  v_res2 := public.record_invoice_payment_v4(
    v_invoice, 100000, 'TM', current_date, 'pay-key-0003', null, null, null, null, null, null, null);
  if (v_res2->>'payment_id') <> (v_res->>'payment_id') then
    raise exception 'T5 FAILED: replay created a second payment';
  end if;
  select count(*) into v_cnt from public.payments
   where invoice_id=v_invoice and amount=100000;
  if v_cnt <> 1 then raise exception 'T5 FAILED: % payments (double-collect)', v_cnt; end if;

  -- T6: same key + different payload → 23505 conflict
  begin
    perform public.record_invoice_payment_v4(
      v_invoice, 200000, 'TM', current_date, 'pay-key-0003', null, null, null, null, null, null, null);
    raise exception 'T6 FAILED: different payload accepted';
  exception when unique_violation then null;
  end;

  -- T7: cross-org account rejected
  begin
    perform public.record_invoice_payment_v4(
      v_invoice, 50000, 'TM', current_date, 'pay-key-0004',
      (select id from public.accounts where organization_id <> v_org and deleted_at is null limit 1),
      null, null, null, null, null, null);
    raise exception 'T7 FAILED: cross-org account accepted';
  exception when insufficient_privilege then null;
  end;

  -- T8: voucher_owner_id mismatch rejected
  begin
    perform public.record_invoice_payment_v4(
      v_invoice, 50000, 'TM', current_date, 'pay-key-0005',
      null, null, null, null, null, null, gen_random_uuid());
    raise exception 'T8 FAILED: forged voucher owner accepted';
  exception when insufficient_privilege then null;
  end;

  -- T9: cross-ledger guard — a key already consumed by the LEGACY v3 path
  -- (income_expenses.idempotency_key stamp) must 23505, never re-execute
  -- canonically (client retry racing the canary flip would double-pay).
  update public.income_expenses set idempotency_key='legacy-key-t9-0001'
   where id = (select id from public.income_expenses
                where organization_id=v_org and deleted_at is null
                  and source_payload_hash is null limit 1);
  begin
    perform public.record_invoice_payment_v4(
      v_invoice, 50000, 'TM', current_date, 'legacy-key-t9-0001',
      null, null, null, null, null, null, null);
    raise exception 'T9 FAILED: legacy-consumed key re-executed canonically';
  exception when unique_violation then null;
  end;

  raise notice 'ALL 8 T1B PAYMENT TESTS PASSED';
end;
$tests$;

rollback;
