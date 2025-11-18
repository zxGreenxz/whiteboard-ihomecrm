-- =============================================
-- Migration 008: Triggers & Functions
-- Created: 2025-11-18
-- Description: Create all database functions and triggers for automation
-- =============================================

-- =============================================
-- 1. UPDATE UPDATED_AT TRIGGER
-- =============================================
-- Automatically updates updated_at column

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at column
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_areas_updated_at
  BEFORE UPDATE ON areas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_buildings_updated_at
  BEFORE UPDATE ON buildings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_beds_updated_at
  BEFORE UPDATE ON beds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_contract_services_updated_at
  BEFORE UPDATE ON contract_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_deposits_updated_at
  BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_assets_updated_at
  BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_asset_categories_updated_at
  BEFORE UPDATE ON asset_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_issues_updated_at
  BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_signature_templates_updated_at
  BEFORE UPDATE ON signature_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_code_sequences_updated_at
  BEFORE UPDATE ON code_sequences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 2. UPDATE BUILDING TOTAL_ROOMS
-- =============================================
-- Auto-calculate total_rooms when rooms are added/removed

CREATE OR REPLACE FUNCTION update_building_total_rooms()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE buildings
  SET total_rooms = (
    SELECT COUNT(*)
    FROM rooms
    WHERE building_id = COALESCE(NEW.building_id, OLD.building_id)
      AND deleted_at IS NULL
  )
  WHERE id = COALESCE(NEW.building_id, OLD.building_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_building_total_rooms_on_room_change
  AFTER INSERT OR UPDATE OR DELETE ON rooms
  FOR EACH ROW
  EXECUTE FUNCTION update_building_total_rooms();


-- =============================================
-- 3. UPDATE ASSET STATUS ON CONTRACT CHANGE
-- =============================================
-- Update room/bed status based on contract status

CREATE OR REPLACE FUNCTION update_asset_status_on_contract_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Update room status
  IF NEW.room_id IS NOT NULL THEN
    UPDATE rooms
    SET status = CASE
      WHEN NEW.status = 'ACTIVE' THEN 'OCCUPIED'::room_status
      WHEN NEW.status IN ('TERMINATED', 'EXPIRED') THEN 'AVAILABLE'::room_status
      ELSE status
    END
    WHERE id = NEW.room_id;
  END IF;

  -- Update bed status
  IF NEW.bed_id IS NOT NULL THEN
    UPDATE beds
    SET status = CASE
      WHEN NEW.status = 'ACTIVE' THEN 'OCCUPIED'::bed_status
      WHEN NEW.status IN ('TERMINATED', 'EXPIRED') THEN 'AVAILABLE'::bed_status
      ELSE status
    END
    WHERE id = NEW.bed_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_asset_status_on_contract_change_trigger
  AFTER INSERT OR UPDATE OF status ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION update_asset_status_on_contract_change();


-- =============================================
-- 4. GENERATE INVOICE NUMBER
-- =============================================

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix TEXT;
  v_counter INTEGER;
  v_new_number TEXT;
BEGIN
  IF NEW.invoice_number IS NULL THEN
    -- Get user's invoice prefix from settings (default: 'INV')
    SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO v_prefix
    FROM settings
    WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

    -- If no setting, use default
    IF v_prefix IS NULL THEN
      v_prefix := 'INV';
    END IF;

    -- Get next counter for this year
    SELECT COUNT(*) + 1
    INTO v_counter
    FROM invoices
    WHERE user_id = NEW.user_id
      AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

    -- Generate: INV-2024-00001
    v_new_number := v_prefix || '-' ||
                    TO_CHAR(NOW(), 'YYYY') || '-' ||
                    LPAD(v_counter::TEXT, 5, '0');

    NEW.invoice_number := v_new_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_invoice_number_trigger
  BEFORE INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION generate_invoice_number();


-- =============================================
-- 5. GENERATE CONTRACT NUMBER
-- =============================================

CREATE OR REPLACE FUNCTION generate_contract_number()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix TEXT;
  v_counter INTEGER;
  v_new_number TEXT;
BEGIN
  IF NEW.contract_number IS NULL THEN
    -- Get user's contract prefix from settings (default: 'HD')
    SELECT COALESCE(value->>'contract_prefix', 'HD')
    INTO v_prefix
    FROM settings
    WHERE user_id = NEW.user_id AND key = 'contract_number_format';

    -- If no setting, use default
    IF v_prefix IS NULL THEN
      v_prefix := 'HD';
    END IF;

    -- Get next counter for this year
    SELECT COUNT(*) + 1
    INTO v_counter
    FROM contracts
    WHERE user_id = NEW.user_id
      AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

    -- Generate: HD-2024-00001
    v_new_number := v_prefix || '-' ||
                    TO_CHAR(NOW(), 'YYYY') || '-' ||
                    LPAD(v_counter::TEXT, 5, '0');

    NEW.contract_number := v_new_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_contract_number_trigger
  BEFORE INSERT ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION generate_contract_number();


-- =============================================
-- 6. UPDATE INVOICE PAID_AMOUNT FROM PAYMENTS
-- =============================================

CREATE OR REPLACE FUNCTION update_invoice_paid_amount()
RETURNS TRIGGER AS $$
DECLARE
  v_total_paid DECIMAL(15, 2);
  v_invoice_total DECIMAL(15, 2);
BEGIN
  -- Get total paid amount for this invoice
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_paid
  FROM payments
  WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Get invoice total
  SELECT total_amount
  INTO v_invoice_total
  FROM invoices
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Update invoice
  UPDATE invoices
  SET
    paid_amount = v_total_paid,
    paid_date = CASE
      WHEN v_total_paid >= v_invoice_total THEN NOW()
      ELSE paid_date
    END,
    status = CASE
      WHEN v_total_paid >= v_invoice_total THEN 'PAID'::invoice_status
      WHEN v_total_paid > 0 THEN 'PARTIAL_PAID'::invoice_status
      ELSE status
    END
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_invoice_paid_amount_trigger
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION update_invoice_paid_amount();


-- =============================================
-- 7. CREATE PROFILE FOR NEW USER
-- =============================================

CREATE OR REPLACE FUNCTION create_profile_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, email, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    NEW.phone
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_profile_for_new_user();


-- =============================================
-- 8. GENERATE CODE FUNCTION (Generic)
-- =============================================

CREATE OR REPLACE FUNCTION generate_code(
  p_user_id UUID,
  p_object_type TEXT
) RETURNS TEXT AS $$
DECLARE
  v_config RECORD;
  v_next_seq INTEGER;
  v_code TEXT;
  v_date_part TEXT;
  v_need_reset BOOLEAN := false;
BEGIN
  -- Get config
  SELECT * INTO v_config
  FROM code_sequences
  WHERE user_id = p_user_id AND object_type = p_object_type;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Code configuration not found for %', p_object_type;
  END IF;

  -- Check if need reset
  IF v_config.reset_period = 'DAILY' AND
     v_config.last_reset_at < CURRENT_DATE THEN
    v_need_reset := true;
  ELSIF v_config.reset_period = 'MONTHLY' AND
        DATE_TRUNC('month', v_config.last_reset_at) < DATE_TRUNC('month', CURRENT_DATE) THEN
    v_need_reset := true;
  ELSIF v_config.reset_period = 'YEARLY' AND
        DATE_TRUNC('year', v_config.last_reset_at) < DATE_TRUNC('year', CURRENT_DATE) THEN
    v_need_reset := true;
  END IF;

  -- Reset or increment
  IF v_need_reset THEN
    v_next_seq := 1;
  ELSE
    v_next_seq := v_config.current_sequence + 1;
  END IF;

  -- Generate date part
  IF v_config.date_format IS NOT NULL THEN
    v_date_part := TO_CHAR(CURRENT_DATE, v_config.date_format);
  END IF;

  -- Build code
  v_code := v_config.prefix;

  IF v_date_part IS NOT NULL THEN
    v_code := v_code || v_config.separator || v_date_part;
  END IF;

  v_code := v_code || v_config.separator ||
            LPAD(v_next_seq::TEXT, v_config.sequence_length, '0');

  -- Update sequence
  UPDATE code_sequences
  SET current_sequence = v_next_seq,
      last_reset_at = CASE WHEN v_need_reset THEN CURRENT_DATE ELSE last_reset_at END,
      updated_at = NOW()
  WHERE user_id = p_user_id AND object_type = p_object_type;

  RETURN v_code;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_code IS 'Generate auto-incrementing codes for various entity types';


-- Migration completed
-- =============================================
-- Functions created: 8
-- Triggers created: 28
-- All automation logic in place
-- Next: 009_seed_data.sql
