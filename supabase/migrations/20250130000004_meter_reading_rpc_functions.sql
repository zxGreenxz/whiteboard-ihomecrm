-- =============================================
-- Migration: Meter Reading RPC Functions
-- Description: Create 5 RPC functions for meter reading operations:
--   1. approve_meter_reading - Single approval (SECURITY DEFINER)
--   2. bulk_approve_meter_readings - Bulk approval (SECURITY DEFINER)
--   3. get_meter_reading_stats - Statistics (SECURITY INVOKER)
--   4. get_meters_without_readings - Unrecorded meters (SECURITY INVOKER)
--   5. bulk_create_meter_readings - Bulk import (SECURITY DEFINER)
-- Requirements: 8.5, 8.6, 8.7, 8.8, 8.9, 12.3
-- =============================================


-- =============================================
-- 1. FUNCTION: approve_meter_reading
-- =============================================
-- Approve a single meter reading by ID.
-- Sets status → APPROVED, approved_by → auth.uid(), approved_at → NOW().
-- RAISE EXCEPTION if reading not found or already approved.
-- Requirement: 8.5, 12.3

CREATE OR REPLACE FUNCTION approve_meter_reading(p_reading_id UUID)
RETURNS VOID AS $$
DECLARE
  v_status TEXT;
BEGIN
  -- Look up the reading
  SELECT status INTO v_status
  FROM meter_readings
  WHERE id = p_reading_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy chỉ số hoặc chỉ số đã bị xoá';
  END IF;

  IF v_status = 'APPROVED' THEN
    RAISE EXCEPTION 'Chỉ số đã được duyệt';
  END IF;

  UPDATE meter_readings
  SET status = 'APPROVED',
      approved_by = auth.uid(),
      approved_at = NOW()
  WHERE id = p_reading_id
    AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =============================================
-- 2. FUNCTION: bulk_approve_meter_readings
-- =============================================
-- Approve multiple meter readings at once.
-- Only approves readings with status = UNAPPROVED.
-- Returns the count of successfully approved readings.
-- Requirement: 8.6, 12.3

CREATE OR REPLACE FUNCTION bulk_approve_meter_readings(p_reading_ids UUID[])
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE meter_readings
  SET status = 'APPROVED',
      approved_by = auth.uid(),
      approved_at = NOW()
  WHERE id = ANY(p_reading_ids)
    AND status = 'UNAPPROVED'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =============================================
-- 3. FUNCTION: get_meter_reading_stats
-- =============================================
-- Return statistics for meter readings filtered by building and month.
-- Both p_building_id and p_month are optional (NULL = no filter).
-- Returns a single row with aggregated stats.
-- Requirement: 8.7

