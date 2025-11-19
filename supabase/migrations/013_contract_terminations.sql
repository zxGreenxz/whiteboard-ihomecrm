-- =============================================
-- Migration 013: Contract Terminations
-- Created: 2025-11-19
-- Description: Handle contract termination with automatic financial calculations
-- =============================================

-- =============================================
-- 1. CONTRACT_TERMINATIONS TABLE
-- =============================================
-- Tracks contract termination details and financial settlements

CREATE TABLE contract_terminations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,

  -- Termination dates
  termination_date DATE NOT NULL DEFAULT CURRENT_DATE,
  actual_move_out_date DATE NOT NULL,
  notice_date DATE, -- When tenant gave notice

  -- Termination type
  termination_type TEXT NOT NULL CHECK (
    termination_type IN (
      'NORMAL',           -- Hết hạn bình thường
      'EARLY_TENANT',     -- Khách rời sớm
      'EARLY_OWNER',      -- Chủ nhà chấm dứt sớm
      'BREACH',           -- Vi phạm hợp đồng
      'FORFEIT'           -- Bỏ cọc
    )
  ),

  -- ================================================
  -- AUTOMATIC CALCULATIONS (populated by trigger)
  -- ================================================

  -- Outstanding debts from unpaid invoices
  outstanding_debt DECIMAL(15,2) DEFAULT 0,

  -- Prorated rent for partial month
  prorated_days INTEGER DEFAULT 0,
  prorated_rent DECIMAL(15,2) DEFAULT 0,

  -- Service charges for partial month
  prorated_services DECIMAL(15,2) DEFAULT 0,

  -- ================================================
  -- MANUAL INPUTS (entered by staff)
  -- ================================================

  -- Penalty fees
  early_termination_fee DECIMAL(15,2) DEFAULT 0,
  notice_violation_fee DECIMAL(15,2) DEFAULT 0, -- Didn't give proper notice

  -- Damage and repairs
  damage_fee DECIMAL(15,2) DEFAULT 0,
  damage_description TEXT,
  damage_images JSONB DEFAULT '[]'::jsonb,

  -- Cleaning and maintenance
  cleaning_fee DECIMAL(15,2) DEFAULT 0,
  other_fees DECIMAL(15,2) DEFAULT 0,
  other_fees_description TEXT,

  -- ================================================
  -- DEPOSIT SETTLEMENT
  -- ================================================

  total_deposit DECIMAL(15,2) NOT NULL, -- From contract

  -- Total deductions = debt + prorated + fees + damages
  total_deductions DECIMAL(15,2) GENERATED ALWAYS AS (
    COALESCE(outstanding_debt, 0) +
    COALESCE(prorated_rent, 0) +
    COALESCE(prorated_services, 0) +
    COALESCE(early_termination_fee, 0) +
    COALESCE(notice_violation_fee, 0) +
    COALESCE(damage_fee, 0) +
    COALESCE(cleaning_fee, 0) +
    COALESCE(other_fees, 0)
  ) STORED,

  -- Net amount to refund (or collect if negative)
  refund_amount DECIMAL(15,2) GENERATED ALWAYS AS (
    total_deposit - (
      COALESCE(outstanding_debt, 0) +
      COALESCE(prorated_rent, 0) +
      COALESCE(prorated_services, 0) +
      COALESCE(early_termination_fee, 0) +
      COALESCE(notice_violation_fee, 0) +
      COALESCE(damage_fee, 0) +
      COALESCE(cleaning_fee, 0) +
      COALESCE(other_fees, 0)
    )
  ) STORED,

  -- Refund details
  refund_method payment_method,
  refund_date DATE,
  refund_receipt_url TEXT,

  -- Approval workflow
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED')
  ),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,

  -- Notes
  notes TEXT,
  internal_notes TEXT, -- Private staff notes

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT terminations_refund_method_required_if_refund CHECK (
    (refund_amount <= 0) OR (refund_method IS NOT NULL)
  )
  -- Note: Move-out date validation is done in trigger (can't use subquery in CHECK constraint)
);

-- Indexes
CREATE INDEX idx_terminations_user_id ON contract_terminations(user_id);
CREATE INDEX idx_terminations_contract_id ON contract_terminations(contract_id);
CREATE INDEX idx_terminations_termination_date ON contract_terminations(termination_date);
CREATE INDEX idx_terminations_status ON contract_terminations(status);
CREATE INDEX idx_terminations_type ON contract_terminations(termination_type);

-- Unique constraint: One termination per contract
CREATE UNIQUE INDEX idx_terminations_unique_contract
  ON contract_terminations(contract_id);

