-- =============================================
-- Migration: Invoice Reimplementation
-- Created: 2025-06-01
-- Description: Drop old invoice tables and recreate with new schema
--   - 4 tables: invoices, invoice_items, payments, excess_amounts
--   - 3 RPC functions: generate_invoices_for_building, record_invoice_payment, get_invoice_statistics
--   - RLS policies, triggers, indexes
-- =============================================

-- =============================================
-- 0. DROP OLD TABLES & TRIGGERS & FUNCTIONS
-- =============================================

-- Drop old triggers first
DROP TRIGGER IF EXISTS update_invoice_paid_amount_trigger ON payments;
DROP TRIGGER IF EXISTS generate_invoice_number_trigger ON invoices;
DROP TRIGGER IF EXISTS set_invoices_updated_at ON invoices;
DROP TRIGGER IF EXISTS set_payments_updated_at ON payments;

-- Drop old functions
DROP FUNCTION IF EXISTS update_invoice_paid_amount() CASCADE;
DROP FUNCTION IF EXISTS generate_invoice_number() CASCADE;

-- Drop old RPC functions if they exist
DROP FUNCTION IF EXISTS generate_invoices_for_building(UUID, UUID, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS record_invoice_payment(UUID, UUID, DECIMAL, payment_method, DATE, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS get_invoice_statistics(UUID, UUID, UUID, invoice_status, DATE, DATE) CASCADE;

-- Drop old tables (order matters due to FK constraints)
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS invoice_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS excess_amounts CASCADE;

-- =============================================
-- 1. INVOICES TABLE
-- =============================================

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  bed_id UUID REFERENCES beds(id) ON DELETE SET NULL,

  -- Invoice info
  invoice_number TEXT UNIQUE,
  billing_month TEXT NOT NULL, -- YYYY-MM format

  -- Dates
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  paid_date DATE,

  -- Status
  status invoice_status NOT NULL DEFAULT 'DRAFT',

  -- Amounts
  subtotal DECIMAL(15, 2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  tax_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  prepaid_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  remaining_amount DECIMAL(15, 2) GENERATED ALWAYS AS (total_amount - COALESCE(paid_amount, 0)) STORED,

  -- Previous debt
  previous_debt DECIMAL(15, 2) NOT NULL DEFAULT 0,

  -- Metadata
  notes TEXT,
  template_id UUID REFERENCES document_templates(id) ON DELETE SET NULL,

  -- Approval
  approved_at TIMESTAMPTZ,
  approved_by UUID,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT invoices_total_amount_non_negative CHECK (total_amount >= 0),
  CONSTRAINT invoices_paid_amount_non_negative CHECK (paid_amount >= 0),
  CONSTRAINT invoices_issue_date_lte_due_date CHECK (issue_date <= due_date),
  CONSTRAINT invoices_billing_month_format CHECK (billing_month ~ '^\d{4}-\d{2}$')
);

-- Partial unique index: one invoice per contract per billing month (excluding soft-deleted)
CREATE UNIQUE INDEX idx_invoices_unique_contract_billing
  ON invoices(contract_id, billing_month)
  WHERE deleted_at IS NULL;

-- Indexes for commonly queried columns
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_building_id ON invoices(building_id);
CREATE INDEX idx_invoices_contract_id ON invoices(contract_id);
CREATE INDEX idx_invoices_room_id ON invoices(room_id);
CREATE INDEX idx_invoices_billing_month ON invoices(billing_month);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_deleted_at ON invoices(deleted_at);
CREATE INDEX idx_invoices_issue_date ON invoices(issue_date);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_invoice_number ON invoices(invoice_number);

COMMENT ON TABLE invoices IS 'Invoices for rent and services (reimplemented)';


-- =============================================
-- 2. INVOICE_ITEMS TABLE
-- =============================================

CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,

  -- Item info
  type invoice_item_type NOT NULL,
  description TEXT NOT NULL,

  -- Calculation
  unit_price DECIMAL(15, 2) NOT NULL DEFAULT 0,
  quantity DECIMAL(10, 2) NOT NULL DEFAULT 1,
  coefficient DECIMAL(5, 2) NOT NULL DEFAULT 1,
  amount DECIMAL(15, 2) NOT NULL DEFAULT 0, -- = unit_price * quantity * coefficient

  -- For meter reading services
  previous_reading DECIMAL(10, 2),
  current_reading DECIMAL(10, 2),

  -- Date range
  from_date DATE,
  to_date DATE,

  -- Display order
  sort_order INT NOT NULL DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_service_id ON invoice_items(service_id);
CREATE INDEX idx_invoice_items_type ON invoice_items(type);

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
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT payments_amount_positive CHECK (amount > 0)
);

CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX idx_payments_payment_date ON payments(payment_date);
CREATE INDEX idx_payments_payment_method ON payments(payment_method);

COMMENT ON TABLE payments IS 'Payment records for invoices';


-- =============================================
-- 4. EXCESS_AMOUNTS TABLE
-- =============================================

CREATE TABLE excess_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,

  -- Amount (positive = credit added, negative = credit used)
  amount DECIMAL(15, 2) NOT NULL,
  description TEXT,

  -- Source references
  source_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  source_payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_excess_amounts_user_id ON excess_amounts(user_id);
CREATE INDEX idx_excess_amounts_contract_id ON excess_amounts(contract_id);
CREATE INDEX idx_excess_amounts_source_invoice_id ON excess_amounts(source_invoice_id);

COMMENT ON TABLE excess_amounts IS 'Excess payment tracking per contract (positive = credit, negative = used)';


-- =============================================
-- 5. RLS POLICIES
-- =============================================

-- Invoices RLS
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoices_select_own" ON invoices FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "invoices_insert_own" ON invoices FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "invoices_update_own" ON invoices FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "invoices_delete_own" ON invoices FOR DELETE USING (auth.uid() = user_id);

-- Invoice Items RLS (via invoice user_id)
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_items_select_own" ON invoice_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM invoices WHERE invoices.id = invoice_items.invoice_id AND invoices.user_id = auth.uid()));

CREATE POLICY "invoice_items_insert_own" ON invoice_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM invoices WHERE invoices.id = invoice_items.invoice_id AND invoices.user_id = auth.uid()));