CREATE OR REPLACE FUNCTION get_meter_reading_stats(
  p_building_id UUID DEFAULT NULL,
  p_month TEXT DEFAULT NULL
)
RETURNS TABLE (
  total_readings BIGINT,
  unapproved_count BIGINT,
  approved_count BIGINT,
  electricity_consumption DECIMAL,
  water_consumption DECIMAL,
  gas_consumption DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_readings,
    COUNT(*) FILTER (WHERE mr.status = 'UNAPPROVED')::BIGINT AS unapproved_count,
    COUNT(*) FILTER (WHERE mr.status = 'APPROVED')::BIGINT AS approved_count,
    COALESCE(SUM(mr.consumption) FILTER (WHERE mr.meter_type = 'ELECTRICITY'), 0)::DECIMAL AS electricity_consumption,
    COALESCE(SUM(mr.consumption) FILTER (WHERE mr.meter_type = 'WATER'), 0)::DECIMAL AS water_consumption,
    COALESCE(SUM(mr.consumption) FILTER (WHERE mr.meter_type = 'GAS'), 0)::DECIMAL AS gas_consumption
  FROM meter_readings mr
  WHERE mr.user_id = auth.uid()
    AND mr.deleted_at IS NULL
    AND (p_building_id IS NULL OR mr.building_id = p_building_id)
    AND (p_month IS NULL OR mr.settlement_month = p_month);
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- =============================================
-- 4. FUNCTION: get_meters_without_readings
-- =============================================
-- Return meters that DON'T have a reading for the given month.
-- Includes last_reading (from most recent meter_reading or initial_reading)
-- and last_reading_date.
-- Filters: p_user_id (required), p_building_id (optional),
--   p_room_id (optional), p_meter_type (optional TEXT, cast to enum),
--   p_month (required).
-- Requirement: 8.8

CREATE OR REPLACE FUNCTION get_meters_without_readings(
  p_user_id UUID,
  p_building_id UUID DEFAULT NULL,
  p_room_id UUID DEFAULT NULL,
  p_meter_type TEXT DEFAULT NULL,
  p_month TEXT DEFAULT NULL
)
RETURNS TABLE (
  meter_id UUID,
  meter_code TEXT,
  meter_name TEXT,
  room_name TEXT,
  meter_type_value TEXT,
  last_reading DECIMAL,
  last_reading_date DATE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id AS meter_id,
    m.code AS meter_code,
    m.name AS meter_name,
    r.name AS room_name,
    m.meter_type::TEXT AS meter_type_value,
    -- last_reading: most recent current_reading, or initial_reading
    COALESCE(
      (SELECT mr.current_reading
       FROM meter_readings mr
       WHERE mr.meter_id = m.id AND mr.deleted_at IS NULL
       ORDER BY mr.reading_date DESC, mr.created_at DESC
       LIMIT 1),
      m.initial_reading
    ) AS last_reading,
    -- last_reading_date: date of most recent reading
    (SELECT mr.reading_date
     FROM meter_readings mr
     WHERE mr.meter_id = m.id AND mr.deleted_at IS NULL
     ORDER BY mr.reading_date DESC, mr.created_at DESC
     LIMIT 1) AS last_reading_date
  FROM meters m
  LEFT JOIN rooms r ON r.id = m.room_id
  WHERE m.user_id = p_user_id
    AND m.deleted_at IS NULL
    AND m.status = 'ACTIVE'
    AND (p_building_id IS NULL OR m.building_id = p_building_id)
    AND (p_room_id IS NULL OR m.room_id = p_room_id)
    AND (p_meter_type IS NULL OR m.meter_type = p_meter_type::meter_type)
    AND (p_month IS NULL OR NOT EXISTS (
      SELECT 1
      FROM meter_readings mr
      WHERE mr.meter_id = m.id
        AND mr.settlement_month = p_month
        AND mr.deleted_at IS NULL
    ))
  ORDER BY r.name, m.meter_type;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- =============================================
-- 5. FUNCTION: bulk_create_meter_readings
-- =============================================
-- Bulk import meter readings from a JSONB array.
-- Each element: { meter_code, reading_date, current_reading, notes? }
-- Looks up meter by code + auth.uid().
-- Inserts into meter_readings (triggers handle auto-population).
-- Returns JSONB array of results per row:
--   { reading_id, reading_code, success, error_message }
-- Requirement: 8.9, 12.3

CREATE OR REPLACE FUNCTION bulk_create_meter_readings(p_readings JSONB)
RETURNS JSONB AS $$
DECLARE
  v_item JSONB;
  v_results JSONB := '[]'::JSONB;
  v_meter_id UUID;
  v_user_id UUID;
  v_reading_id UUID;
  v_reading_code TEXT;
  v_meter_code TEXT;
  v_reading_date DATE;
  v_current_reading DECIMAL(10, 2);
  v_notes TEXT;
  v_result JSONB;
BEGIN
  v_user_id := auth.uid();

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_readings)
  LOOP
    BEGIN
      -- Extract fields from JSONB element
      v_meter_code := v_item->>'meter_code';
      v_reading_date := (v_item->>'reading_date')::DATE;
      v_current_reading := (v_item->>'current_reading')::DECIMAL(10, 2);
      v_notes := v_item->>'notes';

      -- Look up meter by code + user_id
      SELECT id INTO v_meter_id
      FROM meters
      WHERE code = v_meter_code
        AND user_id = v_user_id
        AND deleted_at IS NULL;

      IF NOT FOUND THEN
        v_result := jsonb_build_object(
          'meter_code', v_meter_code,
          'reading_id', NULL,
          'reading_code', NULL,
          'success', false,
          'error_message', 'Không tìm thấy công tơ với mã: ' || COALESCE(v_meter_code, '(trống)')
        );
        v_results := v_results || v_result;
        CONTINUE;
      END IF;

      -- Insert the meter reading (triggers will auto-populate fields)
      INSERT INTO meter_readings (
        user_id,
        meter_id,
        reading_date,
        current_reading,
        notes,
        status
      ) VALUES (
        v_user_id,
        v_meter_id,
        v_reading_date,
        v_current_reading,
        v_notes,
        'UNAPPROVED'
      )
      RETURNING id, reading_code INTO v_reading_id, v_reading_code;

      v_result := jsonb_build_object(
        'meter_code', v_meter_code,
        'reading_id', v_reading_id,
        'reading_code', v_reading_code,
        'success', true,
        'error_message', NULL
      );
      v_results := v_results || v_result;

    EXCEPTION WHEN OTHERS THEN
      v_result := jsonb_build_object(
        'meter_code', v_meter_code,
        'reading_id', NULL,
        'reading_code', NULL,
        'success', false,
        'error_message', SQLERRM
      );
      v_results := v_results || v_result;
    END;
  END LOOP;

  RETURN v_results;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
