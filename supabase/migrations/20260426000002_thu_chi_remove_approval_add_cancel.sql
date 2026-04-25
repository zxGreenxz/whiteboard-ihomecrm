-- =============================================
-- Migration: Remove approval workflow on income_expenses
-- - All vouchers default APPROVED at creation
-- - Add 'CANCELLED' state (huỷ phiếu, vẫn lưu)
-- - View accounts_with_balance excludes CANCELLED
-- - Create storage bucket "income-expense-attachments" + policies
-- =============================================

-- 1. Loosen CHECK constraint to include CANCELLED
ALTER TABLE income_expenses DROP CONSTRAINT IF EXISTS income_expenses_approval_status_check;
ALTER TABLE income_expenses
  ADD CONSTRAINT income_expenses_approval_status_check
  CHECK (approval_status IN ('UNAPPROVED', 'APPROVED', 'CANCELLED'));

-- 2. Default = APPROVED
ALTER TABLE income_expenses ALTER COLUMN approval_status SET DEFAULT 'APPROVED';

-- 3. Backfill: every UNAPPROVED row becomes APPROVED (workflow gone).
UPDATE income_expenses
SET approval_status = 'APPROVED'
WHERE approval_status = 'UNAPPROVED';

-- 4. Recreate balance view: only APPROVED counts toward Tồn quỹ
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

-- 5. Storage bucket for attachments (idempotent)
INSERT INTO storage.buckets (id, name, public)
VALUES ('income-expense-attachments', 'income-expense-attachments', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 6. RLS policies on storage.objects for this bucket.
DROP POLICY IF EXISTS "ie_attachments_select"  ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_insert"  ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_update"  ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_delete"  ON storage.objects;

CREATE POLICY "ie_attachments_select" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'income-expense-attachments');

CREATE POLICY "ie_attachments_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "ie_attachments_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "ie_attachments_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
