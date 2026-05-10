-- =============================================
-- Migration: Drop legacy service_buildings junction
-- Description: Final cleanup after unifying onto building_services.
--   Pre-condition (verified before adoption):
--     - 0 FK constraints from other tables reference service_buildings
--     - 0 views, materialized views, functions, or triggers reference it
--     - All 115 (service_id, building_id) pairs in service_buildings are
--       mirrored as is_active=true rows in building_services (see migration
--       20260510000004_unify_service_building_links).
--     - Runtime code (src/) no longer reads or writes the table; only the
--       seed script `scripts/seed-meter-and-services.mjs` did, and it has
--       been updated to write to building_services exclusively.
--   CASCADE drops the 5 remaining RLS policies on the table along with it.
-- =============================================

DROP TABLE IF EXISTS service_buildings CASCADE;
