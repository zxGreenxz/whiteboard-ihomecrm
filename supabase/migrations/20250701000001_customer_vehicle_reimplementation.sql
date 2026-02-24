-- =============================================
-- Migration: Customer & Vehicle Reimplementation
-- Created: 2025-07-01
-- Description: 
--   - Add ELECTRIC_BIKE to vehicle_type enum
--   - Create customer_status_v2 enum (RENTING, MOVED_OUT, WALK_IN)
--   - Add status_v2 column to customers with data migration
--   - Add organization columns to customers
--   - Add new columns to vehicles (customer_id, vehicle_name, owner_name, etc.)
--   - Create ct01_declarations table
--   - Add indexes for vehicles search
-- =============================================

-- =============================================
-- 1. ENUM UPDATES
-- =============================================

-- Add ELECTRIC_BIKE to vehicle_type enum
ALTER TYPE vehicle_type ADD VALUE IF NOT EXISTS 'ELECTRIC_BIKE';

-- Create new customer_status_v2 enum (replaces old customer_status for new workflow)
CREATE TYPE customer_status_v2 AS ENUM (
  'RENTING',     -- Đang thuê
  'MOVED_OUT',   -- Đã chuyển đi
  'WALK_IN'      -- Khách vãng lai
);

-- =============================================
-- 2. UPDATE CUSTOMERS TABLE
-- =============================================

-- Add status_v2 column using new enum
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status_v2 customer_status_v2 DEFAULT 'RENTING';

-- Migrate existing data from old status to new status_v2
UPDATE customers SET status_v2 = CASE
  WHEN status = 'ACTIVE' THEN 'RENTING'::customer_status_v2
  WHEN status = 'INACTIVE' THEN 'MOVED_OUT'::customer_status_v2
  ELSE 'WALK_IN'::customer_status_v2
END
WHERE status_v2 IS NULL OR status_v2 = 'RENTING';

-- Add organization-specific columns
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS company_name TEXT,
  ADD COLUMN IF NOT EXISTS tax_code TEXT,
  ADD COLUMN IF NOT EXISTS representative TEXT,
  ADD COLUMN IF NOT EXISTS business_registration_url TEXT,
  ADD COLUMN IF NOT EXISTS headquarters_address TEXT;

-- =============================================
-- 3. UPDATE VEHICLES TABLE
-- =============================================

-- Make tenant_id nullable for backward compatibility
ALTER TABLE vehicles ALTER COLUMN tenant_id DROP NOT NULL;

-- Add new columns for customer-vehicle relationship and additional info
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_name TEXT,
  ADD COLUMN IF NOT EXISTS owner_name TEXT,
  ADD COLUMN IF NOT EXISTS ticket_number TEXT,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Indexes for new vehicle columns
CREATE INDEX IF NOT EXISTS idx_vehicles_customer_id ON vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_building_id ON vehicles(building_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_room_id ON vehicles(room_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_vehicle_name ON vehicles(vehicle_name);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_name ON vehicles(owner_name);

-- Full-text search index for vehicles (license_plate, vehicle_name, owner_name)
CREATE INDEX IF NOT EXISTS idx_vehicles_search ON vehicles USING GIN (
  to_tsvector('simple',
    coalesce(license_plate, '') || ' ' ||
    coalesce(vehicle_name, '') || ' ' ||
    coalesce(owner_name, '')
  )
);

-- =============================================
-- 4. CREATE CT01_DECLARATIONS TABLE
-- =============================================

CREATE TABLE ct01_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Thông tin người khai
  registration_authority TEXT NOT NULL,
  full_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  gender TEXT NOT NULL,
  id_number TEXT NOT NULL,
  phone TEXT,
  email TEXT,

  -- Địa chỉ
  permanent_address TEXT,
  temporary_address TEXT,
  current_address TEXT,

  -- Nghề nghiệp
  occupation_workplace TEXT,

  -- Thông tin chủ hộ
  household_head_name TEXT,
  household_head_relationship TEXT,
  household_head_id_number TEXT,

  -- Nội dung đề nghị
  request_content TEXT,

  -- Thành viên gia đình (JSONB array)
  family_members JSONB DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_ct01_user_id ON ct01_declarations(user_id);
CREATE INDEX idx_ct01_customer_id ON ct01_declarations(customer_id);

-- RLS
ALTER TABLE ct01_declarations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ct01" ON ct01_declarations
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own ct01" ON ct01_declarations
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own ct01" ON ct01_declarations
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own ct01" ON ct01_declarations
  FOR DELETE USING (auth.uid() = user_id);

-- Trigger updated_at (reuses existing function from migration 008)
CREATE TRIGGER update_ct01_updated_at
  BEFORE UPDATE ON ct01_declarations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- 5. COMMENTS
-- =============================================

COMMENT ON COLUMN customers.status_v2 IS 'New customer status: RENTING, MOVED_OUT, WALK_IN';
COMMENT ON COLUMN customers.company_name IS 'Organization name (for ORGANIZATION type)';
COMMENT ON COLUMN customers.tax_code IS 'Tax code (for ORGANIZATION type)';
COMMENT ON COLUMN customers.representative IS 'Legal representative (for ORGANIZATION type)';
COMMENT ON COLUMN customers.business_registration_url IS 'Business registration document URL';
COMMENT ON COLUMN customers.headquarters_address IS 'Headquarters address (for ORGANIZATION type)';

COMMENT ON COLUMN vehicles.customer_id IS 'FK to customers table (new relationship)';
COMMENT ON COLUMN vehicles.vehicle_name IS 'Vehicle model/brand name';
COMMENT ON COLUMN vehicles.owner_name IS 'Vehicle owner name per registration';
COMMENT ON COLUMN vehicles.ticket_number IS 'Parking ticket number';
COMMENT ON COLUMN vehicles.building_id IS 'FK to buildings table';
COMMENT ON COLUMN vehicles.room_id IS 'FK to rooms table';
COMMENT ON COLUMN vehicles.image_url IS 'Vehicle image URL';

COMMENT ON TABLE ct01_declarations IS 'CT01 residence change declaration forms';
