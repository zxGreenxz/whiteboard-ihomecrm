-- =============================================
-- Migration: Lease Contract Management - Contract Customers
-- Created: 2025-07-10
-- Description: Create contract_customers junction table linking
--   contracts to multiple customers with representative flag,
--   RLS policies, triggers, and representative uniqueness function
-- =============================================

-- =============================================
-- Contract Customers Junction Table
-- Links contracts to multiple customers with representative flag
-- =============================================

CREATE TABLE IF NOT EXISTS contract_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  is_representative BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT contract_customers_unique UNIQUE (contract_id, customer_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contract_customers_contract_id ON contract_customers(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_customers_customer_id ON contract_customers(customer_id);

-- RLS Policies
ALTER TABLE contract_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own contract customers"
  ON contract_customers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own contract customers"
  ON contract_customers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own contract customers"
  ON contract_customers FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own contract customers"
  ON contract_customers FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

-- Trigger updated_at
CREATE TRIGGER update_contract_customers_updated_at
  BEFORE UPDATE ON contract_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ensure exactly one representative per contract
CREATE OR REPLACE FUNCTION check_contract_representative()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_representative = true THEN
    UPDATE contract_customers
    SET is_representative = false
    WHERE contract_id = NEW.contract_id AND id != NEW.id AND is_representative = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ensure_single_representative
  BEFORE INSERT OR UPDATE ON contract_customers
  FOR EACH ROW EXECUTE FUNCTION check_contract_representative();

-- =============================================
-- Renew Contract
-- Updates end_date, optionally rent_price and deposit, records extension
-- =============================================
CREATE OR REPLACE FUNCTION renew_contract(
  p_contract_id UUID,
  p_new_end_date DATE,
  p_new_rent_price DECIMAL DEFAULT NULL,
  p_new_deposit DECIMAL DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON AS $
DECLARE
  v_contract RECORD;
  v_extension_id UUID;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found';
  END IF;
  IF v_contract.status NOT IN ('ACTIVE', 'EXPIRED') THEN
    RAISE EXCEPTION 'Contract must be ACTIVE or EXPIRED to renew';
  END IF;

  -- Record extension
  INSERT INTO contract_extensions (
    contract_id, user_id, extension_type, extension_months,
    old_end_date, new_end_date, new_rent_price, new_deposit,
    rent_price_changed, deposit_changed, extension_date, notes, status
  ) VALUES (
    p_contract_id, p_user_id, 'RENEWAL',
    EXTRACT(MONTH FROM AGE(p_new_end_date, v_contract.end_date::date))::int,
    v_contract.end_date, p_new_end_date,
    COALESCE(p_new_rent_price, v_contract.rent_price),
    COALESCE(p_new_deposit, v_contract.total_deposit),
    p_new_rent_price IS NOT NULL AND p_new_rent_price != v_contract.rent_price,
    p_new_deposit IS NOT NULL AND p_new_deposit != v_contract.total_deposit,
    NOW(), p_notes, 'APPROVED'
  ) RETURNING id INTO v_extension_id;

  -- Update contract
  UPDATE contracts SET
    end_date = p_new_end_date,
    rent_price = COALESCE(p_new_rent_price, rent_price),
    total_deposit = COALESCE(p_new_deposit, total_deposit),
    status = 'ACTIVE',
    updated_at = NOW()
  WHERE id = p_contract_id;

  RETURN json_build_object('success', true, 'extension_id', v_extension_id);
END;
$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- Transfer Room
-- Terminates old contract, creates new contract with new room,
-- copies customers and services, records transfer, updates room/bed statuses
-- =============================================
CREATE OR REPLACE FUNCTION transfer_room(
  p_contract_id UUID,
  p_new_room_id UUID,
  p_new_bed_id UUID DEFAULT NULL,
  p_new_rent_price DECIMAL DEFAULT NULL,
  p_transfer_date DATE DEFAULT CURRENT_DATE,
  p_notes TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON AS $$
DECLARE
  v_contract RECORD;
  v_new_contract_id UUID;
  v_transfer_id UUID;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found'; END IF;
  IF v_contract.status != 'ACTIVE' THEN RAISE EXCEPTION 'Contract must be ACTIVE to transfer room'; END IF;

  -- Create new contract
  INSERT INTO contracts (
    user_id, room_id, bed_id, tenant_id, signed_date, start_date, end_date,
    rent_price, total_deposit, deposit_paid, payment_cycle, start_billing_date,
    contract_template_id, invoice_template_id, notes, parent_contract_id, status
  ) VALUES (
    p_user_id, p_new_room_id, p_new_bed_id, v_contract.tenant_id,
    v_contract.signed_date, p_transfer_date, v_contract.end_date,
    COALESCE(p_new_rent_price, v_contract.rent_price), v_contract.total_deposit,
    v_contract.deposit_paid, v_contract.payment_cycle, p_transfer_date,
    v_contract.contract_template_id, v_contract.invoice_template_id,
    p_notes, p_contract_id, 'ACTIVE'
  ) RETURNING id INTO v_new_contract_id;

  -- Copy contract_customers to new contract
  INSERT INTO contract_customers (contract_id, customer_id, is_representative)
  SELECT v_new_contract_id, customer_id, is_representative
  FROM contract_customers WHERE contract_id = p_contract_id;

  -- Copy contract_services to new contract
  INSERT INTO contract_services (contract_id, service_id, unit_price, initial_reading)
  SELECT v_new_contract_id, service_id, unit_price, initial_reading
  FROM contract_services WHERE contract_id = p_contract_id;

  -- Record transfer
  INSERT INTO contract_transfers (
    contract_id, user_id, transfer_type, transfer_date,
    old_room_id, old_bed_id, new_room_id, new_bed_id,
    new_rent_price, notes, status
  ) VALUES (
    p_contract_id, p_user_id, 'ROOM_TRANSFER', p_transfer_date,
    v_contract.room_id, v_contract.bed_id, p_new_room_id, p_new_bed_id,
    COALESCE(p_new_rent_price, v_contract.rent_price), p_notes, 'APPROVED'
  ) RETURNING id INTO v_transfer_id;

  -- Terminate old contract
  UPDATE contracts SET status = 'TERMINATED', actual_end_date = p_transfer_date, updated_at = NOW()
  WHERE id = p_contract_id;

  -- Update room statuses
  UPDATE rooms SET status = 'AVAILABLE' WHERE id = v_contract.room_id;
  UPDATE rooms SET status = 'OCCUPIED' WHERE id = p_new_room_id;

  -- Update bed statuses if applicable
  IF v_contract.bed_id IS NOT NULL THEN
    UPDATE beds SET status = 'AVAILABLE' WHERE id = v_contract.bed_id;
  END IF;
  IF p_new_bed_id IS NOT NULL THEN
    UPDATE beds SET status = 'OCCUPIED' WHERE id = p_new_bed_id;
  END IF;

  RETURN json_build_object('success', true, 'new_contract_id', v_new_contract_id, 'transfer_id', v_transfer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- Transfer Contract (Nhượng HĐ)
-- Terminates old contract, creates new contract with new customer
-- =============================================
CREATE OR REPLACE FUNCTION transfer_contract(
  p_contract_id UUID,
  p_new_customer_id UUID,
  p_new_rent_price DECIMAL DEFAULT NULL,
  p_new_deposit DECIMAL DEFAULT NULL,
  p_transfer_date DATE DEFAULT CURRENT_DATE,
  p_notes TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON AS $$
DECLARE
  v_contract RECORD;
  v_new_contract_id UUID;
  v_transfer_id UUID;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found'; END IF;
  IF v_contract.status != 'ACTIVE' THEN RAISE EXCEPTION 'Contract must be ACTIVE to transfer'; END IF;

  INSERT INTO contracts (
    user_id, room_id, bed_id, tenant_id, signed_date, start_date, end_date,
    rent_price, total_deposit, payment_cycle, start_billing_date,
    contract_template_id, invoice_template_id, notes, parent_contract_id, status
  ) VALUES (
    p_user_id, v_contract.room_id, v_contract.bed_id, v_contract.tenant_id,
    p_transfer_date, p_transfer_date, v_contract.end_date,
    COALESCE(p_new_rent_price, v_contract.rent_price),
    COALESCE(p_new_deposit, v_contract.total_deposit),
    v_contract.payment_cycle, p_transfer_date,
    v_contract.contract_template_id, v_contract.invoice_template_id,
    p_notes, p_contract_id, 'ACTIVE'
  ) RETURNING id INTO v_new_contract_id;

  INSERT INTO contract_customers (contract_id, customer_id, is_representative)
  VALUES (v_new_contract_id, p_new_customer_id, true);

  INSERT INTO contract_services (contract_id, service_id, unit_price, initial_reading)
  SELECT v_new_contract_id, service_id, unit_price, initial_reading
  FROM contract_services WHERE contract_id = p_contract_id;

  INSERT INTO contract_transfers (
    contract_id, user_id, transfer_type, transfer_date,
    old_tenant_id, new_tenant_id, new_rent_price, new_deposit, notes, status
  ) VALUES (
    p_contract_id, p_user_id, 'CONTRACT_TRANSFER', p_transfer_date,
    v_contract.tenant_id, v_contract.tenant_id,
    COALESCE(p_new_rent_price, v_contract.rent_price),
    COALESCE(p_new_deposit, v_contract.total_deposit), p_notes, 'APPROVED'
  ) RETURNING id INTO v_transfer_id;

  UPDATE contracts SET status = 'TRANSFERRED', actual_end_date = p_transfer_date, updated_at = NOW()
  WHERE id = p_contract_id;

  RETURN json_build_object('success', true, 'new_contract_id', v_new_contract_id, 'transfer_id', v_transfer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- Terminate Contract — Forfeit Deposit
-- =============================================
CREATE OR REPLACE FUNCTION terminate_contract_forfeit(
  p_contract_id UUID,
  p_forfeit_date DATE,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON AS $$
DECLARE
  v_contract RECORD;
  v_termination_id UUID;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found'; END IF;

  INSERT INTO contract_terminations (
    contract_id, user_id, termination_type, termination_date,
    actual_move_out_date, total_deposit, status
  ) VALUES (
    p_contract_id, p_user_id, 'FORFEIT', p_forfeit_date,
    p_forfeit_date, v_contract.total_deposit, 'COMPLETED'
  ) RETURNING id INTO v_termination_id;

  UPDATE contracts SET status = 'TERMINATED', actual_end_date = p_forfeit_date, updated_at = NOW()
  WHERE id = p_contract_id;

  IF v_contract.room_id IS NOT NULL THEN
    UPDATE rooms SET status = 'AVAILABLE' WHERE id = v_contract.room_id;
  END IF;
  IF v_contract.bed_id IS NOT NULL THEN
    UPDATE beds SET status = 'AVAILABLE' WHERE id = v_contract.bed_id;
  END IF;

  RETURN json_build_object('success', true, 'termination_id', v_termination_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- Terminate Contract — Move Out
-- =============================================
CREATE OR REPLACE FUNCTION terminate_contract_move_out(
  p_contract_id UUID,
  p_move_out_date DATE,
  p_deposit_refund DECIMAL DEFAULT 0,
  p_penalty_fee DECIMAL DEFAULT 0,
  p_excess_rent DECIMAL DEFAULT 0,
  p_outstanding_debt DECIMAL DEFAULT 0,
  p_notes TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON AS $$
DECLARE
  v_contract RECORD;
  v_termination_id UUID;
  v_total_deductions DECIMAL;
  v_refund_amount DECIMAL;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found'; END IF;

  v_total_deductions := p_outstanding_debt + p_penalty_fee;
  v_refund_amount := p_deposit_refund + p_excess_rent - v_total_deductions;

  INSERT INTO contract_terminations (
    contract_id, user_id, termination_type, termination_date,
    actual_move_out_date, total_deposit, outstanding_debt,
    early_termination_fee, other_fees, total_deductions,
    refund_amount, notes, status
  ) VALUES (
    p_contract_id, p_user_id, 'MOVE_OUT', p_move_out_date,
    p_move_out_date, v_contract.total_deposit, p_outstanding_debt,
    p_penalty_fee, p_excess_rent, v_total_deductions,
    v_refund_amount, p_notes, 'COMPLETED'
  ) RETURNING id INTO v_termination_id;

  UPDATE contracts SET status = 'TERMINATED', actual_end_date = p_move_out_date, updated_at = NOW()
  WHERE id = p_contract_id;

  IF v_contract.room_id IS NOT NULL THEN
    UPDATE rooms SET status = 'AVAILABLE' WHERE id = v_contract.room_id;
  END IF;
  IF v_contract.bed_id IS NOT NULL THEN
    UPDATE beds SET status = 'AVAILABLE' WHERE id = v_contract.bed_id;
  END IF;

  RETURN json_build_object(
    'success', true,
    'termination_id', v_termination_id,
    'refund_amount', v_refund_amount
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
