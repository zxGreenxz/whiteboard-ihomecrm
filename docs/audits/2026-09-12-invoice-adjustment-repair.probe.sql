-- Executed by scripts/test-invoice-adjustment-repair.mjs inside BEGIN/ROLLBACK.
-- The runner creates only a DEMO fixture and uses current flags without changes.
DO $probe$
DECLARE
  v_invoice_id uuid:=current_setting('v5h.invoice')::uuid;
  account_id uuid:=current_setting('v5h.account_tm')::uuid;
  today date:=public.org_today_v1('dddd0000-0000-4000-8000-000000000001');
  inv public.invoices%ROWTYPE; a public.invoice_adjustments%ROWTYPE; replay public.invoice_adjustments%ROWTYPE;
  first_collection uuid; second_collection uuid; response jsonb; items jsonb; historical text; snapshots jsonb;
  bad jsonb; probe_num integer:=0; foreign_id uuid;
BEGIN
  IF (SELECT organization_id FROM public.invoices WHERE id=v_invoice_id) IS DISTINCT FROM 'dddd0000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Refusing non-DEMO fixture'; END IF;
  response:=public.record_invoice_collection_v5(v_invoice_id,today,jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',50000,'account_id',account_id)),
    'REJECT',false,'rollback adjustment probe',NULL,0,'adjustment-probe-first-collection');
  first_collection:=(response->>'collection_id')::uuid;
  -- Execute deferred finance allocation before reading private accounting facts.
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('role','none',true);
  SELECT md5(jsonb_build_object('payment',(SELECT jsonb_agg(to_jsonb(p)) FROM public.payments p WHERE p.collection_id=first_collection),
    'allocation',(SELECT jsonb_agg(to_jsonb(fa) ORDER BY fa.id) FROM public.finance_invoice_component_allocations fa WHERE fa.collection_id=first_collection),
    'posting',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=first_collection))::text) INTO historical;
  IF (SELECT count(*) FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=first_collection)=0 THEN RAISE EXCEPTION 'Posting hash must cover actual postings'; END IF;
  IF (SELECT count(*) FROM public.finance_invoice_component_allocations WHERE collection_id=first_collection)<>1 THEN RAISE EXCEPTION 'First collection allocation missing'; END IF;
  PERFORM set_config('role','authenticated',true);
  SELECT * INTO inv FROM public.invoices WHERE id=v_invoice_id;
  items:='[{"type":"RENT","description":"Adjusted rent","unit_price":80000,"quantity":1,"coefficient":1,"accounting_class":"REVENUE"},
    {"type":"OTHER","description":"Adjusted deposit","unit_price":30000,"quantity":1,"coefficient":1,"accounting_class":"DEPOSIT"}]';
  a:=public.adjust_invoice_v2(v_invoice_id,items,0,'Saved discount note','Saved invoice note','Correct amounts',0,50000,inv.updated_at,'  adjustment-probe-revision-1  ');
  replay:=public.adjust_invoice_v2(v_invoice_id,items,0,'Saved discount note','Saved invoice note','Correct amounts',0,50000,inv.updated_at,'adjustment-probe-revision-1');
  IF a IS DISTINCT FROM replay OR a.revision<>1 OR a.after_total<>110000 THEN RAISE EXCEPTION 'Revision or replay mismatch'; END IF;
  IF (SELECT discount_notes FROM public.invoices WHERE id=v_invoice_id)<>'Saved discount note' OR (SELECT notes FROM public.invoices WHERE id=v_invoice_id)<>'Saved invoice note' THEN RAISE EXCEPTION 'Editable header not saved'; END IF;
  BEGIN
    PERFORM public.adjust_invoice_v2(v_invoice_id,items,1000,NULL,NULL,'Different request',0,50000,inv.updated_at,'adjustment-probe-revision-1');
    RAISE EXCEPTION 'Payload mismatch passed'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.adjust_invoice_v2(v_invoice_id,items,0,NULL,NULL,'Stale request',0,50000,inv.updated_at,'adjustment-probe-stale');
    RAISE EXCEPTION 'Stale revision passed'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  SELECT * INTO inv FROM public.invoices WHERE id=v_invoice_id;
  FOREACH bad IN ARRAY ARRAY['[]'::jsonb,'[null]'::jsonb,'[{"type":"RENT","description":"Invalid","unit_price":"NaN","accounting_class":"REVENUE"}]'::jsonb,
    '[{"type":"RENT","description":"Invalid","unit_price":-1,"accounting_class":"REVENUE"}]'::jsonb] LOOP
    probe_num:=probe_num+1;
    BEGIN
      PERFORM public.adjust_invoice_v2(v_invoice_id,bad,0,NULL,NULL,'Bad items',inv.adjustment_revision,inv.paid_amount,inv.updated_at,'adjustment-invalid-'||probe_num);
      RAISE EXCEPTION 'Malformed item passed'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
  -- This keeps total >= paid while attempting to move already posted PNL to deposit.
  BEGIN
    PERFORM public.adjust_invoice_v2(v_invoice_id,'[{"type":"RENT","description":"Rent","unit_price":40000,"accounting_class":"REVENUE"},
      {"type":"OTHER","description":"Deposit","unit_price":70000,"accounting_class":"DEPOSIT"}]',0,NULL,NULL,'Invalid semantic shift',inv.adjustment_revision,inv.paid_amount,inv.updated_at,'adjustment-covered-money');
    RAISE EXCEPTION 'Covered money reduction passed'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  response:=public.record_invoice_collection_v5(v_invoice_id,today,jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',60000,'account_id',account_id)),
    'REJECT',false,'rollback revision collection',NULL,50000,'adjustment-probe-second-collection');
  second_collection:=(response->>'collection_id')::uuid;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('role','none',true);
  IF (SELECT sum(fa.amount) FROM public.finance_invoice_component_allocations fa JOIN public.finance_invoice_components c ON c.id=fa.component_id
      WHERE fa.collection_id=second_collection AND c.component_kind='CURRENT_CHARGE') IS DISTINCT FROM 30000
    OR (SELECT sum(fa.amount) FROM public.finance_invoice_component_allocations fa JOIN public.finance_invoice_components c ON c.id=fa.component_id
      WHERE fa.collection_id=second_collection AND c.component_kind='CURRENT_DEPOSIT') IS DISTINCT FROM 30000 THEN RAISE EXCEPTION 'Second collection must allocate 30000 charge + 30000 deposit'; END IF;
  IF (SELECT m.adjustment_revision FROM public.invoice_payment_collections c JOIN public.finance_invoice_component_manifests m ON m.id=c.component_manifest_id
      WHERE c.id=second_collection) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Second collection not pinned to revision one'; END IF;
  PERFORM set_config('role','authenticated',true);
  snapshots:=to_jsonb(a)-'review_status'-'checked_by'-'checked_at';
  a:=public.review_invoice_adjustment_v2(a.id,1);
  IF a.review_status<>'CHECKED' OR snapshots IS DISTINCT FROM to_jsonb(a)-'review_status'-'checked_by'-'checked_at' THEN RAISE EXCEPTION 'Review mutated financial history'; END IF;
  PERFORM public.reverse_invoice_collection_v5(second_collection,today,'Rollback adjustment probe reversal','adjustment-probe-second-reverse');
  SELECT * INTO inv FROM public.invoices WHERE id=v_invoice_id;
  a:=public.adjust_invoice_v2(v_invoice_id,items,1000,'Actual discount','Second revision','Discount after reversal',inv.adjustment_revision,inv.paid_amount,inv.updated_at,'adjustment-probe-revision-2');
  IF a.revision<>2 OR a.after_total<>109000 OR (SELECT discount_amount FROM public.invoices WHERE id=v_invoice_id)<>1000 THEN RAISE EXCEPTION 'Second adjustment/discount failed'; END IF;
  BEGIN PERFORM public.review_invoice_adjustment_v2(a.id,1); RAISE EXCEPTION 'Stale review passed'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  -- Current line identities, readings/dates and fractional factors survive notes-only saves.
  SELECT * INTO inv FROM public.invoices WHERE id=v_invoice_id;
  SELECT jsonb_agg(to_jsonb(i)||CASE WHEN i.accounting_class='REVENUE'
    THEN '{"unit_price":10000,"quantity":2.5,"coefficient":3.2,"previous_reading":3,"current_reading":7,"from_date":"2093-10-01","to_date":"2093-10-12"}'::jsonb ELSE '{}'::jsonb END ORDER BY i.sort_order,i.id)
    INTO items FROM public.invoice_items i WHERE i.invoice_id=v_invoice_id;
  a:=public.adjust_invoice_v2(v_invoice_id,items,1000,'Actual discount','Fractional metadata','Preserve current metadata',inv.adjustment_revision,inv.paid_amount,inv.updated_at,'adjustment-probe-metadata');
  SELECT * INTO inv FROM public.invoices WHERE id=v_invoice_id;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order,i.id) INTO items FROM public.invoice_items i WHERE i.invoice_id=v_invoice_id;
  a:=public.adjust_invoice_v2(v_invoice_id,items,1000,'Actual discount','Notes only final','Notes only revision',inv.adjustment_revision,inv.paid_amount,inv.updated_at,'adjustment-probe-notes-only');
  IF items IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order,i.id) FROM public.invoice_items i WHERE i.invoice_id=v_invoice_id) THEN
    RAISE EXCEPTION 'Notes-only revision changed line identity or metadata'; END IF;
  PERFORM set_config('role','none',true);
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)'::regprocedure,
      'public.review_invoice_adjustment_v2(uuid,bigint)'::regprocedure) AND (NOT p.prosecdef OR p.provolatile<>'v' OR p.proconfig IS NULL
      OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE') OR NOT has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'RPC volatility/definer/search_path/ACL mismatch'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.guard_paid_invoice_direct_adjustment()'::regprocedure) THEN RAISE EXCEPTION 'Direct guard must remain SECURITY INVOKER'; END IF;
  IF historical IS DISTINCT FROM md5(jsonb_build_object('payment',(SELECT jsonb_agg(to_jsonb(p)) FROM public.payments p WHERE p.collection_id=first_collection),
    'allocation',(SELECT jsonb_agg(to_jsonb(fa) ORDER BY fa.id) FROM public.finance_invoice_component_allocations fa WHERE fa.collection_id=first_collection),
    'posting',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=first_collection))::text) THEN RAISE EXCEPTION 'Original collected money changed'; END IF;
  SELECT id INTO foreign_id FROM public.invoices WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  PERFORM set_config('role','authenticated',true);
  IF foreign_id IS NULL THEN RAISE EXCEPTION 'Missing cross-org deny target'; END IF;
  BEGIN
    PERFORM public.adjust_invoice_v2(foreign_id,items,0,NULL,NULL,'Cross org request',0,0,now(),'adjustment-cross-org');
    RAISE EXCEPTION 'Cross-org request passed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $probe$;
