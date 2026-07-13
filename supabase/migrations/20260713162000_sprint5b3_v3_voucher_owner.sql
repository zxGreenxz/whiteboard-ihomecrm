-- =============================================================================
-- Sprint 5b3 — v3 +p_voucher_owner_id (giữ user_id=owner cho bulk, chống lệch
-- attribution lợi nhuận — xem memory staff_userid_attribution_profit_gap).
-- Validate: chỉ cho phép = invoice owner (không forge user_id tuỳ ý).
-- DROP+CREATE (đổi signature). Named-param call cũ vẫn chạy (default null → auth.uid()).
-- =============================================================================
BEGIN;
DROP FUNCTION IF EXISTS public.record_invoice_payment_v3(uuid,numeric,payment_method,date,text,uuid,text,text,jsonb,jsonb,text);

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v3(
  p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date,
  p_idempotency_key text, p_account_id uuid DEFAULT NULL, p_notes text DEFAULT NULL,
  p_receipt_image_url text DEFAULT NULL, p_voucher jsonb DEFAULT NULL, p_items jsonb DEFAULT NULL,
  p_receipt_number text DEFAULT NULL, p_voucher_owner_id uuid DEFAULT NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_inv RECORD; v_payment_id uuid; v_voucher_id uuid; v_owner uuid;
  v_new_paid numeric(15,2); v_status invoice_status; v_paid_date date; v_excess numeric(15,2) := 0;
  v_existing RECORD; it jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải > 0'; END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 THEN RAISE EXCEPTION 'idempotency_key bắt buộc (>=8 ký tự)'; END IF;

  SELECT ie.id AS voucher_id, ie.payment_id INTO v_existing
  FROM income_expenses ie WHERE ie.idempotency_key = p_idempotency_key AND ie.deleted_at IS NULL LIMIT 1;
  IF FOUND THEN RETURN json_build_object('payment_id', v_existing.payment_id, 'voucher_id', v_existing.voucher_id, 'idempotent', true); END IF;

  SELECT id, user_id, building_id, contract_id, total_amount, paid_amount, status
  INTO v_inv FROM invoices WHERE id = p_invoice_id AND deleted_at IS NULL
    AND public.can_do_on_building('invoices','edit', building_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hoá đơn hoặc không có quyền' USING ERRCODE='42501'; END IF;

  -- Voucher owner: mặc định caller; nếu truyền p_voucher_owner_id phải = invoice owner.
  IF p_voucher_owner_id IS NOT NULL AND p_voucher_owner_id <> v_inv.user_id THEN
    RAISE EXCEPTION 'p_voucher_owner_id phải là chủ hoá đơn' USING ERRCODE='42501';
  END IF;
  v_owner := COALESCE(p_voucher_owner_id, v_caller);

  INSERT INTO payments (invoice_id, amount, payment_method, payment_date, notes, receipt_image_url, receipt_number)
  VALUES (p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url, p_receipt_number)
  RETURNING id INTO v_payment_id;

  v_new_paid := COALESCE(v_inv.paid_amount,0) + p_amount;
  IF v_new_paid >= v_inv.total_amount THEN
    v_status := 'PAID'; v_paid_date := p_payment_date; v_excess := v_new_paid - v_inv.total_amount;
    IF v_excess > 0 THEN
      INSERT INTO excess_amounts (contract_id, amount, description, source_invoice_id, source_payment_id)
      VALUES (v_inv.contract_id, v_excess, 'Tiền thừa từ hoá đơn ' || (SELECT invoice_number FROM invoices WHERE id=p_invoice_id), p_invoice_id, v_payment_id);
    END IF;
  ELSE v_status := 'PARTIAL_PAID'; v_paid_date := NULL; END IF;

  UPDATE invoices SET paid_amount=v_new_paid, status=v_status, paid_date=v_paid_date WHERE id=p_invoice_id;

  IF p_account_id IS NOT NULL AND p_voucher IS NOT NULL THEN
    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, payment_id,
      voucher_date, payer_name, notes, attachments, approval_status, approved_by, approved_at,
      creator_name, business_result_accounting, change_amount, change_account_id, rounding_amount, rounding_account_id, idempotency_key
    ) VALUES (
      v_owner, 'INCOME', COALESCE(p_voucher->>'name','Thu tiền hoá đơn'),
      v_inv.building_id, NULLIF(p_voucher->>'room_id','')::uuid, v_inv.contract_id,
      p_account_id, p_invoice_id, v_payment_id, p_payment_date,
      p_voucher->>'payer_name', p_voucher->>'notes', COALESCE(p_voucher->'attachments','[]'::jsonb),
      'APPROVED', v_caller, now(), p_voucher->>'creator_name',
      CASE WHEN p_voucher ? 'business_result_accounting' AND jsonb_typeof(p_voucher->'business_result_accounting')='boolean'
           THEN (p_voucher->>'business_result_accounting')::boolean ELSE NULL END,
      COALESCE((p_voucher->>'change_amount')::numeric,0), NULLIF(p_voucher->>'change_account_id','')::uuid,
      COALESCE((p_voucher->>'rounding_amount')::numeric,0), NULLIF(p_voucher->>'rounding_account_id','')::uuid, p_idempotency_key
    ) RETURNING id INTO v_voucher_id;
    IF p_items IS NOT NULL THEN
      FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
        VALUES (v_voucher_id, (it->>'income_expense_type_id')::uuid, it->>'description',
                COALESCE((it->>'quantity')::numeric,1), (it->>'unit_price')::numeric, NULLIF(it->>'start_date','')::date, NULLIF(it->>'end_date','')::date);
      END LOOP;
    END IF;
  END IF;

  RETURN json_build_object('payment_id', v_payment_id, 'voucher_id', v_voucher_id, 'new_paid_amount', v_new_paid, 'new_status', v_status, 'excess_amount', v_excess);
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_invoice_payment_v3(uuid,numeric,payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v3(uuid,numeric,payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid) TO authenticated;
COMMIT;
