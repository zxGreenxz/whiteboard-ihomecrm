-- =============================================
-- Migration 017: Meters Table (Công tơ)
-- Created: 2025-11-21
-- Description: Create meters table for tracking physical meters in rooms
-- =============================================

-- =============================================
-- 1. METERS TABLE
-- =============================================
-- Represents physical meters (công tơ) installed in rooms
-- Each room can have multiple meters (electricity, water, gas)

CREATE TABLE meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Meter code (CTD-201, CTD-G01, CTD-106...)
  code TEXT NOT NULL,

  -- Links
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL, -- NULL = common meter
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  -- Meter info
  meter_type meter_type NOT NULL,
  name TEXT, -- Tên công tơ (optional, có thể auto-generate từ room + type)

  -- Installation info
  installation_date DATE,
  initial_reading DECIMAL(10, 2) DEFAULT 0, -- Chỉ số ban đầu khi lắp

  -- Status
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'INACTIVE', 'BROKEN', 'REMOVED')
  ),

  -- Location details
  location_note TEXT, -- Vị trí cụ thể (Phòng khách, Phòng ngủ, Ngoài hành lang...)

  -- Metadata
  manufacturer TEXT, -- Hãng sản xuất
  model TEXT, -- Model công tơ
  serial_number TEXT, -- Số serial
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT meters_code_not_empty CHECK (char_length(code) > 0),
  CONSTRAINT meters_initial_reading_non_negative CHECK (initial_reading >= 0),
  UNIQUE(user_id, code)
);

-- Indexes
CREATE INDEX idx_meters_user_id ON meters(user_id);
CREATE INDEX idx_meters_building_id ON meters(building_id);
CREATE INDEX idx_meters_room_id ON meters(room_id);
CREATE INDEX idx_meters_service_id ON meters(service_id);
CREATE INDEX idx_meters_meter_type ON meters(meter_type);
CREATE INDEX idx_meters_status ON meters(status);
CREATE INDEX idx_meters_code ON meters(code);
CREATE INDEX idx_meters_deleted_at ON meters(deleted_at) WHERE deleted_at IS NULL;

-- Full-text search
CREATE INDEX idx_meters_search ON meters USING GIN (
  to_tsvector('simple',
    coalesce(code, '') || ' ' ||
    coalesce(name, '') || ' ' ||
    coalesce(location_note, '')
  )
);

-- RLS Policies
ALTER TABLE meters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own meters"
  ON meters FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own meters"
  ON meters FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own meters"
  ON meters FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own meters"
  ON meters FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE meters IS 'Physical meters (công tơ) installed in rooms for electricity, water, gas';
COMMENT ON COLUMN meters.code IS 'Meter code (CTD-201, CTD-G01...)';
COMMENT ON COLUMN meters.room_id IS 'Room where meter is installed (NULL for common meters)';
COMMENT ON COLUMN meters.initial_reading IS 'Initial reading when meter was installed';
COMMENT ON COLUMN meters.status IS 'ACTIVE: working, INACTIVE: not in use, BROKEN: needs repair, REMOVED: uninstalled';


-- =============================================
-- 2. TRIGGER: Auto-update updated_at
-- =============================================

CREATE OR REPLACE FUNCTION update_meters_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_meters_updated_at ON meters;

CREATE TRIGGER trigger_update_meters_updated_at
  BEFORE UPDATE ON meters
  FOR EACH ROW
  EXECUTE FUNCTION update_meters_updated_at();


-- =============================================
-- 3. TRIGGER: Auto-generate meter name
-- =============================================

CREATE OR REPLACE FUNCTION auto_generate_meter_name()
RETURNS TRIGGER AS $$
DECLARE
  v_room_name TEXT;
  v_meter_type_name TEXT;
