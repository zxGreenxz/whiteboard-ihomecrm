-- Cho phép super admin "xoá" hoá đơn ở bất kỳ trạng thái nào (kể cả đã thanh toán).
-- Cơ chế: hard-delete payments + excess_amounts liên quan, rồi set status=CANCELLED.
-- HĐ đã huỷ vẫn nằm trong DB, super admin có thể phục hồi qua useRestoreInvoice
-- (CANCELLED → APPROVED). Payment đã xoá KHÔNG phục hồi cùng.

CREATE OR REPLACE FUNCTION public.super_admin_force_cancel_invoice(p_invoice_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status invoice_status;
  v_deleted TIMESTAMPTZ;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Chỉ super admin được phép xoá hoá đơn ở trạng thái này';
  END IF;

  SELECT status, deleted_at INTO v_status, v_deleted
  FROM invoices
  WHERE id = p_invoice_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Hoá đơn không tồn tại';
  END IF;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Hoá đơn đã bị xoá trước đó';
  END IF;
  IF v_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Hoá đơn đã ở trạng thái Đã huỷ';
  END IF;

  -- 1. Xoá excess_amounts gốc từ HĐ này (overpayment credit)
  DELETE FROM excess_amounts WHERE source_invoice_id = p_invoice_id;

  -- 2. Hard-delete payments. FK ON DELETE RESTRICT bị bypass nhờ
  --    SECURITY DEFINER chạy với quyền của owner function.
  --    Trigger trg_payments_recompute_invoice sẽ chạy AFTER DELETE và
  --    reset invoices.paid_amount=0, status='APPROVED'.
  DELETE FROM payments WHERE invoice_id = p_invoice_id;

  -- 3. Override status về CANCELLED (sau khi trigger đã chạy)
  UPDATE invoices SET status = 'CANCELLED' WHERE id = p_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.super_admin_force_cancel_invoice(UUID) TO authenticated;
