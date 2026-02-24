-- =============================================
-- Migration: Meter Reading Full Reimplementation
-- Description: Drop and recreate meters + meter_readings tables
--   with full schema, constraints, RLS policies, and indexes.
--   This is a clean reimplementation to ensure 100% alignment
--   with the design document.
-- Requirements: 8.10, 11.3, 12.1, 12.2, 12.4
-- =============================================

-- =============================================
-- 0. DROP DEPENDENT OBJECTS
-- =============================================

-- Drop views that depend on these tables
DROP VIEW IF EXISTS meter_readings_detailed CASCADE;
DROP VIEW IF EXISTS meters_with_latest_reading CASCADE;

-- Drop functions/triggers that will be recreated in later migrations
DROP TRIGGER IF EXISTS trigger_auto_populate_meter_reading_fields ON meter_readings;
DROP TRIGGER IF EXISTS trigger_auto_populate_previous_reading ON meter_readings;
DROP TRIGGER IF EXISTS trigger_auto_generate_reading_code ON meter_readings;
DROP TRIGGER IF EXISTS trigger_update_meter_reading_updated_at ON meter_readings;
DROP TRIGGER IF EXISTS trigger_auto_generate_meter_name ON meters;
DROP TRIGGER IF EXISTS trigger_update_meters_updated_at ON meters;

DROP FUNCTION IF EXISTS auto_populate_meter_reading_fields() CASCADE;
DROP FUNCTION IF EXISTS auto_populate_previous_reading() CASCADE;
DROP FUNCTION IF EXISTS auto_generate_reading_code() CASCADE;
DROP FUNCTION IF EXISTS generate_meter_reading_code(UUID) CASCADE;
DROP FUNCTION IF EXISTS update_meter_reading_updated_at() CASCADE;
DROP FUNCTION IF EXISTS auto_generate_meter_name() CASCADE;
DROP FUNCTION IF EXISTS update_meters_updated_at() CASCADE;
DROP FUNCTION IF EXISTS approve_meter_reading(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS bulk_approve_meter_readings(UUID[], UUID) CASCADE;
DROP FUNCTION IF EXISTS get_meter_reading_stats(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS get_meters_without_readings(UUID, UUID, UUID, meter_type, TEXT) CASCADE;
DROP FUNCTION IF EXISTS bulk_create_meter_readings(JSONB) CASCADE;

-- Drop tables (CASCADE removes RLS policies, indexes, constraints)
DROP TABLE IF EXISTS meter_readings CASCADE;
DROP TABLE IF EXISTS meters CASCADE;


-- =============================================
-- 1. CREATE TABLE: meters
-- =============================================

CREATE TABLE meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identification
  code TEXT NOT NULL,

  -- Links
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  -- Meter info
  meter_type meter_type NOT NULL,
  name TEXT,
  initial_reading DECIMAL(10, 2) DEFAULT 0,

  -- Status
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'INACTIVE', 'BROKEN', 'REMOVED')
  ),

  -- Installation & location
  installation_date DATE,
  location_note TEXT,

  -- Metadata
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
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

-- Comments
COMMENT ON TABLE meters IS 'Physical meters (công tơ) installed in rooms for electricity, water, gas';
COMMENT ON COLUMN meters.code IS 'Unique meter code per user (CTD-201, CTN-201...)';
COMMENT ON COLUMN meters.room_id IS 'Room where meter is installed (NULL for common meters)';
COMMENT ON COLUMN meters.initial_reading IS 'Initial reading when meter was installed';
COMMENT ON COLUMN meters.status IS 'ACTIVE, INACTIVE, BROKEN, or REMOVED';


-- =============================================
-- 2. CREATE TABLE: meter_readings
-- =============================================

CREATE TABLE meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Meter link
  meter_id UUID REFERENCES meters(id) ON DELETE CASCADE,

  -- Identification
  reading_code TEXT,

  -- Legacy / optional links
  contract_id UUID REFERENCES contracts(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE RESTRICT,

  -- Location (auto-populated from meter)
  building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,

  -- Reading info
  meter_type meter_type NOT NULL,
  settlement_month TEXT,
  reading_date DATE NOT NULL,
  previous_reading DECIMAL(10, 2) NOT NULL DEFAULT 0,
  current_reading DECIMAL(10, 2) NOT NULL,
  consumption DECIMAL(10, 2) GENERATED ALWAYS AS (current_reading - previous_reading) STORED,

  -- Approval workflow
  status TEXT NOT NULL DEFAULT 'UNAPPROVED' CHECK (
    status IN ('UNAPPROVED', 'APPROVED')
  ),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,

  -- Recording
  recorded_by UUID REFERENCES auth.users(id),

  -- Metadata
  notes TEXT,
  meter_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT meter_readings_current_gte_previous CHECK (current_reading >= previous_reading)
);

-- Indexes
CREATE INDEX idx_meter_readings_user_id ON meter_readings(user_id);
CREATE INDEX idx_meter_readings_meter_id ON meter_readings(meter_id);
CREATE INDEX idx_meter_readings_contract_id ON meter_readings(contract_id);
CREATE INDEX idx_meter_readings_service_id ON meter_readings(service_id);
CREATE INDEX idx_meter_readings_building_id ON meter_readings(building_id);
CREATE INDEX idx_meter_readings_room_id ON meter_readings(room_id);
CREATE INDEX idx_meter_readings_reading_date ON meter_readings(reading_date);
CREATE INDEX idx_meter_readings_meter_type ON meter_readings(meter_type);
CREATE INDEX idx_meter_readings_settlement_month ON meter_readings(settlement_month);
CREATE INDEX idx_meter_readings_status ON meter_readings(status);
CREATE INDEX idx_meter_readings_recorded_by ON meter_readings(recorded_by);
CREATE INDEX idx_meter_readings_deleted_at ON meter_readings(deleted_at) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_meter_readings_code ON meter_readings(reading_code) WHERE reading_code IS NOT NULL;

-- Comments
COMMENT ON TABLE meter_readings IS 'Meter readings for electricity, water, gas';
COMMENT ON COLUMN meter_readings.meter_id IS 'Reference to meters table (công tơ)';
COMMENT ON COLUMN meter_readings.reading_code IS 'Unique reading code (CSS250700001)';
COMMENT ON COLUMN meter_readings.settlement_month IS 'Settlement month in YYYY-MM format';
COMMENT ON COLUMN meter_readings.consumption IS 'Auto-calculated: current_reading - previous_reading';
COMMENT ON COLUMN meter_readings.status IS 'Approval status: UNAPPROVED or APPROVED';
COMMENT ON COLUMN meter_readings.approved_by IS 'User who approved the reading';
COMMENT ON COLUMN meter_readings.approved_at IS 'Timestamp when approved';
COMMENT ON COLUMN meter_readings.recorded_by IS 'User who recorded the reading';
COMMENT ON COLUMN meter_readings.deleted_at IS 'Soft delete timestamp';


-- =============================================
-- 3. RLS POLICIES: meters
-- =============================================

ALTER TABLE meters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own active meters"
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


-- =============================================
-- 4. RLS POLICIES: meter_readings
-- =============================================

ALTER TABLE meter_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own meter readings"
  ON meter_readings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own meter readings"
  ON meter_readings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own meter readings"
  ON meter_readings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own meter readings"
  ON meter_readings FOR DELETE
  USING (auth.uid() = user_id);
