-- =============================================
-- Migration: Drop areas table and remove area_id from buildings
-- Description: Areas module is not in SUMMARY.md, removing entirely
-- Requirements: 1.10, 36.6
-- =============================================

-- 1. Drop foreign key constraint on buildings.area_id
ALTER TABLE buildings DROP CONSTRAINT IF EXISTS buildings_area_id_fkey;

-- 2. Drop the area_id column from buildings
ALTER TABLE buildings DROP COLUMN IF EXISTS area_id;

-- 3. Drop the areas table and all dependent objects
DROP TABLE IF EXISTS areas CASCADE;
