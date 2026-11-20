-- npm run test-env:thu-sql -- scripts/tests/test-contract-transfer-signing-live.sql
-- Only on ihomecrm-test. All fixtures and voucher postings must be rolled back.
-- The signing proof uses registered test document metadata, without uploading a file.
SET LOCAL statement_timeout = '90s';

DO $transfer_test$
DECLARE
  org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  actor uuid;
  building uuid;
  account uuid;
  today date := public.org_today_v1(org);
  boundary constant jsonb := '{"state":"VERIFIED","readings":[]}';
  scenario record;
  room uuid;
  old_customer uuid;
  new_customer uuid;
  new_phone text;
  old_contract uuid;
  new_contract uuid;
  draft uuid;
  document uuid;
  exit_case uuid;
  link uuid;
  old_updated_at timestamptz;
  signing_request uuid;
  commission_request uuid;
  commission_voucher uuid;
  settlement_key text;
  deposit_receipt jsonb;
  old_deposit_receipts jsonb;
  parties jsonb;
  terms jsonb;
  settlement jsonb;
  signing_options jsonb;
  response jsonb;
  version_before_commission bigint;
  matches integer;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = org AND is_demo
  ) THEN
    RAISE EXCEPTION 'Requires the marked TEST database and DEMO organization';
  END IF;

  SELECT m.user_id INTO STRICT actor
  FROM public.organization_memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE m.organization_id = org AND m.member_type = 'OWNER' AND m.status = 'ACTIVE'
    AND u.email = 'demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT building FROM public.buildings
  WHERE organization_id = org AND user_id = actor AND deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO STRICT account FROM public.accounts
  WHERE organization_id = org AND deleted_at IS NULL AND NOT coalesce(is_virtual, false)
  ORDER BY is_default DESC NULLS LAST, id LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  FOR scenario IN SELECT * FROM (VALUES
    ('broker',       'BROKER',     'NEW_PAYMENT',        'KEEP_OLD_END_DATE', 1000000, true),
    ('broker_debt',  'BROKER',     'NEW_PAYMENT',        'KEEP_OLD_END_DATE', 1000000, false),
    ('offset',       'SELF_FOUND', 'OLD_DEPOSIT_OFFSET', 'KEEP_OLD_END_DATE', 1000000, true),
    ('self_found',   'SELF_FOUND', 'NEW_PAYMENT',        'NEW_TERM',          1000000, true),
    ('zero_fee',     'BROKER',     'NEW_PAYMENT',        'KEEP_OLD_END_DATE',       0, true)
  ) AS cases(label, mode, deposit_mode, term_mode, old_deposit, paid)
  LOOP
    room := gen_random_uuid(); old_customer := gen_random_uuid(); new_customer := gen_random_uuid();
    draft := gen_random_uuid(); document := gen_random_uuid(); signing_request := gen_random_uuid();
    settlement_key := gen_random_uuid()::text; commission_request := gen_random_uuid();
    new_phone := '08' || lpad(floor(random()*100000000)::text, 8, '0');

    INSERT INTO public.rooms(id, building_id, organization_id, name, rent_price, deposit_amount, status)
    VALUES (room, building, org, 'QA-transfer-' || room::text, 2000000, scenario.old_deposit, 'AVAILABLE');
    INSERT INTO public.customers(id, organization_id, user_id, full_name, phone) VALUES
      (old_customer, org, actor, 'Khách cũ QA', '09' || lpad(floor(random()*100000000)::text, 8, '0')),
      (new_customer, org, actor, 'Khách nhận QA', new_phone);

    SET LOCAL ROLE authenticated;
    deposit_receipt := jsonb_build_object('account_id', account, 'received_date', today, 'attachments', '[]'::jsonb);
    old_deposit_receipts := CASE WHEN scenario.old_deposit > 0
      THEN jsonb_build_array(deposit_receipt || jsonb_build_object('amount', scenario.old_deposit))
      ELSE '[]'::jsonb END;
    response := public.create_contract_v2(jsonb_build_object(
      'contract', jsonb_build_object('room_id', room, 'signed_date', today-2, 'start_date', today-2,
        'end_date', today+60, 'rent_price', 2000000, 'total_deposit', scenario.old_deposit, 'payment_cycle', 'MONTHLY'),
      'customers', jsonb_build_array(jsonb_build_object('customer_id', old_customer, 'is_representative', true)),
      'services', '[]'::jsonb, 'deposit_receipts', old_deposit_receipts
    ), gen_random_uuid()::text);
    old_contract := (response->'contract'->>'id')::uuid;
    SELECT updated_at INTO STRICT old_updated_at FROM public.contracts WHERE id = old_contract;
    response := public.confirm_contract_return_v1(org, old_contract, old_updated_at, gen_random_uuid()::text,
      today, 'EARLY_RETURN', 'DEFERRED', NULL, boundary, 'QA đã bàn giao');
    exit_case := (response->>'id')::uuid;

    terms := jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today,
      'end_date', today + CASE WHEN scenario.term_mode = 'NEW_TERM' THEN 120 ELSE 60 END,
      'rent_price', 2100000, 'total_deposit', 600000, 'payment_cycle', 'MONTHLY',
      'start_billing_date', today, 'end_billing_date', today+5, 'notes', '', 'discount_months', 0, 'discount_amount_per_month', 0);
    parties := jsonb_build_array(jsonb_build_object('id', new_customer, 'full_name', 'Khách nhận QA',
      'phone', new_phone, 'id_number', NULL, 'is_representative', true, 'notes', NULL));
    PERFORM public.save_contract_draft(org, building, room, jsonb_build_object('form', terms,
      'customers', parties, 'services', '[]'::jsonb, 'use_custom_services', false), NULL, draft, NULL, gen_random_uuid());

    RESET ROLE;
    INSERT INTO public.contract_draft_documents(id, draft_id, revision, organization_id, building_id,
      document_path, template_path, document_sha256, template_sha256, template_snapshot, document_data, created_by)
    VALUES (document, draft, 1, org, building, 'QA-transfer/' || document, 'QA-transfer/template/' || document,
      repeat('a',64), repeat('b',64), '{}', '{}', actor);
    SET LOCAL ROLE authenticated;

    response := public.create_contract_transfer_link_v1(org, exit_case, draft, 1, 1,
      scenario.mode, scenario.deposit_mode, scenario.term_mode,
      CASE WHEN scenario.mode = 'BROKER' THEN 'Môi giới QA' END, 'QA nhượng', gen_random_uuid());
    link := (response->>'id')::uuid;
    signing_options := CASE WHEN scenario.paid
      THEN jsonb_build_object('deposit_receipts', jsonb_build_array(deposit_receipt || '{"amount":600000}'::jsonb))
      ELSE jsonb_build_object('deposit_debt_mode', 'DEBT', 'deposit_debt_reason', 'QA', 'deposit_topup_due_date', today+7)
    END;

    IF scenario.label IN ('broker_debt', 'offset') THEN
      BEGIN
        PERFORM public.sign_and_checkin_contract_draft_v1(org, draft, 1, document, repeat('a',64),
          signing_request, today, true, true, boundary, signing_options);
        RAISE EXCEPTION 'Unexpected successful signing for %', scenario.label;
      EXCEPTION WHEN SQLSTATE '55000' THEN
        IF (scenario.label = 'broker_debt' AND SQLERRM NOT LIKE '%nộp đủ cọc%') OR
           (scenario.label = 'offset' AND SQLERRM NOT LIKE '%chuyển cọc%') THEN RAISE; END IF;
      END;
      RESET ROLE;
      IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE id=room AND status='AVAILABLE')
        OR NOT EXISTS (SELECT 1 FROM public.contract_drafts WHERE id=draft AND status='EDITABLE')
        OR EXISTS (SELECT 1 FROM public.contracts WHERE room_id=room AND id<>old_contract)
        OR EXISTS (SELECT 1 FROM public.contract_draft_signings WHERE draft_id=draft) THEN
        RAISE EXCEPTION 'Partial signing survived a rejected %', scenario.label;
      END IF;
      RAISE NOTICE 'PASS %: refused signing, no new contract or occupancy', scenario.label;
      CONTINUE;
    END IF;

    settlement := jsonb_build_object('deposit_refund', scenario.old_deposit, 'penalty_fee', 0,
      'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb,
      'extra_charges', CASE WHEN scenario.mode = 'BROKER' THEN jsonb_build_array(jsonb_build_object(
        'kind', 'CUSTOM', 'description', 'TRANSFER_BROKER_FEE:' || link, 'amount', scenario.old_deposit / 2))
        ELSE '[]'::jsonb END);
    PERFORM public.finalize_contract_transfer_exit_v1(org, exit_case, 1, settlement_key, 'EARLY_RETURN', NULL, settlement, link, 1);
    PERFORM public.finalize_contract_transfer_exit_v1(org, exit_case, 1, settlement_key, 'EARLY_RETURN', NULL, settlement, link, 1);
    response := public.sign_and_checkin_contract_draft_v1(org, draft, 1, document, repeat('a',64),
      signing_request, today, true, true, boundary, signing_options);
    new_contract := (response->>'contract_id')::uuid;
    response := public.sign_and_checkin_contract_draft_v1(org, draft, 1, document, repeat('a',64),
      signing_request, today, true, true, boundary, signing_options);
    IF (response->>'contract_id')::uuid IS DISTINCT FROM new_contract THEN RAISE EXCEPTION 'Signing replay mismatch'; END IF;
    response := public.read_contract_transfer_links_v1(org, new_contract, NULL, NULL);
    IF jsonb_array_length(response) <> 1 OR (response->0->>'id')::uuid IS DISTINCT FROM link THEN
      RAISE EXCEPTION '%: signed contract cannot find its transfer', scenario.label;
    END IF;
    version_before_commission := (response->0->>'version')::bigint;
    SELECT count(*) INTO matches FROM public.real_estate_renewals_transfers_v1(org, ARRAY[building], today, today)
    WHERE kind='TRANSFER' AND contract_id=new_contract;
    IF matches <> 1 THEN RAISE EXCEPTION '%: expected one completed transfer in report, got %', scenario.label, matches; END IF;

    IF scenario.mode = 'BROKER' THEN
      response := public.create_contract_transfer_commission_v1(org, link, version_before_commission, commission_request, account);
      commission_voucher := (response->>'commission_voucher_id')::uuid;
      IF scenario.old_deposit = 0 THEN
        IF commission_voucher IS NOT NULL OR response->>'money_state' IS DISTINCT FROM 'COMMISSION_PENDING'
          OR response->'no_commission_due' IS DISTINCT FROM 'true'::jsonb THEN
          RAISE EXCEPTION 'Zero fee produced a payable commission';
        END IF;
      ELSE
        response := public.create_contract_transfer_commission_v1(org, link, version_before_commission, commission_request, account);
        IF commission_voucher IS NULL OR commission_voucher IS DISTINCT FROM (response->>'commission_voucher_id')::uuid THEN
          RAISE EXCEPTION 'Duplicate or missing commission after retry';
        END IF;
      END IF;
    END IF;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE id=old_contract AND status='TERMINATED')
      OR NOT EXISTS (SELECT 1 FROM public.contracts WHERE id=new_contract AND status='ACTIVE' AND deposit_paid=600000)
      OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id=room AND status='OCCUPIED')
      OR NOT EXISTS (SELECT 1 FROM public.contract_customers WHERE contract_id=new_contract AND customer_id=new_customer AND is_representative)
      OR NOT EXISTS (SELECT 1 FROM public.contract_customers WHERE contract_id=old_contract AND customer_id=old_customer AND is_representative)
      OR (SELECT count(*) FROM app_private.contract_transfer_events WHERE link_id=link AND event='NEW_SIGNED') <> 1
    THEN RAISE EXCEPTION '%: wrong occupancy, parties, deposit or signing history', scenario.label; END IF;
    IF scenario.mode = 'BROKER' AND (
      (SELECT count(*) FROM public.contract_terminations WHERE contract_id=old_contract AND status='COMPLETED'
        AND refund_amount=scenario.old_deposit / 2) <> 1
      OR (SELECT count(*) FROM public.income_expenses WHERE contract_id=new_contract AND commission_kind='broker'
        AND deleted_at IS NULL) <> CASE WHEN scenario.old_deposit > 0 THEN 1 ELSE 0 END
      OR (scenario.old_deposit > 0 AND NOT EXISTS (SELECT 1 FROM public.income_expenses WHERE id=commission_voucher
        AND total_amount=scenario.old_deposit / 2 AND type='EXPENSE'))
    ) THEN RAISE EXCEPTION '%: wrong refund or commission', scenario.label; END IF;
    RAISE NOTICE 'PASS %: signed once, linked, reported once; settlement and commission reconciled', scenario.label;
  END LOOP;
END
$transfer_test$;
