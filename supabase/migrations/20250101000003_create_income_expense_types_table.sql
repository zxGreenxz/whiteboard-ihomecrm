-- =============================================
-- Migration: Create income_expense_types table (Loại thu chi)
-- Description: Income/expense type categories
-- Requirements: 38.3, 31.2
-- =============================================

CREATE TABLE income_expense_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  description TEXT,
  is_default BOOLEAN DEFAULT false,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT income_expense_types_name_not_empty CHECK (char_length(name) > 0)
);

-- Indexes
CREATE INDEX idx_income_expense_types_user_id ON income_expense_types(user_id);
CREATE INDEX idx_income_expense_types_type ON income_expense_types(type);

-- RLS
ALTER TABLE income_expense_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "income_expense_types_select" ON income_expense_types
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "income_expense_types_insert" ON income_expense_types
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "income_expense_types_update" ON income_expense_types
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "income_expense_types_delete" ON income_expense_types
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE income_expense_types IS 'Income/expense type categories (Loại thu chi)';
