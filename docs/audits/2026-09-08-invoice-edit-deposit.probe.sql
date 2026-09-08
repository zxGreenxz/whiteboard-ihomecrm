-- Diagnostic observation of the CURRENT live bug, NOT a passing behavior regression test.
-- Run as one statement batch via the approved DEMO management-query harness.
-- Only DEMO fixtures are written; no DDL, feature-flag override, or real-org write.
-- Every fixture and audit row is rolled back. Do not replace ROLLBACK with COMMIT.
-- Success returns two BUG_REPRODUCED rows; once fixed these assertions should fail.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='2min';

RESET ROLE;

DO $v5h_fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_actor uuid;
  v_contract uuid;
  v_owner uuid;
  v_building uuid;
  v_room uuid;
  v_account_tm uuid;
  v_account_tk uuid;
  v_virtual_account uuid;
  v_cross_org_account uuid;
  v_invoice uuid;
BEGIN
  SELECT id INTO v_actor FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy DEMO owner % để chạy harness', 'demo.chunha@username.ihomecrm.local';
  END IF;

  SELECT contract_row.id, contract_row.user_id, room_row.building_id, contract_row.room_id
    INTO v_contract, v_owner, v_building, v_room
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.organization_id = v_org
    AND contract_row.deleted_at IS NULL
    AND contract_row.status = 'ACTIVE'
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', building_row.id, NULL
      )
    ), false)
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices invoice_row
      WHERE invoice_row.contract_id = contract_row.id
        AND invoice_row.billing_month = '2093-12'
        AND invoice_row.deleted_at IS NULL
    )
  ORDER BY contract_row.id
  LIMIT 1;

  IF v_contract IS NULL THEN
    RAISE EXCEPTION 'Không có hợp đồng DEMO đủ điều kiện + quyền thu tiền cho harness';
  END IF;

  SELECT account_row.id INTO v_account_tm
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account_tk
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual AND account_row.id <> v_account_tm
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;
  -- Multi-tender can legally reuse one real account when only one exists.
  v_account_tk := COALESCE(v_account_tk, v_account_tm);

  SELECT account_row.id INTO v_virtual_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND account_row.is_virtual
  ORDER BY account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_cross_org_account
  FROM public.accounts account_row
  WHERE account_row.organization_id <> v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.organization_id, account_row.id
  LIMIT 1;

  IF v_account_tm IS NULL OR v_virtual_account IS NULL THEN
    RAISE EXCEPTION 'DEMO thiếu sổ quỹ thật/ảo cho harness';
  END IF;

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_owner, v_contract, v_building, v_room, 'MONTHLY',
    '2093-12', '2093-12-01',
    '2093-12-10', 'APPROVED',
    7490000, 7490000, '[E2E-V5-HARNESS:invoice-edit-classification-false]'
  ) RETURNING id INTO v_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, accounting_class, type, description,
    unit_price, quantity, coefficient, amount, sort_order
  ) VALUES
    (v_invoice, 'REVENUE', 'RENT', 'Harness revenue', 5290000, 1, 1, 5290000, 1),
    (v_invoice, 'DEPOSIT', 'OTHER', 'Harness deposit', 2200000, 1, 1, 2200000, 2);

  PERFORM public.recompute_invoice_for_id(v_invoice);

  PERFORM set_config('v5h.actor', v_actor::text, true);
  PERFORM set_config('v5h.contract', v_contract::text, true);
  PERFORM set_config('v5h.building', v_building::text, true);
  PERFORM set_config('v5h.room', v_room::text, true);
  PERFORM set_config('v5h.invoice', v_invoice::text, true);
  PERFORM set_config('v5h.account_tm', v_account_tm::text, true);
  PERFORM set_config('v5h.account_tk', v_account_tk::text, true);
  PERFORM set_config('v5h.virtual_account', v_virtual_account::text, true);
  PERFORM set_config('v5h.cross_org_account',
    COALESCE(v_cross_org_account::text, ''), true);
END
$v5h_fixture$;

