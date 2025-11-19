-- =============================================
-- Migration 006: Asset & Issue Tables
-- Created: 2025-11-18
-- Description: Create tables for asset/inventory management and issue tracking
-- =============================================

-- =============================================
-- ASSET MANAGEMENT TABLES
-- =============================================

-- 1. ASSET_CATEGORIES TABLE
-- =============================================

CREATE TABLE asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT asset_categories_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_asset_categories_user_id ON asset_categories(user_id);
ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own asset categories"
  ON asset_categories FOR ALL
  USING (auth.uid() = user_id);


-- 2. SUPPLIERS TABLE
-- =============================================

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT suppliers_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_suppliers_user_id ON suppliers(user_id);
CREATE INDEX idx_suppliers_deleted_at ON suppliers(deleted_at);
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own suppliers"
  ON suppliers FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own suppliers"
  ON suppliers FOR ALL
  USING (auth.uid() = user_id);


-- 3. ASSETS TABLE
-- =============================================

CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Asset info
  code TEXT,
  name TEXT NOT NULL,
  category_id UUID REFERENCES asset_categories(id),

  -- Purchase info
  supplier_id UUID REFERENCES suppliers(id),
  purchase_date DATE,
  purchase_price DECIMAL(15, 2),

  -- Current status
  condition asset_condition DEFAULT 'GOOD',
  quantity INTEGER DEFAULT 1,

  -- Location
  building_id UUID REFERENCES buildings(id),
  room_id UUID REFERENCES rooms(id),

  -- Metadata
  description TEXT,
  images JSONB DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT assets_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT assets_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX idx_assets_user_id ON assets(user_id);
CREATE INDEX idx_assets_category_id ON assets(category_id);
CREATE INDEX idx_assets_building_id ON assets(building_id);
CREATE INDEX idx_assets_room_id ON assets(room_id);
CREATE INDEX idx_assets_condition ON assets(condition);
CREATE INDEX idx_assets_deleted_at ON assets(deleted_at);

CREATE INDEX idx_assets_search ON assets USING GIN (
  to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(name, '') || ' ' || coalesce(description, ''))
);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own assets"
  ON assets FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own assets"
  ON assets FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE assets IS 'Inventory/furniture items tracked across rooms';


-- 4. ASSET_HANDOVERS TABLE
-- =============================================

CREATE TABLE asset_handovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id),

  -- Type
  type TEXT NOT NULL CHECK (type IN ('CHECK_IN', 'CHECK_OUT')),
  handover_date DATE NOT NULL,

  -- Items (JSONB array)
  -- [{ asset_id, quantity, condition, notes }, ...]
  items JSONB NOT NULL,

  -- Signatures
  landlord_signature TEXT, -- Image URL
  tenant_signature TEXT, -- Image URL

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_asset_handovers_user_id ON asset_handovers(user_id);
CREATE INDEX idx_asset_handovers_contract_id ON asset_handovers(contract_id);
CREATE INDEX idx_asset_handovers_type ON asset_handovers(type);
CREATE INDEX idx_asset_handovers_handover_date ON asset_handovers(handover_date);

ALTER TABLE asset_handovers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own asset handovers"
  ON asset_handovers FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE asset_handovers IS 'Asset handover documents for check-in/check-out';


-- 5. ASSET_MOVEMENTS TABLE
-- =============================================

CREATE TABLE asset_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id),

  -- Movement
  from_location TEXT,
  to_location TEXT,
  from_room_id UUID REFERENCES rooms(id),
  to_room_id UUID REFERENCES rooms(id),

  quantity INTEGER NOT NULL,
  movement_date DATE NOT NULL,
  reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT asset_movements_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX idx_asset_movements_user_id ON asset_movements(user_id);
CREATE INDEX idx_asset_movements_asset_id ON asset_movements(asset_id);
CREATE INDEX idx_asset_movements_movement_date ON asset_movements(movement_date);

ALTER TABLE asset_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own asset movements"
  ON asset_movements FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE asset_movements IS 'Track asset movements between rooms/warehouses';


-- 6. ASSET_MAINTENANCE TABLE
-- =============================================

