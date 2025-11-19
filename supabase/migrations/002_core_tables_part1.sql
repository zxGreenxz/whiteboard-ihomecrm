-- =============================================
-- Migration 002: Core Tables Part 1
-- Created: 2025-11-18
-- Description: Create core tables - profiles, areas, buildings, rooms, beds
-- =============================================

-- =============================================
-- 1. PROFILES TABLE
-- =============================================
-- Extends auth.users with additional user information

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  avatar_url TEXT,

  -- Company info
  company_name TEXT,
  address TEXT,

  -- Settings
  default_payment_due_days INTEGER DEFAULT 5,
  timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
  language TEXT DEFAULT 'vi',

  -- Subscription info
  subscription_plan TEXT DEFAULT 'trial', -- trial, basic, pro, enterprise
  subscription_expires_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT profiles_phone_format CHECK (phone IS NULL OR phone ~ '^[0-9]{10,11}$'),
  CONSTRAINT profiles_full_name_not_empty CHECK (char_length(full_name) > 0)
);

-- Indexes
CREATE INDEX idx_profiles_phone ON profiles(phone);
CREATE INDEX idx_profiles_email ON profiles(email);

-- RLS Policies
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- Comments
COMMENT ON TABLE profiles IS 'Extended user profile information';


-- =============================================
-- 2. AREAS TABLE
-- =============================================
-- Top-level grouping for buildings (Khu vực)

CREATE TABLE areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT areas_name_not_empty CHECK (char_length(name) > 0)
);

-- Indexes
CREATE INDEX idx_areas_user_id ON areas(user_id);
CREATE INDEX idx_areas_status ON areas(status);
CREATE INDEX idx_areas_code ON areas(code);
CREATE INDEX idx_areas_deleted_at ON areas(deleted_at);

-- Full-text search
CREATE INDEX idx_areas_search ON areas USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(code, '') || ' ' || coalesce(description, ''))
);

-- RLS Policies
ALTER TABLE areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own areas"
  ON areas FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own areas"
  ON areas FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own areas"
  ON areas FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own areas"
  ON areas FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE areas IS 'Geographic areas for grouping buildings (e.g., District 1, Zone A)';


-- =============================================
-- 3. BUILDINGS TABLE
-- =============================================

CREATE TABLE buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  area_id UUID REFERENCES areas(id) ON DELETE SET NULL,

  -- Basic info
  name TEXT NOT NULL,
  code TEXT,
  type building_type NOT NULL DEFAULT 'APARTMENT',
  status building_status NOT NULL DEFAULT 'ACTIVE',

  -- Address
  province TEXT NOT NULL,
  district TEXT NOT NULL,
  ward TEXT NOT NULL,
  street_address TEXT,

  -- Configuration
  total_floors INTEGER DEFAULT 1,
  total_rooms INTEGER DEFAULT 0, -- Auto-calculated by trigger

  -- Metadata
  description TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  amenities JSONB DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT buildings_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT buildings_total_floors_positive CHECK (total_floors > 0),
  CONSTRAINT buildings_total_rooms_non_negative CHECK (total_rooms >= 0)
);

-- Indexes
CREATE INDEX idx_buildings_user_id ON buildings(user_id);
CREATE INDEX idx_buildings_area_id ON buildings(area_id);
CREATE INDEX idx_buildings_status ON buildings(status);
CREATE INDEX idx_buildings_type ON buildings(type);
CREATE INDEX idx_buildings_deleted_at ON buildings(deleted_at);

-- Full-text search
CREATE INDEX idx_buildings_search ON buildings USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(code, '') || ' ' || coalesce(street_address, ''))
);

-- RLS Policies
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own buildings"
  ON buildings FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own buildings"
  ON buildings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own buildings"
  ON buildings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own buildings"
  ON buildings FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE buildings IS 'Buildings/properties for rent (apartments, dormitories, houses, etc.)';


