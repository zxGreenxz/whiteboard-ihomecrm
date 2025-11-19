-- =============================================
-- Migration 015: Contract Extensions
-- Created: 2025-11-19
-- Description: Handle contract extensions (gia hạn hợp đồng)
-- =============================================

-- =============================================
-- 1. CONTRACT_EXTENSIONS TABLE
-- =============================================
-- Tracks contract extension history
-- Supports TWO approaches:
-- - Simple: Just update end_date of existing contract
-- - Complex: Create new contract linked to parent

CREATE TABLE contract_extensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,

  -- Extension details
  extension_date DATE NOT NULL DEFAULT CURRENT_DATE,
  extension_type TEXT NOT NULL CHECK (
    extension_type IN (
      'UPDATE_EXISTING',  -- Just extend end_date of current contract
      'CREATE_NEW'        -- Create new contract (for tracking history)
    )
  ),

  -- Old contract info (for audit)
  old_end_date DATE NOT NULL,

  -- Extension period
  extension_months INTEGER NOT NULL CHECK (extension_months > 0),
  new_end_date DATE NOT NULL,

  -- Pricing changes (NULL = keep existing)
  new_rent_price DECIMAL(15,2),
  rent_price_changed BOOLEAN DEFAULT FALSE,

  -- Deposit changes (NULL = keep existing)
  new_deposit DECIMAL(15,2),
  additional_deposit_required DECIMAL(15,2) DEFAULT 0, -- If deposit increased
  deposit_changed BOOLEAN DEFAULT FALSE,

  -- Service changes
  services_changed BOOLEAN DEFAULT FALSE,
  new_services JSONB DEFAULT '[]'::jsonb,
  -- Format: [{"service_id": "uuid", "unit_price": 3000}, ...]

  -- New contract reference (if extension_type = 'CREATE_NEW')
  new_contract_id UUID REFERENCES contracts(id),

  -- Status
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'APPROVED', 'COMPLETED', 'CANCELLED')
  ),

  -- Approval
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,

  -- Notes
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT extensions_new_end_after_old CHECK (new_end_date > old_end_date),
  CONSTRAINT extensions_new_contract_required CHECK (
    extension_type != 'CREATE_NEW' OR new_contract_id IS NOT NULL
  )
);

-- Indexes
CREATE INDEX idx_extensions_user_id ON contract_extensions(user_id);
CREATE INDEX idx_extensions_contract_id ON contract_extensions(contract_id);
CREATE INDEX idx_extensions_extension_date ON contract_extensions(extension_date);
CREATE INDEX idx_extensions_status ON contract_extensions(status);
CREATE INDEX idx_extensions_type ON contract_extensions(extension_type);
CREATE INDEX idx_extensions_new_contract_id ON contract_extensions(new_contract_id);

-- RLS Policies
ALTER TABLE contract_extensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own extensions"
  ON contract_extensions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own extensions"
  ON contract_extensions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own extensions"
  ON contract_extensions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own extensions"
  ON contract_extensions FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE contract_extensions IS 'Contract extension records tracking renewal history';
COMMENT ON COLUMN contract_extensions.extension_type IS 'UPDATE_EXISTING: extend current contract, CREATE_NEW: create new linked contract';
COMMENT ON COLUMN contract_extensions.new_services IS 'JSONB array of new services: [{"service_id": "uuid", "unit_price": 3000}]';


-- =============================================
-- 2. FUNCTION: Apply contract extension (UPDATE_EXISTING type)
-- =============================================

CREATE OR REPLACE FUNCTION apply_contract_extension_update()
RETURNS TRIGGER AS $$
DECLARE
  v_contract RECORD;
BEGIN
  -- Only apply when approved
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN

    -- Only for UPDATE_EXISTING type
    IF NEW.extension_type = 'UPDATE_EXISTING' THEN

      -- Get current contract
      SELECT * INTO v_contract FROM contracts WHERE id = NEW.contract_id;

      -- ================================================
      -- Update existing contract
      -- ================================================
      UPDATE contracts
      SET
        end_date = NEW.new_end_date,
        rent_price = COALESCE(NEW.new_rent_price, rent_price),
        total_deposit = COALESCE(NEW.new_deposit, total_deposit),
        status = 'EXTENDED', -- Mark as extended
        updated_at = NOW()
      WHERE id = NEW.contract_id;

      -- ================================================
      -- Update services if changed
      -- ================================================
      IF NEW.services_changed AND NEW.new_services IS NOT NULL THEN
        -- Delete old services
        DELETE FROM contract_services WHERE contract_id = NEW.contract_id;

        -- Insert new services
        INSERT INTO contract_services (contract_id, service_id, unit_price)
        SELECT
          NEW.contract_id,
          (service->>'service_id')::UUID,
          (service->>'unit_price')::DECIMAL(15,2)
        FROM jsonb_array_elements(NEW.new_services) AS service;
      END IF;

    END IF;

    -- Record approval
    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
    NEW.status := 'COMPLETED';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apply_contract_extension_update() IS
