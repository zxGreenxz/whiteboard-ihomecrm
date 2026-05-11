-- =============================================
-- Migration: Sổ "X Thối" như "ví báo cáo" ghi nhận tiền thối
--
-- Vấn đề: sổ "Hiển Thối", "Hiệp Thối" hiện hiển thị tồn quỹ = 0 vì
-- không có phiếu chi/thu nào nhắm trực tiếp vào sổ này (chỉ là log
-- qua change_account_id trên phiếu thu HĐ).
--
-- Fix: extend view accounts_with_balance để cộng dồn SUM(change_amount)
-- của các phiếu có change_account_id = sổ này. Với sổ thường, không có
-- record nào tham chiếu nên không ảnh hưởng. Với sổ "X Thối", balance
-- = tổng tiền thối NV đã thực hiện → vừa làm ví theo dõi, vừa làm
-- báo cáo audit.
-- =============================================

BEGIN;

CREATE OR REPLACE VIEW public.accounts_with_balance AS
SELECT
  a.id,
  a.user_id,
  a.name,
  a.type,
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

NOTIFY pgrst, 'reload schema';
COMMIT;
