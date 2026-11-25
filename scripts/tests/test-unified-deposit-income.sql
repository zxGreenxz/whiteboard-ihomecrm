-- Run on TEST / DEMO through test-env:thu-sql. The runner rolls the transaction back.
SET LOCAL statement_timeout='90s';
DO $test$
DECLARE
  org constant uuid:='dddd0000-0000-4000-8000-000000000001'; actor uuid; building uuid; book uuid;
  room uuid; first_source uuid; second_source uuid; hold uuid; key text; day date:=public.org_today_v1(org);
  row_data jsonb; terms jsonb; saved jsonb; replay jsonb; snap jsonb; first_channel text; second_channel text;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org AND is_demo)
    THEN RAISE EXCEPTION 'Requires TEST DEMO'; END IF;
  SELECT m.user_id INTO STRICT actor FROM public.organization_memberships m JOIN auth.users u ON u.id=m.user_id
    WHERE m.organization_id=org AND m.member_type='OWNER' AND m.status='ACTIVE' AND u.email='demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT building FROM public.buildings WHERE organization_id=org AND user_id=actor AND deleted_at IS NULL AND NOT coalesce(is_virtual,false) ORDER BY id LIMIT 1;
  SELECT id INTO STRICT book FROM public.accounts WHERE organization_id=org AND user_id=actor AND deleted_at IS NULL AND NOT coalesce(is_virtual,false) ORDER BY is_default DESC NULLS LAST,id LIMIT 1;
  WITH demo_role AS (
    INSERT INTO public.roles(organization_id,user_id,name,permissions) VALUES(org,actor,'QA deposits '||gen_random_uuid(),
      '{"income_expenses":{"create":true,"restricted_create":true,"approve":true}}'::jsonb) RETURNING id
  ) INSERT INTO public.staff_assignments(organization_id,user_id,staff_id,role_id,building_id) SELECT org,actor,actor,id,building FROM demo_role;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  FOREACH first_channel IN ARRAY ARRAY['finance','sale','reservation'] LOOP
    FOREACH second_channel IN ARRAY ARRAY['finance','sale','reservation'] LOOP
      room:=gen_random_uuid(); key:='qa-'||room;
      INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status)
        VALUES(room,building,org,'QA unified '||room,1000000,1000000,'AVAILABLE');
      SET LOCAL ROLE authenticated;
      row_data:=jsonb_build_object('type','INCOME','name','QA first','room_id',room,'account_id',book,'payer_name','Người gửi A','voucher_date',day,'amount',400000);
      terms:=jsonb_build_object('channel',first_channel,'expected_hold',NULL,'hold_until',day+3,'intended_move_in_on',day+3,'topup_due_on',day+7);
      saved:=public.create_deposit_income_v1(org,key,row_data,'[]',terms);
      hold:=(saved->>'reservation_id')::uuid;first_source:=(saved->>'id')::uuid;
      IF (public.get_deposit_income_hold_v1(org,room)->'hold'->>'id')::uuid IS DISTINCT FROM hold THEN RAISE EXCEPTION 'Incorrect room prefill'; END IF;
      replay:=public.create_deposit_income_v1(org,key,row_data,'[]',terms);
      IF hold IS NULL OR first_source IS NULL OR replay->>'id'<>saved->>'id' THEN RAISE EXCEPTION 'failed first / replay'; END IF;
      BEGIN
        PERFORM public.create_deposit_income_v1(org,key,row_data||jsonb_build_object('amount',500000),'[]',terms);
        RAISE EXCEPTION 'replay changed content'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
      END;
      BEGIN
        PERFORM public.create_deposit_income_v1(gen_random_uuid(),key,row_data,'[]',terms);
        RAISE EXCEPTION 'cross org accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        PERFORM public.create_deposit_income_v1(org,key||'-conflict',row_data,'[]',terms);
        RAISE EXCEPTION 'competing new hold accepted'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
      END;
      row_data:=row_data||jsonb_build_object('name','QA topup','payer_name','Người gửi B','amount',600000);
      saved:=public.create_deposit_income_v1(org,key||'-2',row_data,'[]',jsonb_build_object('channel',second_channel,'expected_hold',hold,'expected_revision',1));
      second_source:=(saved->>'id')::uuid;
      IF (saved->>'reservation_id')::uuid<>hold OR first_source=second_source THEN RAISE EXCEPTION 'wrong topup'; END IF;
      RESET ROLE;
      IF (SELECT count(*) FROM public.income_expenses WHERE room_id=room AND type='INCOME')<>2
         OR (SELECT payer_name FROM public.income_expenses WHERE id=second_source)<>'Người gửi B' THEN RAISE EXCEPTION 'wrong receipt count or payer'; END IF;
      IF (SELECT hold_until=day+3 AND intended_move_in_on=day+3 AND topup_due_on=day+7 FROM public.room_reservations WHERE id=hold) IS DISTINCT FROM true THEN RAISE EXCEPTION 'lost schedule'; END IF;
      SET LOCAL ROLE authenticated;
      IF (SELECT approval_status FROM public.income_expenses WHERE id=first_source)='UNAPPROVED' THEN PERFORM public.approve_income_expense_v1(first_source); END IF;
      IF (SELECT approval_status FROM public.income_expenses WHERE id=second_source)='UNAPPROVED' THEN PERFORM public.approve_income_expense_v1(second_source); END IF;
      snap:=public.get_contract_room_deposits_v1(org,room);
      IF jsonb_array_length(snap->'vouchers')<>2 OR (SELECT sum((v->>'total_amount')::numeric) FROM jsonb_array_elements(snap->'vouchers') v WHERE (v->>'received')::boolean) IS DISTINCT FROM 1000000 THEN RAISE EXCEPTION 'wrong signing total'; END IF;
      PERFORM public.cancel_income_voucher_v1(first_source,'QA cancel one');
      RESET ROLE;
      IF NOT EXISTS(SELECT 1 FROM public.room_reservations WHERE id=hold AND status='HOLD') THEN RAISE EXCEPTION 'closed after partial cancellation'; END IF;
      SET LOCAL ROLE authenticated;
      PERFORM public.cancel_income_voucher_v1(second_source,'QA cancel last');
      RESET ROLE;
      IF NOT EXISTS(SELECT 1 FROM public.room_reservations WHERE id=hold AND status='CANCELLED')
       OR EXISTS(SELECT 1 FROM public.room_next_claims WHERE room_id=room AND status='LIVE') THEN RAISE EXCEPTION 'last cancellation did not close'; END IF;
      SET LOCAL ROLE authenticated;
      saved:=public.create_deposit_income_v1(org,key||'-new',row_data,'[]',terms);
      IF (saved->>'reservation_id')::uuid=hold THEN RAISE EXCEPTION 'reopened old hold'; END IF;
      RESET ROLE;
      RAISE NOTICE 'PASS % then %; replay, conflict, cancel and replacement',first_channel,second_channel;
    END LOOP;
  END LOOP;
  room:=gen_random_uuid(); key:='qa-batch-'||room;
  INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status) VALUES(room,building,org,'QA batch '||room,1000000,1000000,'AVAILABLE');
  SET LOCAL ROLE authenticated;
  row_data:=jsonb_build_object('type','INCOME','name','QA mixed batch','room_id',room,'account_id',book,'voucher_date',day,'payer_name','Người gửi lô','batch_child',true);
  SELECT jsonb_build_array(
    jsonb_build_object('income_expense_type_id',(SELECT id FROM public.income_expense_types WHERE organization_id=org AND type='income' AND is_deposit LIMIT 1),'quantity',1,'unit_price',400000),
    jsonb_build_object('income_expense_type_id',(SELECT id FROM public.income_expense_types WHERE organization_id=org AND type='income' AND NOT coalesce(is_deposit,false) AND NOT coalesce(system_only,false) LIMIT 1),'quantity',1,'unit_price',50000)) INTO terms;
  saved:=public.create_deposit_income_v1(org,key||':0',row_data,terms,'{"channel":"finance"}');
  IF saved->>'approval_status' IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'Batch child lost finance approval behavior'; END IF;
  BEGIN
    PERFORM public.create_deposit_income_v1(org,key||':1',row_data||jsonb_build_object('room_id',gen_random_uuid()),terms,'{}');
    RAISE EXCEPTION 'Invalid child room accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (public.create_deposit_income_v1(org,key||':0',row_data,terms,'{"channel":"finance"}')->>'id')<>saved->>'id' THEN RAISE EXCEPTION 'Batch retry duplicated child'; END IF;
  first_source:=(saved->>'id')::uuid;
  snap:=public.get_contract_room_deposits_v1(org,room);
  IF (snap->'vouchers'->0->>'total_amount')::numeric<>400000 THEN RAISE EXCEPTION 'Mixed receipt included rent'; END IF;
  PERFORM public.cancel_income_voucher_v1(first_source,'QA batch rollback');
  IF (public.get_deposit_income_hold_v1(org,room)->'hold') IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Rolled-back batch retained claim'; END IF;
  saved:=public.create_deposit_income_v1(org,key||':pending',row_data||jsonb_build_object('repeat_cycle','MONTH','repeat_count',2,'repeat_remaining',2,'repeat_next_date',day+30),terms,'{"channel":"finance"}');
  IF saved->>'approval_status'<>'UNAPPROVED' OR (public.get_contract_room_deposits_v1(org,room)->'vouchers'->0->>'received')::boolean THEN RAISE EXCEPTION 'Pending receipt counted as money'; END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS mixed batch, partial failure, replay, release and recurring pending receipt';
  SET CONSTRAINTS ALL IMMEDIATE;
