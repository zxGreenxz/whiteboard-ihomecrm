-- =============================================
-- Migration 004: Contract Tables
-- Created: 2025-11-18
-- Description: Create contracts and contract_services tables
-- =============================================

-- =============================================
-- 1. CONTRACTS TABLE
-- =============================================
-- Rental contracts

CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  bed_id UUID REFERENCES beds(id) ON DELETE RESTRICT,

  -- Contract info
  contract_number TEXT,
  status contract_status NOT NULL DEFAULT 'DRAFT',

  -- Dates
  signed_date DATE NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  actual_end_date DATE, -- Actual move-out date when terminated

  -- Pricing
  rent_price DECIMAL(15, 2) NOT NULL,
  payment_cycle payment_cycle DEFAULT 'MONTHLY',

  -- Deposit
  total_deposit DECIMAL(15, 2) NOT NULL DEFAULT 0,
  deposit_paid DECIMAL(15, 2) DEFAULT 0, -- From holding deposit
  deposit_remaining DECIMAL(15, 2) GENERATED ALWAYS AS (total_deposit - COALESCE(deposit_paid, 0)) STORED,

  -- Discounts (JSONB array)
  -- [{ month: 1, amount: 100000, reason: "First month promotion" }, ...]
  discounts JSONB DEFAULT '[]'::jsonb,

  -- Initial meter readings
  initial_electricity_reading DECIMAL(10, 2),
  initial_water_reading DECIMAL(10, 2),

  -- Metadata
  notes TEXT,
  contract_file_url TEXT, -- Signed contract PDF

  -- Related contracts (for extensions/transfers)
  parent_contract_id UUID REFERENCES contracts(id),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT contracts_dates_valid CHECK (start_date <= end_date),
  CONSTRAINT contracts_rent_price_non_negative CHECK (rent_price >= 0),
  CONSTRAINT contracts_total_deposit_non_negative CHECK (total_deposit >= 0),
  CONSTRAINT contracts_deposit_paid_non_negative CHECK (deposit_paid >= 0),
  CONSTRAINT contracts_must_have_room_or_bed CHECK (
    (room_id IS NOT NULL AND bed_id IS NULL) OR
    (room_id IS NULL AND bed_id IS NOT NULL)
  )
);

-- Indexes
CREATE INDEX idx_contracts_user_id ON contracts(user_id);
CREATE INDEX idx_contracts_tenant_id ON contracts(tenant_id);
CREATE INDEX idx_contracts_room_id ON contracts(room_id);
CREATE INDEX idx_contracts_bed_id ON contracts(bed_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_start_date ON contracts(start_date);
CREATE INDEX idx_contracts_end_date ON contracts(end_date);
CREATE INDEX idx_contracts_parent_contract_id ON contracts(parent_contract_id);
CREATE INDEX idx_contracts_deleted_at ON contracts(deleted_at);
CREATE INDEX idx_contracts_contract_number ON contracts(contract_number);

-- Full-text search
CREATE INDEX idx_contracts_search ON contracts USING GIN (
  to_tsvector('simple', coalesce(contract_number, '') || ' ' || coalesce(notes, ''))
);

-- RLS Policies
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own contracts"
  ON contracts FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own contracts"
  ON contracts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own contracts"
  ON contracts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own contracts"
  ON contracts FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE contracts IS 'Rental contracts linking tenants to rooms/beds';
COMMENT ON COLUMN contracts.discounts IS 'Monthly discounts in JSONB format: [{"month": 1, "amount": 100000, "reason": "Promotion"}]';
COMMENT ON COLUMN contracts.parent_contract_id IS 'References parent contract for extensions or transfers';


-- =============================================
-- 2. CONTRACT_SERVICES TABLE
-- =============================================
-- Services assigned to contracts

CREATE TABLE contract_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  -- Pricing (can override from service)
  unit_price DECIMAL(15, 2) NOT NULL,

  -- For meter reading services
  initial_reading DECIMAL(10, 2), -- Initial meter reading

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT contract_services_unit_price_non_negative CHECK (unit_price >= 0),

  -- Unique: Each service only once per contract
  UNIQUE(contract_id, service_id)
);

-- Indexes
CREATE INDEX idx_contract_services_contract_id ON contract_services(contract_id);
CREATE INDEX idx_contract_services_service_id ON contract_services(service_id);

-- RLS Policies
ALTER TABLE contract_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view contract services"
  ON contract_services FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
        AND contracts.deleted_at IS NULL
    )
  );

CREATE POLICY "Users can insert contract services"
  ON contract_services FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update contract services"
  ON contract_services FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete contract services"
  ON contract_services FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

-- Comments
COMMENT ON TABLE contract_services IS 'Services (electricity, water, wifi, etc.) assigned to each contract';


-- Update deposits table foreign key constraint
-- =============================================
-- Now that contracts table exists, we can add the foreign key

ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_contract_id_fkey;
ALTER TABLE deposits
  ADD CONSTRAINT deposits_contract_id_fkey
  FOREIGN KEY (contract_id)
  REFERENCES contracts(id)
  ON DELETE SET NULL;

-- Update vehicles table foreign key constraint
-- =============================================

ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_contract_id_fkey;
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_contract_id_fkey
  FOREIGN KEY (contract_id)
  REFERENCES contracts(id)
  ON DELETE SET NULL;


-- Migration completed
-- =============================================
-- Total: 2 tables created (contracts, contract_services)
-- Updated: deposits and vehicles tables with contract foreign keys
-- Next: 005_billing_tables.sql
