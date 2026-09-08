-- Runs inside the harness's DEMO-only BEGIN/ROLLBACK, with all triggers enabled.
RESET ROLE;
DO $basis$
DECLARE
 org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
 cid uuid := current_setting('v5h.contract')::uuid;
 actor uuid := current_setting('v5h.actor')::uuid;
 bid uuid := current_setting('v5h.building')::uuid;
 aid uuid := current_setting('v5h.account_tm')::uuid;
 virt uuid := current_setting('v5h.virtual_account')::uuid;
 typ uuid; vid uuid; holding uuid; mixed uuid; before_basis jsonb; after_basis jsonb; r record; actual record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.contracts WHERE id=cid AND organization_id=org) THEN RAISE EXCEPTION 'DEMO only'; END IF;
 SELECT id INTO STRICT typ FROM public.income_expense_types WHERE organization_id=org AND is_deposit ORDER BY id LIMIT 1;
 before_basis:=app_private.resolve_signed_contract_deposit_basis_v1(org,cid);
 FOR r IN SELECT * FROM (VALUES
  ('holding','INCOME',2000000::numeric,0::numeric,'APPROVED','POSTED',false,NULL::text,NULL::text,2000000::numeric),
  ('mixed','INCOME',2926000,5074000,'APPROVED','POSTED',false,NULL,NULL,2926000),
  ('partial','INCOME',74000,126000,'APPROVED','POSTED',false,NULL,NULL,74000),
  ('refund','EXPENSE',100000,0,'APPROVED','POSTED',false,'termination.refund',NULL,-100000),
  ('reversed','INCOME',800000,0,'APPROVED','REVERSED',false,NULL,NULL,0),
  ('reversal','EXPENSE',800000,0,'APPROVED','POSTED',false,NULL,'reversal',0),
  ('virtual','INCOME',500000,0,'APPROVED','NOT_APPLICABLE',true,NULL,NULL,500000),
  ('forfeit','EXPENSE',200000,0,'APPROVED','NOT_APPLICABLE',true,'termination.forfeit_offset',NULL,-200000),
  ('cancelled','INCOME',600000,0,'CANCELLED','UNPOSTED',false,NULL,NULL,0),
  ('unapproved','INCOME',600000,0,'UNAPPROVED','UNPOSTED',false,NULL,NULL,0),
  ('unposted','INCOME',600000,0,'APPROVED','UNPOSTED',false,NULL,NULL,0),
  ('deleted','INCOME',600000,0,'APPROVED','POSTED',false,NULL,'deleted',0),
  ('linked','INCOME',1000,0,'APPROVED','POSTED',false,NULL,'linked',1000)
 ) AS f(label,direction,deposit,revenue,approval,posting,virtual,source,special,expected)
 LOOP
  IF r.special='reversal' OR r.label='forfeit' THEN PERFORM app_private.begin_accounting_chain_write_v1(); END IF;
  INSERT INTO public.income_expenses(organization_id,user_id,building_id,contract_id,account_id,type,name,voucher_date,approval_status,posting_status,system_source,reversal_of_income_expense_id,deleted_at)
  VALUES(org,actor,bid,CASE WHEN r.special='linked' THEN NULL ELSE cid END,CASE WHEN r.virtual THEN virt ELSE aid END,r.direction,'[deposit-basis-fixture] '||r.label,current_date,r.approval,r.posting,r.source,CASE WHEN r.special='reversal' THEN holding END,CASE WHEN r.special='deleted' THEN now() END)
  RETURNING id INTO vid;
  INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,accounting_class)
  VALUES(org,vid,typ,'Explicit deposit snapshot',1,r.deposit,'DEPOSIT');
  IF r.revenue>0 THEN
   INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,accounting_class)
   VALUES(org,vid,typ,'Revenue even with deposit display type',1,r.revenue,'PNL');
  END IF;
  UPDATE public.income_expenses SET posting_status=r.posting WHERE id=vid AND organization_id=org;
  IF r.label='holding' THEN holding:=vid; END IF;
  IF r.label='mixed' THEN mixed:=vid; END IF;
  IF r.special='linked' OR r.label='holding' THEN
   INSERT INTO public.contract_deposit_links(organization_id,contract_id,income_expense_id,linked_by) VALUES(org,cid,vid,actor);
  END IF;
  IF r.special='reversal' OR r.label='forfeit' THEN PERFORM app_private.end_accounting_chain_write_v1(); END IF;
  SELECT * INTO STRICT actual FROM app_private.contract_deposit_sources_v1(org,cid) WHERE voucher_id=vid;
  IF actual.amount IS DISTINCT FROM r.deposit OR actual.signed_amount IS DISTINCT FROM r.expected THEN
   RAISE EXCEPTION 'Basis % expected amount % signed %, got %',r.label,r.deposit,r.expected,row_to_json(actual); END IF;
  IF r.label='mixed' THEN
   after_basis:=app_private.resolve_signed_contract_deposit_basis_v1(org,cid);
   IF (after_basis->>'netHeld')::numeric-(before_basis->>'netHeld')::numeric<>4926000 THEN RAISE EXCEPTION '505 mixed basis must add 4926000: %',after_basis; END IF;
  END IF;
 END LOOP;
 after_basis:=app_private.resolve_signed_contract_deposit_basis_v1(org,cid);
 IF (after_basis->>'netHeld')::numeric-(before_basis->>'netHeld')::numeric<>4901000
 OR (after_basis->>'recognizedHistoricalIn')::numeric-(before_basis->>'recognizedHistoricalIn')::numeric<>300000 THEN
  RAISE EXCEPTION 'Basis cash/history separation failed: %',after_basis; END IF;
 IF (SELECT count(*) FROM app_private.contract_deposit_sources_v1(org,cid) WHERE voucher_id=holding)<>1 THEN RAISE EXCEPTION 'Link counted twice'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.contract_deposit_sources_v1(gen_random_uuid(),cid)) THEN RAISE EXCEPTION 'Cross-org source leakage'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.contract_deposit_sources_v1(org,cid,now()-interval '1 day') WHERE voucher_id=mixed) THEN RAISE EXCEPTION 'As-of scope ignored'; END IF;
 PERFORM set_config('deposit_test.basis','PASS',true);
END $basis$;
