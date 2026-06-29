-- =============================================================================
-- room_pass_listings: cờ "Liên hệ quản lý" (ẩn SĐT khách trên trang công khai)
-- =============================================================================
-- Bối cảnh: phòng "khách nhờ sale / pass" mặc định hiển thị SĐT của KHÁCH công
-- khai (opt-in). Đôi khi khách KHÔNG muốn lộ số → chỉ muốn "gọi cho quản lý".
-- Cờ contact_manager:
--   • Vẫn cho nhập/ghi SĐT khách (nội bộ, để nhân viên biết khách nào).
--   • Nhưng RPC public KHÔNG trả contact_phone/contact_name → anon không thấy số
--     khách; trang công khai hiện "Liên hệ quản lý" + dùng hotline/SĐT QL của tòa.
--
-- BASE: 20260629000000_public_rooms_moveout_respect_soon_window.sql (bản MỚI NHẤT
-- của get_public_available_rooms / get_my_available_rooms). Chỉ thêm:
--   1. cột contact_manager (default false).
--   2. upsert_room_pass_listing: thêm tham số p_contact_manager (DROP + tạo lại).
--   3. 2 RPC public: trả pass_contact_manager + che contact_phone/name khi cờ bật.
-- KHÔNG sửa migration cũ.
-- =============================================================================

ALTER TABLE public.room_pass_listings
  ADD COLUMN IF NOT EXISTS contact_manager boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.room_pass_listings.contact_manager IS
  'TRUE = khách nhờ "gọi cho quản lý", ẩn SĐT/tên khách trên trang công khai (RPC public không trả contact_phone/contact_name). SĐT khách vẫn ghi nội bộ.';

-- ---- upsert (chữ ký mới có p_contact_manager) ------------------------------
DROP FUNCTION IF EXISTS public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date);

CREATE OR REPLACE FUNCTION public.upsert_room_pass_listing(
  p_id              uuid,
  p_room_id         uuid,
  p_contact_name    text,
  p_contact_phone   text,
  p_sale_policy     text,
  p_pass_price      numeric,
  p_active          boolean,
  p_avail_date      date DEFAULT NULL,
  p_contact_manager boolean DEFAULT false
)
RETURNS public.room_pass_listings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid;
  v_building uuid;
  v_row      public.room_pass_listings;
BEGIN
  SELECT r.building_id, b.user_id
    INTO v_building, v_owner
  FROM public.rooms r
  JOIN public.buildings b ON b.id = r.building_id
  WHERE r.id = p_room_id AND r.deleted_at IS NULL AND b.deleted_at IS NULL;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Phòng không tồn tại hoặc đã xoá';
  END IF;

  IF NOT public.can_manage_pass_listing(v_building, v_owner) THEN
    RAISE EXCEPTION 'Không có quyền quản lý phòng khách nhờ sale cho tòa này';
  END IF;

  IF p_id IS NULL THEN
    SELECT id INTO p_id FROM public.room_pass_listings
    WHERE room_id = p_room_id AND active LIMIT 1;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.room_pass_listings (
      user_id, building_id, room_id, contact_name, contact_phone,
      sale_policy, pass_price, avail_date, contact_manager, active, created_by
    ) VALUES (
      v_owner, v_building, p_room_id, p_contact_name, p_contact_phone,
      p_sale_policy, p_pass_price, p_avail_date, COALESCE(p_contact_manager, false),
      COALESCE(p_active, true), auth.uid()
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.room_pass_listings SET
      user_id         = v_owner,
      building_id     = v_building,
      room_id         = p_room_id,
      contact_name    = p_contact_name,
      contact_phone   = p_contact_phone,
      sale_policy     = p_sale_policy,
      pass_price      = p_pass_price,
      avail_date      = p_avail_date,
      contact_manager = COALESCE(p_contact_manager, false),
      active          = COALESCE(p_active, active),
      updated_at      = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date,boolean) TO authenticated;

-- =============================================================================
-- get_public_available_rooms: trả pass_contact_manager + che SĐT/tên khách khi bật
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_name  END AS pass_contact_name,
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_phone END AS pass_contact_phone,
      pl.sale_policy   AS pass_sale_policy,
      pl.pass_price    AS pass_price,
      pl.avail_date    AS pass_avail_date,
      COALESCE(pl.contact_manager, false) AS pass_contact_manager,
      CASE
        WHEN pl.id IS NOT NULL THEN 'pass'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
            AND (
              (c.expected_move_out_date IS NOT NULL
                AND c.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon)
              OR COALESCE(c.actual_end_date, c.end_date)
                   BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
            )
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
        SELECT MIN(
          CASE
            WHEN c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
              THEN c.expected_move_out_date
            ELSE COALESCE(c.actual_end_date, c.end_date)
          END
        )
        FROM public.contracts c
        WHERE c.room_id = rm.id
          AND c.deleted_at IS NULL
          AND c.status IN ('ACTIVE','EXTENDED')
          AND (
            (c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon)
            OR COALESCE(c.actual_end_date, c.end_date)
                 BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
          )
      ) AS avail_date
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
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
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
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
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_available_rooms(text) TO anon, authenticated;

-- =============================================================================
-- get_my_available_rooms: đồng bộ y hệt (bản in-app).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

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
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_name  END AS pass_contact_name,
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_phone END AS pass_contact_phone,
      pl.sale_policy   AS pass_sale_policy,
      pl.pass_price    AS pass_price,
      pl.avail_date    AS pass_avail_date,
      COALESCE(pl.contact_manager, false) AS pass_contact_manager,
      CASE
        WHEN pl.id IS NOT NULL THEN 'pass'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
            AND (
              (c.expected_move_out_date IS NOT NULL
                AND c.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon)
              OR COALESCE(c.actual_end_date, c.end_date)
                   BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
            )
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
        SELECT MIN(
          CASE
            WHEN c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
              THEN c.expected_move_out_date
            ELSE COALESCE(c.actual_end_date, c.end_date)
          END
        )
        FROM public.contracts c
        WHERE c.room_id = rm.id
          AND c.deleted_at IS NULL
          AND c.status IN ('ACTIVE','EXTENDED')
          AND (
            (c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon)
            OR COALESCE(c.actual_end_date, c.end_date)
                 BETWEEN CURRENT_DATE AND CURRENT_DATE + v_soon
          )
      ) AS avail_date
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
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
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
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
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_available_rooms() TO authenticated;
