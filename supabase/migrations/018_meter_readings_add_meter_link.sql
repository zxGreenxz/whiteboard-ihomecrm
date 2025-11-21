-- =============================================
-- Migration 018: Update Meter Readings to Link with Meters
-- Created: 2025-11-21
-- Description: Add meter_id and reading_code to meter_readings table
-- =============================================

-- =============================================
-- 1. ADD METER_ID AND READING_CODE COLUMNS
-- =============================================

-- Add meter_id to link with meters table
ALTER TABLE meter_readings
  ADD COLUMN meter_id UUID REFERENCES meters(id) ON DELETE CASCADE;

-- Add reading_code (CSS10807, CSS10806...)
ALTER TABLE meter_readings
  ADD COLUMN reading_code TEXT;

-- Create index
CREATE INDEX idx_meter_readings_meter_id ON meter_readings(meter_id);
CREATE UNIQUE INDEX idx_meter_readings_code ON meter_readings(reading_code) WHERE reading_code IS NOT NULL;


-- =============================================
-- 2. MIGRATE EXISTING DATA
-- =============================================
-- For existing meter_readings, try to find or create corresponding meters

-- Create meters for existing meter_readings if not exists
INSERT INTO meters (user_id, code, building_id, room_id, service_id, meter_type, initial_reading)
SELECT DISTINCT ON (mr.user_id, mr.building_id, mr.room_id, mr.meter_type)
  mr.user_id,
  -- Generate code from building and room
  b.code || '-' || COALESCE(r.name, 'COMMON') || CASE
    WHEN mr.meter_type = 'ELECTRICITY' THEN 'D'
    WHEN mr.meter_type = 'WATER' THEN 'N'
    WHEN mr.meter_type = 'GAS' THEN 'G'
    ELSE 'X'
  END as code,
  mr.building_id,
  mr.room_id,
  mr.service_id,
  mr.meter_type,
  0 as initial_reading
FROM meter_readings mr
LEFT JOIN buildings b ON b.id = mr.building_id
LEFT JOIN rooms r ON r.id = mr.room_id
WHERE mr.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM meters m
    WHERE m.building_id = mr.building_id
      AND (m.room_id = mr.room_id OR (m.room_id IS NULL AND mr.room_id IS NULL))
      AND m.meter_type = mr.meter_type
      AND m.deleted_at IS NULL
  )
ON CONFLICT (user_id, code) DO NOTHING;

-- Link existing meter_readings to meters
UPDATE meter_readings mr
SET meter_id = m.id
FROM meters m
WHERE mr.building_id = m.building_id
  AND (mr.room_id = m.room_id OR (mr.room_id IS NULL AND m.room_id IS NULL))
  AND mr.meter_type = m.meter_type
  AND mr.deleted_at IS NULL
  AND m.deleted_at IS NULL
  AND mr.meter_id IS NULL;


-- =============================================
-- 3. FUNCTION: Generate meter reading code
-- =============================================

CREATE OR REPLACE FUNCTION generate_meter_reading_code(
  p_user_id UUID
)
RETURNS TEXT AS $$
DECLARE
  v_sequence INTEGER;
  v_code TEXT;
  v_month TEXT;
