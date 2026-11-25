-- npm run test-env:thu-sql -- scripts/tests/test-deposit-retained-live.sql
-- Chỉ chạy trên ihomecrm-test, công ty DEMO, sau khi đã áp migration 20261124201133_coc_giu_lai_theo_thoa_thuan.
-- Cọc giữ lại theo thoả thuận qua writer thật (create_contract_v2, confirm_contract_return_v2, finalize_contract_exit_case_v1):
-- chủ nhà hỗ trợ hoàn một phần (bị chặn khi thiếu dòng giữ lại; đúng khi có), hoàn đủ, hết hạn, bỏ cọc, sổ cọc ghi dôi,
-- tự tìm khách có số hỗ trợ. Mọi thứ tạo ra ROLLBACK cùng giao dịch của thu-sql. Số tiền là số thử của công ty DEMO.
SET LOCAL statement_timeout = '180s';

DO $deposit_retained_test$
DECLARE
  org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  label constant text := 'Cọc giữ lại theo thoả thuận';
  dep constant numeric := 4500000;
  boundary constant jsonb := '{"state":"VERIFIED","readings":[]}';
  actor uuid; building uuid; account uuid; today date := public.org_today_v1(org);
  scenario record; room uuid; customer uuid; new_customer uuid; contract uuid; new_contract uuid;
  exit_case uuid; exit_version bigint; updated timestamptz; response jsonb; refund_voucher uuid;
  revenue_items text; settle_lines text; paid numeric;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = org AND is_demo) THEN
    RAISE EXCEPTION 'Requires the marked TEST database and DEMO organization';
  END IF;
  IF strpos(pg_get_functiondef('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'::regprocedure),
      'v_deposit_floor := LEAST(') = 0 THEN
    RAISE EXCEPTION 'Migration 20261124201133 chưa áp lên TEST';
  END IF;
  SELECT m.user_id INTO STRICT actor FROM public.organization_memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE m.organization_id = org AND m.member_type = 'OWNER' AND m.status = 'ACTIVE' AND u.email = 'demo.chunha@username.ihomecrm.local';
  SELECT id INTO STRICT building FROM public.buildings
  WHERE organization_id = org AND user_id = actor AND deleted_at IS NULL AND NOT coalesce(is_virtual, false) ORDER BY id LIMIT 1;
  SELECT id INTO STRICT account FROM public.accounts
  WHERE organization_id = org AND deleted_at IS NULL AND NOT coalesce(is_virtual, false) ORDER BY is_default DESC NULLS LAST, id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);

  FOR scenario IN SELECT * FROM (VALUES ('landlord_partial'), ('landlord_full'), ('natural_expiry'), ('forfeit'), ('over_ledger'), ('self_found'))
    AS cases(name) LOOP
    room := gen_random_uuid(); customer := gen_random_uuid(); new_customer := gen_random_uuid();
    INSERT INTO public.rooms(id, building_id, organization_id, name, rent_price, deposit_amount, status)
    VALUES (room, building, org, 'QA-retain-' || scenario.name || '-' || left(room::text, 8), 3000000, dep, 'AVAILABLE');
    INSERT INTO public.customers(id, organization_id, user_id, full_name, phone) VALUES
      (customer, org, actor, 'Khách cũ QA', '09' || lpad(floor(random()*100000000)::text, 8, '0')),
      (new_customer, org, actor, 'Khách nhận QA', '08' || lpad(floor(random()*100000000)::text, 8, '0'));
    SET LOCAL ROLE authenticated;
    response := public.create_contract_v2(jsonb_build_object(
      'contract', jsonb_build_object('room_id', room, 'signed_date', today-40, 'start_date', today-40, 'end_date', today+60,
        'rent_price', 3000000, 'total_deposit', dep, 'payment_cycle', 'MONTHLY'),
      'customers', jsonb_build_array(jsonb_build_object('customer_id', customer, 'is_representative', true)), 'services', '[]'::jsonb,
      'deposit_receipts', jsonb_build_array(jsonb_build_object('account_id', account, 'received_date', today-40, 'amount', dep,
        'attachments', '[]'::jsonb))), gen_random_uuid()::text);
    contract := (response->'contract'->>'id')::uuid;
    RESET ROLE;
    IF scenario.name = 'over_ledger' THEN
      -- Sổ cọc ghi dôi: cọc theo hợp đồng 4.000.000, đã thu 4.500.000 (trong giao dịch thử).
      UPDATE public.contracts SET total_deposit = 4000000 WHERE id = contract;
    END IF;
    SELECT c.updated_at INTO STRICT updated FROM public.contracts c WHERE c.id = contract;
    SET LOCAL ROLE authenticated;

    IF scenario.name IN ('landlord_partial', 'landlord_full', 'over_ledger') THEN
      IF scenario.name IN ('landlord_partial', 'over_ledger') THEN
        BEGIN
          PERFORM public.confirm_contract_return_v2(org, contract, updated, 'qa-retain-low-' || contract::text, today, 'EARLY_RETURN', 'IMMEDIATE',
            jsonb_build_object('deposit_refund', CASE WHEN scenario.name = 'over_ledger' THEN 3500000 ELSE 2500000 END, 'penalty_fee', 0,
              'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb,
              'extra_charges', '[{"kind":"CLEANING","description":"Vệ sinh","amount":200000}]'::jsonb),
            boundary, 'QA trả phòng', '{"early_reason":"LANDLORD_AGREEMENT"}'::jsonb);
          RAISE EXCEPTION '%: hoàn thấp hơn sàn không có dòng giữ lại mà không bị chặn', scenario.name USING ERRCODE = 'P0001';
        EXCEPTION WHEN invalid_parameter_value THEN
          IF SQLERRM NOT LIKE '%thấp hơn cọc phải xử lý%' THEN RAISE; END IF;
        END;
      END IF;
      response := public.confirm_contract_return_v2(org, contract, updated, 'qa-retain-ok-' || contract::text, today, 'EARLY_RETURN', 'IMMEDIATE',
        jsonb_build_object('deposit_refund', CASE scenario.name WHEN 'over_ledger' THEN 4000000 ELSE dep END, 'penalty_fee', 0, 'excess_rent', 0,
          'outstanding_debt', 0, 'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb,
          'extra_charges', CASE scenario.name
            WHEN 'landlord_partial' THEN jsonb_build_array(jsonb_build_object('kind', 'DEPOSIT_RETAINED', 'description', label, 'amount', 2000000),
              '{"kind":"CLEANING","description":"Vệ sinh","amount":200000}'::jsonb)
            WHEN 'over_ledger' THEN jsonb_build_array(jsonb_build_object('kind', 'DEPOSIT_RETAINED', 'description', label, 'amount', 500000))
            ELSE '[{"kind":"CLEANING","description":"Vệ sinh","amount":200000}]'::jsonb END),
        boundary, 'QA trả phòng', '{"early_reason":"LANDLORD_AGREEMENT"}'::jsonb);
      IF response->>'state' IS DISTINCT FROM 'FINALIZED' THEN RAISE EXCEPTION '%: quyết toán không chốt %', scenario.name, response; END IF;
    ELSIF scenario.name = 'natural_expiry' THEN
      response := public.confirm_contract_return_v2(org, contract, updated, 'qa-retain-ne-' || contract::text, today, 'NATURAL_EXPIRY', 'DEFERRED',
        NULL, boundary, 'QA hết hạn', NULL);
      exit_case := (response->>'id')::uuid; exit_version := (response->>'version')::bigint;
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-retain-ne-low-' || exit_case::text, 'NATURAL_EXPIRY', NULL,
          jsonb_build_object('deposit_refund', 4000000, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID',
            'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb));
        RAISE EXCEPTION 'natural_expiry: hoàn thấp hơn cọc không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%thấp hơn cọc phải xử lý%' THEN RAISE; END IF;
      END;
      response := public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-retain-ne-ok-' || exit_case::text, 'NATURAL_EXPIRY', NULL,
        jsonb_build_object('deposit_refund', dep, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID',
          'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb));
    ELSIF scenario.name = 'forfeit' THEN
      BEGIN
        PERFORM public.confirm_contract_return_v2(org, contract, updated, 'qa-retain-ff-bad-' || contract::text, today, 'FORFEIT', 'IMMEDIATE',
          jsonb_build_object('extra_charges', jsonb_build_array(jsonb_build_object('kind', 'DEPOSIT_RETAINED', 'description', label, 'amount', 1000000))),
          boundary, 'QA bỏ cọc', NULL);
        RAISE EXCEPTION 'forfeit: bỏ cọc kèm dòng giữ lại không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%Bỏ cọc đã giữ toàn bộ cọc%' THEN RAISE; END IF;
      END;
      response := public.confirm_contract_return_v2(org, contract, updated, 'qa-retain-ff-ok-' || contract::text, today, 'FORFEIT', 'IMMEDIATE',
        '{"extra_charges":[]}'::jsonb, boundary, 'QA bỏ cọc', NULL);
    ELSE
      -- Tự tìm khách, hợp đồng khách nhận có số hỗ trợ 500.000 ⇒ cọc đã thu của hợp đồng cũ còn 4.000.000 (sàn).
      response := public.confirm_contract_return_v2(org, contract, updated, 'qa-retain-self-' || contract::text, today, 'EARLY_RETURN', 'DEFERRED',
        NULL, boundary, 'QA bàn giao', '{"early_reason":"SELF_FOUND"}'::jsonb);
      exit_case := (response->>'id')::uuid; exit_version := (response->>'version')::bigint;
      response := public.create_contract_v2(jsonb_build_object(
        'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today, 'end_date', today+90,
          'rent_price', 3000000, 'total_deposit', dep, 'payment_cycle', 'MONTHLY', 'deposit_debt_mode', 'DEBT',
          'deposit_debt_reason', 'QA nộp sau', 'deposit_topup_due_date', today+7),
        'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
        'services', '[]'::jsonb, 'transfer_support_amount', 500000), 'qa-retain-new-' || room::text);
      new_contract := (response->'contract'->>'id')::uuid;
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-retain-self-low-' || exit_case::text, 'EARLY_RETURN', NULL,
          jsonb_build_object('deposit_refund', 3900000, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID',
            'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb));
        RAISE EXCEPTION 'self_found: hoàn thấp hơn cọc còn lại không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%thấp hơn cọc phải xử lý (4000000 đ)%' THEN RAISE; END IF;
      END;
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-retain-self-ret-' || exit_case::text, 'EARLY_RETURN', NULL,
          jsonb_build_object('deposit_refund', 4000000, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID',
            'refund_items', '[]'::jsonb, 'extra_charges', jsonb_build_array(jsonb_build_object('kind', 'DEPOSIT_RETAINED', 'description', label,
              'amount', 300000))));
        RAISE EXCEPTION 'self_found: dòng giữ lại ở ca sang nhượng không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%Hồ sơ sang nhượng phòng hoàn đủ cọc%' THEN RAISE; END IF;
      END;
      response := public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-retain-self-ok-' || exit_case::text, 'EARLY_RETURN', NULL,
        jsonb_build_object('deposit_refund', 4000000, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0, 'shortfall_mode', 'PAID',
          'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb));
    END IF;
    RESET ROLE;

    -- Đối chiếu sổ sách của hợp đồng cũ.
    SELECT string_agg(ii.description || '=' || ii.amount::bigint, ', ' ORDER BY ii.sort_order) INTO settle_lines
      FROM public.invoice_items ii JOIN public.invoices iv ON iv.id = ii.invoice_id
     WHERE iv.contract_id = contract AND iv.kind = 'SETTLEMENT' AND iv.deleted_at IS NULL;
    SELECT string_agg(t.name || '/' || coalesce(i.accounting_class, '?') || '=' || i.amount::bigint, ', ' ORDER BY t.name) INTO revenue_items
      FROM public.income_expense_items i JOIN public.income_expenses v ON v.id = i.income_expense_id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE v.contract_id = contract AND v.system_source = 'termination.revenue' AND v.deleted_at IS NULL;
    SELECT id INTO refund_voucher FROM public.income_expenses
     WHERE contract_id = contract AND system_source = 'termination.refund' AND deleted_at IS NULL;
    paid := (SELECT deposit_paid FROM public.contracts WHERE id = contract);
    IF paid IS DISTINCT FROM public.contract_deposit_paid_derived(contract) THEN RAISE EXCEPTION '%: cột cọc đã thu lệch phiếu', scenario.name; END IF;

    IF scenario.name = 'landlord_partial' THEN
      IF settle_lines IS DISTINCT FROM label || '=2000000, Vệ sinh=200000'
        OR revenue_items IS DISTINCT FROM label || '/PNL=2000000, Doanh thu thanh lý/PNL=200000'
        OR (SELECT total_amount FROM public.income_expenses WHERE id = refund_voucher) <> 2300000
        OR (SELECT count(*) FROM public.contract_terminations WHERE contract_id = contract AND total_deposit = dep AND refund_amount = 2300000) <> 1
        OR paid <> 2300000 THEN
        RAISE EXCEPTION 'landlord_partial: sổ sai · hoá đơn [%] · doanh thu [%] · cọc còn %', settle_lines, revenue_items, paid;
      END IF;
    ELSIF scenario.name = 'landlord_full' THEN
      IF revenue_items IS DISTINCT FROM 'Doanh thu thanh lý/PNL=200000' OR paid <> 4300000
        OR (SELECT total_amount FROM public.income_expenses WHERE id = refund_voucher) <> 4300000 THEN
        RAISE EXCEPTION 'landlord_full: sổ sai · doanh thu [%] · cọc còn %', revenue_items, paid;
      END IF;
    ELSIF scenario.name = 'natural_expiry' THEN
      IF revenue_items IS NOT NULL OR paid <> dep OR (SELECT total_amount FROM public.income_expenses WHERE id = refund_voucher) <> dep THEN
        RAISE EXCEPTION 'natural_expiry: sổ sai · doanh thu [%] · cọc còn %', revenue_items, paid;
      END IF;
    ELSIF scenario.name = 'forfeit' THEN
      IF paid <> 0 OR refund_voucher IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.income_expenses WHERE contract_id = contract
          AND system_source = 'termination.forfeit_revenue' AND approval_status = 'APPROVED' AND total_amount = dep) THEN
        RAISE EXCEPTION 'forfeit: bỏ cọc ghi sai · cọc còn %', paid;
      END IF;
    ELSIF scenario.name = 'over_ledger' THEN
      -- Chỉ phần dưới cọc hợp đồng thành doanh thu; phần sổ ghi dôi 500.000 để nguyên.
      IF revenue_items IS DISTINCT FROM label || '/PNL=500000' OR paid <> 4000000
        OR (SELECT total_amount FROM public.income_expenses WHERE id = refund_voucher) <> 3500000 THEN
        RAISE EXCEPTION 'over_ledger: sổ sai · doanh thu [%] · cọc còn %', revenue_items, paid;
      END IF;
    ELSE
      IF revenue_items IS NOT NULL OR paid <> 4000000 OR (SELECT total_amount FROM public.income_expenses WHERE id = refund_voucher) <> 4000000 THEN
        RAISE EXCEPTION 'self_found: sổ sai · doanh thu [%] · cọc còn %', revenue_items, paid;
      END IF;
    END IF;

    -- Phiếu hoàn không duyệt được trong cùng giao dịch với lúc tạo (rào birth boundary của Thu chi), nên đối chiếu thay:
    -- cọc còn ghi trên hợp đồng trừ dòng cọc của phiếu hoàn chờ duyệt = phần còn lại sau khi duyệt (0, trừ phần sổ ghi dôi).
    paid := paid - coalesce((SELECT sum(i.amount) FROM public.income_expense_items i
      WHERE i.income_expense_id = refund_voucher AND i.accounting_class = 'DEPOSIT'), 0);
    IF paid <> (CASE scenario.name WHEN 'over_ledger' THEN 500000 ELSE 0 END) THEN
      RAISE EXCEPTION '%: sau khi duyệt phiếu hoàn cọc sẽ còn %', scenario.name, paid;
    END IF;
    RAISE NOTICE 'PASS %: hoá đơn [%] · doanh thu [%] · cọc còn % sau khi duyệt phiếu hoàn', scenario.name,
      coalesce(settle_lines, '-'), coalesce(revenue_items, '-'), paid;
  END LOOP;
END
$deposit_retained_test$;