CREATE TABLE asset_maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id),

  -- Maintenance info
  issue_description TEXT NOT NULL,
  maintenance_date DATE NOT NULL,
  cost DECIMAL(15, 2),

  -- Assignment
  assigned_to UUID REFERENCES profiles(id),

  status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT asset_maintenance_cost_non_negative CHECK (cost IS NULL OR cost >= 0)
);

CREATE INDEX idx_asset_maintenance_user_id ON asset_maintenance(user_id);
CREATE INDEX idx_asset_maintenance_asset_id ON asset_maintenance(asset_id);
CREATE INDEX idx_asset_maintenance_status ON asset_maintenance(status);
CREATE INDEX idx_asset_maintenance_maintenance_date ON asset_maintenance(maintenance_date);

ALTER TABLE asset_maintenance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own asset maintenance"
  ON asset_maintenance FOR ALL
  USING (auth.uid() = user_id);


-- =============================================
-- ISSUE/TASK MANAGEMENT TABLES
-- =============================================

-- 7. ISSUE_CATEGORIES TABLE
-- =============================================

CREATE TABLE issue_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT issue_categories_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_issue_categories_user_id ON issue_categories(user_id);
ALTER TABLE issue_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own issue categories"
  ON issue_categories FOR ALL
  USING (auth.uid() = user_id);


-- 8. ISSUES TABLE
-- =============================================

CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Issue info
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id UUID REFERENCES issue_categories(id),
  priority issue_priority DEFAULT 'MEDIUM',
  status issue_status DEFAULT 'NEW',

  -- Location
  building_id UUID REFERENCES buildings(id),
  room_id UUID REFERENCES rooms(id),
  contract_id UUID REFERENCES contracts(id),

  -- Reporter
  reported_by_tenant_id UUID REFERENCES tenants(id),
  reported_by_staff_id UUID REFERENCES profiles(id),

  -- Assignment
  assigned_to UUID REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ,

  -- Timeline
  due_date TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  -- Cost
  estimated_cost DECIMAL(15, 2),
  actual_cost DECIMAL(15, 2),

  -- Metadata
  images JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,

  -- Rating (from tenant)
  rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  feedback TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT issues_title_not_empty CHECK (char_length(title) > 0),
  CONSTRAINT issues_costs_non_negative CHECK (
    (estimated_cost IS NULL OR estimated_cost >= 0) AND
    (actual_cost IS NULL OR actual_cost >= 0)
  )
);

CREATE INDEX idx_issues_user_id ON issues(user_id);
CREATE INDEX idx_issues_category_id ON issues(category_id);
CREATE INDEX idx_issues_priority ON issues(priority);
CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_building_id ON issues(building_id);
CREATE INDEX idx_issues_room_id ON issues(room_id);
CREATE INDEX idx_issues_assigned_to ON issues(assigned_to);
CREATE INDEX idx_issues_created_at ON issues(created_at);

CREATE INDEX idx_issues_search ON issues USING GIN (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
);

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own issues"
  ON issues FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own issues"
  ON issues FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE issues IS 'Issue/task tracking system';


-- 9. ISSUE_COMMENTS TABLE
-- =============================================

CREATE TABLE issue_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),

  comment TEXT NOT NULL,
  images JSONB DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT issue_comments_comment_not_empty CHECK (char_length(comment) > 0)
);

CREATE INDEX idx_issue_comments_issue_id ON issue_comments(issue_id);
CREATE INDEX idx_issue_comments_user_id ON issue_comments(user_id);
CREATE INDEX idx_issue_comments_created_at ON issue_comments(created_at);

ALTER TABLE issue_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view comments on own issues"
  ON issue_comments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM issues
      WHERE issues.id = issue_comments.issue_id
        AND issues.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create comments on own issues"
  ON issue_comments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM issues
      WHERE issues.id = issue_comments.issue_id
        AND issues.user_id = auth.uid()
    )
    AND auth.uid() = user_id
  );

COMMENT ON TABLE issue_comments IS 'Comments and updates on issues';


-- Migration completed
-- =============================================
-- Total: 9 tables created for asset and issue management
-- Next: 007_advanced_tables.sql
