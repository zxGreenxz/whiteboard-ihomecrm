-- =============================================
-- Migration: Create income_expenses table (Phiếu thu/chi)
-- Description: Income/expense vouchers for tracking financial transactions
-- Requirements: 11.1, 11.4, 11.5, 11.7
-- =============================================

CREATE TABLE income_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Voucher info
  code TEXT,
  type TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE')),
  name TEXT NOT NULL,

  -- Relations
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  bed_id UUID REFERENCES beds(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,

  -- Financial
  voucher_date DATE NOT NULL,
  total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,

  -- Approval
  approval_status TEXT NOT NULL DEFAULT 'UNAPPROVED' CHECK (approval_status IN ('UNAPPROVED', 'APPROVED')),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,

  -- Metadata
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT income_expenses_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT income_expenses_total_amount_non_negative CHECK (total_amount >= 0)
);

-- Unique constraint: code unique per user
CREATE UNIQUE INDEX idx_income_expenses_unique_code_per_user
  ON income_expenses(user_id, code)
  WHERE code IS NOT NULL AND deleted_at IS NULL;

-- Indexes
CREATE INDEX idx_income_expenses_user_id ON income_expenses(user_id);
CREATE INDEX idx_income_expenses_building_id ON income_expenses(building_id);
CREATE INDEX idx_income_expenses_type ON income_expenses(type);
CREATE INDEX idx_income_expenses_approval_status ON income_expenses(approval_status);
CREATE INDEX idx_income_expenses_voucher_date ON income_expenses(voucher_date);
CREATE INDEX idx_income_expenses_deleted_at ON income_expenses(deleted_at);
CREATE INDEX idx_income_expenses_room_id ON income_expenses(room_id);
CREATE INDEX idx_income_expenses_tenant_id ON income_expenses(tenant_id);

-- RLS
ALTER TABLE income_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "income_expenses_select" ON income_expenses
  FOR SELECT USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "income_expenses_insert" ON income_expenses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "income_expenses_update" ON income_expenses
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "income_expenses_delete" ON income_expenses
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE income_expenses IS 'Income/expense vouchers (Phiếu thu/chi) for tracking financial transactions';
