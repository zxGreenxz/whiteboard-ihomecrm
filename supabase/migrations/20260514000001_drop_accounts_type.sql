-- =============================================
-- Migration: Drop accounts.type column
--
-- Lý do: chỉ còn 1 loại sổ quỹ (tiền mặt), bỏ phân loại
-- cash/bank/ewallet. Toàn bộ 22 sổ hiện hữu đều type='cash'
-- (đã verify bằng query).
--
-- - Drop view accounts_with_balance (vì view list explicit columns
--   bao gồm 'type')
-- - Drop CHECK constraint accounts_type_check
-- - Drop column accounts.type
-- - Recreate view accounts_with_balance không có cột 'type'
-- =============================================

BEGIN;

DROP VIEW IF EXISTS public.accounts_with_balance;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts DROP COLUMN IF EXISTS type;

CREATE VIEW public.accounts_with_balance AS
SELECT
  a.id,
  a.user_id,
  a.name,
  a.bank_name,
  a.account_number,
  a.is_default,
  a.created_at,
  a.updated_at,
  a.deleted_at,
  a.code,
  a.description,
  a.bank_account_holder,
  a.initial_amount,
  a.initial_date,
  a.lock_date,
  a.branch,
  COALESCE(a.initial_amount, 0::numeric)
  + COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'INCOME'
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0::numeric)
  - COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'EXPENSE'
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0::numeric)
  + COALESCE((
      SELECT SUM(ie.change_amount)
      FROM income_expenses ie
      WHERE ie.change_account_id = a.id
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0::numeric) AS current_amount
FROM accounts a
WHERE a.deleted_at IS NULL;

ALTER VIEW public.accounts_with_balance SET (security_invoker = true);

GRANT SELECT ON public.accounts_with_balance TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