BEGIN
  -- Only generate if name is empty
  IF NEW.name IS NULL OR NEW.name = '' THEN
    -- Get room name
    IF NEW.room_id IS NOT NULL THEN
      SELECT name INTO v_room_name FROM rooms WHERE id = NEW.room_id;
    ELSE
      v_room_name := 'Common';
    END IF;

    -- Get meter type name
    CASE NEW.meter_type
      WHEN 'ELECTRICITY' THEN v_meter_type_name := 'Điện';
      WHEN 'WATER' THEN v_meter_type_name := 'Nước';
      WHEN 'GAS' THEN v_meter_type_name := 'Gas';
      ELSE v_meter_type_name := 'Khác';
    END CASE;

    -- Generate name: "Phòng 201 - Điện" or "Common - Nước"
    NEW.name := v_room_name || ' - ' || v_meter_type_name;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_generate_meter_name ON meters;

CREATE TRIGGER trigger_auto_generate_meter_name
  BEFORE INSERT ON meters
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_meter_name();

COMMENT ON FUNCTION auto_generate_meter_name() IS
'Auto-generates meter name from room name and meter type';


-- =============================================
-- 4. FUNCTION: Get meters without readings in month
-- =============================================
-- Returns meters that haven't been recorded in a specific month
-- Used for "Chỉ hiện công tơ chưa chốt trong tháng"

