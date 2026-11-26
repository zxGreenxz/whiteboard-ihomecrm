-- Run only on TEST / DEMO, inside the rollback transaction of test-env:thu-sql.
SET LOCAL statement_timeout='120s';
DO $test$
DECLARE
  org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  actor uuid; org_building uuid; book uuid; category uuid; room uuid; old uuid; customer uuid;
  first_v uuid; second_v uuid; hold_id uuid; contract_id_new uuid; revision bigint;
  first_channel text; second_channel text; day date:=public.org_today_v1(org);
  row_data jsonb; terms jsonb; result jsonb; state jsonb; payload jsonb;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS (SELECT FROM public.organizations WHERE id=org AND is_demo)
    THEN RAISE EXCEPTION 'Requires TEST DEMO'; END IF;
  SELECT id INTO STRICT actor FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT org_building FROM public.buildings WHERE organization_id=org AND deleted_at IS NULL AND name='DEMO Toà A';
  SELECT id INTO STRICT book FROM public.accounts WHERE organization_id=org AND user_id=actor AND deleted_at IS NULL AND NOT coalesce(is_virtual,false) ORDER BY is_default DESC NULLS LAST,id LIMIT 1;
  SELECT id INTO STRICT category FROM public.income_expense_types WHERE organization_id=org AND type='income' AND is_deposit LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  FOREACH first_channel IN ARRAY ARRAY['finance','sale','reservation'] LOOP
    FOREACH second_channel IN ARRAY ARRAY['finance','sale','reservation'] LOOP
      room:=gen_random_uuid(); customer:=gen_random_uuid();
      INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status)
        VALUES(room,org_building,org,'QA 401 '||room,1000000,1000000,'AVAILABLE');
      INSERT INTO public.customers(id,organization_id,user_id,full_name,phone)
        VALUES(customer,org,actor,'Lộc QA','09'||lpad(floor(random()*100000000)::text,8,'0'));
      INSERT INTO public.income_expenses(user_id,organization_id,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,approved_by,approved_at,payer_name)
        VALUES(actor,org,'INCOME','QA old unallocated',org_building,room,book,day-3,4100000,'APPROVED',actor,clock_timestamp(),'Lộc') RETURNING id INTO old;
      INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,quantity,unit_price,amount,accounting_class,start_date,end_date)
        VALUES(old,org,category,1,4100000,4100000,'DEPOSIT',day-3,day-3);
      INSERT INTO public.contracts(user_id,organization_id,room_id,signed_date,start_date,end_date,actual_end_date,status,rent_price,public_code)
        VALUES(actor,org,room,day-90,day-90,day+90,day-3,'TERMINATED',1000000,gen_random_uuid()::text);
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;
      IF EXISTS(SELECT FROM public.reservation_receipts WHERE source_voucher_id=old) OR EXISTS(SELECT FROM public.income_expenses WHERE id=old AND contract_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Legacy trigger guessed ownership'; END IF;

      SET LOCAL ROLE authenticated;
      row_data:=jsonb_build_object('type','INCOME','name','QA Lộc','room_id',room,'building_id',org_building,'account_id',book,'payer_name','Lộc','voucher_date',day,'amount',400000);
      result:=public.create_deposit_income_v1(org,room||'-first',row_data,'[]',jsonb_build_object('channel',first_channel,'expected_hold',NULL));
      first_v:=(result->>'id')::uuid; hold_id:=(result->>'reservation_id')::uuid;
      IF first_v IS NULL OR hold_id IS NULL THEN RAISE EXCEPTION 'Receipt missing'; END IF;
      IF (public.create_deposit_income_v1(org,room||'-first',row_data,'[]',jsonb_build_object('channel',first_channel,'expected_hold',NULL))->>'id')::uuid<>first_v THEN
        RAISE EXCEPTION 'Retry duplicated receipt'; END IF;
      terms:=jsonb_build_object('channel',second_channel,'expected_hold',hold_id,'expected_revision',1);
      result:=public.create_deposit_income_v1(org,room||'-second',row_data||'{"amount":600000,"payer_name":"Người nộp hộ"}','[]',terms);
      second_v:=(result->>'id')::uuid;
      state:=public.get_contract_room_deposits_v1(org,room);
      revision:=(state->'hold'->>'revision')::bigint;
      IF (result->>'reservation_id')::uuid IS DISTINCT FROM hold_id OR jsonb_array_length(state->'vouchers')<>2
        OR EXISTS (SELECT FROM jsonb_array_elements(state->'vouchers') v WHERE (v->>'id')::uuid NOT IN(first_v,second_v) OR NOT (v->>'received')::boolean)
        OR (SELECT sum((v->>'total_amount')::numeric) FROM jsonb_array_elements(state->'vouchers') v)<>1000000 THEN
        RAISE EXCEPTION 'Preview merged unrelated money'; END IF;
      terms:=jsonb_build_object('room_id',room,'start_date',day,'signed_date',day,'end_date',day+90,'rent_price',1000000,'total_deposit',1000000,
        'payment_cycle','MONTHLY','start_billing_date',day,'end_billing_date',day+5,'discount_months',0,'discount_amount_per_month',0,'notes','');
      payload:=jsonb_build_object('contract',terms,'customers',jsonb_build_array(jsonb_build_object('customer_id',customer,'is_representative',true)),
        'services','[]'::jsonb,'expected_room_deposit_amount',1000000,'existing_deposit_voucher_ids',jsonb_build_array(first_v,second_v),'reservation_id',hold_id,'reservation_revision',revision);
      BEGIN
        PERFORM public.create_contract_v2(payload||jsonb_build_object('existing_deposit_voucher_ids',jsonb_build_array(old,first_v,second_v)),gen_random_uuid()::text);
        RAISE EXCEPTION 'Unassigned voucher was accepted at signing'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
      END;
      BEGIN
        PERFORM public.reconcile_deposit_income_hold_v1(gen_random_uuid(),old,hold_id,revision,4100000,1000000);
        RAISE EXCEPTION 'Cross-org link accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      IF first_channel='reservation' AND second_channel='finance' THEN
        -- One explicit decision while still holding. Money movements are unchanged.
        BEGIN
          PERFORM public.reconcile_deposit_income_hold_v1(org,old,hold_id,revision+1,4100000,1000000);
          RAISE EXCEPTION 'Stale preview accepted'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
        END;
        PERFORM public.reconcile_deposit_income_hold_v1(org,old,hold_id,revision,4100000,1000000);
        PERFORM public.reconcile_deposit_income_hold_v1(org,old,hold_id,revision,4100000,1000000);
        state:=public.get_contract_room_deposits_v1(org,room);
        IF jsonb_array_length(state->'vouchers')<>3 OR (SELECT sum((v->>'total_amount')::numeric) FROM jsonb_array_elements(state->'vouchers') v)<>5100000
          THEN RAISE EXCEPTION 'Explicit hold link failed'; END IF;
      ELSE
        result:=public.create_contract_v2(payload,gen_random_uuid()::text);
        contract_id_new:=(result->'contract'->>'id')::uuid;
        RESET ROLE;
        IF NOT EXISTS (SELECT FROM public.contracts WHERE id=contract_id_new AND deposit_paid=1000000)
          OR EXISTS (SELECT FROM public.income_expenses WHERE id=old AND contract_id IS NOT NULL)
          OR EXISTS (SELECT FROM public.reservation_receipts WHERE source_voucher_id=old)
          OR EXISTS (SELECT FROM public.contract_deposit_links WHERE income_expense_id=old)
          THEN RAISE EXCEPTION 'Contract used unrelated pre-existing money'; END IF;
        IF first_channel='sale' AND second_channel='reservation' THEN
          SELECT h.revision INTO revision FROM public.room_reservations h WHERE h.id=hold_id;
          SET LOCAL ROLE authenticated;
          PERFORM public.reconcile_deposit_income_hold_v1(org,old,hold_id,revision,4100000,1000000);
          PERFORM public.reconcile_deposit_income_hold_v1(org,old,hold_id,revision,4100000,1000000);
          RESET ROLE;
          IF NOT EXISTS(SELECT FROM public.contracts WHERE id=contract_id_new AND deposit_paid=5100000) THEN RAISE EXCEPTION 'Explicit signed link did not reconcile'; END IF;
        END IF;
      END IF;
      RESET ROLE;
      IF (SELECT count(*) FROM public.income_expenses WHERE room_id=room AND type='INCOME' AND public.ie_has_deposit_item(id))<>3
        OR (SELECT sum(total_amount) FROM public.income_expenses WHERE room_id=room AND type='INCOME' AND public.ie_has_deposit_item(id))<>5100000 THEN RAISE EXCEPTION 'Cash changed on allocation'; END IF;
      RAISE NOTICE 'PASS guarded receipt, signing or explicit reconciliation: % -> %',first_channel,second_channel;
    END LOOP;
  END LOOP;
END $test$;
