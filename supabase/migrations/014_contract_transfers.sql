-- =============================================
-- Migration 014: Contract Transfers & Room Changes
-- Created: 2025-11-19
-- Description: Handle contract transfers (tenant changes) and room/bed changes
-- =============================================

-- =============================================
-- 1. CONTRACT_TRANSFERS TABLE
-- =============================================
-- Tracks when a contract is transferred from one tenant to another
-- OR when tenant moves to a different room/bed

CREATE TABLE contract_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,

  -- Transfer type
  transfer_type TEXT NOT NULL CHECK (
    transfer_type IN (
      'TENANT_CHANGE',    -- Nhượng hợp đồng (change tenant, same room)
      'ROOM_CHANGE',      -- Chuyển phòng (same tenant, different room)
      'BOTH_CHANGE'       -- Both tenant and room change
    )
  ),

  transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- ================================================
  -- TENANT CHANGES (for TENANT_CHANGE or BOTH_CHANGE)
  -- ================================================
  old_tenant_id UUID REFERENCES tenants(id),
  new_tenant_id UUID REFERENCES tenants(id),

  -- Transfer fee (phí nhượng hợp đồng)
  transfer_fee DECIMAL(15,2) DEFAULT 0,

  -- ================================================
  -- ROOM CHANGES (for ROOM_CHANGE or BOTH_CHANGE)
  -- ================================================
  old_room_id UUID REFERENCES rooms(id),
  new_room_id UUID REFERENCES rooms(id),
  old_bed_id UUID REFERENCES beds(id),
  new_bed_id UUID REFERENCES beds(id),

  -- New pricing (NULL = keep existing)
  new_rent_price DECIMAL(15,2),
  new_deposit DECIMAL(15,2),

  -- Move-in/move-out logistics
  move_out_date DATE, -- When moving out of old room
  move_in_date DATE,  -- When moving into new room

  -- ================================================
  -- CONTRACT UPDATES (NULL = keep existing)
  -- ================================================
  new_start_date DATE,
  new_end_date DATE,

  -- New services (JSONB array of service IDs)
  -- [{"service_id": "uuid", "unit_price": 3000}, ...]
  new_services JSONB DEFAULT '[]'::jsonb,

  -- ================================================
  -- FINANCIAL SETTLEMENT
  -- ================================================

  -- Deposit handling
  deposit_transfer_type TEXT CHECK (
    deposit_transfer_type IN (
      'KEEP_EXISTING',    -- Old tenant keeps deposit, new tenant pays new
      'TRANSFER_TO_NEW',  -- Transfer old deposit to new tenant
      'REFUND_OLD'        -- Refund old tenant, new tenant pays new
    )
  ),

  old_tenant_deposit_refund DECIMAL(15,2) DEFAULT 0,
  new_tenant_deposit_paid DECIMAL(15,2) DEFAULT 0,

  -- Outstanding balance settlement
  old_tenant_outstanding DECIMAL(15,2) DEFAULT 0, -- Auto-calculated
  old_tenant_settlement_amount DECIMAL(15,2) DEFAULT 0,
  old_tenant_settlement_date DATE,

  -- Status
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'APPROVED', 'COMPLETED', 'CANCELLED')
  ),

  -- Notes
  reason TEXT,
  notes TEXT,

  -- Approval
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT transfers_tenant_change_requires_tenants CHECK (
    transfer_type != 'TENANT_CHANGE' OR (old_tenant_id IS NOT NULL AND new_tenant_id IS NOT NULL)
  ),
  CONSTRAINT transfers_room_change_requires_rooms CHECK (
    transfer_type != 'ROOM_CHANGE' OR (
      (old_room_id IS NOT NULL AND new_room_id IS NOT NULL) OR
      (old_bed_id IS NOT NULL AND new_bed_id IS NOT NULL)
    )
  ),
  CONSTRAINT transfers_move_dates_valid CHECK (
    move_out_date IS NULL OR move_in_date IS NULL OR move_out_date <= move_in_date
  ),
  CONSTRAINT transfers_transfer_fee_non_negative CHECK (transfer_fee >= 0)
);

-- Indexes
CREATE INDEX idx_transfers_user_id ON contract_transfers(user_id);
CREATE INDEX idx_transfers_contract_id ON contract_transfers(contract_id);
CREATE INDEX idx_transfers_transfer_date ON contract_transfers(transfer_date);
CREATE INDEX idx_transfers_status ON contract_transfers(status);
CREATE INDEX idx_transfers_type ON contract_transfers(transfer_type);
CREATE INDEX idx_transfers_old_tenant ON contract_transfers(old_tenant_id);
CREATE INDEX idx_transfers_new_tenant ON contract_transfers(new_tenant_id);

-- RLS Policies
ALTER TABLE contract_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transfers"
  ON contract_transfers FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own transfers"
  ON contract_transfers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own transfers"
  ON contract_transfers FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own transfers"
  ON contract_transfers FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE contract_transfers IS 'Contract transfer records for tenant changes and room changes';
