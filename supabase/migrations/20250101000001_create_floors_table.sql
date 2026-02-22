-- =============================================
-- Migration: Create floors table (Danh sách tầng)
-- Description: Floors management per building
-- Requirements: 38.1, 31.7
-- =============================================

CREATE TABLE floors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number INTEGER NOT NULL,
  name TEXT,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT floors_unique_building_floor UNIQUE (building_id, floor_number)
);

-- Indexes
CREATE INDEX idx_floors_building_id ON floors(building_id);
CREATE INDEX idx_floors_user_id ON floors(user_id);
CREATE INDEX idx_floors_status ON floors(status);

-- RLS
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "floors_select" ON floors
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "floors_insert" ON floors
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "floors_update" ON floors
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "floors_delete" ON floors
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE floors IS 'Floor management per building (Danh sách tầng)';
