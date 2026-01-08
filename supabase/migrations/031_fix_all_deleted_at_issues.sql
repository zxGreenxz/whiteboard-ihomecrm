-- =============================================
-- Migration 031: Comprehensive deleted_at fix
-- Created: 2026-01-08
-- Description:
--   1. Add deleted_at column to contracts if missing
--   2. Fix ALL triggers that reference deleted_at
--   3. Update RLS policies
-- =============================================

-- STEP 1: First add deleted_at column to contracts if it doesn't exist
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- STEP 2: Add deleted_at to invoices if not exists
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- STEP 3: Add deleted_at to deposits if not exists
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- STEP 4: Create index on deleted_at if not exists
CREATE INDEX IF NOT EXISTS idx_contracts_deleted_at ON contracts(deleted_at);

-- STEP 5: Drop and recreate the auto_calculate_deposit_paid function
-- This function queries deposits table with deleted_at, need to handle null case
CREATE OR REPLACE FUNCTION auto_calculate_deposit_paid()
RETURNS TRIGGER AS $$
DECLARE
  v_total_deposits DECIMAL(15,2);
  v_target_room_id UUID;
  v_target_bed_id UUID;
BEGIN
  -- Only run on INSERT
  IF TG_OP = 'INSERT' THEN
    -- Determine which room/bed we're checking
    v_target_room_id := NEW.room_id;
    v_target_bed_id := NEW.bed_id;

    -- Calculate total confirmed deposits for this tenant + room/bed
    -- Use COALESCE to handle missing deleted_at column gracefully
    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_deposits
    FROM deposits
    WHERE tenant_id = NEW.tenant_id
      AND status IN ('CONFIRMED', 'CONVERTED')
      AND (
        (v_target_room_id IS NOT NULL AND room_id = v_target_room_id) OR
        (v_target_bed_id IS NOT NULL AND bed_id = v_target_bed_id)
      )
      AND (deleted_at IS NULL);

    -- Auto-populate deposit_paid if not manually set
    IF NEW.deposit_paid IS NULL OR NEW.deposit_paid = 0 THEN
      NEW.deposit_paid := v_total_deposits;
    END IF;

    -- Update deposits to CONVERTED status
    UPDATE deposits
    SET
      status = 'CONVERTED',
      contract_id = NEW.id,
      updated_at = NOW()
    WHERE tenant_id = NEW.tenant_id
      AND status = 'CONFIRMED'
      AND (
        (v_target_room_id IS NOT NULL AND room_id = v_target_room_id) OR
        (v_target_bed_id IS NOT NULL AND bed_id = v_target_bed_id)
      )
      AND (deleted_at IS NULL);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- STEP 6: Drop and recreate RLS policies for contracts
DROP POLICY IF EXISTS "Users can view own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can insert own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can update own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can delete own contracts" ON contracts;
DROP POLICY IF EXISTS "contracts_select_policy" ON contracts;
DROP POLICY IF EXISTS "contracts_insert_policy" ON contracts;
DROP POLICY IF EXISTS "contracts_update_policy" ON contracts;
DROP POLICY IF EXISTS "contracts_delete_policy" ON contracts;

-- Simple policies without deleted_at check (filter in application layer)
CREATE POLICY "Users can view own contracts"
  ON contracts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own contracts"
  ON contracts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own contracts"
  ON contracts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own contracts"
  ON contracts FOR DELETE
  USING (auth.uid() = user_id);

-- STEP 7: Drop and recreate RLS policies for contract_services
DROP POLICY IF EXISTS "Users can view contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can insert contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can update contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can delete contract services" ON contract_services;

CREATE POLICY "Users can view contract services"
  ON contract_services FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert contract services"
  ON contract_services FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update contract services"
  ON contract_services FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete contract services"
  ON contract_services FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

-- STEP 8: Fix estimate_termination_costs function
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

  -- Calculate outstanding (handle missing deleted_at column)
  SELECT COALESCE(SUM(remaining_amount), 0)
  INTO v_outstanding
  FROM invoices
  WHERE contract_id = p_contract_id
    AND status NOT IN ('PAID', 'CANCELLED');

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

-- STEP 9: Fix auto_calculate_termination_financials function
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

  -- Calculate outstanding debt from unpaid invoices (no deleted_at check)
  SELECT COALESCE(SUM(remaining_amount), 0)
  INTO v_outstanding
  FROM invoices
  WHERE contract_id = NEW.contract_id
    AND status NOT IN ('PAID', 'CANCELLED');

  NEW.outstanding_debt := v_outstanding;

  -- Calculate prorated rent for partial month
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

  -- Set total deposit from contract
  NEW.total_deposit := v_total_deposit;

  -- Calculate prorated services (simple estimation)
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
    AND s.type != 'METER_READING';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Done!
-- Run this migration with: npx supabase db push
