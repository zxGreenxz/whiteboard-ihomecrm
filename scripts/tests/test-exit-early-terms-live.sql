-- npm run test-env:thu-sql -- scripts/tests/test-exit-early-terms-live.sql
-- Chỉ chạy trên ihomecrm-test, công ty DEMO, sau khi đã áp migration 20261124075933_tra_phong_truoc_han_ba_truong_hop.
-- Bốn ca trả phòng trước hạn: nhờ sale, tự tìm khách, chủ nhà hỗ trợ (ghi bằng v1 như Hermes rồi phân loại),
-- khách nhận huỷ. Mọi hợp đồng, phiếu và thông báo tạo ra đều ROLLBACK cùng giao dịch của thu-sql.
SET LOCAL statement_timeout = '120s';

DO $exit_terms_test$
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
  settlement jsonb;
  deposit_receipt jsonb;
  claims text;
  matches integer;
  commission_voucher uuid;
  tick jsonb;
  fact_status text;
  commission_version bigint;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = org AND is_demo
  ) THEN
    RAISE EXCEPTION 'Requires the marked TEST database and DEMO organization';
  END IF;
  IF to_regclass('public.contract_exit_early_terms') IS NULL THEN
    RAISE EXCEPTION 'Migration 20261124075933 chưa áp lên TEST';
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
  -- Link công khai của chủ để đọc danh sách bot Zalo (zalo_phong_trong_cho_worker_v1) của công ty DEMO.
  INSERT INTO public.public_room_share_tokens(token, owner_id, organization_id, label)
  VALUES ('qa-exit-terms-' || replace(gen_random_uuid()::text, '-', ''), actor, org, 'QA trả phòng trước hạn');

  claims := jsonb_build_object('sub', actor, 'role', 'authenticated')::text;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', claims, true);
  deposit_receipt := jsonb_build_object('account_id', account, 'received_date', today, 'attachments', '[]'::jsonb);

  FOR scenario IN SELECT * FROM (VALUES
    ('sale',     'SALE_ASSISTED'),
    ('self',     'SELF_FOUND'),
    ('landlord', 'LANDLORD_AGREEMENT'),
    ('cancel',   'SALE_ASSISTED')
  ) AS cases(label, early_reason)
  LOOP
    room := gen_random_uuid(); old_customer := gen_random_uuid(); new_customer := gen_random_uuid();
    INSERT INTO public.rooms(id, building_id, organization_id, name, rent_price, deposit_amount, status)
    VALUES (room, building, org, 'QA-exit-' || scenario.label || '-' || left(room::text, 8), 2000000, old_deposit, 'AVAILABLE');
    INSERT INTO public.customers(id, organization_id, user_id, full_name, phone) VALUES
      (old_customer, org, actor, 'Khách cũ QA', '09' || lpad(floor(random()*100000000)::text, 8, '0')),
      (new_customer, org, actor, 'Khách nhận QA', '08' || lpad(floor(random()*100000000)::text, 8, '0'));

    SET LOCAL ROLE authenticated;
    response := public.create_contract_v2(jsonb_build_object(
      'contract', jsonb_build_object('room_id', room, 'signed_date', today-2, 'start_date', today-2,
        'end_date', today+60, 'rent_price', 2000000, 'total_deposit', old_deposit, 'payment_cycle', 'MONTHLY'),
      'customers', jsonb_build_array(jsonb_build_object('customer_id', old_customer, 'is_representative', true)),
      'services', '[]'::jsonb, 'deposit_receipts', jsonb_build_array(deposit_receipt || jsonb_build_object('amount', old_deposit))
    ), gen_random_uuid()::text);
    old_contract := (response->'contract'->>'id')::uuid;
    SELECT updated_at INTO STRICT old_updated_at FROM public.contracts WHERE id = old_contract;

    IF scenario.label = 'landlord' THEN
      -- Gọi thẳng v1 quyết toán ngay EARLY_RETURN (không qua v2, chưa chọn trường hợp): phải bị từ chối, không ghi gì.
      BEGIN
        PERFORM public.confirm_contract_return_v1(org, old_contract, old_updated_at, gen_random_uuid()::text,
          today, 'EARLY_RETURN', 'IMMEDIATE', jsonb_build_object('deposit_refund', old_deposit), boundary, 'QA đã bàn giao');
        RAISE EXCEPTION 'landlord: v1 EARLY_RETURN + IMMEDIATE không bị chặn' USING ERRCODE = 'P0001';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%Tải lại trang để chọn trường hợp%' THEN RAISE; END IF;
      END;
      -- Đường Hermes: v1 không biết trường hợp; quyết toán bị chặn tới khi phân loại. Lần gọi này dùng lại
      -- old_updated_at: nếu lần bị chặn ở trên đã ghi gì vào hợp đồng thì CAS ở đây hỏng.
      response := public.confirm_contract_return_v1(org, old_contract, old_updated_at, gen_random_uuid()::text,
        today, 'EARLY_RETURN', 'DEFERRED', NULL, boundary, 'QA đã bàn giao');
    ELSE
      response := public.confirm_contract_return_v2(org, old_contract, old_updated_at, gen_random_uuid()::text,
        today, 'EARLY_RETURN', 'DEFERRED', NULL, boundary, 'QA đã bàn giao',
        jsonb_strip_nulls(jsonb_build_object('early_reason', scenario.early_reason,
          'sale_name', CASE WHEN scenario.early_reason = 'SALE_ASSISTED' THEN 'Sale QA' END)));
    END IF;
    exit_case := (response->>'id')::uuid;
    exit_version := (response->>'version')::bigint;
    settlement := jsonb_build_object('deposit_refund', old_deposit, 'penalty_fee', 0, 'excess_rent', 0, 'outstanding_debt', 0,
      'shortfall_mode', 'PAID', 'refund_items', '[]'::jsonb, 'extra_charges', '[]'::jsonb);

    IF scenario.label = 'landlord' THEN
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, gen_random_uuid()::text, 'EARLY_RETURN', NULL, settlement);
        RAISE EXCEPTION 'landlord: quyết toán hồ sơ chưa phân loại không bị chặn';
      EXCEPTION WHEN SQLSTATE '55000' THEN
        IF SQLERRM NOT LIKE '%chưa chọn trường hợp%' THEN RAISE; END IF;
      END;
      response := public.set_contract_exit_early_terms_v1(org, exit_case, 0, gen_random_uuid(), 'LANDLORD_AGREEMENT', NULL,
        'Chủ nhà đồng ý cho thanh lý sớm');
      IF response->>'early_reason' IS DISTINCT FROM 'LANDLORD_AGREEMENT' OR (response->>'broker_fee')::numeric <> 0
        OR (response->>'hold_open')::boolean THEN RAISE EXCEPTION 'landlord: phân loại sai %', response; END IF;
    END IF;

    term_version := (public.read_contract_exit_early_terms_v1(org, NULL, exit_case)->0->>'version')::bigint;
    RESET ROLE;
    -- Giữ phòng: nhờ sale / tự tìm thì fact là rented và bot không thấy; chủ nhà hỗ trợ thì phòng rao bán ngay.
    SELECT f.status_public INTO STRICT fact_status FROM public.rooms r
      CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(r.id, r.organization_id, r.status::text, false, 30) f
      WHERE r.id = room;
    SELECT count(*) INTO matches FROM jsonb_array_elements(coalesce(public.zalo_phong_trong_cho_worker_v1(org)->'rooms', '[]')) x
      WHERE x->>'id' = room::text;
    IF scenario.label = 'landlord' THEN
      IF fact_status IS DISTINCT FROM 'free' OR matches <> 1 THEN
        RAISE EXCEPTION 'landlord: phòng không rao lại (fact %, bot %)', fact_status, matches; END IF;
    ELSIF fact_status IS DISTINCT FROM 'rented' OR matches <> 0 THEN
      RAISE EXCEPTION '%: phòng đang giữ vẫn rao bán (fact %, bot %)', scenario.label, fact_status, matches;
    END IF;
    SET LOCAL ROLE authenticated;
    IF scenario.label <> 'landlord' THEN
      response := public.get_sale_room_inventory_v1(org, building, room)->'rooms'->0;
      IF response->>'status_public' IS DISTINCT FROM 'rented' OR response->'exit_hold'->>'exit_case_id' IS DISTINCT FROM exit_case::text
        OR (response->'exit_hold'->>'active')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION '%: Sale Phòng không thấy phòng đang giữ %', scenario.label, response; END IF;
      SELECT count(*) INTO matches FROM jsonb_array_elements(public.get_my_available_rooms(org)->'rooms') x
        WHERE x->>'id' = room::text AND x->'exit_hold'->>'exit_case_id' = exit_case::text;
      IF matches <> 1 THEN RAISE EXCEPTION '%: get_my_available_rooms không trả phòng đang giữ', scenario.label; END IF;
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, gen_random_uuid()::text, 'EARLY_RETURN', NULL, settlement);
        RAISE EXCEPTION '%: quyết toán trước khi có hợp đồng mới không bị chặn', scenario.label;
      EXCEPTION WHEN SQLSTATE '55000' THEN
        IF SQLERRM NOT LIKE '%Chưa có hợp đồng của khách nhận%' THEN RAISE; END IF;
      END;
    END IF;

    IF scenario.label = 'cancel' THEN
      -- Hết hạn giữ: cron (không JWT) nhắc người ghi đúng một lần.
      RESET ROLE;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      tick := app_private.exit_hold_expiry_tick_v1(now() + interval '4 days');
      tick := app_private.exit_hold_expiry_tick_v1(now() + interval '4 days');
      SELECT count(*) INTO matches FROM public.notifications n
        WHERE n.user_id = actor AND n.metadata->>'exit_case_id' = exit_case::text AND n.metadata->>'kind' = 'exit_hold_expired';
      IF matches <> 1 THEN RAISE EXCEPTION 'cancel: nhắc hết hạn giữ sai số lần (%)', matches; END IF;
      PERFORM set_config('request.jwt.claim.sub', actor::text, true);
      PERFORM set_config('request.jwt.claims', claims, true);
      SET LOCAL ROLE authenticated;
      -- Khách nhận huỷ: Mở bán lại, phòng rao lại; đổi sang chủ nhà hỗ trợ rồi quyết toán không phí môi giới.
      response := public.reopen_contract_exit_hold_v1(org, exit_case, term_version, gen_random_uuid(), 'Khách nhận huỷ');
      RESET ROLE;
      SELECT count(*) INTO matches FROM jsonb_array_elements(coalesce(public.zalo_phong_trong_cho_worker_v1(org)->'rooms', '[]')) x
        WHERE x->>'id' = room::text;
      IF matches <> 1 THEN RAISE EXCEPTION 'cancel: mở bán lại mà bot vẫn không thấy phòng'; END IF;
      SET LOCAL ROLE authenticated;
      response := public.set_contract_exit_early_terms_v1(org, exit_case, (response->>'version')::bigint, gen_random_uuid(),
        'LANDLORD_AGREEMENT', NULL, 'Khách nhận huỷ, chủ nhà đồng ý thanh lý sớm');
      IF (response->>'broker_fee')::numeric <> 0 OR response->>'early_reason' IS DISTINCT FROM 'LANDLORD_AGREEMENT' THEN
        RAISE EXCEPTION 'cancel: đổi trường hợp sai %', response; END IF;
    ELSIF scenario.label IN ('sale', 'self') THEN
      response := public.create_contract_v2(jsonb_build_object(
        'contract', jsonb_build_object('room_id', room, 'signed_date', today, 'start_date', today,
          'end_date', today+90, 'rent_price', 2100000, 'total_deposit', 600000, 'payment_cycle', 'MONTHLY'),
        'customers', jsonb_build_array(jsonb_build_object('customer_id', new_customer, 'is_representative', true)),
        'services', '[]'::jsonb, 'deposit_receipts', jsonb_build_array(deposit_receipt || '{"amount":600000}'::jsonb)
      ), gen_random_uuid()::text);
      new_contract := (response->'contract'->>'id')::uuid;
      response := public.read_contract_exit_early_terms_v1(org, new_contract);
      IF jsonb_array_length(response) <> 1 OR (response->0->>'exit_case_id')::uuid IS DISTINCT FROM exit_case THEN
        RAISE EXCEPTION '%: hợp đồng mới không tự nối với hồ sơ cũ', scenario.label; END IF;
      BEGIN
        PERFORM public.create_commission_voucher(new_contract, CASE WHEN scenario.label = 'self' THEN 'sale' ELSE 'broker' END,
          100000, today, account, NULL, 'QA', NULL, NULL, NULL, '[]'::jsonb);
        RAISE EXCEPTION '%: hoa hồng theo đường chung không bị chặn', scenario.label;
      EXCEPTION WHEN SQLSTATE '55000' THEN
        IF SQLERRM NOT ILIKE '%hoa hồng%' THEN RAISE; END IF;
      END;
      IF scenario.label = 'self' THEN
        SELECT count(*) INTO matches FROM jsonb_array_elements(public.list_contract_commission_followups_v2(org, ARRAY[new_contract])->'rows') x
          WHERE x->>'state' = 'NOT_APPLICABLE';
        IF matches <> 2 THEN RAISE EXCEPTION 'self: danh sách theo dõi hoa hồng còn nhắc (% dòng không áp dụng)', matches; END IF;
      END IF;
    END IF;

    -- Quyết toán: nhờ sale bắt đúng một dòng phí; trường hợp khác cấm dòng phí.
    IF scenario.label = 'sale' THEN
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, gen_random_uuid()::text, 'EARLY_RETURN', NULL, settlement);
        RAISE EXCEPTION 'sale: thiếu dòng phí môi giới không bị chặn';
      EXCEPTION WHEN SQLSTATE '22023' THEN
        IF SQLERRM NOT LIKE '%phí môi giới%' THEN RAISE; END IF;
      END;
      settlement := settlement || jsonb_build_object('extra_charges', jsonb_build_array(jsonb_build_object(
        'kind', 'BROKER_FEE', 'description', 'Phí môi giới (50% cọc cũ)', 'amount', old_deposit / 2)));
    ELSE
      BEGIN
        PERFORM public.finalize_contract_exit_case_v1(org, exit_case, exit_version, gen_random_uuid()::text, 'EARLY_RETURN', NULL,
          settlement || jsonb_build_object('extra_charges', jsonb_build_array(jsonb_build_object('kind', 'BROKER_FEE',
            'description', 'Phí môi giới', 'amount', 100000))));
        RAISE EXCEPTION '%: dòng phí môi giới ở trường hợp khác không bị chặn', scenario.label;
      EXCEPTION WHEN SQLSTATE '22023' THEN
        IF SQLERRM NOT LIKE '%phí môi giới%' THEN RAISE; END IF;
      END;
    END IF;
    response := public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-settle-' || exit_case::text, 'EARLY_RETURN', NULL, settlement);
    response := public.finalize_contract_exit_case_v1(org, exit_case, exit_version, 'qa-settle-' || exit_case::text, 'EARLY_RETURN', NULL, settlement);
    IF response->>'state' IS DISTINCT FROM 'FINALIZED' THEN RAISE EXCEPTION '%: quyết toán không chốt', scenario.label; END IF;
    response := public.read_contract_exit_early_terms_v1(org, NULL, exit_case)->0;
    IF response->>'fee_applied_at' IS NULL THEN RAISE EXCEPTION '%: chưa ghi mốc đã áp phí', scenario.label; END IF;

    IF scenario.label = 'sale' THEN
      commission_version := (response->>'version')::bigint;
      response := public.create_contract_exit_commission_v1(org, exit_case, commission_version, md5('qa-commission' || exit_case::text)::uuid, account);
      commission_voucher := (response->>'commission_voucher_id')::uuid;
      response := public.create_contract_exit_commission_v1(org, exit_case, commission_version, md5('qa-commission' || exit_case::text)::uuid, account);
      IF commission_voucher IS NULL OR (response->>'commission_voucher_id')::uuid IS DISTINCT FROM commission_voucher THEN
        RAISE EXCEPTION 'sale: phiếu hoa hồng thiếu hoặc trùng khi gọi lặp'; END IF;
    ELSE
      BEGIN
        PERFORM public.create_contract_exit_commission_v1(org, exit_case, (response->>'version')::bigint, gen_random_uuid(), account);
        RAISE EXCEPTION '%: lập được hoa hồng ngoài ca nhờ sale', scenario.label;
      EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
      END;
    END IF;
    IF scenario.label IN ('sale', 'self') THEN
      SELECT count(*) INTO matches FROM public.real_estate_renewals_transfers_v1(org, ARRAY[building], today, today)
        WHERE kind = 'TRANSFER' AND contract_id = new_contract;
      IF matches <> 1 THEN RAISE EXCEPTION '%: báo cáo nhượng có % dòng cho hợp đồng mới', scenario.label, matches; END IF;
    END IF;
    RESET ROLE;

    IF (SELECT count(*) FROM public.contract_terminations WHERE contract_id = old_contract AND status = 'COMPLETED'
        AND refund_amount = CASE WHEN scenario.label = 'sale' THEN old_deposit / 2 ELSE old_deposit END) <> 1 THEN
      RAISE EXCEPTION '%: số hoàn cọc của hợp đồng cũ sai', scenario.label;
    END IF;
    IF scenario.label = 'sale' AND NOT EXISTS (SELECT 1 FROM public.income_expenses WHERE id = commission_voucher
        AND contract_id = new_contract AND commission_kind = 'broker' AND type = 'EXPENSE'
        AND total_amount = old_deposit / 2 AND notes = 'Người nhận: Sale QA' AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'sale: phiếu hoa hồng sai số tiền, người nhận hoặc hợp đồng';
    END IF;
    IF scenario.label = 'self' AND EXISTS (SELECT 1 FROM public.income_expenses WHERE contract_id = new_contract
        AND commission_kind IS NOT NULL AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'self: có phiếu hoa hồng cho khách tự tìm';
    END IF;
    RAISE NOTICE 'PASS %: trường hợp %, giữ phòng/nối/quyết toán/hoa hồng đúng luật', scenario.label, scenario.early_reason;
  END LOOP;
END
$exit_terms_test$;
