-- =============================================
-- Migration: Create income_expense_items table (Hạng mục thu/chi)
-- Description: Line items for income/expense vouchers
-- Requirements: 11.2
-- =============================================

CREATE TABLE income_expense_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent voucher
  income_expense_id UUID NOT NULL REFERENCES income_expenses(id) ON DELETE CASCADE,

  -- Category
  income_expense_type_id UUID NOT NULL REFERENCES income_expense_types(id) ON DELETE RESTRICT,

  -- Item details
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DECIMAL(15, 2) NOT NULL DEFAULT 0,
  amount DECIMAL(15, 2),
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT income_expense_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT income_expense_items_unit_price_non_negative CHECK (unit_price >= 0)
);

-- Indexes
CREATE INDEX idx_income_expense_items_income_expense_id ON income_expense_items(income_expense_id);
CREATE INDEX idx_income_expense_items_income_expense_type_id ON income_expense_items(income_expense_type_id);

-- RLS
ALTER TABLE income_expense_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "income_expense_items_all" ON income_expense_items
  FOR ALL
  USING (
    income_expense_id IN (
      SELECT id FROM income_expenses WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    income_expense_id IN (
      SELECT id FROM income_expenses WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE income_expense_items IS 'Line items for income/expense vouchers (Hạng mục thu/chi)';
