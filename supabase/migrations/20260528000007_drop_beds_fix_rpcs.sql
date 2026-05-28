-- Fix 7 RPC functions còn ref bed_id / beds sau khi drop beds table
-- Tự động sinh từ .scratch/clean_rpc_beds.cjs

CREATE OR REPLACE FUNCTION public.apply_contract_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_contract RECORD;
BEGIN
  -- Only apply when status changes to APPROVED
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN

    -- Get current contract
    SELECT * INTO v_contract FROM contracts WHERE id = NEW.contract_id;

    -- ================================================
    -- Update contract with new values
    -- ================================================
    UPDATE contracts
    SET
      -- Tenant change
      tenant_id = COALESCE(NEW.new_tenant_id, tenant_id),

      -- Room change
      room_id = COALESCE(NEW.new_room_id, room_id),
      -- Pricing updates
      rent_price = COALESCE(NEW.new_rent_price, rent_price),
      total_deposit = COALESCE(NEW.new_deposit, total_deposit),

      -- Date updates
      start_date = COALESCE(NEW.new_start_date, start_date),
      end_date = COALESCE(NEW.new_end_date, end_date),

      -- Mark as transferred
      status = 'TRANSFERRED',
      parent_contract_id = id, -- Self-reference to track original contract

      updated_at = NOW()
    WHERE id = NEW.contract_id;

    -- ================================================
    -- Update old room/bed status to AVAILABLE
    -- ================================================
    IF NEW.transfer_type IN ('ROOM_CHANGE', 'BOTH_CHANGE') THEN
      -- Old room becomes available
      IF NEW.old_room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.old_room_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE room_id = NEW.old_room_id
              AND id != NEW.contract_id
              AND status = 'ACTIVE'
              AND deleted_at IS NULL
          );
      END IF;

      -- Old bed becomes available
      -- New room becomes occupied
      IF NEW.new_room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'OCCUPIED', updated_at = NOW()
        WHERE id = NEW.new_room_id;
      END IF;

      -- New bed becomes occupied
    END IF;

    -- ================================================
    -- Update services if specified
    -- ================================================
    IF NEW.new_services IS NOT NULL AND jsonb_array_length(NEW.new_services) > 0 THEN
      -- Delete old services
      DELETE FROM contract_services WHERE contract_id = NEW.contract_id;

      -- Insert new services
      INSERT INTO contract_services (contract_id, service_id, unit_price)
      SELECT
        NEW.contract_id,
        (service->>'service_id')::UUID,
        (service->>'unit_price')::DECIMAL(15,2)
      FROM jsonb_array_elements(NEW.new_services) AS service;
    END IF;

    -- ================================================
    -- Update tenant statuses
    -- ================================================
    IF NEW.transfer_type IN ('TENANT_CHANGE', 'BOTH_CHANGE') THEN
      -- Old tenant -> INACTIVE if no other active contracts
      UPDATE tenants
      SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = NEW.old_tenant_id
        AND NOT EXISTS (
          SELECT 1 FROM contracts
          WHERE tenant_id = NEW.old_tenant_id
            AND id != NEW.contract_id
            AND status = 'ACTIVE'
            AND deleted_at IS NULL
        );

      -- New tenant -> ACTIVE
      UPDATE tenants
      SET status = 'ACTIVE', updated_at = NOW()
      WHERE id = NEW.new_tenant_id;
    END IF;

    -- Record approval
    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_new_contract_extension(p_contract_id uuid, p_extension_months integer, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_old_contract RECORD;
  v_new_contract_id UUID;
  v_extension_id UUID;
  v_new_end_date DATE;
  v_new_start_date DATE;
BEGIN
  -- Get current contract
  SELECT * INTO v_old_contract
  FROM contracts
  WHERE id = p_contract_id
    AND status = 'ACTIVE'
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found or not active';
  END IF;

  -- Calculate new dates
  v_new_start_date := v_old_contract.end_date + INTERVAL '1 day';
  v_new_end_date := v_new_start_date + (p_extension_months || ' months')::INTERVAL;

  -- ================================================
  -- Create new contract (clone of old one)
  -- ================================================
  INSERT INTO contracts (
    user_id,
    tenant_id,
    room_id,    contract_number, -- Will be auto-generated by trigger
    status,
    signed_date,
    start_date,
    end_date,
    rent_price,
    payment_cycle,
    total_deposit,
    deposit_paid,
    parent_contract_id, -- Link to old contract
    notes
  ) VALUES (
    v_old_contract.user_id,
    v_old_contract.tenant_id,
    v_old_contract.room_id,
    
    NULL, -- Auto-generated
    'ACTIVE',
    CURRENT_DATE,
    v_new_start_date,
    v_new_end_date,
    COALESCE(p_new_rent_price, v_old_contract.rent_price),
    v_old_contract.payment_cycle,
    COALESCE(p_new_deposit, v_old_contract.total_deposit),
    COALESCE(p_new_deposit, v_old_contract.total_deposit), -- Assuming deposit carried over
    p_contract_id, -- Parent contract
    'Gia hạn từ HĐ: ' || COALESCE(v_old_contract.contract_number, p_contract_id::TEXT)
  )
  RETURNING id INTO v_new_contract_id;

  -- Copy services from old contract
  INSERT INTO contract_services (contract_id, service_id, unit_price)
  SELECT v_new_contract_id, service_id, unit_price
  FROM contract_services
  WHERE contract_id = p_contract_id;

  -- ================================================
  -- Mark old contract as EXTENDED
  -- ================================================
  UPDATE contracts
  SET status = 'EXTENDED', updated_at = NOW()
  WHERE id = p_contract_id;

  -- ================================================
  -- Create extension record
  -- ================================================
  INSERT INTO contract_extensions (
    user_id,
    contract_id,
    extension_type,
    old_end_date,
    extension_months,
    new_end_date,
    new_rent_price,
    rent_price_changed,
    new_deposit,
    deposit_changed,
    new_contract_id,
    notes,
    status
  ) VALUES (
    auth.uid(),
    p_contract_id,
    'CREATE_NEW',
    v_old_contract.end_date,
    p_extension_months,
    v_new_end_date,
    p_new_rent_price,
    (p_new_rent_price IS NOT NULL AND p_new_rent_price != v_old_contract.rent_price),
    p_new_deposit,
    (p_new_deposit IS NOT NULL AND p_new_deposit != v_old_contract.total_deposit),
    v_new_contract_id,
    p_notes,
    'COMPLETED' -- Auto-completed
  )
  RETURNING id INTO v_extension_id;

  RETURN v_new_contract_id; -- Return new contract ID
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_invoices_for_building(p_user_id uuid, p_building_id uuid, p_billing_month text, p_invoice_type text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_contract RECORD;
  v_service RECORD;
  v_invoice_id UUID;
  v_created_count INT := 0;
  v_skipped_contracts JSON[] := ARRAY[]::JSON[];
  v_subtotal DECIMAL(15, 2);
  v_item_amount DECIMAL(15, 2);
  v_sort_order INT;
BEGIN
  IF p_invoice_type NOT IN ('rent_only', 'service_only', 'both') THEN
    RAISE EXCEPTION 'Invalid invoice_type: %. Must be rent_only, service_only, or both', p_invoice_type;
  END IF;

  IF p_billing_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Invalid billing_month format: %. Must be YYYY-MM', p_billing_month;
  END IF;

  FOR v_contract IN
    SELECT c.id AS contract_id, c.user_id, c.room_id, c.c.rent_price, r.building_id
    FROM contracts c
    JOIN rooms r ON r.id = c.room_id
    WHERE c.user_id = p_user_id
      AND r.building_id = p_building_id
      AND c.status = 'ACTIVE'
      AND c.deleted_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM invoices
      WHERE contract_id = v_contract.contract_id
        AND billing_month = p_billing_month
        AND deleted_at IS NULL
    ) THEN
      v_skipped_contracts := array_append(
        v_skipped_contracts,
        json_build_object('contract_id', v_contract.contract_id, 'reason', 'Invoice already exists')
      );
      CONTINUE;
    END IF;

    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, approved_at, approved_by,
      subtotal, total_amount
    ) VALUES (
      p_user_id, v_contract.contract_id, v_contract.building_id,
      v_contract.room_id,
      p_billing_month, CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
      'APPROVED', NOW(), p_user_id,
      0, 0
    )
    RETURNING id INTO v_invoice_id;

    v_subtotal := 0;
    v_sort_order := 0;

    IF p_invoice_type IN ('rent_only', 'both') THEN
      v_item_amount := v_contract.rent_price;
      v_sort_order := v_sort_order + 1;

      INSERT INTO invoice_items (
        invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order
      ) VALUES (
        v_invoice_id, 'RENT', 'Tiền thuê phòng',
        v_contract.rent_price, 1, 1, v_item_amount, v_sort_order
      );

      v_subtotal := v_subtotal + v_item_amount;
    END IF;

    IF p_invoice_type IN ('service_only', 'both') THEN
      FOR v_service IN
        SELECT cs.service_id, cs.unit_price, s.name AS service_name, s.type AS service_type
        FROM contract_services cs
        JOIN services s ON s.id = cs.service_id
        WHERE cs.contract_id = v_contract.contract_id
      LOOP
        v_sort_order := v_sort_order + 1;
        v_item_amount := v_service.unit_price;

        INSERT INTO invoice_items (
          invoice_id, service_id, type, description,
          unit_price, quantity, coefficient, amount, sort_order
        ) VALUES (
          v_invoice_id, v_service.service_id, 'SERVICE', v_service.service_name,
          v_service.unit_price, 1, 1, v_item_amount, v_sort_order
        );

        v_subtotal := v_subtotal + v_item_amount;
      END LOOP;
    END IF;

    UPDATE invoices
    SET subtotal = v_subtotal, total_amount = v_subtotal
    WHERE id = v_invoice_id;

    v_created_count := v_created_count + 1;
  END LOOP;

  RETURN json_build_object(
    'created_count', v_created_count,
    'skipped_contracts', to_json(v_skipped_contracts)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(parent_id uuid, child_id uuid, voucher_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  parent RECORD;
  child_voucher_id UUID;
  next_date DATE;
  iteration INTEGER;
  step_interval INTERVAL;
BEGIN
  FOR parent IN
    SELECT *
    FROM income_expenses ie
    WHERE ie.repeat_cycle <> 'NONE'
      AND ie.deleted_at IS NULL
      AND ie.repeat_next_date IS NOT NULL
      AND ie.repeat_next_date <= CURRENT_DATE
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_remaining > 0)
  LOOP
    next_date := parent.repeat_next_date;
    iteration := 0;

    step_interval := CASE parent.repeat_cycle
      WHEN 'WEEK'    THEN INTERVAL '7 days'
      WHEN 'MONTH'   THEN INTERVAL '1 month'
      WHEN 'QUARTER' THEN INTERVAL '3 months'
      WHEN 'YEAR'    THEN INTERVAL '1 year'
      ELSE INTERVAL '0 days'
    END;

    WHILE next_date <= CURRENT_DATE
          AND (parent.repeat_infinity OR parent.repeat_remaining - iteration > 0)
          AND iteration < 24
    LOOP
      INSERT INTO income_expenses (
        user_id, type, name, building_id, room_id, tenant_id,
        contract_id, account_id, payer_name,
        approval_status, business_result_accounting,
        attachments, notes,
        receive_bank_name, receive_bank_account,
        creator_name,
        voucher_date,
        invoice_id,
        repeat_parent_id,
        repeat_cycle, repeat_infinity, repeat_count, repeat_remaining
      ) VALUES (
        parent.user_id, parent.type,
        parent.name || ' (tự động lập)',
        parent.building_id, parent.room_id, parent.parent.tenant_id,
        parent.contract_id, parent.account_id, parent.payer_name,
        'APPROVED', parent.business_result_accounting,
        parent.attachments, parent.notes,
        parent.receive_bank_name, parent.receive_bank_account,
        parent.creator_name,
        next_date,
        NULL,
        parent.id,
        'NONE', false, 0, 0
      ) RETURNING id INTO child_voucher_id;

      INSERT INTO income_expense_items (
        income_expense_id, income_expense_type_id,
        description, quantity, unit_price,
        start_date, end_date
      )
      SELECT
        child_voucher_id, ii.income_expense_type_id,
        ii.description, ii.quantity, ii.unit_price,
        next_date, next_date
      FROM income_expense_items ii
      WHERE ii.income_expense_id = parent.id;

      RETURN QUERY SELECT parent.id, child_voucher_id, next_date;

      iteration := iteration + 1;
      next_date := (next_date + step_interval)::DATE;
    END LOOP;

    UPDATE income_expenses
    SET repeat_next_date = next_date,
        repeat_remaining = CASE
          WHEN parent.repeat_infinity THEN parent.repeat_remaining
          ELSE GREATEST(0, parent.repeat_remaining - iteration)
        END
    WHERE id = parent.id;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_contract(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_invoice_id uuid;
  v_result jsonb;
BEGIN
  -- Hợp đồng phải tồn tại, chưa xoá, và chưa thanh lý.
  -- (building_id resolve qua room.building_id; contracts không có cột này.)
  SELECT id, status, room_id, deleted_at
  INTO v_contract
  FROM public.contracts
  WHERE id = p_contract_id;

  IF v_contract.id IS NULL
     OR v_contract.deleted_at IS NOT NULL
     OR v_contract.status = 'TERMINATED' THEN
    RETURN NULL;
  END IF;

  -- Hoá đơn mới nhất của hợp đồng (bỏ DRAFT/CANCELLED).
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE contract_id = p_contract_id
    AND deleted_at IS NULL
    AND status <> 'CANCELLED'
    AND status <> 'DRAFT'
  ORDER BY billing_month DESC, created_at DESC
  LIMIT 1;

  IF v_invoice_id IS NULL THEN
    -- Hợp đồng chưa có hoá đơn → vẫn trả metadata phòng/toà/khách để
    -- public page hiển thị "chưa có hoá đơn".
    SELECT jsonb_build_object(
      'invoice', NULL,
      'room', CASE WHEN r.id IS NOT NULL
        THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
        ELSE NULL END,
      'building', CASE WHEN b.id IS NOT NULL
        THEN jsonb_build_object('id', b.id, 'name', b.name)
        ELSE NULL END,
      'bed', CASE WHEN bd.id IS NOT NULL
        THEN jsonb_build_object('id', bd.id, 'name', bd.name)
        ELSE NULL END,
      'customer', CASE WHEN c.full_name IS NOT NULL
        THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
        ELSE NULL END
    )
    INTO v_result
    FROM public.contracts ct
    LEFT JOIN public.rooms r ON r.id = ct.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
    LEFT JOIN LATERAL (
      SELECT cust.full_name, cust.phone
      FROM public.contract_customers cc
      JOIN public.customers cust ON cust.id = cc.customer_id
      WHERE cc.contract_id = ct.id
      ORDER BY cc.is_representative DESC NULLS LAST
      LIMIT 1
    ) c ON TRUE
    WHERE ct.id = p_contract_id;

    RETURN v_result;
  END IF;

  SELECT jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', i.id,
      'invoice_number', i.invoice_number,
      'billing_month', i.billing_month,
      'issue_date', i.issue_date,
      'due_date', i.due_date,
      'status', i.status,
      'subtotal', i.subtotal,
      'discount_amount', i.discount_amount,
      'tax_amount', i.tax_amount,
      'total_amount', i.total_amount,
      'paid_amount', i.paid_amount,
      'remaining_amount', i.remaining_amount,
      'previous_debt', i.previous_debt,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', it.id,
          'type', it.type,
          'description', it.description,
          'unit_price', it.unit_price,
          'quantity', it.quantity,
          'coefficient', it.coefficient,
          'amount', it.amount,
          'previous_reading', it.previous_reading,
          'current_reading', it.current_reading,
          'from_date', it.from_date,
          'to_date', it.to_date
        ) ORDER BY it.sort_order NULLS LAST, it.created_at)
        FROM public.invoice_items it
        WHERE it.invoice_id = i.id
      ), '[]'::jsonb)
    ),
    'room', CASE WHEN r.id IS NOT NULL
      THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
      ELSE NULL END,
    'building', CASE WHEN b.id IS NOT NULL
      THEN jsonb_build_object('id', b.id, 'name', b.name)
      ELSE NULL END,
    'bed', CASE WHEN bd.id IS NOT NULL
      THEN jsonb_build_object('id', bd.id, 'name', bd.name)
      ELSE NULL END,
    'customer', CASE WHEN c.full_name IS NOT NULL
      THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
      ELSE NULL END
  )
  INTO v_result
  FROM public.invoices i
  LEFT JOIN public.rooms r ON r.id = i.room_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
  LEFT JOIN LATERAL (
    SELECT cust.full_name, cust.phone
    FROM public.contract_customers cc
    JOIN public.customers cust ON cust.id = cc.customer_id
    WHERE cc.contract_id = i.contract_id
    ORDER BY cc.is_representative DESC NULLS LAST
    LIMIT 1
  ) c ON TRUE
  WHERE i.id = v_invoice_id;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(p_contract_id uuid, p_forfeit_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_paid_exists    boolean;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;

  v_deposit := COALESCE(v_contract.total_deposit, 0);
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');

  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- ── Block khi có hoá đơn tháng đó đã thu tiền (một phần hoặc toàn bộ) ──
  SELECT EXISTS (
    SELECT 1 FROM invoices
     WHERE contract_id   = p_contract_id
       AND billing_month = v_billing
       AND deleted_at    IS NULL
       AND status        <> 'CANCELLED'
       AND COALESCE(paid_amount, 0) > 0
  ) INTO v_paid_exists;
  IF v_paid_exists THEN
    RAISE EXCEPTION
      'Đã có hoá đơn tháng % được thanh toán một phần/toàn bộ — hãy xử lý hoá đơn này trước khi thanh lý bỏ cọc.',
      v_billing;
  END IF;

  -- ── Huỷ tự động mọi hoá đơn unpaid của tháng đó ────────────────────────
  UPDATE invoices
     SET status     = 'CANCELLED',
         notes      = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at = NOW()
   WHERE contract_id   = p_contract_id
     AND billing_month = v_billing
     AND deleted_at    IS NULL
     AND status        <> 'CANCELLED'
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_cancelled_cnt = ROW_COUNT;

  -- ── Settlement invoice — penalty = forfeited deposit ──────────────────
  IF v_deposit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      v_billing, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt
                       || ' hoá đơn chưa thanh toán của tháng '
                       || v_billing || ')'
                  ELSE '' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc)',
      v_deposit, 1, 1, v_deposit, 1
    );
  END IF;

  -- ── Terminate the contract (room/bed freed by trigger) ────────────────
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                             ELSE notes || E'\n[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- ── Audit row ────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT', v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — chờ ghi nhận thanh toán để lập phiếu thu.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',       p_contract_id,
    'invoice_id',        v_invoice_id,
    'forfeit_amount',    v_deposit,
    'cancelled_invoices', v_cancelled_cnt
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract     RECORD;
  v_building_id  uuid;
  v_invoice_id   uuid;
  v_billing      text;
  v_deposit      numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty      numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess       numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt         numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_credit       numeric(15,2);
  v_total        numeric(15,2);
  v_sort         integer := 0;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  v_billing := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_credit  := v_deposit + v_excess;
  v_total   := v_penalty - v_credit;   -- > 0 khách trả thêm; < 0 chủ trả lại

  -- ── Settlement invoice with all line items ────────────────────────────
  IF v_penalty > 0 OR v_credit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      previous_debt, notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      v_billing, p_move_out_date, p_move_out_date,
      'APPROVED'::invoice_status, v_penalty, v_credit, v_total,
      v_debt,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY')
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_invoice_id;

    IF v_penalty > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_sort);
    END IF;

    IF v_deposit > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'DISCOUNT', 'Tiền cọc hoàn trả', v_deposit, 1, 1, v_deposit, v_sort);
    END IF;

    IF v_excess > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'DISCOUNT', 'Tiền phòng thừa', v_excess, 1, 1, v_excess, v_sort);
    END IF;
  END IF;

  -- ── Terminate the contract ────────────────────────────────────────────
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_move_out_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']'
                                    || COALESCE(E'\n' || p_notes, '')
                             ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']'
                                  || COALESCE(E'\n' || p_notes, '')
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- ── Audit row ────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, outstanding_debt,
      early_termination_fee, total_deposit,
      total_deductions, refund_amount,
      status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date,
      'NORMAL', v_debt,
      v_penalty, COALESCE(v_contract.total_deposit, 0),
      v_debt + v_penalty, v_credit,
      'COMPLETED', auth.uid(), NOW(),
      COALESCE(p_notes,'') || ' — chờ ghi nhận thanh toán.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id,
    'invoice_id',  v_invoice_id,
    'penalty',     v_penalty,
    'credit',      v_credit,
    'net_total',   v_total
  );
END;
$function$;