UPDATE public.invoice_items SET description='Tiền cọc'
 WHERE invoice_id=current_setting('v5h.invoice')::uuid AND accounting_class='DEPOSIT'
 AND organization_id='dddd0000-0000-4000-8000-000000000001';

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('v5h.actor'),
    'role', 'authenticated',
    'email', 'v5-collection-harness@example.test',
    'user_metadata', jsonb_build_object('full_name', 'V5 Collection Harness')
  )::text,
  true
);
SET LOCAL ROLE authenticated;

DO $proof$
DECLARE
 v_invoice public.invoices%ROWTYPE; v_before jsonb; v_after jsonb; v_items jsonb; v_request jsonb;
BEGIN
 SELECT * INTO STRICT v_invoice FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 IF v_invoice.organization_id <> 'dddd0000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'DEMO only'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'description',description,'type',type,'amount',amount,'accounting_class',accounting_class) ORDER BY sort_order),
 jsonb_agg(jsonb_build_object('service_id',service_id,'type',type,'description',description,'unit_price',unit_price,'quantity',quantity,'coefficient',coefficient,'amount',unit_price*quantity*coefficient,'previous_reading',previous_reading,'current_reading',current_reading,'from_date',from_date,'to_date',to_date,'sort_order',sort_order)  ORDER BY sort_order)
 INTO v_before,v_items FROM public.invoice_items WHERE invoice_id=v_invoice.id;
 IF v_before->1->>'accounting_class' IS DISTINCT FROM 'DEPOSIT' THEN RAISE EXCEPTION 'fixture not DEPOSIT: %',v_before; END IF;
 v_request := jsonb_build_object('p_invoice_id',v_invoice.id,'p_contract_id',v_invoice.contract_id,'p_building_id',v_invoice.building_id,'p_room_id',v_invoice.room_id,'p_billing_month',v_invoice.billing_month,'p_issue_date',v_invoice.issue_date,'p_due_date',v_invoice.due_date,'p_subtotal',v_invoice.subtotal,'p_discount_amount',v_invoice.discount_amount,'p_total_amount',v_invoice.total_amount,'p_previous_debt',v_invoice.previous_debt,'p_items',v_items,'p_prepaid_amount',v_invoice.prepaid_amount,'p_discount_notes',v_invoice.discount_notes,'p_electricity_prev_overridden',v_invoice.electricity_prev_overridden,'p_previous_debt_sources',v_invoice.previous_debt_sources,'p_template_id',v_invoice.template_id,'p_notes',v_invoice.notes || ' only notes edited');
 PERFORM public.update_invoice_v1(v_invoice.id,v_invoice.contract_id,v_invoice.building_id,v_invoice.room_id,v_invoice.billing_month,v_invoice.issue_date,v_invoice.due_date,v_invoice.subtotal,v_invoice.discount_amount,v_invoice.total_amount,v_invoice.previous_debt,v_items,v_invoice.prepaid_amount,v_invoice.discount_notes,v_invoice.electricity_prev_overridden,v_invoice.previous_debt_sources,v_invoice.template_id,v_invoice.notes || ' only notes edited');
 SELECT jsonb_agg(jsonb_build_object('id',id,'description',description,'type',type,'amount',amount,'accounting_class',accounting_class) ORDER BY sort_order) INTO v_after FROM public.invoice_items WHERE invoice_id=v_invoice.id;
 IF v_after->1->>'accounting_class' IS DISTINCT FROM 'REVENUE' THEN RAISE EXCEPTION 'loss not reproduced: %',v_after; END IF;
 IF ((v_before->1) - 'id' - 'accounting_class') IS DISTINCT FROM ((v_after->1) - 'id' - 'accounting_class') THEN RAISE EXCEPTION 'other deposit fields changed'; END IF;
 IF v_before->1->>'id' IS NOT DISTINCT FROM v_after->1->>'id' THEN RAISE EXCEPTION 'items not replaced'; END IF;
 PERFORM set_config('edit_proof.results',(COALESCE(NULLIF(current_setting('edit_proof.results',true),''),'[]')::jsonb || jsonb_build_array(jsonb_build_object('scenario','frontend_payload_note_only','organization_id',v_invoice.organization_id,'before',v_before,'request',v_request,'after',v_after,'status','BUG_REPRODUCED')) )::text,true);
