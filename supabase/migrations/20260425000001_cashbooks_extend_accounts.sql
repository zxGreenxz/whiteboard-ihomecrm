-- =============================================
-- Migration: Cashbooks (Tài khoản) — extend accounts table
-- Goal: align CRM `accounts` table with Resident `cashbook` model
-- Adds: code, description, bank_account_holder, initial_amount, initial_date,
--       lock_date, supports type='ewallet'.
-- Adds: helper view `accounts_with_balance` for "Tồn quỹ".
-- Adds: trigger to block edits/inserts on income_expenses when cashbook locked.
-- =============================================

-- 1. Extend type CHECK to allow 'ewallet'
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('cash', 'bank', 'ewallet'));

-- 2. New columns
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bank_account_holder TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lock_date DATE;

-- 3. code: auto-generate "TK000001" via sequence + trigger
CREATE SEQUENCE IF NOT EXISTS accounts_code_seq START 1;

CREATE OR REPLACE FUNCTION accounts_set_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'TK' || LPAD(nextval('accounts_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_set_code ON accounts;
CREATE TRIGGER trg_accounts_set_code
BEFORE INSERT ON accounts
FOR EACH ROW EXECUTE FUNCTION accounts_set_code();

-- Backfill code for existing rows
UPDATE accounts
SET code = 'TK' || LPAD(nextval('accounts_code_seq')::text, 6, '0')
WHERE code IS NULL OR code = '';

ALTER TABLE accounts ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_code_unique ON accounts(code) WHERE deleted_at IS NULL;

-- 4. View accounts_with_balance: includes "current_amount" (Tồn quỹ)
--    current_amount = initial_amount
--                   + Σ APPROVED INCOME on this account
--                   - Σ APPROVED EXPENSE on this account
DROP VIEW IF EXISTS accounts_with_balance;
CREATE VIEW accounts_with_balance AS
SELECT
  a.*,
  COALESCE(a.initial_amount, 0)
  + COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'INCOME'
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0)
  - COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'EXPENSE'
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0)
  AS current_amount
FROM accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON accounts_with_balance TO authenticated;

-- 5. Lock-date guard on income_expenses
CREATE OR REPLACE FUNCTION income_expenses_check_lock()
RETURNS TRIGGER AS $$
DECLARE
  v_lock DATE;
  v_account_id UUID;
  v_voucher_date DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_account_id := OLD.account_id;
    v_voucher_date := OLD.voucher_date;
  ELSE
    v_account_id := NEW.account_id;
    v_voucher_date := NEW.voucher_date;
  END IF;

  IF v_account_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT lock_date INTO v_lock FROM accounts WHERE id = v_account_id;

  IF v_lock IS NOT NULL AND v_voucher_date <= v_lock THEN
    RAISE EXCEPTION 'Tài khoản đã khoá sổ đến ngày %, không thể thao tác phiếu có ngày phát sinh ≤ ngày khoá', v_lock
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ie_check_lock_ins ON income_expenses;
DROP TRIGGER IF EXISTS trg_ie_check_lock_upd ON income_expenses;
DROP TRIGGER IF EXISTS trg_ie_check_lock_del ON income_expenses;

CREATE TRIGGER trg_ie_check_lock_ins
BEFORE INSERT ON income_expenses
FOR EACH ROW EXECUTE FUNCTION income_expenses_check_lock();

CREATE TRIGGER trg_ie_check_lock_upd
BEFORE UPDATE ON income_expenses
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL)
EXECUTE FUNCTION income_expenses_check_lock();

CREATE TRIGGER trg_ie_check_lock_del
BEFORE DELETE ON income_expenses
FOR EACH ROW EXECUTE FUNCTION income_expenses_check_lock();

COMMENT ON COLUMN accounts.code IS 'Auto-generated TKxxxxxx, mirrors Resident cashbook.code';
COMMENT ON COLUMN accounts.initial_amount IS 'Số dư đầu kỳ';
COMMENT ON COLUMN accounts.initial_date IS 'Ngày chốt số dư đầu kỳ';
COMMENT ON COLUMN accounts.lock_date IS 'Ngày khoá sổ — chặn lập/sửa/xoá phiếu thu chi có ngày ≤ lock_date';
