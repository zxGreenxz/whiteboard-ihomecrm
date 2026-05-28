-- =============================================
-- Migration: Unify service ↔ building links into building_services
-- Description: Two junction tables coexisted:
--   - service_buildings: written by the Service edit dialog
--   - building_services: written by the Building edit dialog (with is_active
--     and unit_price_override) and read by invoice pricing
-- They were never synced, so picking buildings on the service form did not
-- light up the matching toggle on the building form (and vice versa).
-- This migration:
--   1) Backfills building_services from service_buildings so existing pairs
--      surface on both dialogs.
--   2) Re-activates any building_services row whose pair also lives in
--      service_buildings (the service-side selection wins ambiguity).
-- The Service hook is updated separately to read/write building_services
-- exclusively, so service_buildings becomes legacy/unused at runtime but
-- is kept around to avoid breaking any external scripts that still query it.
-- =============================================

-- 1) Backfill missing pairs (default is_active = true, no override).
INSERT INTO building_services (building_id, service_id, is_active, unit_price_override)
SELECT sb.building_id, sb.service_id, true, NULL
FROM service_buildings sb
LEFT JOIN building_services bs
  ON bs.building_id = sb.building_id
 AND bs.service_id  = sb.service_id
WHERE bs.id IS NULL;

-- 2) Re-activate inactive rows whose pair exists in service_buildings.
UPDATE building_services bs
SET is_active = true,
    updated_at = now()
FROM service_buildings sb
WHERE bs.building_id = sb.building_id
  AND bs.service_id  = sb.service_id
  AND bs.is_active = false;
