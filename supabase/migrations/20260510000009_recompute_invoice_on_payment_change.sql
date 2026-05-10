BEGIN;

CREATE OR REPLACE FUNCTION recompute_invoice_after_payment_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_invoice_id UUID;
  v_total NUMERIC(15, 2);
  v_paid  NUMERIC(15, 2);
  v_status invoice_status;
  v_paid_date DATE;
BEGIN
  v_invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_invoice_id IS NULL THEN RETURN NULL; END IF;

  SELECT total_amount INTO v_total
  FROM invoices WHERE id = v_invoice_id;

  IF v_total IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(amount), 0), MAX(payment_date)
  INTO v_paid, v_paid_date
  FROM payments
  WHERE invoice_id = v_invoice_id;

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
  WHERE id = v_invoice_id;

  RETURN NULL;
END;
$BODY$;

DROP TRIGGER IF EXISTS trg_payments_recompute_invoice ON payments;
CREATE TRIGGER trg_payments_recompute_invoice
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW
EXECUTE FUNCTION recompute_invoice_after_payment_change();

-- Một-lần: backfill các invoice hiện có để khớp với payments thực tế.
UPDATE invoices i
SET paid_amount = COALESCE(p.total, 0),
    status = CASE
      WHEN COALESCE(p.total, 0) >= i.total_amount AND i.total_amount > 0 THEN 'PAID'::invoice_status
      WHEN COALESCE(p.total, 0) > 0 THEN 'PARTIAL_PAID'::invoice_status
      ELSE 'APPROVED'::invoice_status
    END,
    paid_date = CASE
      WHEN COALESCE(p.total, 0) >= i.total_amount AND i.total_amount > 0 THEN p.last_paid
      ELSE NULL
    END
FROM (
  SELECT invoice_id, SUM(amount) AS total, MAX(payment_date) AS last_paid
  FROM payments
  GROUP BY invoice_id
) p
WHERE p.invoice_id = i.id
  AND i.deleted_at IS NULL
  AND i.status NOT IN ('CANCELLED', 'DRAFT');

-- Reset các invoice không còn payment nào
UPDATE invoices i
SET paid_amount = 0,
    status = CASE WHEN i.status IN ('PAID','PARTIAL_PAID') THEN 'APPROVED'::invoice_status ELSE i.status END,
    paid_date = NULL
WHERE i.deleted_at IS NULL
  AND i.status IN ('PAID', 'PARTIAL_PAID')
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id);

COMMIT;
