-- =============================================
-- Migration 009: Seed Data (OPTIONAL)
-- Created: 2025-11-18
-- Description: Insert sample data for testing and development
-- =============================================

-- ⚠️ WARNING: This migration is OPTIONAL
-- Only run this in development/staging environments
-- DO NOT run in production unless you want sample data
-- =============================================

-- =============================================
-- SAMPLE DATA COMMENTS
-- =============================================

-- This file contains sample data that can be used for:
-- 1. Development and testing
-- 2. Demo purposes
-- 3. Understanding the data model

-- To use this migration:
-- 1. Uncomment the sections below
-- 2. Replace 'YOUR_USER_ID' with actual user ID from auth.users
-- 3. Run the migration

-- To get your user ID:
-- SELECT id FROM auth.users WHERE email = 'your@email.com';

-- =============================================
-- EXAMPLE SEED DATA (Commented)
-- =============================================

/*

-- Replace with your actual user ID
-- Run this first: SELECT id FROM auth.users WHERE email = 'your@email.com';
DO $$
DECLARE
  v_user_id UUID := 'YOUR_USER_ID'; -- ⚠️ REPLACE THIS
  v_area_id UUID;
  v_building_id UUID;
  v_room_id_101 UUID;
  v_room_id_102 UUID;
  v_tenant_id UUID;
  v_service_elec_id UUID;
  v_service_water_id UUID;
  v_contract_id UUID;
BEGIN

  -- =============================================
  -- 1. Create Area
  -- =============================================
  INSERT INTO areas (user_id, name, code, status)
  VALUES (v_user_id, 'Khu vực Quận 1', 'Q1', 'ACTIVE')
  RETURNING id INTO v_area_id;

  -- =============================================
  -- 2. Create Building
  -- =============================================
  INSERT INTO buildings (
    user_id, area_id, name, code, type, status,
    province, district, ward, street_address,
    total_floors
  )
  VALUES (
    v_user_id, v_area_id, 'Tòa nhà A', 'TOA-A', 'APARTMENT', 'ACTIVE',
    'Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', '123 Nguyễn Huệ',
    5
  )
  RETURNING id INTO v_building_id;

  -- =============================================
  -- 3. Create Rooms
  -- =============================================
  INSERT INTO rooms (
    building_id, name, floor, status,
    area, max_occupants, rent_price, deposit_amount
  )
  VALUES
    (v_building_id, 'P101', 1, 'AVAILABLE', 25.5, 2, 5000000, 5000000),
    (v_building_id, 'P102', 1, 'AVAILABLE', 30.0, 2, 6000000, 6000000),
    (v_building_id, 'P201', 2, 'AVAILABLE', 25.5, 2, 5000000, 5000000),
    (v_building_id, 'P202', 2, 'AVAILABLE', 30.0, 2, 6000000, 6000000),
    (v_building_id, 'P301', 3, 'AVAILABLE', 25.5, 2, 5000000, 5000000)
  RETURNING id INTO v_room_id_101;

  -- Get room IDs
  SELECT id INTO v_room_id_101 FROM rooms WHERE building_id = v_building_id AND name = 'P101';
  SELECT id INTO v_room_id_102 FROM rooms WHERE building_id = v_building_id AND name = 'P102';

  -- =============================================
  -- 4. Create Services
  -- =============================================
  INSERT INTO services (user_id, name, code, type, unit_price, unit, is_default)
  VALUES
    (v_user_id, 'Tiền điện', 'ELEC', 'METER_READING', 3500, 'kWh', true),
    (v_user_id, 'Tiền nước', 'WATER', 'METER_READING', 15000, 'm³', true),
    (v_user_id, 'Wifi', 'WIFI', 'FIXED', 100000, 'tháng', true),
    (v_user_id, 'Vệ sinh', 'CLEAN', 'PER_PERSON', 50000, 'người/tháng', true),
    (v_user_id, 'Gửi xe máy', 'PARKING_BIKE', 'PER_ROOM', 100000, 'xe/tháng', false)
  RETURNING id INTO v_service_elec_id;

  SELECT id INTO v_service_elec_id FROM services WHERE user_id = v_user_id AND code = 'ELEC';
  SELECT id INTO v_service_water_id FROM services WHERE user_id = v_user_id AND code = 'WATER';

  -- =============================================
  -- 5. Create Tenant
  -- =============================================
  INSERT INTO tenants (
    user_id, full_name, id_number, id_type, date_of_birth, gender,
    phone, email, permanent_address, status
  )
  VALUES (
    v_user_id, 'Nguyễn Văn A', '001234567890', 'CCCD', '1990-01-15', 'Nam',
    '0901234567', 'nguyenvana@email.com', '456 Lê Lợi, Quận 1, TP.HCM', 'ACTIVE'
  )
  RETURNING id INTO v_tenant_id;

  -- =============================================
  -- 6. Create Contract
  -- =============================================
  INSERT INTO contracts (
    user_id, tenant_id, room_id,
    signed_date, start_date, end_date,
    rent_price, payment_cycle, total_deposit, deposit_paid,
    initial_electricity_reading, initial_water_reading,
    status
  )
  VALUES (
    v_user_id, v_tenant_id, v_room_id_101,
    CURRENT_DATE, CURRENT_DATE, CURRENT_DATE + INTERVAL '12 months',
    5000000, 'MONTHLY', 5000000, 0,
    100.0, 50.0,
    'ACTIVE'
  )
  RETURNING id INTO v_contract_id;

  -- =============================================
  -- 7. Add Contract Services
  -- =============================================
  INSERT INTO contract_services (contract_id, service_id, unit_price, initial_reading)
  VALUES
    (v_contract_id, v_service_elec_id, 3500, 100.0),
    (v_contract_id, v_service_water_id, 15000, 50.0);

  -- =============================================
  -- 8. Create Settings
  -- =============================================
  INSERT INTO settings (user_id, key, value)
  VALUES
    (v_user_id, 'invoice_number_format', '{"invoice_prefix": "INV", "contract_prefix": "HD"}'::jsonb),
    (v_user_id, 'general_settings', '{"payment_due_days": 5, "currency": "VND"}'::jsonb);

  RAISE NOTICE 'Sample data inserted successfully!';
  RAISE NOTICE 'Area ID: %', v_area_id;
  RAISE NOTICE 'Building ID: %', v_building_id;
  RAISE NOTICE 'Room 101 ID: %', v_room_id_101;
  RAISE NOTICE 'Tenant ID: %', v_tenant_id;
  RAISE NOTICE 'Contract ID: %', v_contract_id;

END $$;

*/

-- =============================================
-- END OF SEED DATA
-- =============================================

-- To verify the data was inserted:
-- SELECT * FROM buildings;
-- SELECT * FROM rooms;
-- SELECT * FROM tenants;
-- SELECT * FROM contracts;

COMMENT ON TABLE areas IS 'Seed data migration completed (commented out - uncomment to use)';
