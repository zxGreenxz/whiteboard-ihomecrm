-- =============================================================================
-- recompute_invoice_for_id: GIỮ NGUYÊN status khi hoá đơn đã CANCELLED.
--
-- Trigger trg_payments_recompute_invoice gọi hàm này mỗi khi payments thay đổi.
-- Trước đây hàm luôn suy lại status = PAID/PARTIAL_PAID/APPROVED theo tổng
-- payments, KHÔNG bảo toàn CANCELLED. Sau khi thanh lý bỏ cọc giữ tiền đã thu
-- (20260530000001), hoá đơn tháng đó ở trạng thái CANCELLED nhưng VẪN còn payment.
-- Nếu sau này có người sửa/xoá payment đó, hàm sẽ "hồi sinh" hoá đơn về
-- APPROVED/PARTIAL_PAID — và đụng unique index (contract_id, billing_month) với
-- hoá đơn phạt thanh lý cùng tháng.
--
-- Fix: nếu hoá đơn đang CANCELLED thì chỉ cập nhật paid_amount theo payments hiện
-- có, KHÔNG đổi status (giữ CANCELLED). Phần còn lại giữ nguyên logic cũ.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_total NUMERIC(15, 2);
  v_paid  NUMERIC(15, 2);
  v_refunded NUMERIC(15, 2);
  v_status invoice_status;
  v_existing_status invoice_status;
  v_paid_date DATE;
  v_rounding_threshold CONSTANT NUMERIC(15, 2) := 10000;
BEGIN
  IF p_invoice_id IS NULL THEN RETURN; END IF;

  SELECT total_amount, status INTO v_total, v_existing_status
  FROM invoices WHERE id = p_invoice_id;
  IF v_total IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0), MAX(payment_date)
  INTO v_paid, v_paid_date
  FROM payments
  WHERE invoice_id = p_invoice_id;

  SELECT COALESCE(SUM(iei.unit_price * iei.quantity), 0)
  INTO v_refunded
  FROM income_expenses ie
  JOIN income_expense_items iei ON iei.income_expense_id = ie.id
  JOIN income_expense_types iet ON iet.id = iei.income_expense_type_id
  WHERE ie.invoice_id = p_invoice_id
    AND ie.type = 'EXPENSE'
    AND ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL
    AND iet.name = 'Tiền thối';

  v_paid := v_paid - v_refunded;

  -- HĐ đã huỷ (vd thanh lý bỏ cọc giữ tiền đã thu): cập nhật paid_amount theo
  -- payments hiện có nhưng GIỮ NGUYÊN status = CANCELLED — không "hồi sinh" hoá
  -- đơn khi payment bị sửa/xoá sau này (tránh đụng unique index billing_month).
  IF v_existing_status = 'CANCELLED' THEN
    UPDATE invoices SET paid_amount = v_paid WHERE id = p_invoice_id;
    RETURN;
  END IF;

  -- Ngưỡng làm tròn: nếu khoản thiếu < 10K (và > 0) → coi như đủ.
  -- paid_amount KHÔNG bị bump lên total (giữ đúng số khách trả thực).
  IF v_total > 0 AND v_paid > 0 AND (v_total - v_paid) < v_rounding_threshold THEN
    v_status := 'PAID';
  ELSIF v_paid >= v_total AND v_total > 0 THEN
    v_status := 'PAID';
  ELSIF v_paid > 0 THEN
    v_status := 'PARTIAL_PAID';
    v_paid_date := NULL;
  ELSE
    v_status := 'APPROVED';
    v_paid_date := NULL;
  END IF;

  UPDATE invoices
  SET paid_amount = v_paid,
      status = v_status,
      paid_date = v_paid_date
  WHERE id = p_invoice_id;
END;
$function$;