END $test$;


-- TEST DEMO owner has the current tenant permission without a legacy staff assignment.
DO $scope$
DECLARE
  org constant uuid:='dddd0000-0000-4000-8000-000000000001';
  owner_id uuid; denied_id uuid; building uuid; book uuid; room uuid:=gen_random_uuid();
  row_data jsonb; first_receipt jsonb; child boolean;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org AND is_demo)
    THEN RAISE EXCEPTION 'Requires TEST DEMO'; END IF;
  SELECT id INTO STRICT owner_id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT denied_id FROM auth.users WHERE email='demo.quanly2@username.ihomecrm.local';
  SELECT id INTO STRICT building FROM public.buildings WHERE organization_id=org AND name='DEMO Toà A' AND deleted_at IS NULL;
  SELECT cb.cashbook_id INTO STRICT book FROM public.cashbook_possession_bindings cb
    JOIN public.organization_memberships m ON m.id=cb.membership_id
    JOIN public.accounts a ON a.id=cb.cashbook_id AND a.deleted_at IS NULL
    WHERE m.user_id=owner_id AND cb.organization_id=org AND cb.valid_to IS NULL AND cb.possession_kind='CUSTODIAN' ORDER BY cb.cashbook_id LIMIT 1;
  INSERT INTO public.rooms(id,building_id,organization_id,name,status,rent_price,deposit_amount)
    VALUES(room,building,org,'QA scoped '||room::text,'AVAILABLE',10000,10000);
  row_data:=jsonb_build_object('type','INCOME','name','QA scoped collection','room_id',room,'account_id',book,'payer_name','DEMO',
    'voucher_date',public.org_today_v1(org),'amount',10000);
  PERFORM set_config('request.jwt.claim.sub',denied_id::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',denied_id,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  FOREACH child IN ARRAY ARRAY[false,true] LOOP
    BEGIN
      PERFORM public.create_deposit_income_v1(org,gen_random_uuid()::text,row_data||jsonb_build_object('batch_child',child),'[]','{}');
      RAISE EXCEPTION 'Create accepted outside authorized scope'; EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  RESET ROLE;
  IF EXISTS(SELECT 1 FROM public.income_expenses WHERE room_id=room) THEN RAISE EXCEPTION 'Denied request wrote voucher'; END IF;
  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  first_receipt:=public.create_deposit_income_v1(org,gen_random_uuid()::text,row_data,'[]','{"expected_hold":null}');
  IF first_receipt->>'id' IS NULL OR first_receipt->>'reservation_id' IS NULL THEN RAISE EXCEPTION 'Scoped owner receipt missing'; END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS current scoped authorization and denied ordinary/batch writes';
END $scope$;