CREATE POLICY "invoice_items_update_own" ON invoice_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM invoices WHERE invoices.id = invoice_items.invoice_id AND invoices.user_id = auth.uid()));

CREATE POLICY "invoice_items_delete_own" ON invoice_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM invoices WHERE invoices.id = invoice_items.invoice_id AND invoices.user_id = auth.uid()));

-- Payments RLS
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_select_own" ON payments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "payments_insert_own" ON payments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "payments_update_own" ON payments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "payments_delete_own" ON payments FOR DELETE USING (auth.uid() = user_id);

-- Excess Amounts RLS
ALTER TABLE excess_amounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "excess_amounts_select_own" ON excess_amounts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "excess_amounts_insert_own" ON excess_amounts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "excess_amounts_update_own" ON excess_amounts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "excess_amounts_delete_own" ON excess_amounts FOR DELETE USING (auth.uid() = user_id);


-- =============================================
-- 6. TRIGGERS - updated_at auto-update
-- =============================================

-- Reuse existing update_updated_at_column() function from 008_triggers_functions.sql

CREATE TRIGGER set_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 7. TRIGGER - Auto-generate invoice number
-- =============================================

CREATE OR REPLACE FUNCTION generate_invoice_number_v2()
RETURNS TRIGGER AS $BODY$
DECLARE
  v_prefix TEXT;
  v_counter INTEGER;
  v_new_number TEXT;
BEGIN
  IF NEW.invoice_number IS NULL THEN
    SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO v_prefix
    FROM settings
    WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

    IF v_prefix IS NULL THEN
      v_prefix := 'INV';
    END IF;

    SELECT COUNT(*) + 1
    INTO v_counter
    FROM invoices
    WHERE user_id = NEW.user_id
      AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

    v_new_number := v_prefix || '-' ||
                    TO_CHAR(NOW(), 'YYYY') || '-' ||
                    LPAD(v_counter::TEXT, 5, '0');

    NEW.invoice_number := v_new_number;
  END IF;

  RETURN NEW;
