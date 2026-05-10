BEGIN;

DROP FUNCTION IF EXISTS record_invoice_payment(UUID, UUID, DECIMAL, payment_method, DATE, TEXT, TEXT) CASCADE;

CREATE TYPE payment_method_new AS ENUM ('TM', 'TK', 'TT');

ALTER TABLE payments
  ALTER COLUMN payment_method DROP DEFAULT;

ALTER TABLE payments
  ALTER COLUMN payment_method TYPE payment_method_new
  USING (CASE
    WHEN payment_method::text = 'CASH'          THEN 'TM'::payment_method_new
    WHEN payment_method::text = 'BANK_TRANSFER' THEN 'TK'::payment_method_new
    ELSE 'TT'::payment_method_new
  END);

ALTER TABLE payments
  ALTER COLUMN payment_method SET DEFAULT 'TM';

ALTER TABLE contract_terminations
  ALTER COLUMN refund_method TYPE payment_method_new
  USING (CASE
    WHEN refund_method IS NULL                  THEN NULL
    WHEN refund_method::text = 'CASH'           THEN 'TM'::payment_method_new
    WHEN refund_method::text = 'BANK_TRANSFER'  THEN 'TK'::payment_method_new
    ELSE 'TT'::payment_method_new
  END);

DROP TYPE payment_method;
ALTER TYPE payment_method_new RENAME TO payment_method;

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

  SELECT id, user_id, contract_id, total_amount, paid_amount, remaining_amount, status
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND user_id = p_user_id
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
