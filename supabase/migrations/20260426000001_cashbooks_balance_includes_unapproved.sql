-- =============================================
-- Migration: Cashbooks balance + extra fields
-- 1. View accounts_with_balance now counts BOTH approved & unapproved
--    income/expense (matches Resident UX where currentAmount updates as
--    soon as a voucher exists). Soft-deleted vouchers are still excluded.
-- 2. accounts.branch — bank branch (Chi nhánh)
-- 3. income_expenses.receive_bank_name + receive_bank_account — only used
--    on EXPENSE vouchers when paying to a beneficiary's bank account.
-- =============================================

-- 1. Branch column on accounts
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS branch TEXT;
COMMENT ON COLUMN accounts.branch IS 'Chi nhánh ngân hàng';

-- 2. Receive-bank fields on income_expenses (mirror Resident "Số TK nhận" / "Ngân hàng nhận")
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS receive_bank_name TEXT;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS receive_bank_account TEXT;
COMMENT ON COLUMN income_expenses.receive_bank_name IS 'Ngân hàng nhận (chỉ dùng cho phiếu chi)';
COMMENT ON COLUMN income_expenses.receive_bank_account IS 'Số TK nhận (chỉ dùng cho phiếu chi)';

-- 3. Recreate view to include unapproved vouchers
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
        AND ie.deleted_at IS NULL
    ), 0)
  - COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'EXPENSE'
        AND ie.deleted_at IS NULL
    ), 0)
  AS current_amount
FROM accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON accounts_with_balance TO authenticated;
