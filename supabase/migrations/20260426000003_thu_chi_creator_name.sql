-- =============================================
-- Migration: add creator_name on income_expenses
-- Captures the display name of whoever created the voucher so the
-- detail dialog can show "Người tạo" without joining auth.users (which
-- the anon client cannot read).
-- =============================================

ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS creator_name TEXT;

COMMENT ON COLUMN income_expenses.creator_name IS
  'Display name of voucher creator, captured at insert time (auth user_metadata.full_name or email).';
