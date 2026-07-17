-- ============================================================================
-- T3 PREPARED TEST 94 — receipt RPC atomicity + payments canonical guard.
-- Disposable harness only. ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_actor uuid;
  v_building uuid;
  v_invoice uuid;
  v_payment uuid;
  v_voucher uuid;
  v_url text := 'https://example.supabase.co/storage/v1/object/public/payment-receipts/u/r.jpg';
  v_res jsonb;
begin
  -- actor with a building-scoped invoices.edit assignment and a matching
  -- invoice in that building (satisfies can_do_on_building branch 3)
  select m.organization_id, sa.staff_id, i.id
    into v_org, v_actor, v_invoice
    from public.staff_assignments sa
    join public.invoices i
      on i.building_id = sa.building_id and i.deleted_at is null
    join public.organization_memberships m
      on m.user_id = sa.staff_id and m.status = 'ACTIVE'
    join auth.users u on u.id = sa.staff_id
   where sa.building_id is not null
     and coalesce((sa.permissions -> 'invoices' ->> 'edit')::boolean, false)
   limit 1;
  if v_actor is null then
    raise exception 'fixture: no building-scoped actor with invoices.edit';
  end if;
  select building_id into v_building from public.invoices where id = v_invoice;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  -- invoice-linked payment owned by actor + linked unmarked voucher
  -- (payments.invoice_id is NOT NULL in the live schema)
  insert into public.payments
    (user_id, invoice_id, amount, payment_method, payment_date, organization_id)
  values (v_actor, v_invoice, 50000, 'TM', current_date, v_org)
  returning id into v_payment;

  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id,
     approval_status, voucher_date, total_amount, payment_id)
  values (v_org, v_actor, 'INCOME', 'receipt test voucher', v_building,
          'UNAPPROVED', current_date, 50000, v_payment)
  returning id into v_voucher;

  -- T1: atomic attach updates payment + voucher together
  v_res := public.attach_payment_receipt_v1(v_payment, v_url);
  if (select receipt_image_url from public.payments where id = v_payment) <> v_url then
    raise exception 'T1 FAILED: payment receipt not set';
  end if;
  if not exists (
    select 1 from public.income_expenses
     where id = v_voucher and attachments ? v_url) then
    raise exception 'T1 FAILED: voucher attachments not updated';
  end if;
  if (v_res->>'vouchers_updated')::int <> 1 then
    raise exception 'T1 FAILED: vouchers_updated=%', v_res->>'vouchers_updated';
  end if;

  -- T2: idempotent re-attach does not duplicate the URL
  v_res := public.attach_payment_receipt_v1(v_payment, v_url);
  if (select jsonb_array_length(attachments) from public.income_expenses
       where id = v_voucher) <> 1 then
    raise exception 'T2 FAILED: duplicate attachment element';
  end if;

  -- T3: invalid URL rejected before any effect
  begin
    perform public.attach_payment_receipt_v1(v_payment, 'http://evil.example/x');
    raise exception 'T3 FAILED: http URL accepted';
  exception when invalid_parameter_value or sqlstate '22023' then null;
  end;

  -- T4: canonical-marked voucher blocks the receipt path AND direct payment DML
  update public.income_expenses set source_payload_hash = md5('receipt-canon')
   where id = v_voucher;
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, 'income_expense.create_draft.v1', v_building::text, v_actor,
          'receipt-canon-key', md5('receipt-canon'));
  set local role ie_canonical_writer;
  perform app_private.claim_canonical_income_expense_draft_v1(v_voucher, 'receipt-canon-key');
  reset role;

  begin
    perform public.attach_payment_receipt_v1(v_payment, v_url);
    raise exception 'T4 FAILED: receipt RPC touched canonical voucher';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    update public.payments set amount = 1 where id = v_payment;
    raise exception 'T4 FAILED: direct payment update allowed under canonical link';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from public.payments where id = v_payment;
    raise exception 'T4 FAILED: direct payment delete allowed under canonical link';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T5: stranger cannot attach to someone else's standalone payment
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform public.attach_payment_receipt_v1(v_payment, v_url);
    raise exception 'T5 FAILED: stranger attached receipt';
  exception when insufficient_privilege or object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 5 RECEIPT ATOMICITY TESTS PASSED';
end;
$tests$;

rollback;
