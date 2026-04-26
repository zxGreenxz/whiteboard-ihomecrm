-- =============================================
-- Migration: invoices.creator_name
-- Mirror of income_expenses.creator_name (commit 4e46ce4) so the list
-- table can show "Người tạo" without joining auth.users.
-- =============================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS creator_name TEXT;

COMMENT ON COLUMN invoices.creator_name IS
  'Display name of invoice creator captured at insert time.';
