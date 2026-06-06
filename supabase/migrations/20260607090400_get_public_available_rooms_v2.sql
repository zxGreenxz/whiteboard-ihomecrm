-- =============================================
-- Migration: Nâng RPC get_public_available_rooms (supersede 20260606120000).
-- KHÔNG sửa file migration cũ — chỉ CREATE OR REPLACE để thêm:
--   1) soon_days cấu hình theo owner (public_room_settings) thay cho hard-code 30 ngày.
--   2) hotline_id override (chọn hotline hiển thị; NULL = active đầu tiên như cũ).
--   3) buildings trả thêm floor_layouts (sơ đồ tọa độ thủ công) + images (ảnh tòa).
-- Backward compatible: client cũ bỏ qua key mới; không có settings → mặc định 30.
-- =============================================

CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_result  jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN NULL;
  END IF;

  SELECT owner_id INTO v_owner
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;

  IF v_owner IS NULL THEN
    RETURN NULL;
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
      'floor_layouts', b.floor_layouts,                  -- NEW: sơ đồ tọa độ thủ công
      'images',        COALESCE(b.images, '[]'::jsonb)   -- NEW: ảnh tòa cho header
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

COMMENT ON FUNCTION public.get_public_available_rooms(text) IS
'Public read API trang "Phòng trống" (/r/:token). Token -> owner; trả jsonb
{areas, buildings, rooms, contact}, chỉ toà có phòng free/soon. soon_days theo
public_room_settings (mặc định 30). buildings có floor_layouts + images. Trả NULL
nếu token sai/đã thu hồi. Không expose user_id/hợp đồng/khách thuê.';

-- anon (khách) + authenticated đều gọi được (link public).
GRANT EXECUTE ON FUNCTION public.get_public_available_rooms(text) TO anon, authenticated;
