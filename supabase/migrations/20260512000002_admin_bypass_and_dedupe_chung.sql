-- =============================================
-- Migration: Sửa hậu quả của 20260512000001
-- 1) Xoá tòa ảo "Chung" thừa: chỉ giữ 1 tòa thuộc super admin.
-- 2) Patch RPC record_invoice_payment để cho phép super admin / admin /
--    staff (có quyền edit invoices) bypass — không bị "Invoice not found
--    or access denied" khi thanh toán HĐ của user khác.
-- =============================================

BEGIN;

-- 1) Dedupe tòa "Chung"
-- Giữ tòa Chung thuộc 1 super admin duy nhất. Nếu có nhiều super admin,
-- chọn cái cũ nhất. Nếu KHÔNG có super admin, giữ tòa đầu tiên theo
-- created_at để tránh xóa hết.
WITH keeper AS (
  SELECT b.id
  FROM buildings b
  WHERE b.is_virtual = true AND b.name = 'Chung'
  ORDER BY
    (b.user_id IN (SELECT user_id FROM super_admins)) DESC,
    b.created_at ASC
  LIMIT 1
)
DELETE FROM buildings
WHERE is_virtual = true
  AND name = 'Chung'
  AND id NOT IN (SELECT id FROM keeper);

-- 2) Patch RPC: cho phép super admin / admin / staff thanh toán HĐ
DROP FUNCTION IF EXISTS record_invoice_payment(UUID, UUID, DECIMAL, payment_method, DATE, TEXT, TEXT) CASCADE;

CREATE OR REPLACE FUNCTION record_invoice_payment(
  p_user_id UUID,
  p_invoice_id UUID,
  p_amount DECIMAL,
  p_payment_method payment_method,
  p_payment_date DATE,
  p_notes TEXT DEFAULT NULL,
  p_receipt_image_url TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $BODY$
DECLARE
  v_invoice RECORD;
  v_payment_id UUID;
  v_new_paid_amount DECIMAL(15, 2);
  v_remaining DECIMAL(15, 2);
  v_excess DECIMAL(15, 2);
  v_new_status invoice_status;
  v_paid_date DATE;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Cho phép invoice owner, super admin, admin, hoặc staff có quyền edit
  SELECT id, user_id, contract_id, total_amount, paid_amount, remaining_amount, status
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND (
      user_id = p_user_id
      OR is_super_admin()
      OR is_admin()
      OR staff_can('invoices'::text, 'edit'::text, user_id)
    )
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found or access denied';
  END IF;

  INSERT INTO payments (
    user_id, invoice_id, amount, payment_method, payment_date, notes, receipt_image_url
  ) VALUES (
    p_user_id, p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url
  )
  RETURNING id INTO v_payment_id;

  v_new_paid_amount := COALESCE(v_invoice.paid_amount, 0) + p_amount;
  v_remaining := v_invoice.total_amount - v_new_paid_amount;

  IF v_new_paid_amount >= v_invoice.total_amount THEN
    v_new_status := 'PAID';
    v_paid_date := p_payment_date;
    v_excess := v_new_paid_amount - v_invoice.total_amount;

    IF v_excess > 0 THEN
      INSERT INTO excess_amounts (
        user_id, contract_id, amount, description,
        source_invoice_id, source_payment_id
      ) VALUES (
        p_user_id, v_invoice.contract_id, v_excess,
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
$BODY$;

COMMIT;