COMMENT ON COLUMN contract_transfers.transfer_type IS 'TENANT_CHANGE: nhượng HĐ, ROOM_CHANGE: chuyển phòng, BOTH_CHANGE: cả hai';
COMMENT ON COLUMN contract_transfers.deposit_transfer_type IS 'How to handle deposit during transfer';


-- =============================================
-- 2. FUNCTION: Calculate outstanding debt for transfer
-- =============================================

CREATE OR REPLACE FUNCTION auto_calculate_transfer_outstanding()
RETURNS TRIGGER AS $$
DECLARE
  v_outstanding DECIMAL(15,2);
BEGIN
  -- Only for tenant changes
  IF NEW.transfer_type IN ('TENANT_CHANGE', 'BOTH_CHANGE') THEN
    -- Calculate outstanding from unpaid invoices
    SELECT COALESCE(SUM(remaining_amount), 0)
    INTO v_outstanding
    FROM invoices
    WHERE contract_id = NEW.contract_id
      AND status NOT IN ('PAID', 'CANCELLED')
      AND deleted_at IS NULL;

    NEW.old_tenant_outstanding := v_outstanding;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_calculate_transfer_outstanding() IS
'Auto-calculates outstanding debt for old tenant during transfer';


-- =============================================
-- 3. TRIGGER: Calculate transfer outstanding
-- =============================================

DROP TRIGGER IF EXISTS trigger_auto_calculate_transfer_outstanding ON contract_transfers;

CREATE TRIGGER trigger_auto_calculate_transfer_outstanding
  BEFORE INSERT OR UPDATE ON contract_transfers
  FOR EACH ROW
  EXECUTE FUNCTION auto_calculate_transfer_outstanding();


-- =============================================
-- 4. FUNCTION: Apply contract transfer
-- =============================================

CREATE OR REPLACE FUNCTION apply_contract_transfer()
RETURNS TRIGGER AS $$
DECLARE
  v_contract RECORD;
BEGIN
  -- Only apply when status changes to APPROVED
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN

    -- Get current contract
    SELECT * INTO v_contract FROM contracts WHERE id = NEW.contract_id;

    -- ================================================
    -- Update contract with new values
    -- ================================================
    UPDATE contracts
    SET
      -- Tenant change
      tenant_id = COALESCE(NEW.new_tenant_id, tenant_id),

      -- Room/bed change
      room_id = CASE
        WHEN NEW.new_room_id IS NOT NULL THEN NEW.new_room_id
        WHEN NEW.new_bed_id IS NOT NULL THEN NULL -- Moving to bed
        ELSE room_id
      END,
      bed_id = CASE
        WHEN NEW.new_bed_id IS NOT NULL THEN NEW.new_bed_id
        WHEN NEW.new_room_id IS NOT NULL THEN NULL -- Moving to room
        ELSE bed_id
      END,

      -- Pricing updates
      rent_price = COALESCE(NEW.new_rent_price, rent_price),
      total_deposit = COALESCE(NEW.new_deposit, total_deposit),

      -- Date updates
      start_date = COALESCE(NEW.new_start_date, start_date),
      end_date = COALESCE(NEW.new_end_date, end_date),

      -- Mark as transferred
      status = 'TRANSFERRED',
      parent_contract_id = id, -- Self-reference to track original contract

      updated_at = NOW()
    WHERE id = NEW.contract_id;

    -- ================================================
    -- Update old room/bed status to AVAILABLE
    -- ================================================
    IF NEW.transfer_type IN ('ROOM_CHANGE', 'BOTH_CHANGE') THEN
      -- Old room becomes available
      IF NEW.old_room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.old_room_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE room_id = NEW.old_room_id
              AND id != NEW.contract_id
              AND status = 'ACTIVE'
              AND deleted_at IS NULL
          );
      END IF;

      -- Old bed becomes available
      IF NEW.old_bed_id IS NOT NULL THEN
        UPDATE beds
        SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.old_bed_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE bed_id = NEW.old_bed_id
              AND id != NEW.contract_id
              AND status = 'ACTIVE'
              AND deleted_at IS NULL
          );
      END IF;

      -- New room becomes occupied
      IF NEW.new_room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'OCCUPIED', updated_at = NOW()
        WHERE id = NEW.new_room_id;
      END IF;

      -- New bed becomes occupied
      IF NEW.new_bed_id IS NOT NULL THEN
        UPDATE beds
        SET status = 'OCCUPIED', updated_at = NOW()
        WHERE id = NEW.new_bed_id;
      END IF;
    END IF;

    -- ================================================
    -- Update services if specified
    -- ================================================
    IF NEW.new_services IS NOT NULL AND jsonb_array_length(NEW.new_services) > 0 THEN
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

    -- ================================================
    -- Update tenant statuses
    -- ================================================
    IF NEW.transfer_type IN ('TENANT_CHANGE', 'BOTH_CHANGE') THEN
      -- Old tenant -> INACTIVE if no other active contracts
      UPDATE tenants
      SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = NEW.old_tenant_id
        AND NOT EXISTS (
          SELECT 1 FROM contracts
          WHERE tenant_id = NEW.old_tenant_id
            AND id != NEW.contract_id
            AND status = 'ACTIVE'
            AND deleted_at IS NULL
        );

      -- New tenant -> ACTIVE
      UPDATE tenants
      SET status = 'ACTIVE', updated_at = NOW()
      WHERE id = NEW.new_tenant_id;
    END IF;

    -- Record approval
    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apply_contract_transfer() IS
