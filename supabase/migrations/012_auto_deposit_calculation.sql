-- =============================================
-- Migration 012: Auto-calculate Deposit Paid
-- Created: 2025-11-19
-- Description: Automatically calculate deposit_paid from deposits table when creating contract
-- =============================================

-- =============================================
-- 1. FUNCTION: Auto-calculate deposit paid from deposits table
-- =============================================

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
    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_deposits
    FROM deposits
    WHERE tenant_id = NEW.tenant_id
      AND status IN ('CONFIRMED', 'CONVERTED')
      AND (
        (v_target_room_id IS NOT NULL AND room_id = v_target_room_id) OR
        (v_target_bed_id IS NOT NULL AND bed_id = v_target_bed_id)
      )
      AND deleted_at IS NULL;

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
      AND deleted_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_calculate_deposit_paid() IS
'Automatically calculates deposit_paid from confirmed deposits table when creating a new contract';


-- =============================================
-- 2. TRIGGER: Apply auto-calculation on contract insert
-- =============================================

DROP TRIGGER IF EXISTS trigger_auto_calculate_deposit_paid ON contracts;

CREATE TRIGGER trigger_auto_calculate_deposit_paid
  BEFORE INSERT ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION auto_calculate_deposit_paid();

COMMENT ON TRIGGER trigger_auto_calculate_deposit_paid ON contracts IS
'Triggers before inserting contract to auto-calculate deposit_paid from deposits table';


-- =============================================
-- 3. FUNCTION: Update room/bed status when contract is created/updated
-- =============================================

CREATE OR REPLACE FUNCTION update_room_bed_status_on_contract_change()
RETURNS TRIGGER AS $$
BEGIN
  -- When contract becomes ACTIVE
  IF TG_OP = 'INSERT' AND NEW.status = 'ACTIVE' THEN
    -- Update room status to OCCUPIED
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'OCCUPIED'
      WHERE id = NEW.room_id;
    END IF;

    -- Update bed status to OCCUPIED
    IF NEW.bed_id IS NOT NULL THEN
      UPDATE beds
      SET status = 'OCCUPIED'
      WHERE id = NEW.bed_id;
    END IF;

    -- Update tenant status to ACTIVE
    UPDATE tenants
    SET status = 'ACTIVE', updated_at = NOW()
    WHERE id = NEW.tenant_id;

  -- When contract is terminated/expired
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status IN ('TERMINATED', 'EXPIRED') THEN
    -- Update room status to AVAILABLE
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'AVAILABLE'
      WHERE id = NEW.room_id
        AND NOT EXISTS (
          -- Only if no other active contract for this room
          SELECT 1 FROM contracts
          WHERE room_id = NEW.room_id
            AND id != NEW.id
            AND status = 'ACTIVE'
            AND deleted_at IS NULL
        );
    END IF;

    -- Update bed status to AVAILABLE
    IF NEW.bed_id IS NOT NULL THEN
      UPDATE beds
      SET status = 'AVAILABLE'
      WHERE id = NEW.bed_id
        AND NOT EXISTS (
          -- Only if no other active contract for this bed
          SELECT 1 FROM contracts
          WHERE bed_id = NEW.bed_id
            AND id != NEW.id
            AND status = 'ACTIVE'
            AND deleted_at IS NULL
        );
    END IF;

    -- Update tenant status to INACTIVE if no other active contracts
    UPDATE tenants
    SET status = 'INACTIVE', updated_at = NOW()
    WHERE id = NEW.tenant_id
      AND NOT EXISTS (
        SELECT 1 FROM contracts
        WHERE tenant_id = NEW.tenant_id
          AND id != NEW.id
          AND status = 'ACTIVE'
          AND deleted_at IS NULL
      );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_room_bed_status_on_contract_change() IS
'Updates room/bed/tenant status when contract status changes';


-- =============================================
-- 4. TRIGGER: Update room/bed status
-- =============================================

DROP TRIGGER IF EXISTS trigger_update_room_bed_status ON contracts;

CREATE TRIGGER trigger_update_room_bed_status
  AFTER INSERT OR UPDATE OF status ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION update_room_bed_status_on_contract_change();

COMMENT ON TRIGGER trigger_update_room_bed_status ON contracts IS
'Updates room/bed/tenant status when contract is created or status changes';


-- Migration completed
-- =============================================
-- Summary:
-- - Auto-calculates deposit_paid from deposits table
-- - Marks deposits as CONVERTED when linked to contract
-- - Auto-updates room/bed status: AVAILABLE → OCCUPIED → AVAILABLE
-- - Auto-updates tenant status based on contract lifecycle
-- =============================================
