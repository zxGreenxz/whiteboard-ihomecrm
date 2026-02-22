-- =============================================
-- Migration: Create auto_debt_config table (Gạch nợ tự động)
-- Description: Auto debt matching configuration per building
-- Requirements: 38.6, 31.2
-- =============================================

CREATE TABLE auto_debt_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  is_enabled BOOLEAN DEFAULT false,
  bank_account TEXT,
  matching_rules JSONB DEFAULT '{}'::jsonb,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_auto_debt_config_user_id ON auto_debt_config(user_id);
CREATE INDEX idx_auto_debt_config_building_id ON auto_debt_config(building_id);

-- RLS
ALTER TABLE auto_debt_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auto_debt_config_select" ON auto_debt_config
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "auto_debt_config_insert" ON auto_debt_config
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "auto_debt_config_update" ON auto_debt_config
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "auto_debt_config_delete" ON auto_debt_config
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE auto_debt_config IS 'Auto debt matching configuration (Gạch nợ tự động)';