END $proof$;


RESET ROLE;

DO $v5h_fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_actor uuid;
  v_contract uuid;
  v_owner uuid;
  v_building uuid;
  v_room uuid;
  v_account_tm uuid;
  v_account_tk uuid;
  v_virtual_account uuid;
  v_cross_org_account uuid;
  v_invoice uuid;
BEGIN
  SELECT id INTO v_actor FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy DEMO owner % để chạy harness', 'demo.chunha@username.ihomecrm.local';
  END IF;

  SELECT contract_row.id, contract_row.user_id, room_row.building_id, contract_row.room_id
    INTO v_contract, v_owner, v_building, v_room
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.organization_id = v_org
    AND contract_row.deleted_at IS NULL
    AND contract_row.status = 'ACTIVE'
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', building_row.id, NULL
      )
    ), false)
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices invoice_row
      WHERE invoice_row.contract_id = contract_row.id
        AND invoice_row.billing_month = '2094-01'
        AND invoice_row.deleted_at IS NULL
    )
  ORDER BY contract_row.id
  LIMIT 1;

  IF v_contract IS NULL THEN
    RAISE EXCEPTION 'Không có hợp đồng DEMO đủ điều kiện + quyền thu tiền cho harness';
  END IF;

  SELECT account_row.id INTO v_account_tm
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account_tk
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual AND account_row.id <> v_account_tm
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;
  -- Multi-tender can legally reuse one real account when only one exists.
  v_account_tk := COALESCE(v_account_tk, v_account_tm);

  SELECT account_row.id INTO v_virtual_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND account_row.is_virtual
  ORDER BY account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_cross_org_account
  FROM public.accounts account_row
  WHERE account_row.organization_id <> v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.organization_id, account_row.id
  LIMIT 1;

  IF v_account_tm IS NULL OR v_virtual_account IS NULL THEN
    RAISE EXCEPTION 'DEMO thiếu sổ quỹ thật/ảo cho harness';
  END IF;

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_owner, v_contract, v_building, v_room, 'MONTHLY',
    '2094-01', '2094-01-01',
    '2094-01-10', 'APPROVED',
    7490000, 7490000, '[E2E-V5-HARNESS:invoice-edit-classification-true]'
  ) RETURNING id INTO v_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, accounting_class, type, description,
    unit_price, quantity, coefficient, amount, sort_order
  ) VALUES
    (v_invoice, 'REVENUE', 'RENT', 'Harness revenue', 5290000, 1, 1, 5290000, 1),
    (v_invoice, 'DEPOSIT', 'OTHER', 'Harness deposit', 2200000, 1, 1, 2200000, 2);

  PERFORM public.recompute_invoice_for_id(v_invoice);

  PERFORM set_config('v5h.actor', v_actor::text, true);
  PERFORM set_config('v5h.contract', v_contract::text, true);
  PERFORM set_config('v5h.building', v_building::text, true);
  PERFORM set_config('v5h.room', v_room::text, true);
  PERFORM set_config('v5h.invoice', v_invoice::text, true);
  PERFORM set_config('v5h.account_tm', v_account_tm::text, true);
  PERFORM set_config('v5h.account_tk', v_account_tk::text, true);
  PERFORM set_config('v5h.virtual_account', v_virtual_account::text, true);
  PERFORM set_config('v5h.cross_org_account',
    COALESCE(v_cross_org_account::text, ''), true);
END
$v5h_fixture$;

UPDATE public.invoice_items SET description='Tiền cọc'
 WHERE invoice_id=current_setting('v5h.invoice')::uuid AND accounting_class='DEPOSIT'
 AND organization_id='dddd0000-0000-4000-8000-000000000001';

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('v5h.actor'),
    'role', 'authenticated',
    'email', 'v5-collection-harness@example.test',
    'user_metadata', jsonb_build_object('full_name', 'V5 Collection Harness')
  )::text,
  true
);
SET LOCAL ROLE authenticated;

DO $proof$
DECLARE
 v_invoice public.invoices%ROWTYPE; v_before jsonb; v_after jsonb; v_items jsonb; v_request jsonb;
