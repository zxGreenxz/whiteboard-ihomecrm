-- =============================================
-- Migration 016: Meter Readings Enhancements
-- Created: 2025-11-21
-- Description: Add missing fields for "Ghi chỉ số" flow from docs.resident.vn
-- =============================================

-- =============================================
-- 1. ADD MISSING COLUMNS
-- =============================================

-- Add building_id and room_id for faster queries
ALTER TABLE meter_readings
  ADD COLUMN building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  ADD COLUMN room_id UUID REFERENCES rooms(id) ON DELETE CASCADE;

-- Add settlement month (format: YYYY-MM)
ALTER TABLE meter_readings
  ADD COLUMN settlement_month TEXT;

-- Add approval workflow fields
ALTER TABLE meter_readings
  ADD COLUMN status TEXT NOT NULL DEFAULT 'UNAPPROVED' CHECK (
    status IN ('UNAPPROVED', 'APPROVED')
  ),
  ADD COLUMN approved_by UUID REFERENCES auth.users(id),
  ADD COLUMN approved_at TIMESTAMPTZ;

-- Add timestamps
ALTER TABLE meter_readings
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- Add recorded_by (person who recorded the reading)
ALTER TABLE meter_readings
  ADD COLUMN recorded_by UUID REFERENCES auth.users(id);


-- =============================================
-- 2. UPDATE EXISTING DATA
-- =============================================

-- Populate building_id and room_id from contract
UPDATE meter_readings mr
SET
  building_id = c.building_id,
  room_id = COALESCE(c.room_id, b.room_id),
  settlement_month = TO_CHAR(mr.reading_date, 'YYYY-MM'),
  recorded_by = mr.user_id
FROM contracts c
LEFT JOIN beds b ON b.id = c.bed_id
WHERE mr.contract_id = c.id
  AND mr.building_id IS NULL;


-- =============================================
-- 3. CREATE INDEXES
-- =============================================

CREATE INDEX idx_meter_readings_building_id ON meter_readings(building_id);
CREATE INDEX idx_meter_readings_room_id ON meter_readings(room_id);
CREATE INDEX idx_meter_readings_settlement_month ON meter_readings(settlement_month);
CREATE INDEX idx_meter_readings_status ON meter_readings(status);
CREATE INDEX idx_meter_readings_recorded_by ON meter_readings(recorded_by);
CREATE INDEX idx_meter_readings_deleted_at ON meter_readings(deleted_at) WHERE deleted_at IS NULL;


-- =============================================
-- 4. TRIGGER: Auto-populate building_id, room_id, settlement_month
-- =============================================

CREATE OR REPLACE FUNCTION auto_populate_meter_reading_fields()
RETURNS TRIGGER AS $$
DECLARE
  v_contract RECORD;
BEGIN
  -- Get contract info
  SELECT
    c.building_id,
    COALESCE(c.room_id, b.room_id) as room_id
  INTO v_contract
  FROM contracts c
  LEFT JOIN beds b ON b.id = c.bed_id
  WHERE c.id = NEW.contract_id;

  -- Auto-populate fields
  NEW.building_id := v_contract.building_id;
  NEW.room_id := v_contract.room_id;
  NEW.settlement_month := TO_CHAR(NEW.reading_date, 'YYYY-MM');

  -- Auto-populate recorded_by if not set
  IF NEW.recorded_by IS NULL THEN
    NEW.recorded_by := auth.uid();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_populate_meter_reading_fields ON meter_readings;

CREATE TRIGGER trigger_auto_populate_meter_reading_fields
  BEFORE INSERT ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION auto_populate_meter_reading_fields();

COMMENT ON FUNCTION auto_populate_meter_reading_fields() IS
'Auto-populates building_id, room_id, settlement_month, and recorded_by for meter readings';


-- =============================================
-- 5. TRIGGER: Auto-populate previous_reading
-- =============================================

CREATE OR REPLACE FUNCTION auto_populate_previous_reading()
RETURNS TRIGGER AS $$
DECLARE
  v_previous_reading DECIMAL(10, 2);
