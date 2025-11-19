-- =============================================
-- Migration 005: Billing Tables
-- Created: 2025-11-18
-- Description: Create invoices, invoice_items, payments, meter_readings, expenses tables
-- =============================================

-- =============================================
-- 1. INVOICES TABLE
-- =============================================

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,

  -- Invoice info
  invoice_number TEXT,
  title TEXT NOT NULL,

  -- Billing period
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,

  -- Dates
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  paid_date DATE,

  -- Status
  status invoice_status NOT NULL DEFAULT 'DRAFT',

  -- Amounts
  subtotal DECIMAL(15, 2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(15, 2) DEFAULT 0,
  tax_amount DECIMAL(15, 2) DEFAULT 0,
  total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(15, 2) DEFAULT 0,
  remaining_amount DECIMAL(15, 2) GENERATED ALWAYS AS (total_amount - COALESCE(paid_amount, 0)) STORED,

  -- Previous debt
  previous_debt DECIMAL(15, 2) DEFAULT 0,

  -- Metadata
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT invoices_period_valid CHECK (billing_period_start <= billing_period_end),
  CONSTRAINT invoices_total_amount_non_negative CHECK (total_amount >= 0),
  CONSTRAINT invoices_paid_amount_valid CHECK (paid_amount >= 0 AND paid_amount <= total_amount + 1000), -- Allow small overpayment
  CONSTRAINT invoices_discount_non_negative CHECK (discount_amount >= 0),
  CONSTRAINT invoices_tax_non_negative CHECK (tax_amount >= 0)
);

-- Indexes
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_contract_id ON invoices(contract_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_issue_date ON invoices(issue_date);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_billing_period ON invoices(billing_period_start, billing_period_end);
CREATE INDEX idx_invoices_deleted_at ON invoices(deleted_at);
CREATE INDEX idx_invoices_invoice_number ON invoices(invoice_number);

-- Full-text search
CREATE INDEX idx_invoices_search ON invoices USING GIN (
  to_tsvector('simple', coalesce(invoice_number, '') || ' ' || coalesce(title, '') || ' ' || coalesce(notes, ''))
);

-- RLS Policies
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own invoices"
  ON invoices FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own invoices"
  ON invoices FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own invoices"
  ON invoices FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own invoices"
  ON invoices FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE invoices IS 'Monthly invoices for rent and services';


-- =============================================
-- 2. INVOICE_ITEMS TABLE
-- =============================================

CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

  -- Item info
  type invoice_item_type NOT NULL,
  service_id UUID REFERENCES services(id), -- NULL if not a service
  description TEXT NOT NULL,

  -- Calculation
  quantity DECIMAL(10, 2) DEFAULT 1,
  unit_price DECIMAL(15, 2) NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,

  -- For meter reading services
  previous_reading DECIMAL(10, 2),
  current_reading DECIMAL(10, 2),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT invoice_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT invoice_items_unit_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT invoice_items_amount_non_negative CHECK (amount >= 0)
);

-- Indexes
CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_service_id ON invoice_items(service_id);
CREATE INDEX idx_invoice_items_type ON invoice_items(type);

-- RLS Policies
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view invoice items"
  ON invoice_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
        AND invoices.user_id = auth.uid()
        AND invoices.deleted_at IS NULL
    )
  );

CREATE POLICY "Users can insert invoice items"
  ON invoice_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
        AND invoices.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update invoice items"
  ON invoice_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
        AND invoices.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete invoice items"
  ON invoice_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
        AND invoices.user_id = auth.uid()
    )
  );

-- Comments
COMMENT ON TABLE invoice_items IS 'Line items within invoices (rent, services, penalties, etc.)';


-- =============================================
-- 3. PAYMENTS TABLE
-- =============================================

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,

  -- Payment info
  receipt_number TEXT,
  amount DECIMAL(15, 2) NOT NULL,
  payment_method payment_method NOT NULL DEFAULT 'CASH',
  payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT payments_amount_positive CHECK (amount > 0)
);

-- Indexes
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX idx_payments_payment_date ON payments(payment_date);
CREATE INDEX idx_payments_payment_method ON payments(payment_method);
CREATE INDEX idx_payments_receipt_number ON payments(receipt_number);

-- RLS Policies
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payments"
  ON payments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own payments"
  ON payments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own payments"
  ON payments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own payments"
  ON payments FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE payments IS 'Payment records for invoices';


-- =============================================
-- 4. METER_READINGS TABLE
-- =============================================

CREATE TABLE meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  -- Reading info
  meter_type meter_type NOT NULL,
  reading_date DATE NOT NULL,
  previous_reading DECIMAL(10, 2) NOT NULL DEFAULT 0,
  current_reading DECIMAL(10, 2) NOT NULL,
  consumption DECIMAL(10, 2) GENERATED ALWAYS AS (current_reading - previous_reading) STORED,

  -- Metadata
  notes TEXT,
  meter_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT meter_readings_current_gte_previous CHECK (current_reading >= previous_reading)
);

-- Indexes
CREATE INDEX idx_meter_readings_user_id ON meter_readings(user_id);
CREATE INDEX idx_meter_readings_contract_id ON meter_readings(contract_id);
CREATE INDEX idx_meter_readings_service_id ON meter_readings(service_id);
CREATE INDEX idx_meter_readings_reading_date ON meter_readings(reading_date);
CREATE INDEX idx_meter_readings_meter_type ON meter_readings(meter_type);

-- RLS Policies
ALTER TABLE meter_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own meter readings"
  ON meter_readings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own meter readings"
  ON meter_readings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own meter readings"
  ON meter_readings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own meter readings"
  ON meter_readings FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE meter_readings IS 'Meter readings for electricity, water, gas';


-- =============================================
-- 5. EXPENSES TABLE
-- =============================================

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Expense info
  category expense_category NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Links (optional)
  building_id UUID REFERENCES buildings(id) ON DELETE SET NULL,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT expenses_description_not_empty CHECK (char_length(description) > 0)
);

-- Indexes
CREATE INDEX idx_expenses_user_id ON expenses(user_id);
CREATE INDEX idx_expenses_category ON expenses(category);
CREATE INDEX idx_expenses_expense_date ON expenses(expense_date);
CREATE INDEX idx_expenses_building_id ON expenses(building_id);
CREATE INDEX idx_expenses_deleted_at ON expenses(deleted_at);

-- RLS Policies
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own expenses"
  ON expenses FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own expenses"
  ON expenses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own expenses"
  ON expenses FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own expenses"
  ON expenses FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE expenses IS 'Business expenses (maintenance, repairs, utilities, etc.)';


-- Migration completed
-- =============================================
-- Total: 5 tables created (invoices, invoice_items, payments, meter_readings, expenses)
-- Next: 006_asset_issue_tables.sql
