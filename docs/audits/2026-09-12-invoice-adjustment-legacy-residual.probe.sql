-- Live rollback-only missing-allocation proof, using real V5 writers and their
-- ordinary deferred allocator. No historical money is forged/deleted; no
-- triggers, accounting flags, RLS or integrity gates are disabled.
-- Before flushing deferred events both collections exist. The first attempt
-- cannot classify its mixed unallocated peer and remains unknown; the second
-- can prove its pure-PNL peer and gets complete new component allocations.
DO $legacy_residual_probe$
DECLARE
  v_invoice uuid:=current_setting('v5h.invoice')::uuid;
  v_account uuid:=current_setting('v5h.account_tm')::uuid;
  v_today date:=public.org_today_v1('dddd0000-0000-4000-8000-000000000001');
  v_inv public.invoices%ROWTYPE; v_adjustment public.invoice_adjustments%ROWTYPE;
  v_first uuid; v_second uuid; v_response jsonb; v_report record; v_items jsonb;
BEGIN
  v_response:=public.record_invoice_collection_v5(v_invoice,v_today,
    jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',50000,'account_id',v_account)),
    'REJECT',false,'residual first collection',NULL,0,'residual-probe-first-collection');
  v_first:=(v_response->>'collection_id')::uuid;
  SELECT * INTO v_inv FROM public.invoices WHERE id=v_invoice;
  v_items:='[{"type":"RENT","description":"Current charge","unit_price":80000,"accounting_class":"REVENUE"},
    {"type":"OTHER","description":"Current deposit","unit_price":20000,"accounting_class":"DEPOSIT"}]';
  v_adjustment:=public.adjust_invoice_v2(v_invoice,v_items,0,NULL,'Residual revision one','Add deposit component',v_inv.adjustment_revision,v_inv.paid_amount,v_inv.updated_at,'residual-probe-first-adjustment');
  SELECT * INTO v_report FROM public.business_performance_invoice_cohort_v1('dddd0000-0000-4000-8000-000000000001','2093-11-01',ARRAY[current_setting('v5h.building')::uuid]);
  IF v_report.cohort_available IS DISTINCT FROM true OR v_report.invoice_count<>1 OR v_report.billed_current_charge IS DISTINCT FROM 80000
    OR v_report.collected_current_charge IS DISTINCT FROM 50000 OR v_report.allocation_unknown_count<>0 THEN
    RAISE EXCEPTION 'Legacy PNL report was lost after adding deposit: %',to_jsonb(v_report); END IF;
  v_response:=public.record_invoice_collection_v5(v_invoice,v_today,
    jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',50000,'account_id',v_account)),
    'REJECT',false,'residual second collection',NULL,50000,'residual-probe-second-collection');
  v_second:=(v_response->>'collection_id')::uuid;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('role','none',true);
  IF EXISTS(SELECT 1 FROM public.finance_invoice_component_allocations WHERE collection_id=v_first) THEN
    RAISE EXCEPTION 'Residual fixture must have no old component allocations'; END IF;
  IF (SELECT sum(a.amount) FROM public.finance_invoice_component_allocations a JOIN public.finance_invoice_components c ON c.id=a.component_id
      WHERE a.collection_id=v_second AND c.component_kind='CURRENT_CHARGE') IS DISTINCT FROM 30000
    OR (SELECT sum(a.amount) FROM public.finance_invoice_component_allocations a JOIN public.finance_invoice_components c ON c.id=a.component_id
      WHERE a.collection_id=v_second AND c.component_kind='CURRENT_DEPOSIT') IS DISTINCT FROM 20000 THEN
    RAISE EXCEPTION 'Residual fixture new allocations must be 30000 charge + 20000 deposit'; END IF;
  IF app_private.proved_legacy_invoice_pnl_v2(v_invoice) IS DISTINCT FROM 50000 THEN
    RAISE EXCEPTION 'Known new deposit prevented proof of the old 50000 PNL'; END IF;
  PERFORM set_config('role','authenticated',true);
  SELECT * INTO v_inv FROM public.invoices WHERE id=v_invoice;
  v_items:='[{"type":"RENT","description":"Current charge","unit_price":90000,"accounting_class":"REVENUE"},
    {"type":"OTHER","description":"Current deposit","unit_price":30000,"accounting_class":"DEPOSIT"}]';
  v_adjustment:=public.adjust_invoice_v2(v_invoice,v_items,0,NULL,'Residual revision two','Increase current components',v_inv.adjustment_revision,v_inv.paid_amount,v_inv.updated_at,'residual-probe-second-adjustment');
  IF v_adjustment.revision<>2 OR v_adjustment.after_total<>120000 THEN RAISE EXCEPTION 'Residual second adjustment failed'; END IF;
  SELECT * INTO v_report FROM public.business_performance_invoice_cohort_v1('dddd0000-0000-4000-8000-000000000001','2093-11-01',ARRAY[current_setting('v5h.building')::uuid]);
  IF v_report.cohort_available IS DISTINCT FROM true OR v_report.billed_current_charge IS DISTINCT FROM 90000
    OR v_report.collected_current_charge IS DISTINCT FROM 80000 OR v_report.allocation_unknown_count<>0 THEN
    RAISE EXCEPTION 'Legacy plus allocated current charge reported incorrectly: %',to_jsonb(v_report); END IF;
  PERFORM set_config('role','none',true);
  IF EXISTS(SELECT 1 FROM public.finance_invoice_component_allocations WHERE collection_id=v_first) THEN
    RAISE EXCEPTION 'Adjustment fabricated historical allocations'; END IF;
  PERFORM set_config('role','authenticated',true);
END $legacy_residual_probe$;
