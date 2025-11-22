-- =============================================
-- Migration 024: Add start_billing_date to contracts
-- Created: 2025-11-22
-- Description: Add start_billing_date column for automatic invoice generation
-- =============================================

-- Add start_billing_date to contracts table if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'contracts'
    AND column_name = 'start_billing_date'
  ) THEN
    ALTER TABLE contracts ADD COLUMN start_billing_date DATE;
    CREATE INDEX idx_contracts_start_billing_date ON contracts(start_billing_date);
    COMMENT ON COLUMN contracts.start_billing_date IS 'Ngày bắt đầu tính tiền thuê (có thể khác start_date) - dùng để tự động tạo hóa đơn';
  END IF;
END $$;
