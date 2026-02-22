-- =============================================
-- Migration: Create hotlines table (Quản lý Hotline)
-- Description: Hotline management for buildings
-- Requirements: 38.2, 31.4
-- =============================================

CREATE TABLE hotlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hotlines_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT hotlines_phone_not_empty CHECK (char_length(phone_number) > 0)
);

-- Indexes
CREATE INDEX idx_hotlines_user_id ON hotlines(user_id);
CREATE INDEX idx_hotlines_is_active ON hotlines(is_active);

-- RLS
ALTER TABLE hotlines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hotlines_select" ON hotlines
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "hotlines_insert" ON hotlines
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "hotlines_update" ON hotlines
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "hotlines_delete" ON hotlines
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE hotlines IS 'Hotline management (Quản lý Hotline)';
