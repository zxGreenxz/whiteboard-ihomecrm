BEGIN;

ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS payment_id UUID
  REFERENCES payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_income_expenses_payment_id
  ON income_expenses(payment_id) WHERE deleted_at IS NULL;

-- Backfill: link voucher INCOME đã tạo từ record_invoice_payment với payments
-- cùng invoice + amount + payment_date (best-effort).
UPDATE income_expenses ie
SET payment_id = p.id
FROM payments p
WHERE ie.invoice_id IS NOT NULL
  AND ie.type = 'INCOME'
  AND ie.payment_id IS NULL
  AND p.invoice_id = ie.invoice_id
  AND p.payment_date = ie.voucher_date
  AND p.amount = (
    SELECT COALESCE(SUM(unit_price * quantity), 0)
    FROM income_expense_items
    WHERE income_expense_id = ie.id
  );

COMMIT;
