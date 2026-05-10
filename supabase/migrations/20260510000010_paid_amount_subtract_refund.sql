BEGIN;

-- Hàm chung tính lại paid_amount/status cho 1 hoá đơn:
--   net_paid = SUM(payments.amount) - SUM(income_expense_items thuộc voucher EXPENSE
--                                          loại 'Tiền thối' APPROVED gắn với hoá đơn)
-- Nhờ vậy:
--   - Khách trả 3.500.000 + thối lại 150.000 cho hoá đơn 3.350.000
--     → net_paid = 3.350.000 = total → PAID, không bị "thừa thu" sai số.
--   - Huỷ phiếu chi tiền thối → cộng lại vào paid_amount tự động.

CREATE OR REPLACE FUNCTION recompute_invoice_for_id(p_invoice_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_total NUMERIC(15, 2);
  v_paid  NUMERIC(15, 2);
  v_refunded NUMERIC(15, 2);
  v_status invoice_status;
  v_paid_date DATE;
BEGIN
  IF p_invoice_id IS NULL THEN RETURN; END IF;

  SELECT total_amount INTO v_total FROM invoices WHERE id = p_invoice_id;
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

  IF v_paid >= v_total AND v_total > 0 THEN
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
$BODY$;

CREATE OR REPLACE FUNCTION recompute_invoice_after_payment_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
BEGIN
  PERFORM recompute_invoice_for_id(COALESCE(NEW.invoice_id, OLD.invoice_id));
  RETURN NULL;
END;
$BODY$;

CREATE OR REPLACE FUNCTION recompute_invoice_after_voucher_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.invoice_id IS NOT NULL THEN
      PERFORM recompute_invoice_for_id(OLD.invoice_id);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    PERFORM recompute_invoice_for_id(NEW.invoice_id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
     AND OLD.invoice_id IS NOT NULL THEN
    PERFORM recompute_invoice_for_id(OLD.invoice_id);
  END IF;
  RETURN NULL;
END;
$BODY$;

DROP TRIGGER IF EXISTS trg_voucher_recompute_invoice ON income_expenses;
CREATE TRIGGER trg_voucher_recompute_invoice
AFTER INSERT OR UPDATE OR DELETE ON income_expenses
FOR EACH ROW
EXECUTE FUNCTION recompute_invoice_after_voucher_change();

-- Cũng có thể có trigger trên income_expense_items khi user sửa unit_price
-- của item tiền thối → recompute. Hiếm khi xảy ra qua UI, nhưng cover cho an toàn.
CREATE OR REPLACE FUNCTION recompute_invoice_after_item_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_invoice_id UUID;
BEGIN
  SELECT invoice_id INTO v_invoice_id
  FROM income_expenses
  WHERE id = COALESCE(NEW.income_expense_id, OLD.income_expense_id);
  IF v_invoice_id IS NOT NULL THEN
    PERFORM recompute_invoice_for_id(v_invoice_id);
  END IF;
  RETURN NULL;
END;
$BODY$;

DROP TRIGGER IF EXISTS trg_voucher_item_recompute_invoice ON income_expense_items;
CREATE TRIGGER trg_voucher_item_recompute_invoice
AFTER INSERT OR UPDATE OR DELETE ON income_expense_items
FOR EACH ROW
EXECUTE FUNCTION recompute_invoice_after_item_change();

-- Backfill: recompute toàn bộ hoá đơn đang có payment hoặc refund APPROVED.
DO $$
DECLARE
  inv_id UUID;
BEGIN
  FOR inv_id IN
    SELECT DISTINCT id FROM (
      SELECT i.id FROM invoices i
      WHERE i.deleted_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)
          OR EXISTS (SELECT 1 FROM income_expenses ie
                     WHERE ie.invoice_id = i.id
                       AND ie.deleted_at IS NULL)
        )
    ) AS sub
  LOOP
    PERFORM recompute_invoice_for_id(inv_id);
  END LOOP;
END $$;

COMMIT;
