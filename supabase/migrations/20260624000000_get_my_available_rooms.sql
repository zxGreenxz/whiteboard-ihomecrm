-- =============================================
-- Migration: RPC get_my_available_rooms() — bản AUTHENTICATED của
-- get_public_available_rooms(token), dùng cho trang "Phòng trống" IN-APP (mobile).
--
-- Khác bản public: KHÔNG nhận token. Suy owner từ ngữ cảnh caller GIỐNG
-- get_my_context() (super/owner → chính mình; staff → staff_assignments.user_id),
-- rồi tái dùng ĐÚNG query của get_public_available_rooms_v2
-- (20260607090400) để trả CÙNG payload {areas, buildings, rooms, contact}.
-- => FE map qua mapPayloadToBuildings và dùng lại 100% UI.
--
-- KHÔNG sửa function/migration cũ — chỉ CREATE thêm function mới.
-- =============================================

CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  -- Suy owner: staff → user_id chủ dữ liệu; owner/super → chính caller.
  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

  -- Cấu hình hiển thị theo owner (thiếu dòng → mặc định 30 ngày, hotline NULL).
  SELECT soon_days, hotline_id INTO v_soon, v_hotline
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
            AND COALESCE(c.actual_end_date, c.end_date)
                BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
        ) THEN 'soon'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
        ) THEN 'rented'
        WHEN rm.status = 'AVAILABLE' THEN 'free'
        ELSE 'rented'
      END AS status_public,
      (
        SELECT MIN(COALESCE(c.actual_end_date, c.end_date))
        FROM public.contracts c
        WHERE c.room_id = rm.id
          AND c.deleted_at IS NULL
          AND c.status IN ('ACTIVE','EXTENDED')
          AND COALESCE(c.actual_end_date, c.end_date)
              BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
      ) AS avail_date
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  -- Chỉ giữ toà có ≥1 phòng free/soon.
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_id',      b.area_id,
      'area_name',    a.name,
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb)
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    LEFT JOIN public.areas a ON a.id = b.area_id
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_my_available_rooms() IS
'Bản authenticated của get_public_available_rooms cho trang "Phòng trống" in-app.
Suy owner từ caller (staff → staff_assignments.user_id; owner/super → auth.uid),
trả cùng payload {areas, buildings, rooms, contact}, chỉ toà có phòng free/soon.';

REVOKE EXECUTE ON FUNCTION public.get_my_available_rooms() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_available_rooms() TO authenticated;