'Applies contract extension by updating existing contract (UPDATE_EXISTING type)';


-- =============================================
-- 3. TRIGGER: Apply extension update
-- =============================================

DROP TRIGGER IF EXISTS trigger_apply_contract_extension_update ON contract_extensions;

CREATE TRIGGER trigger_apply_contract_extension_update
  BEFORE UPDATE OF status ON contract_extensions
  FOR EACH ROW
  EXECUTE FUNCTION apply_contract_extension_update();


-- =============================================
-- 4. HELPER FUNCTION: Create simple extension (most common)
-- =============================================

CREATE OR REPLACE FUNCTION create_simple_extension(
  p_contract_id UUID,
  p_extension_months INTEGER,
  p_new_rent_price DECIMAL DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_contract RECORD;
  v_new_end_date DATE;
  v_extension_id UUID;
BEGIN
  -- Get current contract
  SELECT * INTO v_contract
  FROM contracts
  WHERE id = p_contract_id
    AND status = 'ACTIVE'
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found or not active';
  END IF;

  -- Calculate new end date
  v_new_end_date := v_contract.end_date + (p_extension_months || ' months')::INTERVAL;

  -- Create extension record
  INSERT INTO contract_extensions (
    user_id,
    contract_id,
    extension_type,
    old_end_date,
    extension_months,
    new_end_date,
    new_rent_price,
    rent_price_changed,
    notes,
    status
  ) VALUES (
    auth.uid(),
    p_contract_id,
    'UPDATE_EXISTING',
    v_contract.end_date,
    p_extension_months,
    v_new_end_date,
    p_new_rent_price,
    (p_new_rent_price IS NOT NULL AND p_new_rent_price != v_contract.rent_price),
    p_notes,
    'DRAFT'
  )
  RETURNING id INTO v_extension_id;

  RETURN v_extension_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION create_simple_extension IS
'Helper to create simple contract extension (UPDATE_EXISTING type)';


-- =============================================
-- 5. HELPER FUNCTION: Create new contract extension
-- =============================================
-- For cases where you want to create a completely new contract
-- while marking the old one as EXTENDED

CREATE OR REPLACE FUNCTION create_new_contract_extension(
  p_contract_id UUID,
  p_extension_months INTEGER,
  p_new_rent_price DECIMAL DEFAULT NULL,
  p_new_deposit DECIMAL DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_old_contract RECORD;
  v_new_contract_id UUID;
  v_extension_id UUID;
  v_new_end_date DATE;
  v_new_start_date DATE;
BEGIN
  -- Get current contract
  SELECT * INTO v_old_contract
  FROM contracts
  WHERE id = p_contract_id
    AND status = 'ACTIVE'
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found or not active';
  END IF;

  -- Calculate new dates
  v_new_start_date := v_old_contract.end_date + INTERVAL '1 day';
  v_new_end_date := v_new_start_date + (p_extension_months || ' months')::INTERVAL;

  -- ================================================
  -- Create new contract (clone of old one)
  -- ================================================
  INSERT INTO contracts (
    user_id,
    tenant_id,
    room_id,
    bed_id,
    contract_number, -- Will be auto-generated by trigger
    status,
    signed_date,
    start_date,
    end_date,
    rent_price,
    payment_cycle,
    total_deposit,
    deposit_paid,
    parent_contract_id, -- Link to old contract
    notes
  ) VALUES (
    v_old_contract.user_id,
    v_old_contract.tenant_id,
    v_old_contract.room_id,
    v_old_contract.bed_id,
    NULL, -- Auto-generated
    'ACTIVE',
    CURRENT_DATE,
    v_new_start_date,
    v_new_end_date,
    COALESCE(p_new_rent_price, v_old_contract.rent_price),
    v_old_contract.payment_cycle,
    COALESCE(p_new_deposit, v_old_contract.total_deposit),
    COALESCE(p_new_deposit, v_old_contract.total_deposit), -- Assuming deposit carried over
    p_contract_id, -- Parent contract
    'Gia hạn từ HĐ: ' || COALESCE(v_old_contract.contract_number, p_contract_id::TEXT)
  )
  RETURNING id INTO v_new_contract_id;

  -- Copy services from old contract
  INSERT INTO contract_services (contract_id, service_id, unit_price)
  SELECT v_new_contract_id, service_id, unit_price
  FROM contract_services
  WHERE contract_id = p_contract_id;

  -- ================================================
  -- Mark old contract as EXTENDED
  -- ================================================
  UPDATE contracts
  SET status = 'EXTENDED', updated_at = NOW()
  WHERE id = p_contract_id;

  -- ================================================
  -- Create extension record
  -- ================================================
  INSERT INTO contract_extensions (
    user_id,
    contract_id,
    extension_type,
    old_end_date,
    extension_months,
    new_end_date,
    new_rent_price,
    rent_price_changed,
    new_deposit,
    deposit_changed,
    new_contract_id,
    notes,
    status
  ) VALUES (
    auth.uid(),
    p_contract_id,
    'CREATE_NEW',
    v_old_contract.end_date,
    p_extension_months,
    v_new_end_date,
    p_new_rent_price,
    (p_new_rent_price IS NOT NULL AND p_new_rent_price != v_old_contract.rent_price),
    p_new_deposit,
    (p_new_deposit IS NOT NULL AND p_new_deposit != v_old_contract.total_deposit),
    v_new_contract_id,
    p_notes,
    'COMPLETED' -- Auto-completed
  )
  RETURNING id INTO v_extension_id;

  RETURN v_new_contract_id; -- Return new contract ID
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION create_new_contract_extension IS
'Creates a brand new contract as extension (CREATE_NEW type) - preserves full history';


-- =============================================
-- 6. HELPER VIEW: Extension history
-- =============================================

CREATE OR REPLACE VIEW contract_extension_history AS
SELECT
  ce.id AS extension_id,
  ce.contract_id,
  c.contract_number,
  c.tenant_id,
  t.full_name AS tenant_name,
  ce.extension_type,
  ce.extension_date,
  ce.old_end_date,
  ce.new_end_date,
  ce.extension_months,
  ce.rent_price_changed,
  COALESCE(ce.new_rent_price, c.rent_price) AS rent_price,
  ce.status,
  ce.approved_at,
  ce.created_at
FROM contract_extensions ce
JOIN contracts c ON c.id = ce.contract_id
JOIN tenants t ON t.id = c.tenant_id
WHERE ce.status != 'CANCELLED'
ORDER BY ce.extension_date DESC;

COMMENT ON VIEW contract_extension_history IS
'Summary view of all contract extensions with tenant info';


-- =============================================
-- 7. HELPER FUNCTION: Get extension count for contract
-- =============================================

CREATE OR REPLACE FUNCTION get_contract_extension_count(p_contract_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO v_count
  FROM contract_extensions
  WHERE contract_id = p_contract_id
    AND status = 'COMPLETED';

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_contract_extension_count IS
'Returns number of times a contract has been extended';


-- Migration completed
-- =============================================
-- Summary:
-- - Created contract_extensions table to track renewal history
-- - Supports TWO extension approaches:
--   1. UPDATE_EXISTING: Simple, just extends end_date
--   2. CREATE_NEW: Creates new contract linked to parent
--
-- Helper Functions:
-- - create_simple_extension(): Quick extension (most common)
-- - create_new_contract_extension(): Full new contract with history
-- - get_contract_extension_count(): Count extensions
--
-- View:
-- - contract_extension_history: Summary of all extensions
--
-- Workflows:
--
-- A. SIMPLE EXTENSION (Recommended for most cases):
-- 1. Call create_simple_extension(contract_id, months, new_price)
-- 2. Returns extension_id with status = 'DRAFT'
-- 3. Review and approve
-- 4. Trigger updates contract.end_date and contract.status = 'EXTENDED'
--
-- B. NEW CONTRACT EXTENSION (For strict audit requirements):
-- 1. Call create_new_contract_extension(contract_id, months, new_price)
-- 2. Creates brand new contract with parent_contract_id link
-- 3. Old contract.status = 'EXTENDED'
-- 4. New contract.status = 'ACTIVE'
-- 5. Full history preserved
--
-- Notes:
-- - Simple extension is faster and cleaner
-- - New contract extension gives complete audit trail
-- - Choose based on business requirements
-- =============================================