'Applies contract transfer changes when transfer record is approved';


-- =============================================
-- 5. TRIGGER: Apply transfer on approval
-- =============================================

DROP TRIGGER IF EXISTS trigger_apply_contract_transfer ON contract_transfers;

CREATE TRIGGER trigger_apply_contract_transfer
  BEFORE UPDATE OF status ON contract_transfers
  FOR EACH ROW
  EXECUTE FUNCTION apply_contract_transfer();


-- =============================================
-- 6. HELPER FUNCTION: Create simple tenant transfer
-- =============================================

CREATE OR REPLACE FUNCTION create_tenant_transfer(
  p_contract_id UUID,
  p_new_tenant_id UUID,
  p_transfer_date DATE DEFAULT CURRENT_DATE,
  p_transfer_fee DECIMAL DEFAULT 0,
  p_reason TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_old_tenant_id UUID;
  v_transfer_id UUID;
BEGIN
  -- Get old tenant
  SELECT tenant_id INTO v_old_tenant_id
  FROM contracts
  WHERE id = p_contract_id;

  -- Create transfer record
  INSERT INTO contract_transfers (
    user_id,
    contract_id,
    transfer_type,
    transfer_date,
    old_tenant_id,
    new_tenant_id,
    transfer_fee,
    reason,
    status
  ) VALUES (
    auth.uid(),
    p_contract_id,
    'TENANT_CHANGE',
    p_transfer_date,
    v_old_tenant_id,
    p_new_tenant_id,
    p_transfer_fee,
    p_reason,
    'DRAFT'
  )
  RETURNING id INTO v_transfer_id;

  RETURN v_transfer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION create_tenant_transfer IS
'Helper function to quickly create a tenant transfer record';


-- =============================================
-- 7. HELPER FUNCTION: Create room transfer
-- =============================================

CREATE OR REPLACE FUNCTION create_room_transfer(
  p_contract_id UUID,
  p_new_room_id UUID DEFAULT NULL,
  p_new_bed_id UUID DEFAULT NULL,
  p_new_rent_price DECIMAL DEFAULT NULL,
  p_move_date DATE DEFAULT CURRENT_DATE,
  p_reason TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_old_room_id UUID;
  v_old_bed_id UUID;
  v_transfer_id UUID;
BEGIN
  -- Get old room/bed
  SELECT room_id, bed_id INTO v_old_room_id, v_old_bed_id
  FROM contracts
  WHERE id = p_contract_id;

  -- Create transfer record
  INSERT INTO contract_transfers (
    user_id,
    contract_id,
    transfer_type,
    transfer_date,
    old_room_id,
    new_room_id,
    old_bed_id,
    new_bed_id,
    new_rent_price,
    move_out_date,
    move_in_date,
    reason,
    status
  ) VALUES (
    auth.uid(),
    p_contract_id,
    'ROOM_CHANGE',
    p_move_date,
    v_old_room_id,
    p_new_room_id,
    v_old_bed_id,
    p_new_bed_id,
    p_new_rent_price,
    p_move_date,
    p_move_date,
    p_reason,
    'DRAFT'
  )
  RETURNING id INTO v_transfer_id;

  RETURN v_transfer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION create_room_transfer IS
'Helper function to quickly create a room/bed transfer record';


-- Migration completed
-- =============================================
-- Summary:
-- - Created contract_transfers table for tracking tenant/room changes
-- - Auto-calculates outstanding debt for old tenant
-- - Updates contract, room/bed, tenant statuses when transfer approved
-- - Handles service changes during transfer
-- - Helper functions for quick transfer creation
--
-- Workflows:
--
-- A. TENANT TRANSFER (Nhượng hợp đồng):
-- 1. Create transfer with transfer_type = 'TENANT_CHANGE'
-- 2. System calculates old tenant's outstanding debt
-- 3. Approve transfer
-- 4. Contract.tenant_id updated to new tenant
-- 5. Old tenant → INACTIVE, New tenant → ACTIVE
--
-- B. ROOM CHANGE (Chuyển phòng):
-- 1. Create transfer with transfer_type = 'ROOM_CHANGE'
-- 2. Approve transfer
-- 3. Old room → AVAILABLE, New room → OCCUPIED
-- 4. Contract.room_id updated
-- 5. Optional: Update rent_price and services
--
-- C. BOTH CHANGES:
-- 1. Create transfer with transfer_type = 'BOTH_CHANGE'
-- 2. Combines both workflows above
-- =============================================
