-- npm run test-env:thu-sql -- scripts/tests/test-contract-room-deposits-live.sql (ROLLBACK)
SET LOCAL statement_timeout='100s';
DO $test$
DECLARE
  org constant uuid:='dddd0000-0000-4000-8000-000000000001';
  actor uuid; building uuid; book uuid; dep_type uuid; room uuid; tenant uuid; old_customer uuid; moved_room uuid; phone text;
  day date:=public.org_today_v1(org); scenario text; hold jsonb; snap jsonb; original uuid;
  inputs uuid[]; source uuid; amount int; terms jsonb; parties jsonb; payload jsonb;
  draft uuid; doc uuid; request uuid; signed_id uuid; result jsonb; repeated jsonb;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org AND is_demo)
    THEN RAISE EXCEPTION 'Fixture requires TEST / DEMO'; END IF;
  SELECT m.user_id INTO STRICT actor FROM public.organization_memberships m JOIN auth.users u ON u.id=m.user_id
    WHERE m.organization_id=org AND m.status='ACTIVE' AND m.member_type='OWNER' AND u.email='demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT building FROM public.buildings WHERE organization_id=org AND user_id=actor AND deleted_at IS NULL AND NOT coalesce(is_virtual,false) ORDER BY id LIMIT 1;
  SELECT id INTO STRICT book FROM public.accounts WHERE organization_id=org AND deleted_at IS NULL AND NOT coalesce(is_virtual,false) ORDER BY is_default DESC NULLS LAST,id LIMIT 1;
  SELECT id INTO STRICT dep_type FROM public.income_expense_types WHERE organization_id=org AND lower(type)='income' AND is_deposit ORDER BY id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  FOREACH scenario IN ARRAY ARRAY['cash-at-sign','direct','draft','no-hold-draft','abandon','bound','replaced-abandon','unrelated-zero','legacy-customer','moved-source'] LOOP
    room:=gen_random_uuid(); tenant:=gen_random_uuid(); draft:=gen_random_uuid(); doc:=gen_random_uuid(); request:=gen_random_uuid();
    inputs:='{}'; hold:=NULL; original:=NULL; phone:='09'||lpad(floor(random()*100000000)::text,8,'0');
    INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status)
      VALUES(room,building,org,'QA-coc-'||room,1000000,1000000,'AVAILABLE');
    INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES(tenant,org,actor,'Người ký QA',phone);
    IF scenario='legacy-customer' THEN
      old_customer:=gen_random_uuid();
      INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES(old_customer,org,actor,'Khách trên hồ sơ cũ','08'||right(phone,8));
    END IF;
    SET LOCAL ROLE authenticated;
    IF scenario='unrelated-zero' THEN
      hold:=public.create_room_reservation_v1(org,'qa-zero-'||room,jsonb_build_object('room_id',room,'customer_id',tenant,'hold_until',day+7));
    ELSIF scenario<>'no-hold-draft' THEN
      RESET ROLE;
      amount:=CASE WHEN scenario='bound' THEN 1000000 ELSE 100000 END;
      INSERT INTO public.income_expenses(user_id,organization_id,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,approved_by,approved_at)
        VALUES(actor,org,'INCOME','QA cọc cũ',building,room,book,day,amount,CASE WHEN scenario='moved-source' THEN 'UNAPPROVED' ELSE 'APPROVED' END,CASE WHEN scenario<>'moved-source' THEN actor END,CASE WHEN scenario<>'moved-source' THEN clock_timestamp() END) RETURNING id INTO original;
      INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,description,quantity,unit_price,amount,start_date,end_date,accounting_class)
        VALUES(original,org,dep_type,'Tiền cọc thử',1,amount,amount,day,day,'DEPOSIT');
      SET LOCAL ROLE authenticated;
      hold:=public.create_room_reservation_v1(org,'qa-hold-'||room,jsonb_build_object('room_id',room,'existing_voucher_ids',jsonb_build_array(original)) ||
        CASE WHEN scenario='legacy-customer' THEN jsonb_build_object('customer_id',old_customer) ELSE jsonb_build_object('customer_hint','Tên nhắc khác tên ký') END);
      IF original IS NULL OR (scenario<>'legacy-customer' AND hold->>'customer_id' IS NOT NULL) THEN RAISE EXCEPTION 'Expected hint-only hold'; END IF;
      IF scenario='legacy-customer' AND (hold->>'customer_id')::uuid IS DISTINCT FROM old_customer THEN RAISE EXCEPTION 'Missing historical customer'; END IF;
      IF scenario='abandon' THEN
        -- A confirmed abandonment releases this specific hold, while correcting a voucher below preserves it.
        snap:=public.preview_reservation_settlement_v1(original);
        PERFORM public.settle_reservation_deposit_v1(jsonb_build_object('voucherId',original,'refundAmount',100000,
          'refundMode','LATER','settlementDate',day,'reasonCode','NO_SHOW','reasonText','','basisFingerprint',snap->>'fingerprint','idempotencyKey',request::text));
        RESET ROLE;
        IF EXISTS(SELECT 1 FROM public.room_next_claims WHERE room_id=room AND status='LIVE')
          OR NOT EXISTS(SELECT 1 FROM public.room_reservations WHERE id=(hold->>'id')::uuid AND status='CANCELLED')
          THEN RAISE EXCEPTION 'Abandonment did not release hold'; END IF;
        RAISE NOTICE 'PASS abandon';
        CONTINUE;
      END IF;
      IF scenario='bound' THEN inputs:=ARRAY[original];
      ELSIF scenario<>'moved-source' THEN PERFORM public.cancel_income_voucher_v1(original,'QA thay phiếu'); END IF;
      IF scenario IN ('bound','moved-source') THEN
        IF (public.get_contract_room_deposits_v1(org,room)->'hold'->>'id') IS DISTINCT FROM (hold->>'id') THEN RAISE EXCEPTION 'Open source lost hold'; END IF;
      ELSIF (public.get_contract_room_deposits_v1(org,room)->'hold'->>'id') IS NOT NULL THEN
        RAISE EXCEPTION 'Last cancelled source retained its hold';
      END IF;
    END IF;
    RESET ROLE;
    FOREACH amount IN ARRAY (CASE WHEN scenario='bound' THEN ARRAY[]::int[] ELSE ARRAY[400000,600000] END) LOOP
      INSERT INTO public.income_expenses(user_id,organization_id,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,approved_by,approved_at)
        VALUES(actor,org,'INCOME','QA cọc thay thế',building,room,book,day,amount,'APPROVED',actor,clock_timestamp()) RETURNING id INTO source;
      INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,description,quantity,unit_price,amount,start_date,end_date,accounting_class)
        VALUES(source,org,dep_type,'Tiền cọc thử',1,amount,amount,day,day,'DEPOSIT');
      IF scenario<>'unrelated-zero' THEN PERFORM app_private.attach_deposit_income_v1(source,'{}',actor); END IF;
      inputs:=array_append(inputs,source);
    END LOOP;
    SET LOCAL ROLE authenticated;
    snap:=public.get_contract_room_deposits_v1(org,room);
    hold:=nullif(snap->'hold','null'::jsonb);
    terms:=jsonb_build_object('room_id',room,'signed_date',day,'start_date',day,'end_date',day+90,'rent_price',1000000,'total_deposit',1000000,'payment_cycle','MONTHLY','start_billing_date',day,'end_billing_date',day+5,'discount_months',0,'discount_amount_per_month',0,'notes','');
    parties:=jsonb_build_array(jsonb_build_object('id',tenant,'full_name','Người ký QA','phone',phone,'is_representative',true,'notes',NULL,'id_number',NULL));
    payload:=jsonb_build_object('contract',terms,'customers',jsonb_build_array(jsonb_build_object('customer_id',tenant,'is_representative',true)),
      'services','[]'::jsonb,'expected_room_deposit_amount',1000000,'existing_deposit_voucher_ids',to_jsonb(inputs)) ||
      CASE WHEN hold IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reservation_id',hold->>'id','reservation_revision',(hold->>'revision')::bigint) END;
    IF scenario='cash-at-sign' THEN
      payload:=jsonb_set(payload,'{contract,total_deposit}','1100000')||jsonb_build_object('deposit_receipts',jsonb_build_array(
        jsonb_build_object('amount',100000,'account_id',book,'received_date',day)));
    END IF;
    IF scenario='moved-source' THEN
      RESET ROLE;
      moved_room:=gen_random_uuid();
      INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status)
        VALUES(moved_room,building,org,'QA-coc-'||moved_room,1000000,1000000,'AVAILABLE');
      UPDATE public.income_expenses SET room_id=moved_room WHERE id=original;
      SET LOCAL ROLE authenticated;
      BEGIN
        PERFORM public.get_contract_room_deposits_v1(org,room);
        RAISE EXCEPTION 'Source moved away but snapshot hid the discrepancy';
      EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
      BEGIN
        PERFORM public.create_contract_v2(payload,request::text);
        RAISE EXCEPTION 'Contract consumed hold with unresolved source in another room';
      EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
    ELSE
    snap:=public.get_contract_room_deposits_v1(org,room);
    IF scenario<>'unrelated-zero' AND (jsonb_array_length(snap->'vouchers')<>cardinality(inputs) OR (SELECT sum((v->>'total_amount')::numeric) FROM jsonb_array_elements(snap->'vouchers') v WHERE (v->>'received')::boolean) IS DISTINCT FROM 1000000)
      THEN RAISE EXCEPTION 'Each received payment must appear once in the balance'; END IF;
    IF scenario='legacy-customer' AND snap->'hold'->>'hint'='Khách trên hồ sơ cũ' THEN RAISE EXCEPTION 'A directory name was exposed as a hold hint'; END IF;
    END IF;
    BEGIN
      PERFORM public.get_contract_room_deposits_v1(gen_random_uuid(),room);
      RAISE EXCEPTION 'Cross-org read succeeded';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    IF scenario IN ('replaced-abandon','unrelated-zero','moved-source') THEN
      FOREACH source IN ARRAY inputs LOOP
        snap:=public.preview_reservation_settlement_v1(source);
        PERFORM public.settle_reservation_deposit_v1(jsonb_build_object('voucherId',source,'refundAmount',(snap->>'depositAmount')::numeric,
          'refundMode','LATER','settlementDate',day,'reasonCode','NO_SHOW','reasonText','','basisFingerprint',snap->>'fingerprint','idempotencyKey',gen_random_uuid()::text));
        RESET ROLE;
        IF EXISTS(SELECT 1 FROM public.room_next_claims WHERE room_id=room AND status='LIVE') IS DISTINCT FROM
          (source=inputs[1] OR scenario IN ('unrelated-zero','moved-source')) THEN
          RAISE EXCEPTION 'Unexpected hold after settlement of replacement for %',scenario;
        END IF;
        SET LOCAL ROLE authenticated;
      END LOOP;
      RESET ROLE;
      RAISE NOTICE 'PASS %',scenario;
      CONTINUE;
    END IF;
    BEGIN
      PERFORM public.create_contract_v2(payload||jsonb_build_object('existing_deposit_voucher_ids',to_jsonb(inputs[1:cardinality(inputs)-1])),gen_random_uuid()::text);
      RAISE EXCEPTION 'Partial voucher set was accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
    BEGIN
      PERFORM public.create_contract_v2(payload||jsonb_build_object('expected_room_deposit_amount',999999),gen_random_uuid()::text);
      RAISE EXCEPTION 'Changed room deposit amount was accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
    IF hold IS NOT NULL THEN
      BEGIN
        PERFORM public.create_contract_v2(payload||jsonb_build_object('reservation_revision',(hold->>'revision')::bigint+1),gen_random_uuid()::text);
        RAISE EXCEPTION 'Stale hold was accepted';
      EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
    END IF;
    IF scenario IN ('cash-at-sign','direct','bound','legacy-customer') THEN
      result:=public.create_contract_v2(payload,request::text); repeated:=public.create_contract_v2(payload,request::text);
      signed_id:=(result->'contract'->>'id')::uuid;
      IF signed_id IS DISTINCT FROM (repeated->'contract'->>'id')::uuid THEN RAISE EXCEPTION 'Replay duplicated direct creation'; END IF;
    ELSE
      PERFORM public.save_contract_draft(org,building,room,jsonb_build_object('form',terms,'customers',parties,'services','[]'::jsonb,'use_custom_services',false),NULL,draft,NULL,gen_random_uuid());
      RESET ROLE;
      INSERT INTO public.contract_draft_documents(id,draft_id,revision,organization_id,building_id,document_path,template_path,document_sha256,template_sha256,template_snapshot,document_data,created_by)
        VALUES(doc,draft,1,org,building,'QA/'||doc,'QA/template/'||doc,repeat('a',64),repeat('b',64),'{}','{}',actor);
      SET LOCAL ROLE authenticated;
      result:=public.sign_and_checkin_contract_draft_v1(org,draft,1,doc,repeat('a',64),request,day,true,true,'{"state":"VERIFIED","readings":[]}',jsonb_build_object('expected_room_deposit_amount',1000000,'existing_deposit_voucher_ids',to_jsonb(inputs)),(hold->>'id')::uuid,(hold->>'revision')::bigint,CASE WHEN hold IS NOT NULL THEN inputs END);
      signed_id:=(result->>'contract_id')::uuid;
    END IF;
    RESET ROLE;
    IF signed_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.contracts WHERE id=signed_id AND deposit_paid=CASE WHEN scenario='cash-at-sign' THEN 1100000 ELSE 1000000 END)
      OR (SELECT count(*) FROM public.contract_deposit_links WHERE contract_id=signed_id AND income_expense_id=ANY(inputs))<>cardinality(inputs)
      OR (SELECT count(*) FROM public.income_expenses WHERE contract_id=signed_id AND public.ie_has_deposit_item(id))<>(cardinality(inputs)+(CASE WHEN scenario='cash-at-sign' THEN 1 ELSE 0 END))
      OR (scenario<>'bound' AND EXISTS(SELECT 1 FROM public.income_expenses WHERE id=original AND contract_id IS NOT NULL))
      OR NOT EXISTS(SELECT 1 FROM public.contract_customers WHERE contract_id=signed_id AND customer_id=tenant AND is_representative)
      OR EXISTS(SELECT 1 FROM public.room_next_claims WHERE room_id=room AND status='LIVE')
      THEN RAISE EXCEPTION 'Incorrect contract, party, room or money for %',scenario; END IF;
    RAISE NOTICE 'PASS %', scenario;
  END LOOP;
END $test$;