END;
$BODY$ LANGUAGE plpgsql;

CREATE TRIGGER generate_invoice_number_v2_trigger
  BEFORE INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION generate_invoice_number_v2();


-- =============================================
-- 8. RPC FUNCTION: generate_invoices_for_building
-- =============================================

CREATE OR REPLACE FUNCTION generate_invoices_for_building(
  p_user_id UUID,
  p_building_id UUID,
  p_billing_month TEXT,
  p_invoice_type TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_contract RECORD;
  v_service RECORD;
  v_invoice_id UUID;
  v_created_count INT := 0;
  v_skipped_contracts JSON[] := ARRAY[]::JSON[];
  v_subtotal DECIMAL(15, 2);
  v_item_amount DECIMAL(15, 2);
  v_sort_order INT;
BEGIN
  IF p_invoice_type NOT IN ('rent_only', 'service_only', 'both') THEN
    RAISE EXCEPTION 'Invalid invoice_type: %. Must be rent_only, service_only, or both', p_invoice_type;
  END IF;

  IF p_billing_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Invalid billing_month format: %. Must be YYYY-MM', p_billing_month;
  END IF;

  FOR v_contract IN
    SELECT c.id AS contract_id, c.user_id, c.room_id, c.bed_id, c.rent_price, r.building_id
    FROM contracts c
    JOIN rooms r ON r.id = c.room_id
    WHERE c.user_id = p_user_id
      AND r.building_id = p_building_id
      AND c.status = 'ACTIVE'
      AND c.deleted_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM invoices
      WHERE contract_id = v_contract.contract_id
        AND billing_month = p_billing_month
        AND deleted_at IS NULL
    ) THEN
      v_skipped_contracts := array_append(
        v_skipped_contracts,
        json_build_object('contract_id', v_contract.contract_id, 'reason', 'Invoice already exists')
      );
      CONTINUE;
    END IF;

    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date, status, subtotal, total_amount
    ) VALUES (
      p_user_id, v_contract.contract_id, v_contract.building_id,
      v_contract.room_id, v_contract.bed_id,
      p_billing_month, CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days', 'DRAFT', 0, 0
    )
    RETURNING id INTO v_invoice_id;

    v_subtotal := 0;
    v_sort_order := 0;

    IF p_invoice_type IN ('rent_only', 'both') THEN
      v_item_amount := v_contract.rent_price;
      v_sort_order := v_sort_order + 1;

      INSERT INTO invoice_items (
        invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order
      ) VALUES (
        v_invoice_id, 'RENT', 'Tiền thuê phòng',
        v_contract.rent_price, 1, 1, v_item_amount, v_sort_order
      );

      v_subtotal := v_subtotal + v_item_amount;
    END IF;

    IF p_invoice_type IN ('service_only', 'both') THEN
      FOR v_service IN
        SELECT cs.service_id, cs.unit_price, s.name AS service_name, s.type AS service_type
        FROM contract_services cs
        JOIN services s ON s.id = cs.service_id
        WHERE cs.contract_id = v_contract.contract_id
      LOOP
        v_sort_order := v_sort_order + 1;
        v_item_amount := v_service.unit_price;

        INSERT INTO invoice_items (
          invoice_id, service_id, type, description,
          unit_price, quantity, coefficient, amount, sort_order
        ) VALUES (
          v_invoice_id, v_service.service_id, 'SERVICE', v_service.service_name,
          v_service.unit_price, 1, 1, v_item_amount, v_sort_order
        );

        v_subtotal := v_subtotal + v_item_amount;
      END LOOP;
    END IF;

    UPDATE invoices
    SET subtotal = v_subtotal, total_amount = v_subtotal
    WHERE id = v_invoice_id;

    v_created_count := v_created_count + 1;
  END LOOP;

  RETURN json_build_object(
    'created_count', v_created_count,
    'skipped_contracts', to_json(v_skipped_contracts)
  );
END;
$BODY$;

COMMENT ON FUNCTION generate_invoices_for_building IS 'Generate invoices for all active contracts in a building for a given billing month';


