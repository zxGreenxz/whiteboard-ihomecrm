-- npm run test-env:thu-sql -- scripts/tests/test-exit-support-live.sql
-- Chỉ chạy trên ihomecrm-test, công ty DEMO, sau khi đã áp migration 20261124154554_so_ho_tro_sang_nhuong_chuyen_coc.
-- Số tiền khách cũ hỗ trợ khách mới (chuyển cọc giữa hai hợp đồng) qua writer thật: create_contract_v2, thu hoá đơn đầu
-- record_invoice_collection_v5, quyết toán finalize_contract_exit_case_v1, phiếu hoa hồng, đảo số hỗ trợ. Bốn ca: nhờ sale
-- (hoá đơn đầu), tự tìm (đường Cọc: phiếu cọc giữ chỗ có sẵn), vượt trần, đảo. Mọi thứ tạo ra ROLLBACK cùng giao dịch
-- của thu-sql. Số tiền là số thử của công ty DEMO.
SET LOCAL statement_timeout = '180s';

DO $exit_support_test$
DECLARE
  org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  actor uuid;
  building uuid;
  account uuid;
  today date := public.org_today_v1(org);
  boundary constant jsonb := '{"state":"VERIFIED","readings":[]}';
  old_deposit constant numeric := 1000000;
  scenario record;
  room uuid;
  old_customer uuid;
  new_customer uuid;
  old_contract uuid;
  new_contract uuid;
  exit_case uuid;
  exit_version bigint;
  term_version bigint;
  old_updated_at timestamptz;
  response jsonb;
  replay jsonb;
  payload jsonb;
  create_key text;
  deposit_receipt jsonb;
  claims text;
  matches integer;
  amount numeric;
  out_voucher uuid;
  in_voucher uuid;
  invoice uuid;
  invoice_total numeric;
  reservation jsonb;
  reservation_voucher uuid;
  settlement jsonb;
  real_before integer;
  collect_method text;
  collect_account uuid;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = org AND is_demo
  ) THEN
    RAISE EXCEPTION 'Requires the marked TEST database and DEMO organization';
  END IF;
  IF to_regprocedure('public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Migration 20261124154554 chưa áp lên TEST';
  END IF;

  SELECT m.user_id INTO STRICT actor
  FROM public.organization_memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE m.organization_id = org AND m.member_type = 'OWNER' AND m.status = 'ACTIVE'
    AND u.email = 'demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT building FROM public.buildings
  WHERE organization_id = org AND user_id = actor AND deleted_at IS NULL AND NOT coalesce(is_virtual, false) ORDER BY id LIMIT 1;
  SELECT id INTO STRICT account FROM public.accounts
  WHERE organization_id = org AND deleted_at IS NULL AND NOT coalesce(is_virtual, false)
  ORDER BY is_default DESC NULLS LAST, id LIMIT 1;

  claims := jsonb_build_object('sub', actor, 'role', 'authenticated')::text;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', claims, true);
  deposit_receipt := jsonb_build_object('account_id', account, 'received_date', today, 'attachments', '[]'::jsonb);
  -- Sổ nhận tiền khi thu hoá đơn: chuyển khoản của toà, không có thì sổ tiền mặt riêng của người thu.
  SELECT 'TK', (app_private.receiving_cashbook_ids_v1(org, building, 'TK', m.id))[1] INTO collect_method, collect_account
  FROM public.organization_memberships m WHERE m.organization_id = org AND m.user_id = actor AND m.status = 'ACTIVE';
  IF collect_account IS NULL THEN
    SELECT 'TM', (app_private.receiving_cashbook_ids_v1(org, building, 'TM', m.id))[1] INTO collect_method, collect_account
    FROM public.organization_memberships m WHERE m.organization_id = org AND m.user_id = actor AND m.status = 'ACTIVE';
  END IF;
  IF collect_account IS NULL THEN
    -- Toà DEMO chưa cài sổ nhận tiền: trong giao dịch thử (ROLLBACK) đặt sổ chuyển khoản mặc định là một sổ thật chủ đang giữ.
    SELECT 'TK', a.id INTO collect_method, collect_account
    FROM public.accounts a JOIN public.organization_memberships m ON m.organization_id = org AND m.user_id = actor AND m.status = 'ACTIVE'
    WHERE a.organization_id = org AND a.deleted_at IS NULL AND NOT coalesce(a.is_virtual, false)
      AND app_private.ie_has_cashbook_possession_v1(org, a.id, m.id)
    ORDER BY a.is_default DESC NULLS LAST, a.id LIMIT 1;
    IF collect_account IS NULL THEN RAISE EXCEPTION 'Chủ DEMO không giữ sổ thật nào để thu hoá đơn'; END IF;
    UPDATE public.buildings SET default_account_id_tk = collect_account WHERE id = building;
  END IF;

  FOR scenario IN SELECT * FROM (VALUES
    ('sale',    'SALE_ASSISTED'),
    ('self',    'SELF_FOUND'),
    ('cap',     'SALE_ASSISTED'),
    ('reverse', 'SELF_FOUND')
  ) AS cases(label, early_reason)
  LOOP
    room := gen_random_uuid(); old_customer := gen_random_uuid(); new_customer := gen_random_uuid();
    INSERT INTO public.rooms(id, building_id, organization_id, name, rent_price, deposit_amount, status)
    VALUES (room, building, org, 'QA-support-' || scenario.label || '-' || left(room::text, 8), 2000000, old_deposit, 'AVAILABLE');
    INSERT INTO public.customers(id, organization_id, user_id, full_name, phone) VALUES
      (old_customer, org, actor, 'Khách cũ QA', '09' || lpad(floor(random()*100000000)::text, 8, '0')),
      (new_customer, org, actor, 'Khách nhận QA', '08' || lpad(floor(random()*100000000)::text, 8, '0'));

    SET LOCAL ROLE authenticated;
    response := public.create_contract_v2(jsonb_build_object(
      'contract', jsonb_build_object('room_id', room, 'signed_date', today-30, 'start_date', today-30,
        'end_date', today+60, 'rent_price', 2000000, 'total_deposit', old_deposit, 'payment_cycle', 'MONTHLY'),
      'customers', jsonb_build_array(jsonb_build_object('customer_id', old_customer, 'is_representative', true)),
      'services', '[]'::jsonb, 'deposit_receipts', jsonb_build_array(deposit_receipt || jsonb_build_object('amount', old_deposit))
    ), gen_random_uuid()::text);
    old_contract := (response->'contract'->>'id')::uuid;
    SELECT updated_at INTO STRICT old_updated_at FROM public.contracts WHERE id = old_contract;
    response := public.confirm_contract_return_v2(org, old_contract, old_updated_at, gen_random_uuid()::text,
      today, 'EARLY_RETURN', 'DEFERRED', NULL, boundary, 'QA đã bàn giao',
      jsonb_strip_nulls(jsonb_build_object('early_reason', scenario.early_reason,
        'sale_name', CASE WHEN scenario.early_reason = 'SALE_ASSISTED' THEN 'Sale QA' END)));
    exit_case := (response->>'id')::uuid;
    exit_version := (response->>'version')::bigint;
    SELECT count(*) INTO real_before FROM public.income_expenses v JOIN public.accounts a ON a.id = v.account_id
      WHERE v.room_id = room AND NOT a.is_virtual AND v.deleted_at IS NULL;

    IF scenario.label = 'sale' THEN
      -- Nhờ sale, đường tạo thẳng, hoá đơn đầu: cọc mới 1.000.000 = nộp 200.000 + hỗ trợ 300.000 + dòng cọc 500.000.
      amount := 300000;
      create_key := 'qa-support-sale-' || room::text;
      payload := jsonb_build_object(
        'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
          'rent_price', 2100000, 'total_deposit', 1000000, 'payment_cycle', 'MONTHLY', 'deposit_debt_mode', 'FIRST_INVOICE'),
        'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
        'services', '[]'::jsonb, 'deposit_receipts', jsonb_build_array(deposit_receipt || '{"amount":200000}'::jsonb),
        'transfer_support_amount', amount,
        'first_invoice', jsonb_build_object('items', jsonb_build_array(
          jsonb_build_object('type', 'RENT', 'accounting_class', 'REVENUE', 'description', 'Tiền phòng', 'unit_price', 2100000, 'quantity', 1),
          jsonb_build_object('type', 'OTHER', 'accounting_class', 'DEPOSIT', 'description', 'Tiền cọc', 'unit_price', 500000, 'quantity', 1))));
      response := public.create_contract_v2(payload, create_key);
      replay := public.create_contract_v2(payload, create_key);
      IF replay IS DISTINCT FROM response THEN RAISE EXCEPTION 'sale: gọi lặp cùng khoá trả kết quả khác'; END IF;
      new_contract := (response->'contract'->>'id')::uuid;
      invoice := (response->'invoice'->>'id')::uuid;
      invoice_total := (response->'invoice'->>'total_amount')::numeric;
      IF (response->>'deposit_paid')::numeric <> 500000 OR (response->>'deposit_shortfall')::numeric <> 500000 THEN
        RAISE EXCEPTION 'sale: cọc hợp đồng mới sai %', response - 'contract' - 'invoice'; END IF;
    ELSIF scenario.label = 'self' THEN
      -- Tự tìm, đường Cọc: khách nhận cọc giữ chỗ 400.000 (phiếu thu cọc của phòng, giữ chỗ bằng create_room_reservation_v1),
      -- hợp đồng nhận phiếu đó + hỗ trợ 600.000. Phiếu cọc ghi thẳng vì chủ DEMO không có phân công lập phiếu ở toà
      -- (create_income_expense_v1 đọc staff_assignments); giữ chỗ và hợp đồng đi writer thật.
      amount := 600000;
      RESET ROLE;
      INSERT INTO public.income_expenses(user_id, organization_id, type, name, building_id, room_id, account_id, voucher_date,
        total_amount, approval_status, approved_by, approved_at, notes)
      VALUES (actor, org, 'INCOME', 'QA cọc giữ chỗ khách nhận', building, room, account, today, 400000, 'APPROVED', actor, clock_timestamp(),
        'QA đường Cọc') RETURNING id INTO reservation_voucher;
      INSERT INTO public.income_expense_items(income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price,
        amount, start_date, end_date, accounting_class)
      SELECT reservation_voucher, org, t.id, 'Tiền cọc', 1, 400000, 400000, today, today, 'DEPOSIT'
      FROM public.income_expense_types t WHERE t.organization_id = org AND lower(t.type) = 'income' AND t.is_deposit
      ORDER BY CASE WHEN lower(btrim(t.name)) = 'tiền cọc' THEN 0 ELSE 1 END, t.created_at LIMIT 1;
      SET LOCAL ROLE authenticated;
      reservation := public.create_room_reservation_v1(org, 'qa-support-resv-' || room::text, jsonb_build_object(
        'room_id', room, 'customer_id', new_customer, 'hold_until', today+3, 'topup_due_on', today+3, 'deposit_target', 1000000,
        'existing_voucher_ids', jsonb_build_array(reservation_voucher)));
      IF reservation->>'status' IS DISTINCT FROM 'HOLD' OR NOT (reservation->'source_voucher_ids') ? reservation_voucher::text THEN
        RAISE EXCEPTION 'self: giữ chỗ không nhận phiếu cọc %', reservation; END IF;
      response := public.create_contract_v2(jsonb_build_object(
        'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
          'rent_price', 2100000, 'total_deposit', 1000000, 'payment_cycle', 'MONTHLY'),
        'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
        'services', '[]'::jsonb, 'deposit_receipts', '[]'::jsonb,
        'existing_deposit_voucher_ids', jsonb_build_array(reservation_voucher),
        'reservation_id', reservation->>'id', 'reservation_revision', (reservation->>'revision')::bigint,
        'transfer_support_amount', amount), 'qa-support-self-' || room::text);
      new_contract := (response->'contract'->>'id')::uuid;
      IF (response->>'deposit_paid')::numeric <> 1000000 OR (response->>'deposit_shortfall')::numeric <> 0 THEN
        RAISE EXCEPTION 'self: cọc hợp đồng mới sai %', response - 'contract' - 'invoice'; END IF;
    ELSIF scenario.label = 'cap' THEN
      -- Trần: cọc cũ 1.000.000 - phí 500.000 = 500.000; hợp đồng mới cọc 400.000 chưa nộp ⇒ trần 400.000.
      BEGIN
        PERFORM public.create_contract_v2(jsonb_build_object(
          'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
            'rent_price', 2100000, 'total_deposit', 1000000, 'payment_cycle', 'MONTHLY', 'deposit_debt_mode', 'DEBT',
            'deposit_debt_reason', 'QA nộp sau', 'deposit_topup_due_date', today+7),
          'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
          'services', '[]'::jsonb, 'transfer_support_amount', 500001), 'qa-support-cap1-' || room::text);
        RAISE EXCEPTION 'cap: vượt trần cọc cũ không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%vượt cọc cũ đã thu sau khi trừ phí môi giới%' THEN RAISE; END IF;
      END;
      BEGIN
        PERFORM public.create_contract_v2(jsonb_build_object(
          'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
            'rent_price', 2100000, 'total_deposit', 400000, 'payment_cycle', 'MONTHLY'),
          'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
          'services', '[]'::jsonb, 'transfer_support_amount', 500000), 'qa-support-cap2-' || room::text);
        RAISE EXCEPTION 'cap: vượt phần cọc còn thiếu của hợp đồng mới không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%vượt phần cọc còn thiếu của hợp đồng mới%' THEN RAISE; END IF;
      END;
      IF EXISTS (SELECT 1 FROM public.contracts WHERE room_id = room AND id <> old_contract)
        OR EXISTS (SELECT 1 FROM public.income_expenses WHERE room_id = room AND system_source LIKE 'exit.support%') THEN
        RAISE EXCEPTION 'cap: lần bị từ chối vẫn để lại hợp đồng hoặc phiếu'; END IF;
      amount := 400000;
      response := public.create_contract_v2(jsonb_build_object(
        'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
          'rent_price', 2100000, 'total_deposit', 400000, 'payment_cycle', 'MONTHLY'),
        'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
        'services', '[]'::jsonb, 'transfer_support_amount', amount), 'qa-support-cap3-' || room::text);
      new_contract := (response->'contract'->>'id')::uuid;
    ELSE
      amount := 250000;
      response := public.create_contract_v2(jsonb_build_object(
        'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
          'rent_price', 2100000, 'total_deposit', 1000000, 'payment_cycle', 'MONTHLY', 'deposit_debt_mode', 'DEBT',
          'deposit_debt_reason', 'QA nộp sau', 'deposit_topup_due_date', today+7),
        'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
        'services', '[]'::jsonb, 'deposit_receipts', jsonb_build_array(deposit_receipt || '{"amount":300000}'::jsonb),
        'transfer_support_amount', amount), 'qa-support-reverse-' || room::text);
      new_contract := (response->'contract'->>'id')::uuid;
    END IF;

    -- Hai bên khớp: cặp phiếu đã duyệt cùng số trên sổ nội bộ, dòng cọc, không vào KQKD, không sinh bút toán sổ thật.
    RESET ROLE;
    SELECT id INTO STRICT out_voucher FROM public.income_expenses
      WHERE contract_id = old_contract AND system_source = 'exit.support_out' AND deleted_at IS NULL;
    SELECT id INTO STRICT in_voucher FROM public.income_expenses
      WHERE contract_id = new_contract AND system_source = 'exit.support_in' AND deleted_at IS NULL;
    SELECT count(*) INTO matches FROM public.income_expenses v JOIN public.accounts a ON a.id = v.account_id
      WHERE v.id IN (out_voucher, in_voucher) AND a.is_virtual AND v.approval_status = 'APPROVED' AND v.total_amount = amount
        AND v.voucher_date = today AND coalesce(v.business_result_accounting, false) = false
        AND coalesce(v.posting_status, 'NOT_APPLICABLE') = 'NOT_APPLICABLE'
        AND (SELECT string_agg(i.accounting_class, ',') FROM public.income_expense_items i WHERE i.income_expense_id = v.id) = 'DEPOSIT';
    IF matches <> 2 OR (SELECT account_id FROM public.income_expenses WHERE id = out_voucher)
        IS DISTINCT FROM (SELECT account_id FROM public.income_expenses WHERE id = in_voucher) THEN
      RAISE EXCEPTION '%: cặp phiếu chuyển cọc sai (sổ, trạng thái, số, lớp hoặc KQKD)', scenario.label; END IF;
    IF (SELECT sum(CASE WHEN type = 'INCOME' THEN total_amount ELSE -total_amount END) FROM public.income_expenses
        WHERE id IN (out_voucher, in_voucher)) <> 0 THEN
      RAISE EXCEPTION '%: tổng hai phiếu trên sổ nội bộ khác 0', scenario.label; END IF;
    IF (SELECT deposit_paid FROM public.contracts WHERE id = old_contract) <> old_deposit - amount
      OR (SELECT deposit_paid FROM public.contracts WHERE id = old_contract) <> public.contract_deposit_paid_derived(old_contract)
      OR (SELECT deposit_paid FROM public.contracts WHERE id = new_contract) <> public.contract_deposit_paid_derived(new_contract) THEN
      RAISE EXCEPTION '%: cọc đã thu hai bên lệch', scenario.label; END IF;
    -- Quỹ thật: chỉ có phiếu nộp cọc của khách (nếu có), không thêm dòng nào cho số hỗ trợ.
    SELECT count(*) INTO matches FROM public.income_expenses v JOIN public.accounts a ON a.id = v.account_id
      WHERE v.room_id = room AND NOT a.is_virtual AND v.deleted_at IS NULL;
    IF matches - real_before <> (CASE WHEN scenario.label = 'cap' THEN 0 ELSE 1 END) THEN
      RAISE EXCEPTION '%: sổ thật có % phiếu mới, ngoài phiếu nộp cọc', scenario.label, matches - real_before; END IF;
    -- Không huỷ, không sửa được phiếu chuyển cọc, không xoá được hợp đồng khách nhận.
    BEGIN
      UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = in_voucher;
      RAISE EXCEPTION '%: huỷ được phiếu chuyển cọc', scenario.label USING ERRCODE = 'P0001';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      IF SQLERRM NOT LIKE '%đảo số hỗ trợ ở hồ sơ trả phòng%' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE public.contracts SET deleted_at = now() WHERE id = new_contract;
      RAISE EXCEPTION '%: xoá được hợp đồng khách nhận đang có số hỗ trợ', scenario.label USING ERRCODE = 'P0001';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      IF SQLERRM NOT LIKE '%đảo số hỗ trợ%' THEN RAISE; END IF;
    END;

    SET LOCAL ROLE authenticated;
    response := public.read_contract_exit_early_terms_v1(org, new_contract)->0;
    term_version := (response->>'version')::bigint;
    IF (response->>'support_amount')::numeric <> amount OR response->>'support_out_code' IS NULL OR response->>'support_in_code' IS NULL
      OR (response->>'old_contract_deposit_paid')::numeric <> old_deposit - amount THEN
      RAISE EXCEPTION '%: hồ sơ trả phòng không hiện số hỗ trợ %', scenario.label, response; END IF;
    BEGIN
      PERFORM public.set_contract_exit_early_terms_v1(org, exit_case, term_version, gen_random_uuid(), 'LANDLORD_AGREEMENT', NULL, 'Thử đổi');
      RAISE EXCEPTION '%: đổi trường hợp khi có số hỗ trợ không bị chặn', scenario.label USING ERRCODE = 'P0001';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      IF SQLERRM NOT LIKE '%tiền hỗ trợ%' THEN RAISE; END IF;
    END;

    IF scenario.label = 'sale' THEN
      -- Thu nốt hoá đơn đầu (phần còn lại của cọc + tiền phòng) bằng writer thu hoá đơn: không bị rào semantic chặn.
      PERFORM public.record_invoice_collection_v5(invoice, today,
        jsonb_build_array(jsonb_build_object('payment_method', collect_method, 'gross_amount', invoice_total, 'account_id', collect_account)),
        'REJECT', false, 'QA thu hoá đơn đầu sau khi cấn cọc', NULL, 0, 'qa-support-collect-' || room::text);
      IF (SELECT deposit_paid FROM public.contracts WHERE id = new_contract) <> 1000000 THEN
        RAISE EXCEPTION 'sale: thu hoá đơn đầu xong mà cọc mới chưa đủ'; END IF;
      settlement := jsonb_build_object('deposit_refund', old_deposit - amount, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0,
        'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb, 'extra_charges', jsonb_build_array(jsonb_build_object(
          'kind', 'BROKER_FEE', 'description', 'Phí môi giới (50% cọc cũ)', 'amount', old_deposit / 2)));
    ELSIF scenario.label = 'reverse' THEN
      -- Đảo: cần lý do; cặp phiếu bị huỷ, cọc hai bên về như trước; gọi lặp trả cùng kết quả; rồi mới đổi trường hợp được.
      BEGIN
        PERFORM public.reverse_contract_exit_support_v1(org, exit_case, term_version, gen_random_uuid(), ' ');
        RAISE EXCEPTION 'reverse: đảo không lý do không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN NULL;
      END;
      response := public.reverse_contract_exit_support_v1(org, exit_case, term_version, md5('qa-reverse' || room::text)::uuid, 'Khách nhận huỷ');
      replay := public.reverse_contract_exit_support_v1(org, exit_case, term_version, md5('qa-reverse' || room::text)::uuid, 'Khách nhận huỷ');
      IF replay IS DISTINCT FROM response OR (response->>'support_amount')::numeric <> 0 OR response->>'support_in_voucher_id' IS NOT NULL THEN
        RAISE EXCEPTION 'reverse: kết quả đảo sai %', response; END IF;
      RESET ROLE;
      IF (SELECT count(*) FROM public.income_expenses WHERE id IN (out_voucher, in_voucher) AND approval_status = 'CANCELLED') <> 2
        OR (SELECT deposit_paid FROM public.contracts WHERE id = old_contract) <> old_deposit
        OR (SELECT deposit_paid FROM public.contracts WHERE id = new_contract) <> 300000 THEN
        RAISE EXCEPTION 'reverse: phiếu hoặc cọc sau khi đảo sai'; END IF;
      SET LOCAL ROLE authenticated;
      response := public.set_contract_exit_early_terms_v1(org, exit_case, (response->>'version')::bigint, gen_random_uuid(),
        'LANDLORD_AGREEMENT', NULL, 'Khách nhận huỷ, chủ nhà đồng ý thanh lý sớm');
      IF response->>'early_reason' IS DISTINCT FROM 'LANDLORD_AGREEMENT' OR response->>'new_contract_id' IS NOT NULL THEN
        RAISE EXCEPTION 'reverse: đổi trường hợp sau khi đảo sai %', response; END IF;
      amount := 0;
      settlement := jsonb_build_object('deposit_refund', old_deposit, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0,
        'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb);
    ELSIF scenario.label = 'cap' THEN
      settlement := jsonb_build_object('deposit_refund', old_deposit - amount, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0,
        'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb, 'extra_charges', jsonb_build_array(jsonb_build_object(
          'kind', 'BROKER_FEE', 'description', 'Phí môi giới (50% cọc cũ)', 'amount', old_deposit / 2)));
    ELSE
      settlement := jsonb_build_object('deposit_refund', old_deposit - amount, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0,
        'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb);
    END IF;

    -- Quyết toán khách cũ: hàm quyết toán không đổi, cọc đem ra là cọc còn lại sau khi cấn; trả khách = còn lại - phí.
    response := public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-support-settle-' || exit_case::text,
      'EARLY_RETURN', NULL, settlement);
    IF response->>'state' IS DISTINCT FROM 'FINALIZED' THEN RAISE EXCEPTION '%: quyết toán không chốt', scenario.label; END IF;
    RESET ROLE;
    IF (SELECT count(*) FROM public.contract_terminations WHERE contract_id = old_contract AND status = 'COMPLETED'
        AND total_deposit = old_deposit - amount
        AND refund_amount = old_deposit - amount - (CASE WHEN scenario.early_reason = 'SALE_ASSISTED' THEN old_deposit / 2 ELSE 0 END)) <> 1 THEN
      RAISE EXCEPTION '%: số trả khách cũ sai', scenario.label;
    END IF;
    IF scenario.label <> 'reverse' THEN
      -- Sau quyết toán vẫn không đảo được số hỗ trợ.
      SET LOCAL ROLE authenticated;
      BEGIN
        PERFORM public.reverse_contract_exit_support_v1(org, exit_case,
          (public.read_contract_exit_early_terms_v1(org, NULL, exit_case)->0->>'version')::bigint, gen_random_uuid(), 'Muộn');
        RAISE EXCEPTION '%: đảo được sau quyết toán', scenario.label USING ERRCODE = 'P0001';
      EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM NOT LIKE '%đã quyết toán%' THEN RAISE; END IF;
      END;
      RESET ROLE;
    END IF;
    IF scenario.label = 'sale' THEN
      -- Phiếu hoa hồng môi giới (khách mới đã nộp đủ cọc, tính cả số hỗ trợ) bằng đúng phí.
      SET LOCAL ROLE authenticated;
      response := public.create_contract_exit_commission_v1(org, exit_case,
        (public.read_contract_exit_early_terms_v1(org, NULL, exit_case)->0->>'version')::bigint, gen_random_uuid(), account);
      RESET ROLE;
      IF NOT EXISTS (SELECT 1 FROM public.income_expenses WHERE id = (response->>'commission_voucher_id')::uuid
          AND contract_id = new_contract AND commission_kind = 'broker' AND total_amount = old_deposit / 2) THEN
        RAISE EXCEPTION 'sale: phiếu hoa hồng sai'; END IF;
    END IF;
    RAISE NOTICE 'PASS %: trường hợp %, số hỗ trợ %, hai bên khớp, quyết toán đúng', scenario.label, scenario.early_reason, amount;
  END LOOP;
END
$exit_support_test$;
