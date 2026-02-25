-- =============================================
-- Migration: Building Room Reimplementation
-- Created: 2025-07-03
-- Description: Create building_services junction table and add template columns to rooms
-- =============================================

-- =============================================
-- 1. Building Services Junction Table
-- Links buildings to services with per-building toggle and price override
-- =============================================

CREATE TABLE building_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,

  -- Configuration
  is_active BOOLEAN NOT NULL DEFAULT true,
  unit_price_override DECIMAL(15, 2),     -- NULL = use default from services table

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraint: one service per building
  CONSTRAINT building_services_unique UNIQUE (building_id, service_id),
  CONSTRAINT building_services_price_non_negative CHECK (unit_price_override IS NULL OR unit_price_override >= 0)
);

-- Indexes
CREATE INDEX idx_building_services_building_id ON building_services(building_id);
CREATE INDEX idx_building_services_service_id ON building_services(service_id);

-- RLS Policies
ALTER TABLE building_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own building services"
  ON building_services FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = building_services.building_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own building services"
  ON building_services FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = building_services.building_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own building services"
  ON building_services FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = building_services.building_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own building services"
  ON building_services FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = building_services.building_id
        AND buildings.user_id = auth.uid()
    )
  );

-- Trigger updated_at
CREATE TRIGGER update_building_services_updated_at
  BEFORE UPDATE ON building_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE building_services IS 'Junction table linking buildings to services with per-building toggle and price override';

-- =============================================
-- 2. Add invoice and lease template references to rooms
-- =============================================

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS invoice_template_id UUID REFERENCES document_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lease_template_id UUID REFERENCES document_templates(id) ON DELETE SET NULL;

-- Indexes for template lookups
CREATE INDEX IF NOT EXISTS idx_rooms_invoice_template_id ON rooms(invoice_template_id);
CREATE INDEX IF NOT EXISTS idx_rooms_lease_template_id ON rooms(lease_template_id);

-- =============================================
-- Migration completed
-- Created: building_services table with RLS, indexes, trigger
-- Altered: rooms table with invoice_template_id, lease_template_id columns
-- =============================================
