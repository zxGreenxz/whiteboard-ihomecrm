-- =============================================
-- Migration 003: Core Tables Part 2
-- Created: 2025-11-18
-- Description: Create services, tenants, deposits, vehicles tables
-- =============================================

-- =============================================
-- 1. SERVICES TABLE
-- =============================================
-- Service definitions (electricity, water, wifi, etc.)

CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL,
  code TEXT,
  type service_type NOT NULL,

  -- Pricing
  unit_price DECIMAL(15, 2) NOT NULL DEFAULT 0,
  unit TEXT, -- kWh, m3, người, phòng...

  -- Configuration
  is_default BOOLEAN DEFAULT false, -- Auto-selected for new contracts
  is_mandatory BOOLEAN DEFAULT false, -- Required for all contracts

  -- Metadata
  description TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT services_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT services_unit_price_non_negative CHECK (unit_price >= 0)
);

-- Indexes
CREATE INDEX idx_services_user_id ON services(user_id);
CREATE INDEX idx_services_type ON services(type);
CREATE INDEX idx_services_is_default ON services(is_default);
CREATE INDEX idx_services_deleted_at ON services(deleted_at);

-- Full-text search
CREATE INDEX idx_services_search ON services USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(code, '') || ' ' || coalesce(description, ''))
);

-- RLS Policies
ALTER TABLE services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own services"
  ON services FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own services"
  ON services FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own services"
  ON services FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own services"
  ON services FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE services IS 'Service definitions (electricity, water, wifi, parking, etc.)';


-- =============================================
-- 2. TENANTS TABLE
-- =============================================
-- Tenant/customer information

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Personal info
  full_name TEXT NOT NULL,
  id_number TEXT,
  id_type id_type DEFAULT 'CCCD',
  date_of_birth DATE,
  gender TEXT,

  -- Contact
  phone TEXT NOT NULL,
  email TEXT,

  -- Address
  permanent_address TEXT,

  -- Status
  status tenant_status DEFAULT 'PROSPECT',

  -- Emergency contact
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  emergency_contact_relationship TEXT,

  -- Metadata
  notes TEXT,
  avatar_url TEXT,
  id_images JSONB DEFAULT '[]'::jsonb, -- Front/back CCCD images

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT tenants_full_name_not_empty CHECK (char_length(full_name) > 0),
  CONSTRAINT tenants_phone_format CHECK (phone ~ '^[0-9]{10,11}$')
);

-- Indexes
CREATE INDEX idx_tenants_user_id ON tenants(user_id);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_phone ON tenants(phone);
CREATE INDEX idx_tenants_id_number ON tenants(id_number);
CREATE INDEX idx_tenants_deleted_at ON tenants(deleted_at);

-- Full-text search
CREATE INDEX idx_tenants_search ON tenants USING GIN (
  to_tsvector('simple', coalesce(full_name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email, '') || ' ' || coalesce(id_number, ''))
);

-- RLS Policies
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tenants"
  ON tenants FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own tenants"
  ON tenants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tenants"
  ON tenants FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tenants"
  ON tenants FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE tenants IS 'Tenant/customer information';


-- =============================================
-- 3. DEPOSITS TABLE
-- =============================================
-- Security deposits before contract

CREATE TABLE deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  bed_id UUID REFERENCES beds(id) ON DELETE RESTRICT,
  contract_id UUID, -- Foreign key will be added in migration 004

  -- Deposit info
  amount DECIMAL(15, 2) NOT NULL,
  deposit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status deposit_status NOT NULL DEFAULT 'PENDING',

  -- Hold period
  hold_until DATE, -- Reserve room until this date

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT deposits_amount_positive CHECK (amount > 0),
  CONSTRAINT deposits_must_have_room_or_bed CHECK (
    (room_id IS NOT NULL AND bed_id IS NULL) OR
    (room_id IS NULL AND bed_id IS NOT NULL)
  )
);

-- Indexes
CREATE INDEX idx_deposits_user_id ON deposits(user_id);
CREATE INDEX idx_deposits_tenant_id ON deposits(tenant_id);
CREATE INDEX idx_deposits_room_id ON deposits(room_id);
CREATE INDEX idx_deposits_bed_id ON deposits(bed_id);
CREATE INDEX idx_deposits_status ON deposits(status);
CREATE INDEX idx_deposits_deposit_date ON deposits(deposit_date);
CREATE INDEX idx_deposits_hold_until ON deposits(hold_until);

-- RLS Policies
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own deposits"
  ON deposits FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own deposits"
  ON deposits FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own deposits"
  ON deposits FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own deposits"
  ON deposits FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE deposits IS 'Security deposits to reserve rooms before contract signing';


-- =============================================
-- 4. VEHICLES TABLE
-- =============================================
-- Tenant vehicles (motorbikes, cars, bicycles)

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contract_id UUID, -- Foreign key will be added in migration 004

  -- Vehicle info
  vehicle_type vehicle_type NOT NULL,
  brand TEXT,
  model TEXT,
  license_plate TEXT,
  color TEXT,

  -- Parking fee
  parking_fee DECIMAL(15, 2) DEFAULT 0,

  -- Metadata
  notes TEXT,
  images JSONB DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT vehicles_parking_fee_non_negative CHECK (parking_fee >= 0)
);

-- Indexes
CREATE INDEX idx_vehicles_user_id ON vehicles(user_id);
CREATE INDEX idx_vehicles_tenant_id ON vehicles(tenant_id);
CREATE INDEX idx_vehicles_contract_id ON vehicles(contract_id);
CREATE INDEX idx_vehicles_vehicle_type ON vehicles(vehicle_type);
CREATE INDEX idx_vehicles_license_plate ON vehicles(license_plate);
CREATE INDEX idx_vehicles_deleted_at ON vehicles(deleted_at);

-- RLS Policies
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own vehicles"
  ON vehicles FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own vehicles"
  ON vehicles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own vehicles"
  ON vehicles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own vehicles"
  ON vehicles FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE vehicles IS 'Tenant vehicles for parking management';


-- Migration completed
-- =============================================
-- Total: 4 tables created (services, tenants, deposits, vehicles)
-- Note: deposits and vehicles reference contracts table which will be created in next migration
-- Next: 004_contract_tables.sql
