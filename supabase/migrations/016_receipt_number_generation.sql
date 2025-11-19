-- =============================================
-- Migration 016: Receipt Number Auto-generation
-- Created: 2025-11-19
-- Description: Add auto-generation for payment receipt numbers
-- =============================================

-- =============================================
-- GENERATE RECEIPT NUMBER
-- =============================================
-- Auto-generate receipt numbers for payments
-- Format: PT-YYYY-00001 (PT = Phiếu Thu)

CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix TEXT;
  v_counter INTEGER;
  v_new_number TEXT;
BEGIN
  IF NEW.receipt_number IS NULL THEN
    -- Get user's receipt prefix from settings (default: 'PT')
    SELECT COALESCE(value->>'receipt_prefix', 'PT')
    INTO v_prefix
    FROM settings
    WHERE user_id = NEW.user_id AND key = 'receipt_number_format';

    -- If no setting, use default
    IF v_prefix IS NULL THEN
      v_prefix := 'PT';
    END IF;

    -- Get next counter for this year
    SELECT COUNT(*) + 1
    INTO v_counter
    FROM payments
    WHERE user_id = NEW.user_id
      AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

    -- Generate: PT-2025-00001
    v_new_number := v_prefix || '-' ||
                    TO_CHAR(NOW(), 'YYYY') || '-' ||
                    LPAD(v_counter::TEXT, 5, '0');

    NEW.receipt_number := v_new_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
CREATE TRIGGER generate_receipt_number_trigger
  BEFORE INSERT ON payments
  FOR EACH ROW
  EXECUTE FUNCTION generate_receipt_number();

-- Add comment
COMMENT ON FUNCTION generate_receipt_number() IS 'Auto-generates receipt numbers for payments in format PT-YYYY-00001';
