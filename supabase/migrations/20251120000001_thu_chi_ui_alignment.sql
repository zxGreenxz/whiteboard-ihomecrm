-- =============================================
-- Migration: Thu chi UI alignment - Database schema changes
-- Description: Create accounts table, add new columns to income_expenses and income_expense_items
-- Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9
-- =============================================

-- =============================================
-- 1. Create accounts table (Tài khoản ngân hàng/tiền mặt)
-- =============================================
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bank', 'cash')),
  bank_name TEXT,
  account_number TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_deleted_at ON accounts(deleted_at);

-- RLS
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounts_select" ON accounts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "accounts_insert" ON accounts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "accounts_update" ON accounts
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "accounts_delete" ON accounts
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE accounts IS 'Bank accounts and cash accounts for income/expense transactions (Tài khoản ngân hàng/tiền mặt)';

-- =============================================
-- 2. Add new columns to income_expenses table
-- =============================================

-- 2.1 payer_name: Tên người nộp/nhận tiền
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS payer_name TEXT;

-- 2.2 account_id: FK tới bảng accounts
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- 2.3 contract_id: FK tới bảng contracts
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL;

-- 2.4 attachments: Danh sách URL file đính kèm
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2.5 business_result_accounting: Hạch toán kết quả kinh doanh
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS business_result_accounting BOOLEAN NOT NULL DEFAULT false;

-- Indexes for new FK columns
CREATE INDEX IF NOT EXISTS idx_income_expenses_account_id ON income_expenses(account_id);
CREATE INDEX IF NOT EXISTS idx_income_expenses_contract_id ON income_expenses(contract_id);

-- =============================================
-- 3. Add new columns to income_expense_items table
-- =============================================

-- 3.1 start_date: Ngày bắt đầu hạng mục
ALTER TABLE income_expense_items ADD COLUMN IF NOT EXISTS start_date DATE;

-- 3.2 end_date: Ngày kết thúc hạng mục
ALTER TABLE income_expense_items ADD COLUMN IF NOT EXISTS end_date DATE;
