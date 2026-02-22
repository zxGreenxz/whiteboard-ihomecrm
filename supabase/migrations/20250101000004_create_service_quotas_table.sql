-- =============================================
-- Migration: Create service_quotas table (Định mức dịch vụ)
-- Description: Service quota configuration per building
-- Requirements: 38.4, 31.2
-- =============================================

CREATE TABLE service_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  quota_value NUMERIC NOT NULL,
  unit TEXT,
  description TEXT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_service_quotas_user_id ON service_quotas(user_id);
CREATE INDEX idx_service_quotas_service_id ON service_quotas(service_id);
CREATE INDEX idx_service_quotas_building_id ON service_quotas(building_id);

-- RLS
ALTER TABLE service_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_quotas_select" ON service_quotas
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "service_quotas_insert" ON service_quotas
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_quotas_update" ON service_quotas
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "service_quotas_delete" ON service_quotas
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE service_quotas IS 'Service quota configuration per building (Định mức dịch vụ)';