BEGIN
  -- Get current month
  v_month := TO_CHAR(CURRENT_DATE, 'YYMM');

  -- Get next sequence for this user and month
  SELECT COALESCE(MAX(
    CASE
      WHEN reading_code ~ '^CSS\d{4}\d+$'
      THEN CAST(SUBSTRING(reading_code FROM 9) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_sequence
  FROM meter_readings
  WHERE user_id = p_user_id
    AND reading_code LIKE 'CSS' || v_month || '%';

  -- Generate code: CSS + YYMM + sequence (CSS250700001)
  v_code := 'CSS' || v_month || LPAD(v_sequence::TEXT, 5, '0');

  RETURN v_code;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_meter_reading_code IS
'Generates unique meter reading code in format CSS{YYMM}{sequence}';


-- =============================================
-- 4. UPDATE TRIGGER: Auto-generate reading_code
-- =============================================

CREATE OR REPLACE FUNCTION auto_generate_reading_code()
RETURNS TRIGGER AS $$
BEGIN
  -- Only generate if reading_code is empty
  IF NEW.reading_code IS NULL OR NEW.reading_code = '' THEN
    NEW.reading_code := generate_meter_reading_code(NEW.user_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_generate_reading_code ON meter_readings;

CREATE TRIGGER trigger_auto_generate_reading_code
  BEFORE INSERT ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_reading_code();

COMMENT ON FUNCTION auto_generate_reading_code() IS
'Auto-generates meter reading code before insert';


-- =============================================
-- 5. UPDATE auto_populate_meter_reading_fields FUNCTION
-- =============================================
-- Update to handle meter_id

CREATE OR REPLACE FUNCTION auto_populate_meter_reading_fields()
RETURNS TRIGGER AS $$
DECLARE
  v_contract RECORD;
  v_meter_id UUID;
BEGIN
  -- If meter_id is provided, use it to populate other fields
  IF NEW.meter_id IS NOT NULL THEN
    SELECT
      m.building_id,
      m.room_id,
      m.meter_type,
      m.service_id
    INTO
      NEW.building_id,
      NEW.room_id,
      NEW.meter_type,
      NEW.service_id
    FROM meters m
    WHERE m.id = NEW.meter_id;

  -- Otherwise, try to find meter from contract
  ELSIF NEW.contract_id IS NOT NULL THEN
    -- Get contract info
    SELECT
      c.building_id,
      COALESCE(c.room_id, b.room_id) as room_id
    INTO v_contract
    FROM contracts c
    LEFT JOIN beds b ON b.id = c.bed_id
    WHERE c.id = NEW.contract_id;

    NEW.building_id := v_contract.building_id;
    NEW.room_id := v_contract.room_id;

    -- Try to find corresponding meter
    IF NEW.meter_type IS NOT NULL AND NEW.room_id IS NOT NULL THEN
      SELECT id INTO v_meter_id
      FROM meters
      WHERE building_id = NEW.building_id
        AND room_id = NEW.room_id
        AND meter_type = NEW.meter_type
        AND status = 'ACTIVE'
        AND deleted_at IS NULL
      LIMIT 1;

      IF v_meter_id IS NOT NULL THEN
        NEW.meter_id := v_meter_id;
      END IF;
    END IF;
  END IF;

  -- Auto-populate settlement_month
  NEW.settlement_month := TO_CHAR(NEW.reading_date, 'YYYY-MM');

  -- Auto-populate recorded_by if not set
  IF NEW.recorded_by IS NULL THEN
    NEW.recorded_by := auth.uid();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_populate_meter_reading_fields() IS
'Auto-populates meter_id, building_id, room_id, settlement_month, and recorded_by';


-- =============================================
-- 6. UPDATE auto_populate_previous_reading FUNCTION
-- =============================================
-- Update to use meter_id for better accuracy

CREATE OR REPLACE FUNCTION auto_populate_previous_reading()
RETURNS TRIGGER AS $$
DECLARE
  v_previous_reading DECIMAL(10, 2);
BEGIN
  -- Only populate if previous_reading is 0 or NULL
  IF NEW.previous_reading = 0 OR NEW.previous_reading IS NULL THEN
    -- If meter_id is available, use it (most accurate)
    IF NEW.meter_id IS NOT NULL THEN
      SELECT current_reading
      INTO v_previous_reading
      FROM meter_readings
      WHERE meter_id = NEW.meter_id
        AND deleted_at IS NULL
        AND id != NEW.id
        AND reading_date < NEW.reading_date
      ORDER BY reading_date DESC, created_at DESC
      LIMIT 1;

    -- Otherwise, fallback to room_id + meter_type
    ELSIF NEW.room_id IS NOT NULL AND NEW.meter_type IS NOT NULL THEN
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
    END IF;

    -- Set previous_reading
    IF v_previous_reading IS NOT NULL THEN
      NEW.previous_reading := v_previous_reading;
    ELSIF NEW.meter_id IS NOT NULL THEN
      -- If no previous reading, use meter's initial_reading
      SELECT initial_reading INTO v_previous_reading
      FROM meters
      WHERE id = NEW.meter_id;

      IF v_previous_reading IS NOT NULL THEN
        NEW.previous_reading := v_previous_reading;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_populate_previous_reading() IS
'Auto-populates previous_reading from the last meter reading or meter initial_reading';


-- =============================================
-- 7. UPDATE meter_readings_detailed VIEW
-- =============================================

DROP VIEW IF EXISTS meter_readings_detailed;

CREATE OR REPLACE VIEW meter_readings_detailed AS
SELECT
  mr.id,
  mr.user_id,
  mr.reading_code,

  -- Meter info
  mr.meter_id,
  m.code as meter_code,
  m.name as meter_name,

  -- Contract & Service info
  mr.contract_id,
  mr.service_id,
  s.name as service_name,

  -- Building & Room info
  mr.building_id,
  b.name as building_name,
  mr.room_id,
  r.name as room_name,

  -- Meter reading info
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
LEFT JOIN meters m ON m.id = mr.meter_id
LEFT JOIN buildings b ON b.id = mr.building_id
LEFT JOIN rooms r ON r.id = mr.room_id
LEFT JOIN services s ON s.id = mr.service_id
LEFT JOIN auth.users approver ON approver.id = mr.approved_by
LEFT JOIN auth.users recorder ON recorder.id = mr.recorded_by
WHERE mr.deleted_at IS NULL
ORDER BY mr.reading_date DESC, mr.created_at DESC;

COMMENT ON VIEW meter_readings_detailed IS
'Detailed view of meter readings with meter, building, room, and user information';


-- =============================================
-- 8. FUNCTION: Bulk create meter readings
-- =============================================
-- For batch import functionality

CREATE OR REPLACE FUNCTION bulk_create_meter_readings(
  p_readings JSONB -- Array of meter reading objects
)
RETURNS TABLE(
  reading_id UUID,
  reading_code TEXT,
  meter_code TEXT,
  success BOOLEAN,
  error_message TEXT
) AS $$
DECLARE
  v_reading JSONB;
  v_meter_id UUID;
  v_reading_id UUID;
  v_reading_code TEXT;
  v_meter_code TEXT;
BEGIN
  -- Loop through each reading in the array
  FOR v_reading IN SELECT * FROM jsonb_array_elements(p_readings)
  LOOP
    BEGIN
      -- Find meter by code
      SELECT id, code INTO v_meter_id, v_meter_code
      FROM meters
      WHERE code = (v_reading->>'meter_code')::TEXT
        AND user_id = auth.uid()
        AND deleted_at IS NULL;

      IF v_meter_id IS NULL THEN
        -- Meter not found
        RETURN QUERY SELECT
          NULL::UUID,
          NULL::TEXT,
          (v_reading->>'meter_code')::TEXT,
          FALSE,
          'Meter not found: ' || (v_reading->>'meter_code')::TEXT;
        CONTINUE;
      END IF;

      -- Insert meter reading
      INSERT INTO meter_readings (
        user_id,
        meter_id,
        reading_date,
        current_reading,
        notes,
        meter_image_url
      ) VALUES (
        auth.uid(),
        v_meter_id,
        (v_reading->>'reading_date')::DATE,
        (v_reading->>'current_reading')::DECIMAL(10, 2),
        (v_reading->>'notes')::TEXT,
        (v_reading->>'meter_image_url')::TEXT
      )
      RETURNING id, reading_code INTO v_reading_id, v_reading_code;

      -- Return success
      RETURN QUERY SELECT
        v_reading_id,
        v_reading_code,
        v_meter_code,
        TRUE,
        NULL::TEXT;

    EXCEPTION WHEN OTHERS THEN
      -- Return error
      RETURN QUERY SELECT
        NULL::UUID,
        NULL::TEXT,
        v_meter_code,
        FALSE,
        SQLERRM;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION bulk_create_meter_readings IS
'Bulk creates meter readings from JSON array - used for batch import';


-- =============================================
-- 9. UPDATE COMMENTS
-- =============================================

COMMENT ON COLUMN meter_readings.meter_id IS 'Reference to meters table (công tơ)';
COMMENT ON COLUMN meter_readings.reading_code IS 'Unique reading code (CSS250700001)';


-- =============================================
-- 10. GENERATE READING CODES FOR EXISTING DATA
-- =============================================

-- Generate reading_code for existing records that don't have one
UPDATE meter_readings
SET reading_code = generate_meter_reading_code(user_id)
WHERE reading_code IS NULL
  AND deleted_at IS NULL;


-- Migration completed
-- =============================================
-- Summary:
-- - Added meter_id to link meter_readings with meters table
-- - Added reading_code (CSS...) for unique identification
-- - Auto-generates reading_code on insert
-- - Updated triggers to handle meter_id
-- - Updated auto_populate_previous_reading to use meter_id
-- - Updated meter_readings_detailed view to include meter info
-- - Added bulk_create_meter_readings function for batch import
-- - Migrated existing data to link with meters
--
-- Reading Code Format: CSS{YYMM}{sequence}
-- Examples: CSS250700001, CSS250700128, CSS250700039
--
-- Updated Workflows:
--
-- A. INDIVIDUAL METER READING (with meter):
-- 1. Select building, room, meter type
-- 2. System shows meters using get_meters_without_readings()
-- 3. For each meter, enter current_reading
-- 4. System auto-fills: meter_id, previous_reading, reading_code
-- 5. Save → Status: UNAPPROVED
--
-- B. BATCH IMPORT:
-- 1. Download template with columns: meter_code, reading_date, current_reading
-- 2. Fill template
-- 3. Upload file → Call bulk_create_meter_readings()
-- 4. System creates multiple readings with auto-generated codes
--
-- C. APPROVAL:
-- 1. View list of UNAPPROVED readings
-- 2. Single approve: approve_meter_reading(reading_id)
-- 3. Bulk approve: bulk_approve_meter_readings([reading_ids])
-- =============================================