-- RLS Policies
ALTER TABLE contract_terminations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own terminations"
  ON contract_terminations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own terminations"
  ON contract_terminations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own terminations"
  ON contract_terminations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own terminations"
  ON contract_terminations FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE contract_terminations IS 'Contract termination records with automatic financial calculations';
COMMENT ON COLUMN contract_terminations.outstanding_debt IS 'Auto-calculated from unpaid invoices';
COMMENT ON COLUMN contract_terminations.prorated_rent IS 'Auto-calculated rent for partial month';
COMMENT ON COLUMN contract_terminations.refund_amount IS 'Auto-calculated: deposit - all deductions (negative = tenant owes money)';


-- =============================================
-- 2. FUNCTION: Auto-calculate termination financials
-- =============================================

CREATE OR REPLACE FUNCTION auto_calculate_termination_financials()
RETURNS TRIGGER AS $$
DECLARE
  v_contract RECORD;
  v_contract_start_date DATE;
  v_contract_end_date DATE;
  v_rent_price DECIMAL(15,2);
  v_total_deposit DECIMAL(15,2);
  v_outstanding DECIMAL(15,2);
  v_days_in_month INTEGER;
  v_daily_rate DECIMAL(15,2);
  v_prorated_days INTEGER;
BEGIN
  -- Get contract details
  SELECT
    c.start_date,
    c.end_date,
    c.rent_price,
    c.total_deposit,
    c.id
  INTO v_contract
  FROM contracts c
  WHERE c.id = NEW.contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found: %', NEW.contract_id;
  END IF;

  v_contract_start_date := v_contract.start_date;
  v_contract_end_date := v_contract.end_date;
  v_rent_price := v_contract.rent_price;
  v_total_deposit := v_contract.total_deposit;

  -- Validate: Move-out date must be >= contract start date
  IF NEW.actual_move_out_date < v_contract_start_date THEN
    RAISE EXCEPTION 'Move-out date (%) cannot be before contract start date (%)',
      NEW.actual_move_out_date, v_contract_start_date;
  END IF;

  -- ================================================
  -- 1. Calculate outstanding debt from unpaid invoices
  -- ================================================
  SELECT COALESCE(SUM(remaining_amount), 0)
  INTO v_outstanding
  FROM invoices
  WHERE contract_id = NEW.contract_id
    AND status NOT IN ('PAID', 'CANCELLED')
    AND deleted_at IS NULL;

  NEW.outstanding_debt := v_outstanding;

  -- ================================================
  -- 2. Calculate prorated rent for partial month
  -- ================================================
  -- Get the billing month
  v_days_in_month := EXTRACT(DAY FROM (
    DATE_TRUNC('month', NEW.actual_move_out_date) + INTERVAL '1 month - 1 day'
  ));

  v_daily_rate := v_rent_price / v_days_in_month;

  -- Calculate days used in the final month
  v_prorated_days := EXTRACT(DAY FROM NEW.actual_move_out_date);

  -- Only charge prorated rent if moving out before month end
  IF v_prorated_days < v_days_in_month THEN
    NEW.prorated_days := v_prorated_days;
    NEW.prorated_rent := v_daily_rate * v_prorated_days;
  ELSE
    NEW.prorated_days := 0;
    NEW.prorated_rent := 0;
  END IF;

  -- ================================================
  -- 3. Set total deposit from contract
  -- ================================================
  NEW.total_deposit := v_total_deposit;

  -- ================================================
  -- 4. Calculate prorated services (simple estimation)
  -- ================================================
  -- This is a simplified calculation
  -- In production, you'd want to read actual meter readings
  SELECT COALESCE(SUM(cs.unit_price *
    CASE s.type
      WHEN 'FIXED' THEN (v_prorated_days::DECIMAL / v_days_in_month)
      WHEN 'PER_PERSON' THEN 1
      WHEN 'PER_ROOM' THEN (v_prorated_days::DECIMAL / v_days_in_month)
      ELSE 0
    END
  ), 0)
  INTO NEW.prorated_services
  FROM contract_services cs
  JOIN services s ON s.id = cs.service_id
  WHERE cs.contract_id = NEW.contract_id
    AND s.type != 'METER_READING'; -- Meter readings handled separately

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_calculate_termination_financials() IS
'Auto-calculates outstanding debt, prorated rent, and services when creating termination record';


-- =============================================
-- 3. TRIGGER: Calculate termination financials
-- =============================================

DROP TRIGGER IF EXISTS trigger_auto_calculate_termination_financials ON contract_terminations;

CREATE TRIGGER trigger_auto_calculate_termination_financials
  BEFORE INSERT OR UPDATE ON contract_terminations
  FOR EACH ROW
  EXECUTE FUNCTION auto_calculate_termination_financials();