-- =============================================
-- 4. ROOMS TABLE
-- =============================================

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL,
  code TEXT,
  floor INTEGER NOT NULL DEFAULT 1,
  status room_status NOT NULL DEFAULT 'AVAILABLE',

  -- Room details
  area DECIMAL(10, 2),
  max_occupants INTEGER DEFAULT 1,

  -- Pricing
  rent_price DECIMAL(15, 2) NOT NULL,
  deposit_amount DECIMAL(15, 2) NOT NULL,

  -- Metadata
  description TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  amenities JSONB DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT rooms_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT rooms_floor_positive CHECK (floor > 0),
  CONSTRAINT rooms_area_positive CHECK (area IS NULL OR area > 0),
  CONSTRAINT rooms_rent_price_non_negative CHECK (rent_price >= 0),
  CONSTRAINT rooms_deposit_amount_non_negative CHECK (deposit_amount >= 0),
  CONSTRAINT rooms_max_occupants_positive CHECK (max_occupants > 0)
);

-- Indexes
CREATE INDEX idx_rooms_building_id ON rooms(building_id);
CREATE INDEX idx_rooms_status ON rooms(status);
CREATE INDEX idx_rooms_floor ON rooms(floor);
CREATE INDEX idx_rooms_deleted_at ON rooms(deleted_at);

-- Unique constraint: Room name unique per building
CREATE UNIQUE INDEX idx_rooms_unique_name_per_building
  ON rooms(building_id, name)
  WHERE deleted_at IS NULL;

-- Full-text search
CREATE INDEX idx_rooms_search ON rooms USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(code, '') || ' ' || coalesce(description, ''))
);

-- RLS Policies
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view rooms of own buildings"
  ON rooms FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
        AND buildings.deleted_at IS NULL
    )
    AND deleted_at IS NULL
  );

CREATE POLICY "Users can insert rooms to own buildings"
  ON rooms FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update rooms of own buildings"
  ON rooms FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete rooms of own buildings"
  ON rooms FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
    )
  );

-- Comments
COMMENT ON TABLE rooms IS 'Rooms/apartments within buildings';


-- =============================================
-- 5. BEDS TABLE
-- =============================================
-- For dormitory/sleepbox models

CREATE TABLE beds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL,
  code TEXT,
  status bed_status NOT NULL DEFAULT 'AVAILABLE',

  -- Pricing
  rent_price DECIMAL(15, 2) NOT NULL,
  deposit_amount DECIMAL(15, 2) NOT NULL,

  -- Metadata
  description TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT beds_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT beds_rent_price_non_negative CHECK (rent_price >= 0),
  CONSTRAINT beds_deposit_amount_non_negative CHECK (deposit_amount >= 0)
);

-- Indexes
CREATE INDEX idx_beds_room_id ON beds(room_id);
CREATE INDEX idx_beds_status ON beds(status);
CREATE INDEX idx_beds_deleted_at ON beds(deleted_at);

-- Unique constraint: Bed name unique per room
CREATE UNIQUE INDEX idx_beds_unique_name_per_room
  ON beds(room_id, name)
  WHERE deleted_at IS NULL;

-- RLS Policies
ALTER TABLE beds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view beds of own rooms"
  ON beds FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN buildings ON buildings.id = rooms.building_id
      WHERE rooms.id = beds.room_id
        AND buildings.user_id = auth.uid()
        AND rooms.deleted_at IS NULL
        AND buildings.deleted_at IS NULL
    )
    AND deleted_at IS NULL
  );

CREATE POLICY "Users can insert beds to own rooms"
  ON beds FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN buildings ON buildings.id = rooms.building_id
      WHERE rooms.id = beds.room_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update beds of own rooms"
  ON beds FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN buildings ON buildings.id = rooms.building_id
      WHERE rooms.id = beds.room_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete beds of own rooms"
  ON beds FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN buildings ON buildings.id = rooms.building_id
      WHERE rooms.id = beds.room_id
        AND buildings.user_id = auth.uid()
    )
  );

-- Comments
COMMENT ON TABLE beds IS 'Individual beds for dormitory/sleepbox models';


-- Migration completed
-- =============================================
-- Total: 5 tables created (profiles, areas, buildings, rooms, beds)
-- All tables have RLS enabled and policies configured
-- Next: 003_core_tables_part2.sql