CREATE OR REPLACE FUNCTION get_meters_without_readings(
  p_user_id UUID,
  p_building_id UUID DEFAULT NULL,
  p_room_id UUID DEFAULT NULL,
  p_meter_type meter_type DEFAULT NULL,
  p_month TEXT DEFAULT TO_CHAR(CURRENT_DATE, 'YYYY-MM')
)
RETURNS TABLE(
  meter_id UUID,
  meter_code TEXT,
  meter_name TEXT,
  room_name TEXT,
  meter_type_value meter_type,
  last_reading DECIMAL,
  last_reading_date DATE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id as meter_id,
    m.code as meter_code,
    m.name as meter_name,
    r.name as room_name,
    m.meter_type as meter_type_value,
    COALESCE(
      (SELECT current_reading
       FROM meter_readings
       WHERE meter_id = m.id
         AND deleted_at IS NULL
       ORDER BY reading_date DESC, created_at DESC
       LIMIT 1),
      m.initial_reading
    ) as last_reading,
    (SELECT reading_date
     FROM meter_readings
     WHERE meter_id = m.id
       AND deleted_at IS NULL
     ORDER BY reading_date DESC, created_at DESC
     LIMIT 1) as last_reading_date
  FROM meters m
  LEFT JOIN rooms r ON r.id = m.room_id
  WHERE m.user_id = p_user_id
    AND m.status = 'ACTIVE'
    AND m.deleted_at IS NULL
    AND (p_building_id IS NULL OR m.building_id = p_building_id)
    AND (p_room_id IS NULL OR m.room_id = p_room_id)
    AND (p_meter_type IS NULL OR m.meter_type = p_meter_type)
    -- Not yet recorded in this month
    AND NOT EXISTS (
      SELECT 1 FROM meter_readings mr
      WHERE mr.meter_id = m.id
        AND mr.settlement_month = p_month
        AND mr.deleted_at IS NULL
    )
  ORDER BY r.name, m.meter_type;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_meters_without_readings IS
'Returns active meters that have not been recorded in a specific month';


-- =============================================
-- 5. VIEW: Meters with latest reading
-- =============================================

CREATE OR REPLACE VIEW meters_with_latest_reading AS
SELECT
  m.id,
  m.user_id,
  m.code,
  m.name,
  m.building_id,
  b.name as building_name,
  m.room_id,
  r.name as room_name,
  m.service_id,
  s.name as service_name,
  m.meter_type,
  m.status,
  m.installation_date,
  m.initial_reading,

  -- Latest reading
  (SELECT current_reading
   FROM meter_readings
   WHERE meter_id = m.id AND deleted_at IS NULL
   ORDER BY reading_date DESC, created_at DESC
   LIMIT 1) as latest_reading,

  (SELECT reading_date
   FROM meter_readings
   WHERE meter_id = m.id AND deleted_at IS NULL
   ORDER BY reading_date DESC, created_at DESC
   LIMIT 1) as latest_reading_date,

  -- Count readings
  (SELECT COUNT(*)
   FROM meter_readings
   WHERE meter_id = m.id AND deleted_at IS NULL) as total_readings,

  m.location_note,
  m.manufacturer,
  m.model,
  m.serial_number,
  m.notes,
  m.created_at,
  m.updated_at

FROM meters m
LEFT JOIN buildings b ON b.id = m.building_id
LEFT JOIN rooms r ON r.id = m.room_id
LEFT JOIN services s ON s.id = m.service_id
WHERE m.deleted_at IS NULL
ORDER BY b.name, r.name, m.meter_type;

COMMENT ON VIEW meters_with_latest_reading IS
'Meters with their latest reading information';


-- =============================================
-- 6. SEED DATA: Create meters for existing rooms (optional)
-- =============================================
-- This will auto-create meters for rooms that have contracts with metered services
-- Run this only if you want to auto-populate meters

/*
INSERT INTO meters (user_id, code, building_id, room_id, service_id, meter_type, installation_date)
SELECT DISTINCT
  c.user_id,
  -- Generate code: Building code + Room name + Meter type initial
  b.code || '-' || r.name || CASE
    WHEN s.type = 'ELECTRICITY' THEN 'D'
    WHEN s.type = 'WATER' THEN 'N'
    WHEN s.type = 'GAS' THEN 'G'
    ELSE 'X'
  END as code,
  c.building_id,
  c.room_id,
  cs.service_id,
  CASE s.type
    WHEN 'ELECTRICITY' THEN 'ELECTRICITY'::meter_type
    WHEN 'WATER' THEN 'WATER'::meter_type
    WHEN 'GAS' THEN 'GAS'::meter_type
    ELSE 'OTHER'::meter_type
  END as meter_type,
  c.start_date as installation_date
FROM contracts c
INNER JOIN contract_services cs ON cs.contract_id = c.id
INNER JOIN services s ON s.id = cs.service_id
INNER JOIN buildings b ON b.id = c.building_id
INNER JOIN rooms r ON r.id = c.room_id
WHERE c.status = 'ACTIVE'
  AND s.type IN ('ELECTRICITY', 'WATER', 'GAS')
  AND c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM meters m
    WHERE m.room_id = c.room_id
      AND m.service_id = cs.service_id
      AND m.deleted_at IS NULL
  )
ON CONFLICT (user_id, code) DO NOTHING;
*/


-- Migration completed
-- =============================================
-- Summary:
-- - Created meters table for physical meters (công tơ)
-- - Auto-generates meter name from room + type
-- - Function to get meters without readings in month
-- - View with latest reading information
-- - RLS policies for multi-tenant security
--
-- Meter Code Examples:
-- - CTD-201: Công tơ điện phòng 201
-- - CTD-G01: Công tơ điện phòng G01
-- - CTN-201: Công tơ nước phòng 201
-- - CTG-301: Công tơ gas phòng 301
--
-- Workflows:
--
-- A. CREATE METER:
-- 1. Admin navigates to Settings → Meters
-- 2. Click (+) Add Meter
-- 3. Fill: Building, Room, Meter Type, Code
-- 4. System auto-generates name
-- 5. Save → Status: ACTIVE
--
-- B. RECORD METER READING:
-- 1. Select Building, Room, Meter Type
-- 2. System shows list of meters (use get_meters_without_readings for unrecorded)
-- 3. Enter readings for multiple meters at once
-- 4. Save → Creates meter_reading records
--
-- C. VIEW METER STATUS:
-- 1. Query meters_with_latest_reading view
-- 2. Shows all meters with their latest reading
-- 3. Filter by building, room, type, status
-- =============================================
