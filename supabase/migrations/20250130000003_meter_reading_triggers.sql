-- =============================================
-- Migration: Meter Reading Triggers
-- Description: Create 4 business-logic triggers + 2 updated_at triggers
--   for meters and meter_readings tables.
-- Triggers:
--   1. auto_populate_meter_reading_fields (BEFORE INSERT on meter_readings)
--   2. auto_populate_previous_reading (BEFORE INSERT on meter_readings)
--   3. auto_generate_reading_code (BEFORE INSERT on meter_readings)
--   4. auto_generate_meter_name (BEFORE INSERT on meters)
--   5. trigger_update_meters_updated_at (BEFORE UPDATE on meters)
--   6. trigger_update_meter_reading_updated_at (BEFORE UPDATE on meter_readings)
-- Requirements: 8.1, 8.2, 8.3, 8.4, 2.5, 2.6, 2.8
-- =============================================


-- =============================================
-- 1. TRIGGER FUNCTION: auto_populate_meter_reading_fields
-- =============================================
-- BEFORE INSERT on meter_readings
-- From meter_id → populate building_id, room_id, meter_type,
-- service_id, settlement_month (from reading_date), recorded_by (from auth.uid())
-- Requirement: 8.1

CREATE OR REPLACE FUNCTION auto_populate_meter_reading_fields()
RETURNS TRIGGER AS $$
DECLARE
  v_meter RECORD;
BEGIN
  -- Only populate if meter_id is provided
  IF NEW.meter_id IS NOT NULL THEN
    SELECT building_id, room_id, meter_type, service_id
    INTO v_meter
    FROM meters
    WHERE id = NEW.meter_id;

    IF FOUND THEN
      NEW.building_id := v_meter.building_id;
      NEW.room_id := v_meter.room_id;
      NEW.meter_type := v_meter.meter_type;
      NEW.service_id := v_meter.service_id;
    END IF;
  END IF;

  -- Auto-populate settlement_month from reading_date (YYYY-MM)
  IF NEW.reading_date IS NOT NULL THEN
    NEW.settlement_month := TO_CHAR(NEW.reading_date, 'YYYY-MM');
  END IF;

  -- Auto-populate recorded_by from auth.uid()
  NEW.recorded_by := auth.uid();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


CREATE TRIGGER trigger_auto_populate_meter_reading_fields
  BEFORE INSERT ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION auto_populate_meter_reading_fields();


-- =============================================
-- 2. TRIGGER FUNCTION: auto_populate_previous_reading
-- =============================================
-- BEFORE INSERT on meter_readings
-- Get previous_reading from the most recent reading for the same meter_id
-- (ORDER BY reading_date DESC, created_at DESC LIMIT 1 → current_reading).
-- If no previous reading exists, use meters.initial_reading.
-- Requirement: 8.2

CREATE OR REPLACE FUNCTION auto_populate_previous_reading()
RETURNS TRIGGER AS $$
DECLARE
  v_previous DECIMAL(10, 2);
BEGIN
  IF NEW.meter_id IS NOT NULL THEN
    -- Try to get the most recent reading for this meter
    SELECT current_reading
    INTO v_previous
    FROM meter_readings
    WHERE meter_id = NEW.meter_id
      AND deleted_at IS NULL
    ORDER BY reading_date DESC, created_at DESC
    LIMIT 1;

    IF FOUND THEN
      NEW.previous_reading := v_previous;
    ELSE
      -- No previous reading → use initial_reading from meters
      SELECT initial_reading
      INTO v_previous
      FROM meters
      WHERE id = NEW.meter_id;

      IF FOUND AND v_previous IS NOT NULL THEN
        NEW.previous_reading := v_previous;
      ELSE
        NEW.previous_reading := 0;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

CREATE TRIGGER trigger_auto_populate_previous_reading
  BEFORE INSERT ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION auto_populate_previous_reading();


-- =============================================
-- 3. TRIGGER FUNCTION: auto_generate_reading_code
-- =============================================
-- BEFORE INSERT on meter_readings
-- Generate reading_code in format CSS{YY}{MM}{5-digit-sequence}
-- e.g. CSS2507000001
-- Sequence is per user_id per YYMM prefix.
-- Requirement: 8.3

CREATE OR REPLACE FUNCTION auto_generate_reading_code()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix TEXT;
  v_yymm TEXT;
  v_next_seq INT;
BEGIN
  -- Only generate if reading_code is not already set
  IF NEW.reading_code IS NOT NULL AND NEW.reading_code <> '' THEN
    RETURN NEW;
  END IF;

  -- Build YYMM from reading_date
  v_yymm := TO_CHAR(NEW.reading_date, 'YYMM');
  v_prefix := 'CSS' || v_yymm;

  -- Count existing readings for this user + YYMM prefix to determine next sequence
  SELECT COUNT(*) + 1
  INTO v_next_seq
  FROM meter_readings
  WHERE user_id = NEW.user_id
    AND reading_code LIKE v_prefix || '%';

  -- Format: CSS{YYMM}{5-digit-padded-sequence}
  NEW.reading_code := v_prefix || LPAD(v_next_seq::TEXT, 5, '0');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

CREATE TRIGGER trigger_auto_generate_reading_code
  BEFORE INSERT ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_reading_code();


-- =============================================
-- 4. TRIGGER FUNCTION: auto_generate_meter_name
-- =============================================
-- BEFORE INSERT on meters
-- Generate name from room_name + meter_type label
-- Labels: ELECTRICITY → 'Điện', WATER → 'Nước', GAS → 'Gas'
-- Format: "{room_name} - {type_label}"
-- Requirement: 8.4

CREATE OR REPLACE FUNCTION auto_generate_meter_name()
RETURNS TRIGGER AS $$
DECLARE
  v_room_name TEXT;
  v_type_label TEXT;
BEGIN
  -- Only generate if name is not already set
  IF NEW.name IS NOT NULL AND NEW.name <> '' THEN
    RETURN NEW;
  END IF;

  -- Look up room name
  IF NEW.room_id IS NOT NULL THEN
    SELECT name INTO v_room_name
    FROM rooms
    WHERE id = NEW.room_id;
  END IF;

  -- Determine Vietnamese label for meter_type
  CASE NEW.meter_type
    WHEN 'ELECTRICITY' THEN v_type_label := 'Điện';
    WHEN 'WATER' THEN v_type_label := 'Nước';
    WHEN 'GAS' THEN v_type_label := 'Gas';
    ELSE v_type_label := NEW.meter_type::TEXT;
  END CASE;

  -- Build name: "{room_name} - {type_label}"
  IF v_room_name IS NOT NULL THEN
    NEW.name := v_room_name || ' - ' || v_type_label;
  ELSE
    NEW.name := v_type_label;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

CREATE TRIGGER trigger_auto_generate_meter_name
  BEFORE INSERT ON meters
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_meter_name();


-- =============================================
-- 5. UPDATED_AT TRIGGERS
-- =============================================
-- Reuse existing update_updated_at_column() function from 008_triggers_functions.sql

CREATE TRIGGER trigger_update_meters_updated_at
  BEFORE UPDATE ON meters
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_update_meter_reading_updated_at
  BEFORE UPDATE ON meter_readings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
