-- =============================================
-- Migration: accounts_with_balance — cộng SUM(rounding_amount) vào tồn quỹ
-- Created: 2026-05-27
-- Description:
--   View `accounts_with_balance` đang cộng `change_amount` từ các phiếu thu
--   có change_account_id = sổ hiện tại (mô hình ledger cho sổ "Thối").
--   Bổ sung tương tự cho `rounding_amount` / `rounding_account_id` để sổ
--   "Làm tròn tiền thiếu" hiển thị đúng tổng đã làm tròn (ledger audit).
-- =============================================

BEGIN;

CREATE OR REPLACE VIEW accounts_with_balance AS
SELECT
  id,
  user_id,
  name,
  bank_name,
  account_number,
  is_default,
  created_at,
  updated_at,
  deleted_at,
  code,
  description,
  bank_account_holder,
  initial_amount,
  initial_date,
  lock_date,
  branch,
  COALESCE(initial_amount, 0::numeric)
    + COALESCE((
        SELECT SUM(ie.total_amount)
        FROM income_expenses ie
        WHERE ie.account_id = a.id
          AND ie.type = 'INCOME'::text
          AND ie.approval_status = 'APPROVED'::text
          AND ie.deleted_at IS NULL
      ), 0::numeric)
    - COALESCE((
        SELECT SUM(ie.total_amount)
        FROM income_expenses ie
        WHERE ie.account_id = a.id
          AND ie.type = 'EXPENSE'::text
          AND ie.approval_status = 'APPROVED'::text
          AND ie.deleted_at IS NULL
      ), 0::numeric)
    + COALESCE((
        SELECT SUM(ie.change_amount)
        FROM income_expenses ie
        WHERE ie.change_account_id = a.id
          AND ie.approval_status = 'APPROVED'::text
          AND ie.deleted_at IS NULL
      ), 0::numeric)
    + COALESCE((
        SELECT SUM(ie.rounding_amount)
        FROM income_expenses ie
        WHERE ie.rounding_account_id = a.id
          AND ie.approval_status = 'APPROVED'::text
          AND ie.deleted_at IS NULL
      ), 0::numeric) AS current_amount
FROM accounts a
WHERE deleted_at IS NULL;

COMMIT;
