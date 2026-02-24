-- =============================================
-- Migration: Meter Reading Views
-- Description: Recreate views meter_readings_detailed and
--   meters_with_latest_reading after table reimplementation.
-- Requirements: 6.1, 1.1
-- =============================================


-- =============================================
-- 1. VIEW: meter_readings_detailed
-- =============================================
-- JOIN meter_readings with meters, buildings, rooms, services,
-- auth.users (approver + recorder). Filter deleted_at IS NULL.
-- Provides: meter_code, meter_name, building_name, room_name,
-- service_name, approver_email, recorder_email.

CREATE OR REPLACE VIEW meter_readings_detailed AS
SELECT
  mr.id,
  mr.user_id,
  mr.reading_code,

  -- Meter info
  mr.meter_id,
  m.code AS meter_code,
  m.name AS meter_name,

  -- Contract & Service info
  mr.contract_id,
  mr.service_id,
  s.name AS service_name,

  -- Building & Room info
  mr.building_id,
  b.name AS building_name,
  mr.room_id,
  r.name AS room_name,

  -- Meter reading info
  mr.meter_type,
  mr.settlement_month,
  mr.reading_date,
  mr.previous_reading,
  mr.current_reading,
  mr.consumption,

  -- Approval info
  mr.status,
  mr.approved_by,
  approver.email AS approver_email,
  mr.approved_at,

  -- Recorded by
  mr.recorded_by,
  recorder.email AS recorder_email,

  -- Metadata
  mr.notes,
  mr.meter_image_url,

  -- Timestamps
  mr.created_at,
  mr.updated_at

FROM meter_readings mr
LEFT JOIN meters m ON m.id = mr.meter_id
LEFT JOIN buildings b ON b.id = mr.building_id
LEFT JOIN rooms r ON r.id = mr.room_id
LEFT JOIN services s ON s.id = mr.service_id
LEFT JOIN auth.users approver ON approver.id = mr.approved_by
LEFT JOIN auth.users recorder ON recorder.id = mr.recorded_by
WHERE mr.deleted_at IS NULL
ORDER BY mr.reading_date DESC, mr.created_at DESC;

COMMENT ON VIEW meter_readings_detailed IS
  'Detailed view of meter readings with meter, building, room, and user information';


-- =============================================
-- 2. VIEW: meters_with_latest_reading
-- =============================================
-- JOIN meters with buildings, rooms, services.
-- Subquery for latest_reading, latest_reading_date, total_readings
-- from meter_readings. Filter deleted_at IS NULL.

CREATE OR REPLACE VIEW meters_with_latest_reading AS
SELECT
  m.id,
  m.user_id,
  m.code,
  m.name,
  m.building_id,
  b.name AS building_name,
  m.room_id,
  r.name AS room_name,
  m.service_id,
  s.name AS service_name,
  m.meter_type,
  m.status,
  m.installation_date,
  m.initial_reading,

  -- Latest reading (from most recent meter_readings entry)
  (SELECT current_reading
   FROM meter_readings
   WHERE meter_id = m.id AND deleted_at IS NULL
   ORDER BY reading_date DESC, created_at DESC
   LIMIT 1) AS latest_reading,

  (SELECT reading_date
   FROM meter_readings
   WHERE meter_id = m.id AND deleted_at IS NULL
   ORDER BY reading_date DESC, created_at DESC
   LIMIT 1) AS latest_reading_date,

  -- Total readings count
  (SELECT COUNT(*)
   FROM meter_readings
   WHERE meter_id = m.id AND deleted_at IS NULL) AS total_readings,

  m.location_note,
  m.manufacturer,
  m.model,
  m.serial_number,
  m.notes,
  m.created_at,
  m.updated_at

FROM meters m
LEFT JOIN buildings b ON b.id = m.building_id
LEFT JOIN rooms r ON r.id = m.room_id
LEFT JOIN services s ON s.id = m.service_id
WHERE m.deleted_at IS NULL
ORDER BY b.name, r.name, m.meter_type;

COMMENT ON VIEW meters_with_latest_reading IS
  'Meters with their latest reading information';