-- =============================================
-- 9. RPC FUNCTION: record_invoice_payment
-- =============================================

CREATE OR REPLACE FUNCTION record_invoice_payment(
  p_user_id UUID,
  p_invoice_id UUID,
  p_amount DECIMAL,
  p_payment_method payment_method,
  p_payment_date DATE,
  p_notes TEXT DEFAULT NULL,
  p_receipt_image_url TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_invoice RECORD;
  v_payment_id UUID;
  v_new_paid_amount DECIMAL(15, 2);
  v_remaining DECIMAL(15, 2);
  v_excess DECIMAL(15, 2);
  v_new_status invoice_status;
  v_paid_date DATE;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  SELECT id, user_id, contract_id, total_amount, paid_amount, remaining_amount, status
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND user_id = p_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found or access denied';
  END IF;

  INSERT INTO payments (
    user_id, invoice_id, amount, payment_method, payment_date, notes, receipt_image_url
  ) VALUES (
    p_user_id, p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url
  )
  RETURNING id INTO v_payment_id;

  v_new_paid_amount := COALESCE(v_invoice.paid_amount, 0) + p_amount;
  v_remaining := v_invoice.total_amount - v_new_paid_amount;

  IF v_new_paid_amount >= v_invoice.total_amount THEN
    v_new_status := 'PAID';
    v_paid_date := p_payment_date;
    v_excess := v_new_paid_amount - v_invoice.total_amount;

    IF v_excess > 0 THEN
      INSERT INTO excess_amounts (
        user_id, contract_id, amount, description,
        source_invoice_id, source_payment_id
      ) VALUES (
        p_user_id, v_invoice.contract_id, v_excess,
        'Tiền thừa từ hoá đơn ' || (SELECT invoice_number FROM invoices WHERE id = p_invoice_id),
        p_invoice_id, v_payment_id
      );
    END IF;
  ELSE
    v_new_status := 'PARTIAL_PAID';
    v_paid_date := NULL;
    v_excess := 0;
  END IF;

  UPDATE invoices
  SET paid_amount = v_new_paid_amount,
      status = v_new_status,
      paid_date = v_paid_date
  WHERE id = p_invoice_id;

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'new_paid_amount', v_new_paid_amount,
    'new_status', v_new_status,
    'excess_amount', v_excess
  );
END;
$BODY$;

COMMENT ON FUNCTION record_invoice_payment IS 'Record a payment for an invoice, auto-handle excess amounts';


-- =============================================
-- 10. RPC FUNCTION: get_invoice_statistics
-- =============================================

CREATE OR REPLACE FUNCTION get_invoice_statistics(
  p_user_id UUID,
  p_building_id UUID DEFAULT NULL,
  p_room_id UUID DEFAULT NULL,
  p_status invoice_status DEFAULT NULL,
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_total_paid DECIMAL(15, 2);
  v_total_remaining DECIMAL(15, 2);
  v_total_count BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(remaining_amount), 0),
    COUNT(*)
  INTO v_total_paid, v_total_remaining, v_total_count
  FROM invoices
  WHERE user_id = p_user_id
    AND deleted_at IS NULL
    AND (p_building_id IS NULL OR building_id = p_building_id)
    AND (p_room_id IS NULL OR room_id = p_room_id)
    AND (p_status IS NULL OR status = p_status)
    AND (p_start_date IS NULL OR issue_date >= p_start_date)
    AND (p_end_date IS NULL OR issue_date <= p_end_date);

  RETURN json_build_object(
    'total_paid', v_total_paid,
    'total_remaining', v_total_remaining,
    'total_count', v_total_count
  );
END;
$BODY$;

COMMENT ON FUNCTION get_invoice_statistics IS 'Get aggregated invoice statistics with optional filters';


-- =============================================
-- Migration completed
-- =============================================
-- Tables: invoices, invoice_items, payments, excess_amounts
-- RPC Functions: generate_invoices_for_building, record_invoice_payment, get_invoice_statistics
-- Triggers: updated_at auto-update, invoice number generation
-- RLS: All 4 tables with user_id = auth.uid() policies
-- Indexes: user_id, building_id, contract_id, billing_month, status, deleted_at
