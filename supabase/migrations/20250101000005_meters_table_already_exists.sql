-- =============================================
-- Migration: meters table (Đồng hồ công tơ)
-- Description: NO-OP - meters table already exists in 017_meters_table.sql
-- The existing table has a more comprehensive schema including:
--   code, building_id, room_id, service_id, meter_type, initial_reading,
--   status, location_note, manufacturer, model, serial_number, etc.
-- This satisfies requirements 38.5, 31.2
-- =============================================

-- meters table already created in 017_meters_table.sql
-- Adding current_reading column if not exists (design doc specifies it)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meters' AND column_name = 'current_reading'
  ) THEN
    ALTER TABLE meters ADD COLUMN current_reading NUMERIC DEFAULT 0;
  END IF;
END $$;
