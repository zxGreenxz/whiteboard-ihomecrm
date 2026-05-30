-- =============================================
-- Migration: Sửa các tham chiếu "mồ côi" còn sót sau khi DROP bảng beds.
--
-- Migration 20260528000007_drop_beds_fix_rpcs.sql (sinh tự động từ
-- .scratch/clean_rpc_beds.cjs) đã gỡ JOIN/cột beds nhưng để lại tham chiếu
-- dangling khiến 4 hàm THROW ở runtime/plan-time:
--
--   1. get_public_latest_invoice_by_contract  → còn `bd.id`/`bd.name` dù đã gỡ
--      `LEFT JOIN beds bd`  ⇒ "missing FROM-clause entry for table bd".
--      Đây là RPC public cho QR hợp đồng → khách quét QR thấy "Mã QR không
--      khả dụng" dù hợp đồng vẫn ACTIVE. (BUG được report)
--   2. generate_invoices_for_building          → `c.c.rent_price` (thừa `c.`)
--   3. generate_recurring_vouchers             → `parent.parent.tenant_id`
--   4. get_invoice_statistics                  → vẫn lọc `i.bed_id` (cột đã drop)
--
-- (3 hàm sau là legacy đã được thay bằng bản *_v2* mà frontend đang dùng —
--  bản v2 sạch, không đụng beds — nhưng v1 vẫn được GRANT nên gọi trực tiếp
--  sẽ crash; sửa luôn để dọn dứt điểm.)
--
-- Cách sửa: bảng beds đã bị drop ⇒ thông tin "giường" không còn tồn tại.
--  • get_public_*: trả `'bed', NULL` (frontend coi `bed` là optional).
--  • get_invoice_statistics: bỏ điều kiện lọc theo bed_id, GIỮ NGUYÊN signature
--    (param p_bed_id) để không phá vỡ overload-resolution của PostgREST.
-- =============================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1) get_public_latest_invoice_by_contract — RPC public QR hợp đồng (THE FIX)
-- ─────────────────────────────────────────────────────────────────────────
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
      'bed', NULL,
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
    'bed', NULL,
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

-- ─────────────────────────────────────────────────────────────────────────
-- 2) generate_invoices_for_building — fix `c.c.rent_price` → `c.rent_price`
-- ─────────────────────────────────────────────────────────────────────────
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
    SELECT c.id AS contract_id, c.user_id, c.room_id, c.rent_price, r.building_id
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

-- ─────────────────────────────────────────────────────────────────────────
-- 3) generate_recurring_vouchers — fix `parent.parent.tenant_id` → `parent.tenant_id`
-- ─────────────────────────────────────────────────────────────────────────
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
        parent.building_id, parent.room_id, parent.tenant_id,
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

-- ─────────────────────────────────────────────────────────────────────────
-- 4) get_invoice_statistics — bỏ lọc theo `i.bed_id` (cột đã drop), GIỮ signature
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_invoice_statistics(p_user_id uuid, p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_bed_id uuid DEFAULT NULL::uuid, p_area_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller            UUID := auth.uid();
  v_is_super          BOOLEAN := FALSE;
  v_owner             UUID;
  v_staff_buildings   UUID[];
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
BEGIN
  -- 1) Determine effective owner & staff building scope.
  IF v_caller IS NULL THEN
    v_owner := p_user_id;
    v_staff_buildings := NULL;
  ELSE
    SELECT EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = v_caller)
      INTO v_is_super;

    IF v_is_super THEN
      v_owner := COALESCE(p_user_id, v_caller);
      v_staff_buildings := NULL;
    ELSE
      SELECT sa.user_id INTO v_owner
      FROM staff_assignments sa
      WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
      LIMIT 1;

      IF v_owner IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM staff_assignments
          WHERE staff_id = v_caller AND user_id = v_owner AND building_id IS NULL
        ) THEN
          v_staff_buildings := NULL;
        ELSE
          SELECT array_agg(building_id) INTO v_staff_buildings
          FROM staff_assignments
          WHERE staff_id = v_caller AND user_id = v_owner AND building_id IS NOT NULL;
        END IF;
      ELSE
        v_owner := v_caller;
        v_staff_buildings := NULL;
      END IF;
    END IF;
  END IF;

  -- 2) Aggregates trên bảng invoices
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM invoices i
    LEFT JOIN buildings b ON b.id = i.building_id
    WHERE i.user_id = v_owner
      AND i.deleted_at IS NULL
      AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO
    v_total_amount,
    v_total_paid,
    v_total_remaining,
    v_total_refunded,
    v_total_count
  FROM filtered_invoices;

  -- 3) Breakdown Điện/Nước/PDV
  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO
    v_rent_amount,
    v_electric_amount,
    v_water_amount,
    v_pdv_amount
  FROM invoices i
  LEFT JOIN buildings b ON b.id = i.building_id
  JOIN invoice_items ii ON ii.invoice_id = i.id
  WHERE i.user_id = v_owner
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- 4) Tổng tiền thu + chia theo phương thức (payments của HĐ)
  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0)
  INTO
    v_total_collected,
    v_payment_tm,
    v_payment_tk,
    v_payment_tt
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  LEFT JOIN buildings b ON b.id = i.building_id
  WHERE i.user_id = v_owner
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- 5) Tiền Thối
  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM income_expenses ie
  JOIN invoices i ON i.id = ie.invoice_id
  LEFT JOIN buildings b ON b.id = i.building_id
  WHERE ie.user_id = v_owner
    AND ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- 6) Cọc đã thu — phiếu IE INCOME APPROVED có item is_deposit=true
  SELECT COALESCE(SUM(ie.total_amount), 0)
  INTO v_deposit_collected
  FROM income_expenses ie
  LEFT JOIN buildings b ON b.id = ie.building_id
  WHERE ie.user_id = v_owner
    AND ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND (v_staff_buildings IS NULL OR ie.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id        = p_area_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
    AND EXISTS (
      SELECT 1
      FROM income_expense_items it
      JOIN income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
    );

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$function$;
