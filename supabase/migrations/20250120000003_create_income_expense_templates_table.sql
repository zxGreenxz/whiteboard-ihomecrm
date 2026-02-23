-- =============================================
-- Migration: Create income_expense_templates table (Mẫu in thu chi)
-- Description: Templates for printing income/expense receipts
-- Requirements: 11.3
-- =============================================

CREATE TABLE income_expense_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Template info
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  template_file_url TEXT,

  -- Settings
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_income_template BOOLEAN NOT NULL DEFAULT false,

  -- Field mappings (e.g. {"customer_name": "{{ho_ten}}", "amount": "{{so_tien}}"})
  field_mappings JSONB,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT income_expense_templates_name_not_empty CHECK (char_length(name) > 0)
);

-- Partial unique index: code unique per user (only active records)
CREATE UNIQUE INDEX idx_income_expense_templates_unique_code_per_user
  ON income_expense_templates(user_id, code)
  WHERE code IS NOT NULL AND deleted_at IS NULL;

-- Indexes
CREATE INDEX idx_income_expense_templates_user_id ON income_expense_templates(user_id);
CREATE INDEX idx_income_expense_templates_is_default ON income_expense_templates(is_default);
CREATE INDEX idx_income_expense_templates_is_income_template ON income_expense_templates(is_income_template);
CREATE INDEX idx_income_expense_templates_deleted_at ON income_expense_templates(deleted_at);

-- RLS
ALTER TABLE income_expense_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "income_expense_templates_select" ON income_expense_templates
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "income_expense_templates_insert" ON income_expense_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "income_expense_templates_update" ON income_expense_templates
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "income_expense_templates_delete" ON income_expense_templates
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE income_expense_templates IS 'Templates for printing income/expense receipts (Mẫu in thu chi)';
