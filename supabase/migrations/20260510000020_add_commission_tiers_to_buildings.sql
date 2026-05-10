-- =============================================
-- Migration: Add commission_tiers to buildings
-- Cấu hình bậc % hoa hồng môi giới theo số tháng hợp đồng.
-- Mỗi tier: { min_months, max_months, rate_percent } — số tháng nằm trong
-- [min_months, max_months] thì tính hoa hồng = rent_price * rate_percent / 100.
-- Default: 5-6 tháng = 50%, 10-12 tháng = 60%.
-- =============================================

ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS commission_tiers JSONB
  NOT NULL
  DEFAULT '[
    {"min_months":5,"max_months":6,"rate_percent":50},
    {"min_months":10,"max_months":12,"rate_percent":60}
  ]'::jsonb;

COMMENT ON COLUMN buildings.commission_tiers IS
  'Cấu hình bậc % hoa hồng môi giới theo số tháng HĐ. Array of {min_months, max_months, rate_percent}.';
