-- =============================================
-- Migration: Create task_types and asset_warehouses tables
-- Description: Task type categories and asset warehouse management
-- Requirements: 31.5, 31.3
-- =============================================

-- 1. TASK_TYPES TABLE (Loại công việc)
CREATE TABLE task_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT task_types_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_task_types_user_id ON task_types(user_id);

ALTER TABLE task_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_types_select" ON task_types
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "task_types_insert" ON task_types
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "task_types_update" ON task_types
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "task_types_delete" ON task_types
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE task_types IS 'Task/issue type categories (Loại công việc)';


-- 2. ASSET_WAREHOUSES TABLE (Kho tài sản)
CREATE TABLE asset_warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT asset_warehouses_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_asset_warehouses_user_id ON asset_warehouses(user_id);
CREATE INDEX idx_asset_warehouses_building_id ON asset_warehouses(building_id);

ALTER TABLE asset_warehouses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_warehouses_select" ON asset_warehouses
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "asset_warehouses_insert" ON asset_warehouses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "asset_warehouses_update" ON asset_warehouses
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "asset_warehouses_delete" ON asset_warehouses
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE asset_warehouses IS 'Asset warehouse/storage locations (Kho tài sản)';
