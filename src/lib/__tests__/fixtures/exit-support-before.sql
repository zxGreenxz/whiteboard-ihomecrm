-- Read-only catalog capture of reviewed pre-fix function definitions; no business data.
-- pg_get_functiondef trên production ngày 24/11/2026 (npm run db:query, chỉ đọc), trước migration 20261124154554.

-- public.create_contract_v2(jsonb,text) md5 1df4fcbebf3ff4fea861618612b48d4d
CREATE OR REPLACE FUNCTION public.create_contract_v2(p_payload jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_contract_json jsonb := COALESCE(p_payload->'contract', '{}'::jsonb);
  v_customers jsonb := COALESCE(p_payload->'customers', '[]'::jsonb);
  v_services jsonb := COALESCE(p_payload->'services', '[]'::jsonb);
  v_receipts jsonb := COALESCE(p_payload->'deposit_receipts', '[]'::jsonb);
  v_existing_deposits jsonb := COALESCE(p_payload->'existing_deposit_voucher_ids', '[]'::jsonb);
  v_first_invoice jsonb := p_payload->'first_invoice';
  v_support jsonb; v_support_context jsonb; v_support_revision bigint;
  v_room_id uuid;
  v_building_id uuid;
  v_org uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_payload_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_contract_id uuid;
  v_invoice_id uuid;
  v_customer jsonb;
  v_service jsonb;
  v_receipt jsonb;
  v_item jsonb;
  v_voucher_id uuid;
  v_deposit_type_id uuid;
  v_account_id uuid;
  v_total_deposit numeric;
  v_deposit_paid numeric := 0;
  v_new_deposit_receipts numeric := 0;
  v_deposit_shortfall numeric := 0;
  v_debt_mode text;
  v_debt_reason text;
  v_debt_due date;
  v_start_date date;
  v_end_date date;
  v_signed_date date;
  v_start_billing date;
  v_end_billing date;
  v_billing_month text;
  v_issue_date date;
  v_due_date date;
  v_subtotal numeric := 0;
  v_revenue_subtotal numeric := 0;
  v_deposit_invoice_total numeric := 0;
  v_discount numeric := 0;
  v_revenue_after_discount numeric := 0;
  v_rounded_revenue numeric := 0;
  v_total_amount numeric := 0;
  v_remainder numeric := 0;
  v_rep_count integer;
  v_customer_count integer;
  v_distinct_customer_count integer;
  v_locked_customer_count integer;
  v_deposit_item_count integer := 0;
  v_contract_row jsonb;
  v_invoice_row jsonb := NULL;
  v_response jsonb;
  v_idx integer := 0;
  v_amount numeric;
  v_qty numeric;
  v_unit numeric;
  v_item_from date;
  v_item_to date;
  v_class text;
  v_type text;
  v_service_id uuid;
  v_room_name text;
  v_building_name text;
  v_room_status public.room_status;
  v_contract_template_id uuid;
  v_invoice_template_id uuid;
BEGIN
  -- RENT_SUPPORT_CREATE_V2
  IF v_contract_json ? 'rent_support' THEN
    PERFORM app_private.validate_rent_support_v1(v_contract_json->'rent_support');
    IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
    IF v_contract_json ? 'discounts' AND v_contract_json->'discounts' NOT IN ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'{"version":2,"kind":"RENT_SUPPORT_SCHEDULE"}'::jsonb)
      AND (COALESCE((v_contract_json->'discounts'->>'months')::numeric,0)<>0 OR COALESCE((v_contract_json->'discounts'->>'amount_per_month')::numeric,0)<>0) THEN RAISE EXCEPTION 'V2 schedule cannot also use legacy discount' USING ERRCODE='22023';END IF;
    v_contract_json:=jsonb_set(v_contract_json,'{discounts}','{"version":2,"kind":"RENT_SUPPORT_SCHEDULE"}');
  ELSIF v_contract_json->'discounts'->>'version'='2' THEN
    RAISE EXCEPTION 'Support marker requires schedule' USING ERRCODE='22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(v_customers) <> 'array'
     OR jsonb_typeof(v_services) <> 'array'
     OR jsonb_typeof(v_receipts) <> 'array'
     OR jsonb_typeof(v_existing_deposits) <> 'array' THEN
    RAISE EXCEPTION 'Payload contract V2 không hợp lệ' USING ERRCODE = '22023';
  END IF;

  v_room_id := NULLIF(v_contract_json->>'room_id', '')::uuid;
  v_start_date := NULLIF(v_contract_json->>'start_date', '')::date;
  v_end_date := NULLIF(v_contract_json->>'end_date', '')::date;
  v_signed_date := COALESCE(NULLIF(v_contract_json->>'signed_date', '')::date, v_start_date);
  v_start_billing := COALESCE(NULLIF(v_contract_json->>'start_billing_date', '')::date, v_start_date);
  v_end_billing := COALESCE(NULLIF(v_contract_json->>'end_billing_date', '')::date, v_start_billing);
  v_total_deposit := COALESCE((v_contract_json->>'total_deposit')::numeric, 0);
  v_debt_mode := NULLIF(v_contract_json->>'deposit_debt_mode', '');
  v_debt_reason := NULLIF(btrim(v_contract_json->>'deposit_debt_reason'), '');
  v_debt_due := NULLIF(v_contract_json->>'deposit_topup_due_date', '')::date;
  v_contract_template_id := NULLIF(v_contract_json->>'contract_template_id', '')::uuid;
  v_invoice_template_id := NULLIF(v_contract_json->>'invoice_template_id', '')::uuid;

  IF v_room_id IS NULL OR v_start_date IS NULL OR v_end_date IS NULL OR v_start_date > v_end_date THEN
    RAISE EXCEPTION 'Phòng hoặc ngày hợp đồng không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF v_start_billing IS NULL OR v_end_billing IS NULL OR v_start_billing > v_end_billing THEN
    RAISE EXCEPTION 'Kỳ tính tiền đầu không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF v_start_billing < v_start_date OR v_end_billing > v_end_date THEN
    RAISE EXCEPTION 'Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE((v_contract_json->>'rent_price')::numeric, -1)::text
       IN ('NaN', 'Infinity', '-Infinity')
     OR v_total_deposit::text IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE((v_contract_json->>'rent_price')::numeric, -1) < 0
     OR v_total_deposit < 0 THEN
    RAISE EXCEPTION 'Giá thuê hoặc tiền cọc không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT room_row.building_id, building_row.organization_id, building_row.user_id,
         room_row.name, building_row.name, room_row.status
    INTO v_building_id, v_org, v_owner, v_room_name, v_building_name, v_room_status
  FROM public.rooms room_row
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  JOIN public.organizations org_row
    ON org_row.id = building_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE room_row.id = v_room_id
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
  FOR UPDATE OF room_row;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy phòng trong tổ chức đang hoạt động'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'contracts.create', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng' USING ERRCODE = '42501';
  END IF;

  v_payload_hash := md5(jsonb_build_object('organization_id', v_org, 'payload', p_payload)::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.create.v2', v_room_id::text || '|' || v_start_date::text,
    v_actor, v_key, v_payload_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.create.v2'
    AND operation_row.subject_scope = v_room_id::text || '|' || v_start_date::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_payload_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF v_room_status NOT IN ('AVAILABLE', 'RESERVED') THEN
    RAISE EXCEPTION 'Trạng thái phòng không cho phép tạo hợp đồng: %', v_room_status
      USING ERRCODE = '55000';
  END IF;

  v_route := app_private.evaluate_feature_route('contract.create.v2', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer contract.create.v2 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer contract.create.v2 chưa bật' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contracts contract_row
    WHERE contract_row.room_id = v_room_id
      AND contract_row.deleted_at IS NULL
      AND contract_row.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Phòng đã có hợp đồng đang hiệu lực' USING ERRCODE = '23505';
  END IF;

  PERFORM app_private.assert_room_next_claim_for_signing_v1(v_org,v_room_id,NULLIF(p_payload->>'reservation_id','')::uuid,NULLIF(p_payload->>'reservation_revision','')::bigint,ARRAY(SELECT (value->>'customer_id')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'customers','[]'::jsonb))),ARRAY(SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'existing_deposit_voucher_ids','[]'::jsonb))));
  UPDATE public.room_reservation_holds
     SET status = 'EXPIRED'
   WHERE room_id = v_room_id
     AND status = 'PENDING_APPROVAL'
     AND expires_at <= clock_timestamp();

  IF EXISTS (
    SELECT 1 FROM public.room_reservation_holds hold_row
    WHERE hold_row.room_id = v_room_id
      AND hold_row.status = 'PENDING_APPROVAL'
      AND hold_row.expires_at > clock_timestamp()
      AND hold_row.held_by <> v_actor
  ) THEN
    RAISE EXCEPTION 'Phòng đang được người khác giữ chỗ' USING ERRCODE = '55P03';
  END IF;

  SELECT count(*), count(DISTINCT customer_row->>'customer_id'),
         count(*) FILTER (WHERE COALESCE((customer_row->>'is_representative')::boolean, false))
    INTO v_customer_count, v_distinct_customer_count, v_rep_count
  FROM jsonb_array_elements(v_customers) customer_row;

  IF v_customer_count = 0 OR v_customer_count <> v_distinct_customer_count OR v_rep_count <> 1 THEN
    RAISE EXCEPTION 'Hợp đồng cần danh sách khách không trùng và đúng một người đại diện'
      USING ERRCODE = '22023';
  END IF;

  -- Preserve tenant/deletion validation while concurrent contract creates share
  -- customer locks acquired in one deterministic UUID order.
  WITH requested_customers AS MATERIALIZED (
    SELECT (requested.value->>'customer_id')::uuid AS customer_id
    FROM jsonb_array_elements(v_customers) AS requested(value)
  ), locked_customers AS MATERIALIZED (
    SELECT customer_row.id
    FROM public.customers customer_row
    JOIN requested_customers requested
      ON requested.customer_id = customer_row.id
    WHERE customer_row.deleted_at IS NULL
      AND customer_row.organization_id = v_org
    ORDER BY customer_row.id
    FOR SHARE OF customer_row
  )
  SELECT count(*)
    INTO v_locked_customer_count
  FROM locked_customers;

  IF v_locked_customer_count <> v_customer_count THEN
    RAISE EXCEPTION 'Khách hàng không thuộc tổ chức' USING ERRCODE = '42501';
  END IF;

  FOR v_service IN SELECT value FROM jsonb_array_elements(v_services) LOOP
    IF COALESCE((v_service->>'unit_price')::numeric, -1)::text
         IN ('NaN', 'Infinity', '-Infinity')
       OR COALESCE(NULLIF(v_service->>'initial_reading', '')::numeric, 0)::text
         IN ('NaN', 'Infinity', '-Infinity')
       OR COALESCE((v_service->>'unit_price')::numeric, -1) < 0 THEN
      RAISE EXCEPTION 'Đơn giá dịch vụ không hợp lệ' USING ERRCODE = '22023';
    END IF;
    PERFORM 1
    FROM public.services service_row
    WHERE service_row.id = (v_service->>'service_id')::uuid
      AND service_row.organization_id = v_org
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dịch vụ không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF v_contract_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.document_templates template_row
    WHERE template_row.id = v_contract_template_id
      AND template_row.organization_id = v_org
      AND template_row.category = 'CONTRACT_NEW'
      AND COALESCE(template_row.is_active, true)
      AND template_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mẫu hợp đồng không thuộc tổ chức hoặc không còn hiệu lực'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_invoice_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.document_templates template_row
    WHERE template_row.id = v_invoice_template_id
      AND template_row.organization_id = v_org
      AND template_row.category = 'INVOICE'
      AND COALESCE(template_row.is_active, true)
      AND template_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mẫu hóa đơn không thuộc tổ chức hoặc không còn hiệu lực'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT type_row.id INTO v_deposit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1
  FOR SHARE;

  IF (jsonb_array_length(v_receipts) > 0 OR jsonb_array_length(v_existing_deposits) > 0)
     AND v_deposit_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu cọc is_deposit' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('app.contract_create_v2', 'on', true);

  INSERT INTO public.contracts (
    user_id, organization_id, tenant_id, room_id, status,
    signed_date, start_date, end_date, rent_price, payment_cycle,
    total_deposit, deposit_paid, start_billing_date, end_billing_date,
    contract_template_id, invoice_template_id, notes, discounts,
    deposit_debt_acknowledged, deposit_debt_mode, deposit_debt_reason,
    deposit_topup_due_date
  ) VALUES (
    v_owner, v_org, NULL, v_room_id, 'ACTIVE',
    v_signed_date, v_start_date, v_end_date,
    (v_contract_json->>'rent_price')::numeric,
    COALESCE(NULLIF(v_contract_json->>'payment_cycle', '')::public.payment_cycle, 'MONTHLY'),
    v_total_deposit, 0, v_start_billing, v_end_billing,
    v_contract_template_id,
    v_invoice_template_id,
    NULLIF(v_contract_json->>'notes', ''),
    COALESCE(v_contract_json->'discounts', '[]'::jsonb),
    false, NULL, NULL, NULL
  ) RETURNING id INTO v_contract_id;
  IF v_contract_json ? 'rent_support' THEN
    IF NOT app_private.rent_support_scope_v1(v_org,v_building_id,'income_expenses.create') THEN RAISE EXCEPTION 'Financial permission required for support' USING ERRCODE='42501';END IF;
    PERFORM app_private.persist_contract_rent_support_v1(v_org,v_contract_id,v_contract_json->'rent_support');
  END IF;

  FOR v_customer IN SELECT value FROM jsonb_array_elements(v_customers) LOOP
    INSERT INTO public.contract_customers (
      organization_id, contract_id, customer_id, is_representative, notes
    ) VALUES (
      v_org, v_contract_id, (v_customer->>'customer_id')::uuid,
      COALESCE((v_customer->>'is_representative')::boolean, false),
      NULLIF(v_customer->>'notes', '')
    );
  END LOOP;

  FOR v_service IN SELECT value FROM jsonb_array_elements(v_services) LOOP
    INSERT INTO public.contract_services (
      organization_id, contract_id, service_id, unit_price, initial_reading
    ) VALUES (
      v_org, v_contract_id, (v_service->>'service_id')::uuid,
      (v_service->>'unit_price')::numeric,
      NULLIF(v_service->>'initial_reading', '')::numeric
    );
  END LOOP;

  IF jsonb_array_length(v_existing_deposits) <> (
    SELECT count(DISTINCT value #>> '{}') FROM jsonb_array_elements(v_existing_deposits)
  ) THEN
    RAISE EXCEPTION 'Danh sách phiếu cọc có ID trùng' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_existing_deposits) LOOP
    SELECT voucher.id INTO v_voucher_id
    FROM public.income_expenses voucher
    WHERE voucher.id = (v_item #>> '{}')::uuid
      AND voucher.organization_id = v_org
      AND voucher.room_id = v_room_id
      AND voucher.contract_id IS NULL
      AND NOT app_private.reservation_deposit_is_settled_v1(voucher.id)
      AND voucher.type = 'INCOME'
      AND voucher.approval_status = 'APPROVED'
      AND voucher.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
          AND item.accounting_class = 'DEPOSIT'
      )
    FOR SHARE;

    IF v_voucher_id IS NULL THEN
      RAISE EXCEPTION 'Phiếu cọc được chọn không hợp lệ hoặc đã được dùng'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.contract_deposit_links (
      organization_id, contract_id, income_expense_id, link_source, linked_by
    ) VALUES (
      v_org, v_contract_id, v_voucher_id, 'EXPLICIT_V2', v_actor
    );

    -- Keep the legacy lifecycle field in sync so linked reservation deposits
    -- immediately leave orphan/holding-deposit queries as well as the link table.
    PERFORM app_private.begin_ie_flex_write_v1(v_voucher_id, 'LINK_CONTRACT');
    UPDATE public.income_expenses
       SET contract_id = v_contract_id,
           updated_at = now()
     WHERE id = v_voucher_id
       AND contract_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu cọc đã đổi trạng thái trong lúc tạo hợp đồng'
        USING ERRCODE = '40001';
    END IF;
    PERFORM app_private.end_ie_flex_write_v1(v_voucher_id);
    v_voucher_id := NULL;
  END LOOP;

  FOR v_receipt IN SELECT value FROM jsonb_array_elements(v_receipts) LOOP
    v_amount := COALESCE((v_receipt->>'amount')::numeric, 0);
    IF v_amount::text IN ('NaN', 'Infinity', '-Infinity') OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Số tiền cọc phải lớn hơn 0' USING ERRCODE = '22023';
    END IF;
    v_new_deposit_receipts := v_new_deposit_receipts + v_amount;

    v_account_id := NULLIF(v_receipt->>'account_id', '')::uuid;
    IF v_account_id IS NULL THEN
      SELECT account_row.id INTO v_account_id
      FROM public.accounts account_row
      WHERE account_row.organization_id = v_org
        AND account_row.user_id = v_actor
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
      ORDER BY account_row.is_default DESC,
               CASE WHEN account_row.name ILIKE '%thu' THEN 0 ELSE 1 END,
               account_row.created_at
      LIMIT 1
      FOR SHARE;
      IF v_account_id IS NULL THEN
        RAISE EXCEPTION 'Chưa chọn sổ quỹ nhận cọc trong tổ chức'
          USING ERRCODE = '22023';
      END IF;
    END IF;
    PERFORM 1 FROM public.accounts account_row
    WHERE account_row.id = v_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ cọc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;

    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_org, 'thu_tien.collect', v_building_id, v_account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền ghi tiền cọc vào sổ đã chọn' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, voucher_date, total_amount, approval_status, approved_by,
      approved_at, attachments, business_result_accounting, creator_name,
      system_source, idempotency_key
    ) VALUES (
      v_owner, v_org, 'INCOME',
      'Cọc giữ phòng ' || COALESCE(v_room_name, '') || ' ' || COALESCE(v_building_name, ''),
      v_building_id, v_room_id, v_contract_id, v_account_id,
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      v_amount, 'APPROVED', v_actor, clock_timestamp(),
      COALESCE(v_receipt->'attachments', '[]'::jsonb), NULL,
      COALESCE(NULLIF(v_receipt->>'creator_name', ''), 'Contract V2'),
      'contract.create.v2', v_key || ':deposit:' || v_idx
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO public.income_expense_items (
      income_expense_id, organization_id, income_expense_type_id, description,
      quantity, unit_price, amount, start_date, end_date, accounting_class
    ) VALUES (
      v_voucher_id, v_org, v_deposit_type_id, 'Tiền cọc hợp đồng',
      1, v_amount, v_amount,
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      'DEPOSIT'
    );
    v_idx := v_idx + 1;
  END LOOP;

  PERFORM public.recompute_contract_deposit_paid(v_contract_id);
  SELECT COALESCE(contract_row.deposit_paid, 0)
    INTO v_deposit_paid
  FROM public.contracts contract_row
  WHERE contract_row.id = v_contract_id
  FOR UPDATE;

  v_deposit_shortfall := GREATEST(v_total_deposit - v_deposit_paid, 0);
  IF v_deposit_paid - v_total_deposit >= 0.01 THEN
    RAISE EXCEPTION 'Tiền cọc đã nhận vượt số cọc của hợp đồng'
      USING ERRCODE = '22023';
  END IF;
  IF v_deposit_shortfall >= 0.01 THEN
    IF v_debt_mode NOT IN ('DEBT', 'FIRST_INVOICE') THEN
      RAISE EXCEPTION 'Thiếu cọc: phải chọn DEBT hoặc FIRST_INVOICE'
        USING ERRCODE = '22023';
    END IF;
    IF v_debt_mode = 'DEBT' AND (v_debt_reason IS NULL OR v_debt_due IS NULL) THEN
      RAISE EXCEPTION 'Nợ cọc cần lý do và hạn bổ sung' USING ERRCODE = '22023';
    END IF;
    IF v_debt_mode = 'FIRST_INVOICE' AND v_first_invoice IS NULL THEN
      RAISE EXCEPTION 'FIRST_INVOICE cần hóa đơn đầu' USING ERRCODE = '22023';
    END IF;

    UPDATE public.contracts
       SET deposit_debt_acknowledged = true,
           deposit_debt_mode = v_debt_mode,
           deposit_debt_reason = CASE WHEN v_debt_mode = 'DEBT' THEN v_debt_reason END,
           deposit_topup_due_date = CASE WHEN v_debt_mode = 'DEBT' THEN v_debt_due END
     WHERE id = v_contract_id;
  ELSE
    v_debt_mode := NULL;
  END IF;

  IF v_first_invoice IS NOT NULL THEN
    IF jsonb_typeof(COALESCE(v_first_invoice->'items', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_first_invoice->'items', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'Hóa đơn đầu cần ít nhất một hạng mục' USING ERRCODE = '22023';
    END IF;

    v_subtotal := 0;
    v_revenue_subtotal := 0;
    v_deposit_invoice_total := 0;
    v_deposit_item_count := 0;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_first_invoice->'items') LOOP
      v_type := COALESCE(NULLIF(v_item->>'type', ''), 'OTHER');
      v_class := COALESCE(NULLIF(v_item->>'accounting_class', ''), 'REVENUE');
      v_unit := COALESCE((v_item->>'unit_price')::numeric, -1);
      v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
      v_service_id := NULLIF(v_item->>'service_id', '')::uuid;
      v_item_from := NULLIF(v_item->>'from_date', '')::date;
      v_item_to := NULLIF(v_item->>'to_date', '')::date;

      IF v_type NOT IN ('RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER')
         OR v_class NOT IN ('REVENUE', 'DEPOSIT')
         OR v_unit::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_qty::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_unit < 0 OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Hạng mục hóa đơn đầu không hợp lệ' USING ERRCODE = '22023';
      END IF;
      IF (v_item_from IS NULL) <> (v_item_to IS NULL) THEN
        RAISE EXCEPTION 'Kỳ hạng mục hóa đơn phải có đủ từ ngày và đến ngày'
          USING ERRCODE = '22023';
      END IF;
      IF v_item_from IS NOT NULL AND v_item_from > v_item_to THEN
        RAISE EXCEPTION 'Kỳ hạng mục hóa đơn bị đảo ngày' USING ERRCODE = '22023';
      END IF;
      IF v_class = 'REVENUE'
         AND (
           COALESCE(v_item_from, v_start_billing) < v_start_billing
           OR COALESCE(v_item_to, v_end_billing) > v_end_billing
         ) THEN
        RAISE EXCEPTION 'Kỳ hạng mục doanh thu phải nằm trong kỳ tính tiền đầu'
          USING ERRCODE = '22023';
      END IF;
      IF v_class = 'DEPOSIT' AND v_type <> 'OTHER' THEN
        RAISE EXCEPTION 'Hạng mục cọc phải có type OTHER' USING ERRCODE = '22023';
      END IF;
      IF v_service_id IS NOT NULL THEN
        PERFORM 1 FROM public.services service_row
        WHERE service_row.id = v_service_id AND service_row.organization_id = v_org;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Dịch vụ trong hóa đơn không thuộc tổ chức' USING ERRCODE = '42501';
        END IF;
      END IF;

      v_amount := round(v_unit * v_qty, 2);
      v_subtotal := v_subtotal + v_amount;
      IF v_class = 'DEPOSIT' THEN
        v_deposit_invoice_total := v_deposit_invoice_total + v_amount;
        v_deposit_item_count := v_deposit_item_count + 1;
      ELSE
        v_revenue_subtotal := v_revenue_subtotal + v_amount;
      END IF;
    END LOOP;

    IF v_debt_mode = 'FIRST_INVOICE' THEN
      IF v_deposit_item_count <> 1
         OR abs(v_deposit_invoice_total - v_deposit_shortfall) >= 0.01 THEN
        RAISE EXCEPTION 'Dòng cọc hóa đơn đầu phải đúng bằng phần cọc còn thiếu'
          USING ERRCODE = '22023';
      END IF;
    ELSIF v_deposit_item_count <> 0 THEN
      RAISE EXCEPTION 'Chỉ mode FIRST_INVOICE mới được có dòng cọc'
        USING ERRCODE = '22023';
    END IF;

    -- RENT_SUPPORT_FIRST_INVOICE_V1
    v_billing_month := public.compute_first_billing_month_v2(v_start_billing, v_end_billing);
    IF v_contract_json ? 'rent_support' THEN
      SELECT revision INTO v_support_revision FROM app_private.contract_rent_support_plans WHERE organization_id=v_org AND contract_id=v_contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
      IF jsonb_typeof(v_first_invoice->'manual_discount_amount') IS DISTINCT FROM 'string' OR v_first_invoice->>'manual_discount_amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'Explicit first invoice manual discount required' USING ERRCODE='22023';END IF;
      v_support_context:=jsonb_build_object('version',1,'expected_plan_revision',v_support_revision,'manual_discount_amount',v_first_invoice->>'manual_discount_amount','request_id',md5('contract.first_invoice|'||v_key)::uuid);
      v_support:=app_private.invoice_rent_support_before_v1(v_org,v_contract_id,v_billing_month,'MONTHLY',v_first_invoice->'items',COALESCE((v_first_invoice->>'discount_amount')::numeric,0),0,v_support_context);
    END IF;
    v_discount := COALESCE((v_first_invoice->>'discount_amount')::numeric, 0);
    IF v_discount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_discount < 0 OR v_discount > v_revenue_subtotal THEN
      RAISE EXCEPTION 'Giảm trừ không được vượt phần doanh thu không-cọc'
        USING ERRCODE = '22023';
    END IF;

    v_revenue_after_discount := GREATEST(v_revenue_subtotal - v_discount, 0);
    v_remainder := mod(v_revenue_after_discount, 1000);
    v_rounded_revenue := CASE
      WHEN v_revenue_after_discount <= 0 THEN 0
      WHEN v_remainder >= 900 THEN ceil(v_revenue_after_discount / 1000) * 1000
      ELSE floor(v_revenue_after_discount / 1000) * 1000
    END;
    v_total_amount := v_deposit_invoice_total + v_rounded_revenue;

    v_billing_month := public.compute_first_billing_month_v2(v_start_billing, v_end_billing);
    v_due_date := COALESCE(NULLIF(v_first_invoice->>'due_date', '')::date, v_end_billing);
    v_issue_date := COALESCE(NULLIF(v_first_invoice->>'issue_date', '')::date, v_signed_date);
    IF v_due_date < v_start_billing OR v_due_date > v_end_billing THEN
      RAISE EXCEPTION 'Hạn trả hóa đơn đầu phải nằm trong kỳ tính tiền đầu'
        USING ERRCODE = '22023';
    END IF;
    IF v_issue_date < v_signed_date OR v_issue_date > v_due_date THEN
      RAISE EXCEPTION 'Ngày phát hành hóa đơn đầu phải từ ngày ký đến hạn trả'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.invoices (
      user_id, organization_id, contract_id, building_id, room_id,
      invoice_number, billing_month, issue_date, due_date, status,
      subtotal, discount_amount, discount_notes, total_amount,
      prepaid_amount, paid_amount, previous_debt, notes, template_id,
      approved_at, approved_by, kind,invoice_support_amount,manual_discount_amount,credit_discount_amount,rent_support_plan_revision,rent_support_request_id
    ) VALUES (
      v_owner, v_org, v_contract_id, v_building_id, v_room_id,
      NULL, v_billing_month, v_issue_date, v_due_date, 'APPROVED',
      v_subtotal, v_discount, NULLIF(v_first_invoice->>'discount_notes', ''),
      v_total_amount, 0, 0, 0, NULLIF(v_first_invoice->>'notes', ''),
      v_invoice_template_id,
      clock_timestamp(), v_actor, 'MONTHLY',coalesce((v_support->>'invoice_support')::numeric,0),(v_support_context->>'manual_discount_amount')::numeric,CASE WHEN v_support IS NOT NULL THEN 0 END,(v_support->>'plan_revision')::bigint,(v_support_context->>'request_id')::uuid
    ) RETURNING id INTO v_invoice_id;
  -- RENT_SUPPORT_ITEM_CAPABILITY_V1
  PERFORM app_private.invoice_rent_support_items_open_v1(v_invoice_id);

    v_idx := 0;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_first_invoice->'items') LOOP
      v_unit := (v_item->>'unit_price')::numeric;
      v_qty := (v_item->>'quantity')::numeric;
      v_class := COALESCE(NULLIF(v_item->>'accounting_class', ''), 'REVENUE');
      INSERT INTO public.invoice_items (
        organization_id, invoice_id, service_id, type, description,
        unit_price, quantity, coefficient, amount, previous_reading,
        current_reading, from_date, to_date, sort_order, accounting_class
      ) VALUES (
        v_org, v_invoice_id, NULLIF(v_item->>'service_id', '')::uuid,
        COALESCE(NULLIF(v_item->>'type', ''), 'OTHER')::public.invoice_item_type,
        COALESCE(NULLIF(v_item->>'description', ''), 'Hạng mục'),
        v_unit, v_qty, 1, round(v_unit * v_qty, 2), NULL, NULL,
        CASE WHEN v_class = 'REVENUE'
          THEN COALESCE(NULLIF(v_item->>'from_date', '')::date, v_start_billing)
          ELSE NULLIF(v_item->>'from_date', '')::date
        END,
        CASE WHEN v_class = 'REVENUE'
          THEN COALESCE(NULLIF(v_item->>'to_date', '')::date, v_end_billing)
          ELSE NULLIF(v_item->>'to_date', '')::date
        END,
        v_idx,
        v_class
      );
      v_idx := v_idx + 1;
    END LOOP;

    IF v_support IS NOT NULL THEN PERFORM app_private.resolve_invoice_rent_support_v1(v_org,v_contract_id,v_invoice_id,v_billing_month,jsonb_build_array(jsonb_build_object('billing_month',v_billing_month)),v_support_revision,(v_support_context->>'request_id')::uuid);END IF;
  PERFORM app_private.invoice_rent_support_items_close_v1(v_invoice_id);
    SELECT to_jsonb(invoice_row) INTO v_invoice_row
    FROM public.invoices invoice_row WHERE invoice_row.id = v_invoice_id;
  END IF;

  PERFORM app_private.claim_feature_operation_v1(
    'contract.create.v2',
    v_org,
    v_room_id::text || '|' || v_start_date::text,
    v_actor,
    v_key,
    round(v_new_deposit_receipts + COALESCE(v_total_amount, 0), 2)
  );

  UPDATE public.room_reservation_holds
     SET status = 'APPROVED', contract_id = v_contract_id
   WHERE room_id = v_room_id
     AND held_by = v_actor
     AND status = 'PENDING_APPROVAL'
     AND expires_at > clock_timestamp();

  UPDATE public.rooms SET status = 'OCCUPIED' WHERE id = v_room_id;

  SELECT to_jsonb(contract_row) INTO v_contract_row
  FROM public.contracts contract_row WHERE contract_row.id = v_contract_id;

  PERFORM app_private.consume_room_next_claim_v1(v_org,NULLIF(p_payload->>'reservation_id','')::uuid,NULLIF(p_payload->>'reservation_revision','')::bigint,v_contract_id);
  v_response := jsonb_build_object(
    'contract', v_contract_row,
    'invoice', v_invoice_row,
    'deposit_paid', v_deposit_paid,
    'deposit_shortfall', v_deposit_shortfall
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.create.v2'
     AND subject_scope = v_room_id::text || '|' || v_start_date::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  RETURN v_response;
END;
$function$;

-- public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) md5 048ce2e383f642b10e375166b6a3416e
CREATE OR REPLACE FUNCTION public.sign_and_checkin_contract_draft_v1(p_organization_id uuid, p_draft_id uuid, p_expected_revision integer, p_document_id uuid, p_document_sha256 text, p_request_id uuid, p_received_on date, p_room_ready boolean, p_terms_confirmed boolean, p_boundary jsonb, p_creation_options jsonb, p_reservation_id uuid DEFAULT NULL::uuid, p_reservation_revision bigint DEFAULT NULL::bigint, p_source_voucher_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE d public.contract_drafts%ROWTYPE; a public.contract_draft_documents%ROWTYPE; s public.contract_draft_signings%ROWTYPE;
  r public.rooms%ROWTYPE; c public.contracts%ROWTYPE; v_room_id uuid; v_building_id uuid; v_allowed boolean;
  v_hash text; v_terms jsonb; f jsonb; v_party jsonb; v_payload jsonb; v_result jsonb; v_id uuid:=gen_random_uuid(); v_count integer; v_rep_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 OR p_document_id IS NULL
    OR p_document_sha256 IS NULL OR p_document_sha256 !~ '^[a-f0-9]{64}$'
    OR p_received_on IS NULL OR NOT isfinite(p_received_on) OR p_room_ready IS DISTINCT FROM true OR p_terms_confirmed IS DISTINCT FROM true
    OR jsonb_typeof(p_boundary) IS DISTINCT FROM 'object' OR p_boundary->>'state' IS DISTINCT FROM 'VERIFIED'
    OR jsonb_typeof(p_creation_options) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Cần xác nhận ngày nhận, phòng sẵn sàng, điều khoản và đủ mốc chỉ số' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_creation_options) k WHERE k NOT IN
    ('deposit_debt_mode','deposit_debt_reason','deposit_topup_due_date','first_invoice','deposit_receipts','existing_deposit_voucher_ids','invoice_template_id')) THEN
    RAISE EXCEPTION 'Lựa chọn tạo hợp đồng không hợp lệ; nhánh này không chuyển giữ chỗ hoặc thu cọc' USING ERRCODE='22023';
  END IF;
  IF (p_creation_options ? 'deposit_receipts' AND jsonb_typeof(p_creation_options->'deposit_receipts') IS DISTINCT FROM 'array')
    OR (p_creation_options ? 'existing_deposit_voucher_ids' AND jsonb_typeof(p_creation_options->'existing_deposit_voucher_ids') IS DISTINCT FROM 'array')
    OR (p_creation_options ? 'invoice_template_id' AND jsonb_typeof(p_creation_options->'invoice_template_id') NOT IN ('string','null'))
    OR (p_creation_options->>'invoice_template_id' IS NOT NULL AND p_creation_options->>'invoice_template_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_creation_options->'deposit_receipts')='array' THEN p_creation_options->'deposit_receipts' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_creation_options->'existing_deposit_voucher_ids')='array' THEN p_creation_options->'existing_deposit_voucher_ids' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Lựa chọn nguồn cọc hoặc mẫu hoá đơn không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF (p_reservation_id IS NULL AND (p_reservation_revision IS NOT NULL OR cardinality(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]))>0))
    OR (p_reservation_id IS NOT NULL AND (p_reservation_revision IS NULL OR p_reservation_revision<1 OR p_source_voucher_ids IS NULL))
    OR array_position(p_source_voucher_ids,NULL) IS NOT NULL
    OR cardinality(p_source_voucher_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_source_voucher_ids) x) THEN
    RAISE EXCEPTION 'Nguồn giữ chỗ cần đúng ID, phiên bản và danh sách chứng từ không trùng' USING ERRCODE='22023';
  END IF;
  SELECT room_id,building_id INTO v_room_id,v_building_id FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id;
  IF NOT FOUND OR v_room_id IS NULL OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building_id,'contracts.create') THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng từ bản nháp' USING ERRCODE='42501';
  END IF;
  -- Existing create_v2 locks room then organization. Keep that order for sign versus direct-create.
  SELECT * INTO r FROM public.rooms WHERE id=v_room_id AND organization_id=p_organization_id AND building_id=v_building_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phòng không còn thuộc phạm vi bản nháp' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.create',v_building_id,NULL);
  IF NOT COALESCE(v_allowed,false) OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building_id,'contracts.create') THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng' USING ERRCODE='42501';
  END IF;
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id FOR UPDATE;
  IF d.room_id IS DISTINCT FROM v_room_id OR d.building_id<>v_building_id OR d.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'Bản nháp đã đổi phiên bản hoặc phòng; tải lại trước khi ký' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO a FROM public.contract_draft_documents WHERE id=p_document_id AND draft_id=d.id AND revision BETWEEN COALESCE(d.customer_revision,d.revision) AND d.revision
    AND organization_id=p_organization_id AND building_id=d.building_id AND document_sha256=p_document_sha256;
  IF NOT FOUND OR a.template_snapshot->>'id' IS DISTINCT FROM d.template_id::text THEN
    RAISE EXCEPTION 'Tài liệu đã xuất không khớp phiên bản nháp' USING ERRCODE='PT409';
  END IF;
  v_hash:=md5(jsonb_build_object('org',p_organization_id,'draft',p_draft_id,'revision',p_expected_revision,'document',p_document_id,
    'document_sha256',p_document_sha256,'received_on',p_received_on,'boundary',p_boundary,'options',p_creation_options,
    'reservation_id',p_reservation_id,'reservation_revision',p_reservation_revision,'source_voucher_ids',COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]))::text);
  SELECT * INTO s FROM public.contract_draft_signings WHERE request_id=p_request_id;
  IF FOUND AND s.draft_id<>d.id THEN RAISE EXCEPTION 'Định danh ký đã dùng cho nháp khác' USING ERRCODE='23505'; END IF;
  SELECT * INTO s FROM public.contract_draft_signings WHERE draft_id=d.id;
  IF FOUND THEN
    IF s.draft_id<>d.id OR s.intent_hash<>v_hash THEN RAISE EXCEPTION 'Định danh ký hoặc bản nháp đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
    RETURN to_jsonb(s)-'intent_hash';
  END IF;
  IF d.status<>'EDITABLE' THEN RAISE EXCEPTION 'Bản nháp không còn có thể ký' USING ERRCODE='55000'; END IF;
  SELECT payload INTO v_terms FROM public.contract_draft_versions WHERE draft_id=d.id AND revision=d.revision;
  IF v_terms IS DISTINCT FROM d.payload THEN RAISE EXCEPTION 'Nội dung nháp không khớp phiên bản đã lưu' USING ERRCODE='PT409'; END IF;
  f:=v_terms->'form';
  IF f->>'room_id' IS DISTINCT FROM r.id::text OR p_received_on IS DISTINCT FROM (f->>'start_date')::date
    OR p_received_on>public.org_today_v1(p_organization_id) OR (f->>'signed_date')::date>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Ngày nhận phải là ngày bắt đầu đã xuất, không được ở tương lai; sửa và xuất lại nháp nếu đổi ngày' USING ERRCODE='22023';
  END IF;
  IF r.status::text<>'AVAILABLE' AND NOT (r.status::text='RESERVED' AND p_reservation_id IS NOT NULL) THEN RAISE EXCEPTION 'Phòng chưa sẵn sàng nhận khách mới' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts old WHERE old.organization_id=p_organization_id AND old.room_id=r.id AND old.deleted_at IS NULL
    AND old.status::text IN ('ACTIVE','EXTENDED') AND old.actual_end_date IS NULL) THEN
    RAISE EXCEPTION 'Phòng vẫn có lượt ở chưa trả' USING ERRCODE='55000';
  END IF;
  IF (p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id)) OR EXISTS (SELECT 1 FROM public.room_reservation_holds h WHERE h.room_id=r.id
    AND h.status='PENDING_APPROVAL' AND h.expires_at>clock_timestamp() AND (p_reservation_id IS NULL OR h.held_by<>auth.uid())) THEN
    RAISE EXCEPTION 'Phòng có cọc hoặc giữ chỗ; chưa hỗ trợ chuyển nguồn này từ nháp' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public.room_turnovers t WHERE t.organization_id=p_organization_id AND t.room_id=r.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.room_turnovers t WHERE t.organization_id=p_organization_id AND t.room_id=r.id AND t.status<>'READY') THEN
    RAISE EXCEPTION 'Phòng đang chuẩn bị; xác nhận sẵn sàng trước khi nhận khách' USING ERRCODE='55000';
  END IF;
  SELECT count(*),count(*) FILTER (WHERE (j->>'is_representative')::boolean) INTO v_count,v_rep_count FROM jsonb_array_elements(v_terms->'customers') j;
  IF v_count=0 OR v_rep_count<>1 OR v_count<>(SELECT count(DISTINCT j->>'id') FROM jsonb_array_elements(v_terms->'customers') j) THEN
    RAISE EXCEPTION 'Danh sách khách chưa đủ điều kiện ký' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.customers p WHERE p.id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j) ORDER BY p.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'customers') j LEFT JOIN public.customers p ON p.id=(j->>'id')::uuid
    WHERE p.id IS NULL OR p.organization_id<>p_organization_id OR p.deleted_at IS NOT NULL
      OR p.full_name IS DISTINCT FROM j->>'full_name' OR COALESCE(p.phone,'') IS DISTINCT FROM j->>'phone'
      OR p.id_number IS DISTINCT FROM j->>'id_number') THEN
    RAISE EXCEPTION 'Thông tin khách đã thay đổi; lưu và xuất lại đúng bản được ký' USING ERRCODE='PT409';
  END IF;
  -- No-claim remains usable before P9 exists; conversion never pretends support when its assertion/consumer is absent.
  IF p_reservation_id IS NOT NULL AND (to_regprocedure('app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])') IS NULL
    OR to_regprocedure('app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid)') IS NULL) THEN
    RAISE EXCEPTION 'Chưa hỗ trợ chuyển nguồn giữ chỗ đã chọn' USING ERRCODE='55000';
  END IF;
  IF to_regprocedure('app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])') IS NOT NULL THEN
    PERFORM app_private.assert_room_next_claim_for_signing_v1(p_organization_id,r.id,p_reservation_id,p_reservation_revision,
      ARRAY(SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j),COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]));
  END IF;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO v_party FROM public.customers p WHERE p.id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j);
  -- The handover is separate from printed terms. Current create_v2 stores one
  -- incoming scalar per service, so use B's actual verified room measurements.
  PERFORM 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
    AND m.status='ACTIVE' AND m.deleted_at IS NULL ORDER BY m.id FOR SHARE;
  PERFORM app_private.validate_meter_boundary_payload_v1(p_organization_id,r.id,d.building_id,p_boundary);
  IF COALESCE((v_terms->>'use_custom_services')::boolean,false) AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'services') j
    WHERE (j->>'type'='METER_READING' OR j->>'pricing_type'='METER') AND NOT EXISTS (
      SELECT 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
        AND m.service_id=(j->>'id')::uuid AND m.status='ACTIVE' AND m.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Dịch vụ đo chỉ số chưa có đồng hồ đang hoạt động gắn đúng phòng và dịch vụ' USING ERRCODE='22023';
  END IF;
  IF COALESCE((v_terms->>'use_custom_services')::boolean,false) AND EXISTS (SELECT m.service_id FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
    WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
      AND m.service_id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'services') j)
    GROUP BY m.service_id HAVING count(DISTINCT (b->>'reading')::numeric)>1) THEN
    RAISE EXCEPTION 'Nhiều đồng hồ của cùng dịch vụ có số đầu khác nhau; chưa thể ánh xạ vào dịch vụ hiện hành' USING ERRCODE='22023';
  END IF;
  -- RENT_SUPPORT_SIGN_V2
  IF v_terms ? 'rent_support' THEN
    -- RENT_SUPPORT_PRIVATE_SIGN_V1: hydrate only the canonical write input, not the public signing snapshot.
    PERFORM app_private.validate_rent_support_v1(app_private.rent_support_draft_payload_v1(p_organization_id,d.id,d.revision,v_terms,true)->'rent_support',(f->>'start_date')::date,(f->>'end_date')::date);
    IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
  END IF;
  v_payload:=jsonb_build_object('contract',jsonb_build_object('room_id',r.id,'signed_date',f->>'signed_date','start_date',f->>'start_date',
    'end_date',f->>'end_date','rent_price',f->'rent_price','total_deposit',f->'total_deposit','payment_cycle',f->>'payment_cycle',
    'start_billing_date',NULLIF(f->>'start_billing_date',''),'end_billing_date',NULLIF(f->>'end_billing_date',''),'notes',f->>'notes',
    'contract_template_id',d.template_id,'discounts',jsonb_build_object('months',f->'discount_months','amount_per_month',f->'discount_amount_per_month'))
    || CASE WHEN v_terms ? 'rent_support' THEN jsonb_build_object('rent_support',app_private.rent_support_draft_payload_v1(p_organization_id,d.id,d.revision,v_terms,true)->'rent_support','discounts',jsonb_build_object('version',2,'kind','RENT_SUPPORT_SCHEDULE')) ELSE '{}'::jsonb END
    ||(p_creation_options-'first_invoice'-'deposit_receipts'-'existing_deposit_voucher_ids'),
    'customers',(SELECT jsonb_agg(jsonb_build_object('customer_id',j->>'id','is_representative',j->'is_representative','notes',j->'notes')) FROM jsonb_array_elements(v_terms->'customers') j),
    'services',CASE WHEN COALESCE((v_terms->>'use_custom_services')::boolean,false) THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('service_id',j->>'id','unit_price',j->'unit_price','initial_reading',
      COALESCE((SELECT to_jsonb(min((b->>'reading')::numeric)) FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
        WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.service_id=(j->>'id')::uuid
          AND m.status='ACTIVE' AND m.deleted_at IS NULL),j->'initial_reading'))) FROM jsonb_array_elements(v_terms->'services') j),'[]'::jsonb) ELSE '[]'::jsonb END,
    'deposit_receipts',COALESCE(p_creation_options->'deposit_receipts','[]'::jsonb),
    'existing_deposit_voucher_ids',to_jsonb(ARRAY(
      SELECT DISTINCT voucher_id FROM (
        SELECT unnest(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[])) AS voucher_id
        UNION ALL
        SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'::jsonb))
      ) sources ORDER BY voucher_id)));
  IF p_reservation_id IS NOT NULL THEN v_payload:=v_payload||jsonb_build_object('reservation_id',p_reservation_id,'reservation_revision',p_reservation_revision); END IF;
  IF p_creation_options ? 'first_invoice' THEN v_payload:=v_payload||jsonb_build_object('first_invoice',p_creation_options->'first_invoice'); END IF;
  PERFORM app_private.assert_contract_transfer_draft_v1(d.id);
  v_result:=public.create_contract_v2(v_payload,'draft-sign:'||d.id::text);
  IF COALESCE((v_result->>'deposit_shortfall')::numeric,0)>=0.01 AND NULLIF(p_creation_options->>'deposit_debt_mode','') IS NULL THEN
    RAISE EXCEPTION 'Cọc còn thiếu cần chọn cách bổ sung hiện hành' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.contracts WHERE id=(v_result->'contract'->>'id')::uuid;
  IF NOT FOUND OR c.organization_id<>p_organization_id OR c.room_id<>r.id OR c.status::text<>'ACTIVE' OR c.actual_end_date IS NOT NULL
    OR NULLIF(btrim(c.contract_number),'') IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms current_room WHERE current_room.id=r.id AND current_room.status::text='OCCUPIED') THEN
    RAISE EXCEPTION 'Core chưa tạo hợp đồng nhận phòng hợp lệ' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts old WHERE old.organization_id=p_organization_id AND old.contract_number=c.contract_number AND old.id<>c.id) THEN
    RAISE EXCEPTION 'Số hợp đồng mới bị trùng; không ghi nhận ký' USING ERRCODE='23505';
  END IF;
  PERFORM app_private.record_contract_meter_boundary_set_v1(p_organization_id,c.id,r.id,'MOVE_IN',p_received_on,p_boundary,'contracts.create');
  PERFORM app_private.assert_contract_move_in_boundaries_v1(p_organization_id,c.id,'contracts.create');
  IF p_reservation_id IS NOT NULL THEN PERFORM app_private.consume_room_next_claim_v1(p_organization_id,p_reservation_id,p_reservation_revision,c.id); END IF;
  INSERT INTO public.contract_draft_signings(id,organization_id,building_id,room_id,draft_id,revision,document_id,document_sha256,template_sha256,
    template_path,template_snapshot,document_data,terms,party_snapshot,creation_options,reservation_id,reservation_revision,source_voucher_ids,received_on,contract_id,contract_number,request_id,intent_hash,signed_by,official_document_path)
  VALUES(v_id,p_organization_id,d.building_id,r.id,d.id,d.revision,a.id,a.document_sha256,a.template_sha256,a.template_path,a.template_snapshot,
    (a.document_data-'DRAFT_TITLE'-'DRAFT_REVISION')||jsonb_build_object('CONTRACT_NUMBER',c.contract_number),v_terms,v_party,p_creation_options,p_reservation_id,p_reservation_revision,COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]),
    p_received_on,c.id,c.contract_number,p_request_id,v_hash,auth.uid(),p_organization_id::text||'/'||d.building_id::text||'/'||v_id::text||'/document.docx') RETURNING * INTO s;
  UPDATE public.contract_drafts SET status='SIGNED',converted_contract_id=c.id WHERE id=d.id;
  PERFORM app_private.complete_contract_transfer_signing_v1(d.id,c.id);
  RETURN to_jsonb(s)-'intent_hash';
