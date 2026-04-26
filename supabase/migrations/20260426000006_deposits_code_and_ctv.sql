-- =============================================
-- Migration: deposits gain code (DCxxxxxx auto) + ctv_name
-- Resident's deposit list shows a "Mã đặt cọc" code and a CTV column.
-- =============================================

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ctv_name TEXT;

CREATE SEQUENCE IF NOT EXISTS deposits_code_seq START 1;

CREATE OR REPLACE FUNCTION deposits_set_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'DC' || LPAD(nextval('deposits_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposits_set_code ON deposits;
CREATE TRIGGER trg_deposits_set_code
BEFORE INSERT ON deposits
FOR EACH ROW EXECUTE FUNCTION deposits_set_code();

UPDATE deposits
SET code = 'DC' || LPAD(nextval('deposits_code_seq')::text, 6, '0')
WHERE code IS NULL OR code = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_code ON deposits(code);

COMMENT ON COLUMN deposits.code IS 'Auto DCxxxxxx, mirrors Resident reservation code';
COMMENT ON COLUMN deposits.ctv_name IS 'Cộng tác viên';
