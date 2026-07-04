-- ============================================================
-- FIX: v5_distance_m khai báo NUMERIC nhưng buildings.latitude/longitude
-- là DOUBLE PRECISION. Postgres KHÔNG implicit-cast float8→numeric khi
-- resolve hàm → submit_inspection_photo / record_payment_gps nổ
-- "function v5_distance_m(numeric, numeric, double precision, double precision)
--  does not exist" NGAY KHI toà có gắn toạ độ (toà chưa có toạ độ thì nhánh
-- này bị skip nên bug ẩn tới giờ — lỗi thực địa 04/07 tại 44TL/1392QT).
-- Fix: đổi tham số sang DOUBLE PRECISION (numeric→float8 là implicit nên
-- các call-site truyền p_lat/p_lng NUMERIC vẫn resolve được).
-- ============================================================

DROP FUNCTION IF EXISTS public.v5_distance_m(NUMERIC, NUMERIC, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION public.v5_distance_m(
  lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION, lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION
) RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN NULL
  ELSE ROUND(6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))::int END;
$$;