BEGIN
 SELECT * INTO STRICT v_invoice FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 IF v_invoice.organization_id <> 'dddd0000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'DEMO only'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'description',description,'type',type,'amount',amount,'accounting_class',accounting_class) ORDER BY sort_order),
 jsonb_agg(jsonb_build_object('service_id',service_id,'type',type,'description',description,'unit_price',unit_price,'quantity',quantity,'coefficient',coefficient,'amount',unit_price*quantity*coefficient,'previous_reading',previous_reading,'current_reading',current_reading,'from_date',from_date,'to_date',to_date,'sort_order',sort_order) || jsonb_build_object('accounting_class',accounting_class) ORDER BY sort_order)
 INTO v_before,v_items FROM public.invoice_items WHERE invoice_id=v_invoice.id;
 IF v_before->1->>'accounting_class' IS DISTINCT FROM 'DEPOSIT' THEN RAISE EXCEPTION 'fixture not DEPOSIT: %',v_before; END IF;
 v_request := jsonb_build_object('p_invoice_id',v_invoice.id,'p_contract_id',v_invoice.contract_id,'p_building_id',v_invoice.building_id,'p_room_id',v_invoice.room_id,'p_billing_month',v_invoice.billing_month,'p_issue_date',v_invoice.issue_date,'p_due_date',v_invoice.due_date,'p_subtotal',v_invoice.subtotal,'p_discount_amount',v_invoice.discount_amount,'p_total_amount',v_invoice.total_amount,'p_previous_debt',v_invoice.previous_debt,'p_items',v_items,'p_prepaid_amount',v_invoice.prepaid_amount,'p_discount_notes',v_invoice.discount_notes,'p_electricity_prev_overridden',v_invoice.electricity_prev_overridden,'p_previous_debt_sources',v_invoice.previous_debt_sources,'p_template_id',v_invoice.template_id,'p_notes',v_invoice.notes || ' only notes edited');
 PERFORM public.update_invoice_v1(v_invoice.id,v_invoice.contract_id,v_invoice.building_id,v_invoice.room_id,v_invoice.billing_month,v_invoice.issue_date,v_invoice.due_date,v_invoice.subtotal,v_invoice.discount_amount,v_invoice.total_amount,v_invoice.previous_debt,v_items,v_invoice.prepaid_amount,v_invoice.discount_notes,v_invoice.electricity_prev_overridden,v_invoice.previous_debt_sources,v_invoice.template_id,v_invoice.notes || ' only notes edited');
 SELECT jsonb_agg(jsonb_build_object('id',id,'description',description,'type',type,'amount',amount,'accounting_class',accounting_class) ORDER BY sort_order) INTO v_after FROM public.invoice_items WHERE invoice_id=v_invoice.id;
 IF v_after->1->>'accounting_class' IS DISTINCT FROM 'REVENUE' THEN RAISE EXCEPTION 'loss not reproduced: %',v_after; END IF;
 IF ((v_before->1) - 'id' - 'accounting_class') IS DISTINCT FROM ((v_after->1) - 'id' - 'accounting_class') THEN RAISE EXCEPTION 'other deposit fields changed'; END IF;
 IF v_before->1->>'id' IS NOT DISTINCT FROM v_after->1->>'id' THEN RAISE EXCEPTION 'items not replaced'; END IF;
 PERFORM set_config('edit_proof.results',(COALESCE(NULLIF(current_setting('edit_proof.results',true),''),'[]')::jsonb || jsonb_build_array(jsonb_build_object('scenario','explicit_accounting_class_ignored','organization_id',v_invoice.organization_id,'before',v_before,'request',v_request,'after',v_after,'status','BUG_REPRODUCED')) )::text,true);
END $proof$;

RESET ROLE;
SELECT jsonb_build_object('mode','DEMO_BEGIN_ROLLBACK_NO_DDL','results',current_setting('edit_proof.results')::jsonb,'catalog',(SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(p.oid)),'definition',pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='update_invoice_v1'),'accounting_class_default',(SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_items' AND column_name='accounting_class')) AS proof;
ROLLBACK;