BEGIN
  -- Only populate if previous_reading is 0 or NULL
  IF NEW.previous_reading = 0 OR NEW.previous_reading IS NULL THEN
    -- Get the last reading for this room/meter_type
    SELECT current_reading
    INTO v_previous_reading
    FROM meter_readings
    WHERE room_id = NEW.room_id
      AND meter_type = NEW.meter_type
      AND deleted_at IS NULL
      AND id != NEW.id
      AND reading_date < NEW.reading_date
    ORDER BY reading_date DESC, created_at DESC
    LIMIT 1;

    -- Set previous_reading
    IF v_previous_reading IS NOT NULL THEN
      NEW.previous_reading := v_previous_reading;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_populate_previous_reading ON meter_readings;

CREATE TRIGGER trigger_auto_populate_previous_reading
  BEFORE INSERT ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION auto_populate_previous_reading();

COMMENT ON FUNCTION auto_populate_previous_reading() IS
'Auto-populates previous_reading from the last meter reading';


-- =============================================
-- 6. TRIGGER: Update updated_at timestamp
-- =============================================

CREATE OR REPLACE FUNCTION update_meter_reading_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_meter_reading_updated_at ON meter_readings;

CREATE TRIGGER trigger_update_meter_reading_updated_at
  BEFORE UPDATE ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION update_meter_reading_updated_at();


-- =============================================
-- 7. FUNCTION: Approve meter reading
-- =============================================