END $function$;

-- public.meter_capture_exit_v1(uuid,text,jsonb,jsonb) md5 3de2baa15f7c204c6f1ac3da08c909a7
CREATE OR REPLACE FUNCTION public.meter_capture_exit_v1(p_organization_id uuid, p_rpc_name text, p_arguments jsonb, p_sources jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_contract uuid;v_building uuid;v_date date;v_key text:='exit:'||(p_arguments->>'p_idempotency_key');v_hash text;
 v_old app_private.meter_capture_document_requests%ROWTYPE;v_args jsonb:=p_arguments;v_result jsonb;v_extra jsonb;s jsonb;it jsonb;v_settlement jsonb;v_invoice uuid;
BEGIN
 IF p_rpc_name NOT IN ('confirm_contract_return_v1','finalize_contract_exit_case_v1','finalize_contract_transfer_exit_v1') OR (p_arguments->>'p_organization_id')::uuid IS DISTINCT FROM p_organization_id THEN RAISE EXCEPTION 'Wrong exit writer/organization' USING ERRCODE='42501'; END IF;
 IF p_rpc_name='confirm_contract_return_v1' THEN
  v_contract:=(p_arguments->>'p_contract_id')::uuid;v_date:=(p_arguments->>'p_actual_move_out_on')::date;
  IF p_arguments->>'p_settlement_mode' IS DISTINCT FROM 'IMMEDIATE' THEN RAISE EXCEPTION 'Evidence settlement requires immediate mode' USING ERRCODE='22023'; END IF;
 ELSE SELECT contract_id,actual_move_out_on INTO v_contract,v_date FROM public.contract_exit_cases WHERE id=(p_arguments->>'p_case_id')::uuid AND organization_id=p_organization_id; END IF;
 SELECT r.building_id INTO v_building FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id WHERE c.id=v_contract AND c.organization_id=p_organization_id AND c.deleted_at IS NULL;
 PERFORM app_private.meter_capture_scope_v1(p_organization_id,v_building,'contracts.edit');
 IF v_key IS NULL THEN RAISE EXCEPTION 'Document key required' USING ERRCODE='22023'; END IF;
 v_hash:=md5(jsonb_build_object('rpc',p_rpc_name,'args',p_arguments,'sources',p_sources)::text);
 INSERT INTO app_private.meter_capture_document_requests(organization_id,actor_id,request_key,payload_hash) VALUES(p_organization_id,auth.uid(),v_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO v_old FROM app_private.meter_capture_document_requests WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=v_key FOR UPDATE;
 IF v_old.payload_hash<>v_hash THEN RAISE EXCEPTION 'Exit key reused with different meter evidence' USING ERRCODE='23505'; END IF;
 IF v_old.result IS NOT NULL THEN RETURN v_old.result; END IF;
 PERFORM app_private.meter_capture_validate_sources_v1(p_organization_id,v_contract,p_sources,'MOVE_OUT');
 IF (SELECT count(*) FROM jsonb_array_elements(p_arguments#>'{p_settlement,extra_charges}') x WHERE x ? 'meter_source')<>jsonb_array_length(p_sources) THEN RAISE EXCEPTION 'Every exit source must identify one charge line' USING ERRCODE='22023'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
  IF (s->>'readingDate')::date IS DISTINCT FROM v_date THEN RAISE EXCEPTION 'Exit meter must match actual move-out date' USING ERRCODE='22023'; END IF;
  SELECT x INTO it FROM jsonb_array_elements(p_arguments#>'{p_settlement,extra_charges}') x WHERE x->'meter_source'=s;
  IF it IS NULL OR it->>'kind' IS DISTINCT FROM 'ELECTRIC' OR (it->>'previous_reading')::numeric IS DISTINCT FROM (s->>'previousReading')::numeric
   OR (it->>'current_reading')::numeric IS DISTINCT FROM (s->>'currentReading')::numeric THEN RAISE EXCEPTION 'Exit line must use selected meter evidence' USING ERRCODE='22023'; END IF;
  IF it->>'unit_price' IS NULL OR it->>'amount' IS NULL OR it->>'unit_price' IN ('NaN','Infinity','-Infinity') OR it->>'amount' IN ('NaN','Infinity','-Infinity')
   OR (it->>'unit_price')::numeric<0 OR (it->>'amount')::numeric<0 OR (it->>'amount')::numeric<>round(((s->>'currentReading')::numeric-(s->>'previousReading')::numeric)*(it->>'unit_price')::numeric) THEN
   RAISE EXCEPTION 'Exit electric amount must equal confirmed consumption times rate' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Existing termination helper creates readings when meter_id is present. Omit it only
 -- for a validated capture source: the confirmed TLY reading is already retained, even at zero kWh.
 SELECT COALESCE(jsonb_agg(CASE WHEN x ? 'meter_source' THEN x-'meter_source'-'meter_id' ELSE x END ORDER BY n),'[]') INTO v_extra
  FROM jsonb_array_elements(p_arguments#>'{p_settlement,extra_charges}') WITH ORDINALITY q(x,n);
 v_args:=jsonb_set(v_args,'{p_settlement,extra_charges}',v_extra);
 v_result:=app_private.meter_capture_invoke_writer_v1(p_rpc_name,v_args);
 IF NOT EXISTS(SELECT 1 FROM public.contract_exit_cases WHERE id=(v_result->>'id')::uuid AND organization_id=p_organization_id AND contract_id=v_contract AND state='FINALIZED') THEN RAISE EXCEPTION 'Exit writer did not finalize expected case' USING ERRCODE='55000'; END IF;
 PERFORM app_private.meter_capture_attach_v1(p_organization_id,'EXIT',(v_result->>'id')::uuid,v_contract,p_sources);
 SELECT settlement_result INTO v_settlement FROM public.contract_exit_cases WHERE id=(v_result->>'id')::uuid AND organization_id=p_organization_id;
 v_settlement:=COALESCE(v_settlement->'termination',v_settlement);
 FOR v_invoice IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(CASE WHEN v_settlement ? 'extra_invoice_id' THEN v_settlement->>'extra_invoice_id' ELSE v_settlement->>'settlement_invoice_id' END)) WHERE value IS NOT NULL LOOP
  IF NOT EXISTS(SELECT 1 FROM public.invoices WHERE id=v_invoice AND organization_id=p_organization_id AND contract_id=v_contract AND building_id=v_building) THEN RAISE EXCEPTION 'Settlement invoice scope mismatch' USING ERRCODE='55000'; END IF;
  PERFORM app_private.meter_capture_attach_v1(p_organization_id,'INVOICE',v_invoice,v_contract,app_private.meter_capture_map_exit_invoice_v1(p_organization_id,v_invoice,v_contract,p_arguments#>'{p_settlement,extra_charges}',p_sources));
 END LOOP;
 UPDATE app_private.meter_capture_document_requests SET result=v_result WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=v_key;
 RETURN v_result;
END $function$;

-- app_private.meter_capture_invoke_writer_v1(text,jsonb) md5 f77b040aff83c5e1078f22ff9a9d1623
CREATE OR REPLACE FUNCTION app_private.meter_capture_invoke_writer_v1(p_name text, p_args jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE f record; i integer; v_parts text[]; v_sql text; v_result jsonb; v_count integer:=0; v_candidate text;
BEGIN
 IF p_name NOT IN ('create_invoice_v1','create_invoice_with_credit_v1','confirm_contract_return_v1','finalize_contract_exit_case_v1','finalize_contract_transfer_exit_v1') OR jsonb_typeof(p_args) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Unsupported meter document writer' USING ERRCODE='22023'; END IF;
 FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=p_name AND p.prokind='f' LOOP
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_args) k WHERE NOT k=ANY(f.proargnames)) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM generate_series(1,f.pronargs-f.pronargdefaults) k WHERE NOT p_args ? f.proargnames[k]) THEN CONTINUE; END IF;
  v_parts:=ARRAY[]::text[];
  FOR i IN 1..f.pronargs LOOP
   IF p_args ? f.proargnames[i] THEN
    v_parts:=array_append(v_parts,format('%I => %s',f.proargnames[i],CASE WHEN f.proargtypes[i-1] IN ('json'::regtype,'jsonb'::regtype)
     THEN format('($1->%L)::%s',f.proargnames[i],format_type(f.proargtypes[i-1],NULL))
     ELSE format('($1->>%L)::%s',f.proargnames[i],format_type(f.proargtypes[i-1],NULL)) END));
   END IF;
  END LOOP;
  v_candidate:=format('SELECT to_jsonb(public.%I(%s))',p_name,array_to_string(v_parts,','));v_count:=v_count+1;
 END LOOP;
 IF v_count<>1 THEN RAISE EXCEPTION 'Meter document writer signature not found or ambiguous' USING ERRCODE='55000'; END IF;
 EXECUTE v_candidate INTO v_result USING p_args;RETURN v_result;
END $function$;

-- public.contract_deposit_paid_derived(uuid) md5 6087ba851827b4e769ab41c31b9d312b
CREATE OR REPLACE FUNCTION public.contract_deposit_paid_derived(p_contract_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT GREATEST(
           COALESCE(SUM(
             CASE WHEN voucher.type = 'EXPENSE' THEN -1 ELSE 1 END
             * COALESCE(item.amount, item.unit_price * item.quantity)
           ) FILTER (
             WHERE voucher.approval_status = 'APPROVED'
               AND voucher.deleted_at IS NULL
           ), 0),
           0
         )::numeric(15,2)
    FROM public.income_expenses voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
     AND item.accounting_class = 'DEPOSIT'
    LEFT JOIN public.contract_deposit_links link_row
      ON link_row.income_expense_id = voucher.id
     AND link_row.contract_id = p_contract_id
   WHERE p_contract_id IS NOT NULL
     AND (voucher.contract_id = p_contract_id OR link_row.id IS NOT NULL);
$function$;

-- public.recompute_contract_deposit_paid(uuid) md5 152a5d5ea57755478a6e7e79dac67628
CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(p_contract_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric(15,2) := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  -- [H2.2] ĐÃ BỎ early-return "không đếm được phiếu cọc nào thì thôi".
  -- Cái đếm đó biến hàm thành một chiều: thêm phiếu thì cột đi lên, gỡ phiếu
  -- CUỐI CÙNG thì cột đứng im ở số cũ. Số đứng im đó là tiền hoàn THẬT ở màn
  -- thanh lý. Hàm dẫn xuất đã GREATEST(...,0) nên trường hợp rỗng ra đúng 0 —
  -- không cần bảo vệ gì thêm.
  v_total := public.contract_deposit_paid_derived(p_contract_id);

  UPDATE public.contracts
     SET deposit_paid = v_total,
         updated_at = now()
   WHERE id = p_contract_id
     AND deleted_at IS NULL
     AND deposit_paid IS DISTINCT FROM v_total;
END;
$function$;

-- app_private.finance_v2_transition_owned_approval(uuid,text,text) md5 eef3599c99d67b34fb2cf09cacb6a025
CREATE OR REPLACE FUNCTION app_private.finance_v2_transition_owned_approval(p_voucher uuid, p_new_status text, p_posting_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_new_status NOT IN ('APPROVED','CANCELLED') THEN
    RAISE EXCEPTION 'finance_v2_transition_owned_approval: unsupported status %', p_new_status USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), p_new_status)
  ON CONFLICT DO NOTHING;

  UPDATE public.income_expenses ie
     SET approval_status = p_new_status,
         approved_at     = CASE WHEN p_new_status = 'APPROVED' THEN now() ELSE ie.approved_at END,
         review_state    = 'RESOLVED',
         posting_status  = COALESCE(p_posting_status, ie.posting_status),
         approval_version = ie.approval_version + 1,
         updated_at      = now()
   WHERE ie.id = p_voucher;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  DELETE FROM app_private.ie_transition_authorization t
   WHERE t.income_expense_id = p_voucher AND t.xid = pg_current_xact_id();

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'finance_v2_transition_owned_approval: expected 1 row, affected % for voucher %', v_rows, p_voucher
      USING ERRCODE = '55000';
  END IF;
END
$function$;
