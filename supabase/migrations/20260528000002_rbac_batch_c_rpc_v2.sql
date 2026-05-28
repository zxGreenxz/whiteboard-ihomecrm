-- =============================================
-- Batch C: RPC v2 không nhận p_user_id (RBAC-aware)
-- =============================================
-- Thay vì truyền owner_id, dùng auth.uid() trực tiếp và can_access_building.
-- Bản v1 (có p_user_id) GIỮ NGUYÊN — frontend chuyển sang v2 từng bước.
-- =============================================

-- ─── record_invoice_payment_v2 ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_invoice_payment_v2(
  p_invoice_id        uuid,
  p_amount            numeric,
  p_payment_method    payment_method,
  p_payment_date      date,
  p_notes             text DEFAULT NULL,
  p_receipt_image_url text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_invoice RECORD;
  v_payment_id uuid;
  v_new_paid_amount decimal(15,2);
  v_remaining decimal(15,2);
  v_excess decimal(15,2);
  v_new_status invoice_status;
  v_paid_date date;
  v_caller uuid := auth.uid();
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Lookup invoice + check RBAC qua can_access_building
  SELECT id, user_id, building_id, contract_id, total_amount, paid_amount, remaining_amount, status
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND deleted_at IS NULL
    AND public.can_do_on_building('invoices','edit', building_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found or access denied';
  END IF;

  -- Insert payment (trigger set_user_id_audit auto-fill user_id = auth.uid())
  INSERT INTO payments (invoice_id, amount, payment_method, payment_date, notes, receipt_image_url)
  VALUES (p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url)
  RETURNING id INTO v_payment_id;

  v_new_paid_amount := COALESCE(v_invoice.paid_amount, 0) + p_amount;
  v_remaining := v_invoice.total_amount - v_new_paid_amount;

  IF v_new_paid_amount >= v_invoice.total_amount THEN
    v_new_status := 'PAID';
    v_paid_date := p_payment_date;
    v_excess := v_new_paid_amount - v_invoice.total_amount;

    IF v_excess > 0 THEN
      INSERT INTO excess_amounts (contract_id, amount, description, source_invoice_id, source_payment_id)
      VALUES (
        v_invoice.contract_id, v_excess,
        'Tiền thừa từ hoá đơn ' || (SELECT invoice_number FROM invoices WHERE id = p_invoice_id),
        p_invoice_id, v_payment_id
      );
    END IF;
  ELSE
    v_new_status := 'PARTIAL_PAID';
    v_paid_date := NULL;
    v_excess := 0;
  END IF;

  UPDATE invoices
  SET paid_amount = v_new_paid_amount,
      status = v_new_status,
      paid_date = v_paid_date
  WHERE id = p_invoice_id;

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'new_paid_amount', v_new_paid_amount,
    'new_status', v_new_status,
    'excess_amount', v_excess
  );
END;
$function$;

COMMENT ON FUNCTION public.record_invoice_payment_v2(uuid, numeric, payment_method, date, text, text) IS
  'RBAC version of record_invoice_payment. Caller phải có quyền edit invoices trên building tương ứng.';

-- ─── generate_invoices_for_building_v2 ──────────────────────────────────────
-- Tương tự bản cũ nhưng bỏ p_user_id, dùng can_do_on_building.
CREATE OR REPLACE FUNCTION public.generate_invoices_for_building_v2(
  p_building_id   uuid,
  p_billing_month text,
  p_invoice_type  text DEFAULT 'RENT'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF NOT public.can_do_on_building('invoices','create', p_building_id) THEN
    RAISE EXCEPTION 'Access denied for building %', p_building_id;
  END IF;

  -- Delegate to v1 — v1 dùng p_user_id để INSERT; trigger auto sẽ override user_id = auth.uid()
  -- nhưng v1 còn dùng p_user_id ở nhiều chỗ filter. Để an toàn không thay đổi logic v1,
  -- ta gọi v1 với p_user_id = building owner (lookup buildings.user_id).
  RETURN public.generate_invoices_for_building(
    (SELECT user_id FROM buildings WHERE id = p_building_id),
    p_building_id, p_billing_month, p_invoice_type
  );
END;
$function$;

COMMENT ON FUNCTION public.generate_invoices_for_building_v2(uuid, text, text) IS
  'RBAC wrapper: kiểm tra can_do_on_building rồi delegate v1 với owner_id thật của building.';

-- ─── generate_recurring_vouchers_v2 ─────────────────────────────────────────
-- v1 chạy với p_user_id; v2 chạy "for all visible buildings" by caller.
-- Vì các vouchers gắn building_id, ta chỉ generate cho buildings caller được phép.
CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers_v2()
RETURNS TABLE(parent_id uuid, child_id uuid, voucher_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owner_ids uuid[];
  v_owner uuid;
BEGIN
  -- Lấy danh sách owner mà caller có quyền (super_admin → all owners; staff → các owner mình thuộc)
  IF public.is_super_admin() THEN
    SELECT array_agg(DISTINCT user_id) INTO v_owner_ids FROM buildings WHERE deleted_at IS NULL;
  ELSE
    SELECT array_agg(DISTINCT sa.user_id) INTO v_owner_ids
    FROM staff_assignments sa WHERE sa.staff_id = auth.uid();
  END IF;

  IF v_owner_ids IS NULL OR array_length(v_owner_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_owner IN ARRAY v_owner_ids LOOP
    RETURN QUERY SELECT * FROM public.generate_recurring_vouchers(v_owner);
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.generate_recurring_vouchers_v2() IS
  'RBAC wrapper: gọi v1 cho từng owner caller có quyền (super_admin = all, staff = các owner mình thuộc).';

-- ─── get_meters_without_readings_v2 ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_meters_without_readings_v2(
  p_building_id uuid DEFAULT NULL,
  p_room_id     uuid DEFAULT NULL,
  p_meter_type  text DEFAULT NULL,
  p_month       text DEFAULT NULL
)
RETURNS TABLE(
  meter_id          uuid,
  code              text,
  name              text,
  room_name         text,
  meter_type        text,
  last_reading      numeric,
  last_reading_date date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owner uuid;
BEGIN
  -- Single-org: caller có quyền access building → lấy owner của building đó qua FK
  -- Cách simple nhất: delegate v1 với p_user_id của 1 owner mà caller thấy được
  IF p_building_id IS NOT NULL THEN
    IF NOT public.can_access_building(p_building_id) THEN
      RAISE EXCEPTION 'Access denied for building %', p_building_id;
    END IF;
    SELECT user_id INTO v_owner FROM buildings WHERE id = p_building_id;
  ELSE
    -- Pick first owner visible to caller
    IF public.is_super_admin() THEN
      SELECT user_id INTO v_owner FROM buildings WHERE deleted_at IS NULL LIMIT 1;
    ELSE
      SELECT DISTINCT sa.user_id INTO v_owner FROM staff_assignments sa
       WHERE sa.staff_id = auth.uid() LIMIT 1;
    END IF;
  END IF;

  IF v_owner IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT * FROM public.get_meters_without_readings(v_owner, p_building_id, p_room_id, p_meter_type, p_month);
END;
$function$;

COMMENT ON FUNCTION public.get_meters_without_readings_v2(uuid, uuid, text, text) IS
  'RBAC wrapper: kiểm tra can_access_building, lookup owner và delegate v1.';
