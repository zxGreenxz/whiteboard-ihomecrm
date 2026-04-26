-- =============================================
-- Migration: link income_expenses to invoices
-- Resident creates a phiếu thu (TC...) every time the user records an
-- invoice payment. Add invoice_id so the same row can be looked up from
-- both sides.
-- =============================================

ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS invoice_id UUID
  REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_income_expenses_invoice_id
  ON income_expenses(invoice_id) WHERE invoice_id IS NOT NULL;

COMMENT ON COLUMN income_expenses.invoice_id IS
  'Linked invoice when this voucher was auto-generated from RecordPaymentDialog.';