-- =============================================
-- 4. FUNCTION: Update contract when termination is approved
-- =============================================

CREATE OR REPLACE FUNCTION update_contract_on_termination_approved()
RETURNS TRIGGER AS $$
BEGIN
  -- When termination is approved, update the contract
  IF TG_OP = 'UPDATE' AND OLD.status != 'APPROVED' AND NEW.status = 'APPROVED' THEN
    UPDATE contracts
    SET
      status = 'TERMINATED',
      actual_end_date = NEW.actual_move_out_date,
      updated_at = NOW()
    WHERE id = NEW.contract_id;

    -- Record approval timestamp
    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_contract_on_termination_approved() IS
'Updates contract status to TERMINATED when termination record is approved';


-- =============================================
-- 5. TRIGGER: Apply contract termination
-- =============================================

DROP TRIGGER IF EXISTS trigger_update_contract_on_termination ON contract_terminations;

CREATE TRIGGER trigger_update_contract_on_termination
  BEFORE UPDATE OF status ON contract_terminations
  FOR EACH ROW
  EXECUTE FUNCTION update_contract_on_termination_approved();


-- =============================================
-- 6. HELPER FUNCTION: Quick termination estimate
-- =============================================
-- This function can be called from frontend to show estimate before creating termination

CREATE OR REPLACE FUNCTION estimate_termination_costs(
  p_contract_id UUID,
  p_move_out_date DATE,
  p_damage_fee DECIMAL DEFAULT 0,
  p_cleaning_fee DECIMAL DEFAULT 0,
  p_early_termination_fee DECIMAL DEFAULT 0
)
RETURNS TABLE (
  outstanding_debt DECIMAL(15,2),
  prorated_rent DECIMAL(15,2),
  prorated_services DECIMAL(15,2),
  total_fees DECIMAL(15,2),
  total_deposit DECIMAL(15,2),
  refund_amount DECIMAL(15,2)
) AS $$
DECLARE
  v_contract RECORD;
  v_outstanding DECIMAL(15,2);
  v_prorated_rent DECIMAL(15,2);
  v_prorated_services DECIMAL(15,2);
  v_days_in_month INTEGER;
  v_daily_rate DECIMAL(15,2);
  v_prorated_days INTEGER;
BEGIN
  -- Get contract
  SELECT c.rent_price, c.total_deposit
  INTO v_contract
  FROM contracts c
  WHERE c.id = p_contract_id;

  -- Calculate outstanding
  SELECT COALESCE(SUM(remaining_amount), 0)
  INTO v_outstanding
  FROM invoices
  WHERE contract_id = p_contract_id
    AND status NOT IN ('PAID', 'CANCELLED')
    AND deleted_at IS NULL;

  -- Calculate prorated rent
  v_days_in_month := EXTRACT(DAY FROM (
    DATE_TRUNC('month', p_move_out_date) + INTERVAL '1 month - 1 day'
  ));
  v_daily_rate := v_contract.rent_price / v_days_in_month;
  v_prorated_days := EXTRACT(DAY FROM p_move_out_date);

  IF v_prorated_days < v_days_in_month THEN
    v_prorated_rent := v_daily_rate * v_prorated_days;
  ELSE
    v_prorated_rent := 0;
  END IF;

  -- Estimate services (simplified)
  v_prorated_services := 0; -- Could be enhanced

  -- Return results
  RETURN QUERY SELECT
    v_outstanding,
    v_prorated_rent,
    v_prorated_services,
    p_damage_fee + p_cleaning_fee + p_early_termination_fee,
    v_contract.total_deposit,
    v_contract.total_deposit - (
      v_outstanding + v_prorated_rent + v_prorated_services +
      p_damage_fee + p_cleaning_fee + p_early_termination_fee
    );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION estimate_termination_costs IS
'Returns estimated termination costs for a contract - useful for showing preview before creating termination';


-- Migration completed
-- =============================================
-- Summary:
-- - Created contract_terminations table with auto-calculations
-- - Auto-calculates: outstanding_debt, prorated_rent, prorated_services
-- - Auto-calculates: total_deductions and refund_amount (GENERATED columns)
-- - Updates contract.status to TERMINATED when termination approved
-- - Helper function estimate_termination_costs() for preview
--
-- Workflow:
-- 1. Staff creates termination record (status = DRAFT)
-- 2. System auto-calculates financials
-- 3. Staff reviews and adds manual fees (damage, cleaning, etc.)
-- 4. Staff approves (status = APPROVED)
-- 5. Contract.status → TERMINATED, room/bed → AVAILABLE
-- 6. Staff processes refund (if refund_amount > 0) or collects debt (if negative)
-- =============================================