CREATE OR REPLACE FUNCTION approve_meter_reading(
  p_reading_id UUID,
  p_approver_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE meter_readings
  SET
    status = 'APPROVED',
    approved_by = COALESCE(p_approver_id, auth.uid()),
    approved_at = NOW(),
    updated_at = NOW()
  WHERE id = p_reading_id
    AND status = 'UNAPPROVED'
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meter reading not found or already approved';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION approve_meter_reading IS
'Approves a meter reading (changes status from UNAPPROVED to APPROVED)';


-- =============================================
-- 8. FUNCTION: Bulk approve meter readings
-- =============================================

CREATE OR REPLACE FUNCTION bulk_approve_meter_readings(
  p_reading_ids UUID[],
  p_approver_id UUID DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE meter_readings
  SET
    status = 'APPROVED',
    approved_by = COALESCE(p_approver_id, auth.uid()),
    approved_at = NOW(),
    updated_at = NOW()
  WHERE id = ANY(p_reading_ids)
    AND status = 'UNAPPROVED'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION bulk_approve_meter_readings IS
'Bulk approves multiple meter readings at once';


-- =============================================
-- 9. FUNCTION: Get meter reading statistics
-- =============================================

CREATE OR REPLACE FUNCTION get_meter_reading_stats(
  p_building_id UUID DEFAULT NULL,
  p_month TEXT DEFAULT TO_CHAR(CURRENT_DATE, 'YYYY-MM')
)
RETURNS TABLE(
  total_readings BIGINT,
  unapproved_count BIGINT,
  approved_count BIGINT,
  electricity_consumption DECIMAL,
  water_consumption DECIMAL,
  gas_consumption DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) as total_readings,
    COUNT(*) FILTER (WHERE status = 'UNAPPROVED') as unapproved_count,
    COUNT(*) FILTER (WHERE status = 'APPROVED') as approved_count,
    SUM(consumption) FILTER (WHERE meter_type = 'ELECTRICITY') as electricity_consumption,
    SUM(consumption) FILTER (WHERE meter_type = 'WATER') as water_consumption,
    SUM(consumption) FILTER (WHERE meter_type = 'GAS') as gas_consumption
  FROM meter_readings
  WHERE settlement_month = p_month
    AND (p_building_id IS NULL OR building_id = p_building_id)
    AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_meter_reading_stats IS
'Returns meter reading statistics for a given month and optional building';


-- =============================================
-- 10. VIEW: Meter readings with room/building info
-- =============================================

CREATE OR REPLACE VIEW meter_readings_detailed AS
SELECT
  mr.id,
  mr.user_id,
  mr.contract_id,
  mr.service_id,

  -- Building & Room info
  mr.building_id,
  b.name as building_name,
  mr.room_id,
  r.name as room_name,

  -- Meter info
  mr.meter_type,
  mr.settlement_month,
  mr.reading_date,
  mr.previous_reading,
  mr.current_reading,
  mr.consumption,

  -- Approval info
  mr.status,
  mr.approved_by,
  approver.email as approver_email,
  mr.approved_at,

  -- Recorded by
  mr.recorded_by,
  recorder.email as recorder_email,

  -- Metadata
  mr.notes,
  mr.meter_image_url,

  -- Timestamps
  mr.created_at,
  mr.updated_at,
  mr.deleted_at

FROM meter_readings mr
LEFT JOIN buildings b ON b.id = mr.building_id
LEFT JOIN rooms r ON r.id = mr.room_id
LEFT JOIN auth.users approver ON approver.id = mr.approved_by
LEFT JOIN auth.users recorder ON recorder.id = mr.recorded_by
WHERE mr.deleted_at IS NULL
ORDER BY mr.reading_date DESC, mr.created_at DESC;

COMMENT ON VIEW meter_readings_detailed IS
'Detailed view of meter readings with building, room, and user information';


-- =============================================
-- 11. UPDATE RLS POLICIES
-- =============================================

-- Allow users to see detailed meter readings through the view
-- (The view will use the existing RLS policies on meter_readings table)


-- =============================================
-- 12. UPDATE COMMENTS
-- =============================================

COMMENT ON COLUMN meter_readings.building_id IS 'Building reference for faster queries';
COMMENT ON COLUMN meter_readings.room_id IS 'Room reference for faster queries';
COMMENT ON COLUMN meter_readings.settlement_month IS 'Settlement month in YYYY-MM format';
COMMENT ON COLUMN meter_readings.status IS 'Approval status: UNAPPROVED or APPROVED';
COMMENT ON COLUMN meter_readings.approved_by IS 'User who approved the reading';
COMMENT ON COLUMN meter_readings.approved_at IS 'Timestamp when approved';
COMMENT ON COLUMN meter_readings.recorded_by IS 'User who recorded the reading';
COMMENT ON COLUMN meter_readings.updated_at IS 'Last update timestamp';
COMMENT ON COLUMN meter_readings.deleted_at IS 'Soft delete timestamp';


-- Migration completed
-- =============================================
-- Summary:
-- - Added building_id, room_id for faster queries
-- - Added settlement_month for monthly grouping
-- - Added approval workflow (status, approved_by, approved_at)
-- - Added updated_at, deleted_at for soft deletes
-- - Added recorded_by to track who recorded the reading
-- - Auto-populates building_id, room_id, settlement_month on insert
-- - Auto-populates previous_reading from last reading
-- - Helper functions for approval (single and bulk)
-- - Statistics function for dashboard
-- - Detailed view with building/room/user info
--
-- Workflows:
--
-- A. INDIVIDUAL METER READING:
-- 1. User navigates to Finance → Meter Reading
-- 2. Click (+) to add new reading
-- 3. Fill form: building, room, meter_type, reading_date, current_reading, photo
-- 4. System auto-populates: previous_reading, settlement_month, building_id, room_id
-- 5. Save → Status: UNAPPROVED
-- 6. Approve (single or bulk) → Status: APPROVED
--
-- B. BATCH IMPORT:
-- 1. Download template
-- 2. Fill template with meter data
-- 3. Upload file
-- 4. System creates multiple readings with status: UNAPPROVED
-- 5. Review and bulk approve
--
-- C. STATISTICS & REPORTING:
-- 1. Call get_meter_reading_stats(building_id, month)
-- 2. Display: total, unapproved, approved counts
-- 3. Display: consumption by meter type
-- =============================================
