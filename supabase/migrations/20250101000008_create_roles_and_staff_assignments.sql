-- =============================================
-- Migration: Create roles and staff_assignments tables
-- Description: Role-based access control and staff-building assignments
-- Requirements: 38.8, 33.1-33.4
-- =============================================

-- 1. ROLES TABLE (Loại tài khoản)
CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT roles_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_roles_user_id ON roles(user_id);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "roles_select" ON roles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "roles_insert" ON roles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "roles_update" ON roles
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "roles_delete" ON roles
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE roles IS 'User roles with JSONB permissions (Loại tài khoản)';


-- 2. STAFF_ASSIGNMENTS TABLE (Phân quyền nhân viên theo toà nhà)
CREATE TABLE staff_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_assignments_unique_staff_building UNIQUE (staff_id, building_id)
);

CREATE INDEX idx_staff_assignments_user_id ON staff_assignments(user_id);
CREATE INDEX idx_staff_assignments_staff_id ON staff_assignments(staff_id);
CREATE INDEX idx_staff_assignments_role_id ON staff_assignments(role_id);
CREATE INDEX idx_staff_assignments_building_id ON staff_assignments(building_id);

ALTER TABLE staff_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_assignments_select" ON staff_assignments
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "staff_assignments_insert" ON staff_assignments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "staff_assignments_update" ON staff_assignments
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "staff_assignments_delete" ON staff_assignments
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE staff_assignments IS 'Staff role assignments per building (Phân quyền nhân viên)';
