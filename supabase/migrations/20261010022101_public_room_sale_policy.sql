-- Chính sách sale chung cho bảng "DANH SÁCH PHÒNG TRỐNG" (ảnh Tải ảnh + ảnh gửi Zalo).
-- Một cột chữ tự do trên public_room_settings, trả thêm khoá 'sale_policy' ở gốc payload
-- của ba reader phòng trống. Thân hàm chép nguyên bản đang chạy (pg_get_functiondef,
-- đọc production 10/10/2026, khớp 20260928021213 theo khoảng trắng); chỉ thêm biến
-- v_sale_policy, đọc cột mới và một khoá trong jsonb_build_object cuối.
-- Không đổi kiểu trả về, không đổi ACL (CREATE OR REPLACE giữ GRANT/COMMENT).
-- Không ghi dữ liệu: cột mới NULL cho mọi dòng cũ.

ALTER TABLE public.public_room_settings ADD COLUMN IF NOT EXISTS sale_policy text;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.public_room_settings'::regclass
      AND conname = 'public_room_settings_sale_policy_len'
  ) THEN
    ALTER TABLE public.public_room_settings
      ADD CONSTRAINT public_room_settings_sale_policy_len CHECK (char_length(sale_policy) <= 2000);
  END IF;
END
$do$;

COMMENT ON COLUMN public.public_room_settings.sale_policy IS
  'Chính sách sale chung (chữ tự do, nhiều dòng) in ở khối đầu bảng phòng trống; NULL = không in.';

CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
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

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
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
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
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
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
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

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
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
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
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
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.zalo_phong_trong_cho_worker_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
  v_today   date;
  v_result  jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL);
  END IF;

  SELECT prs.soon_days, prs.hotline_id, prs.sale_policy INTO v_soon, v_hotline, v_sale_policy
    FROM public.public_room_settings prs
   WHERE prs.organization_id = p_organization_id
   LIMIT 1;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  v_today := public.org_today_v1(p_organization_id);

  WITH rms AS (
    SELECT
      rm.id, rm.building_id, rm.floor, rm.name, rm.code, rm.area,
      rm.rent_price, rm.deposit_amount, rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description, rm.sale_note, rm.room_type,
      -- contact_manager = che liên hệ của khách, chỉ để lại "liên hệ quản lý".
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public,fact.avail_date,fact.sale_state,fact.sale_today,fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id
     AND pl.active = true
     AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL)
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    WHERE rm.organization_id=p_organization_id AND b.organization_id = p_organization_id
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
       AND rms.status_public IN ('free','soon','pass')
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'code', b.code,
      'area_ids', COALESCE((SELECT jsonb_agg(ab.area_id)
                              FROM public.area_buildings ab
                              JOIN public.areas a ON a.id = ab.area_id
                             WHERE ab.building_id = b.id AND a.deleted_at IS NULL), '[]'::jsonb),
      'district', b.district, 'ward', b.ward,
      'address', CASE
                   WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address
                   ELSE concat_ws(', ', NULLIF(b.street_address,''), NULLIF(b.ward,''),
                                        NULLIF(b.district,''), NULLIF(b.province,''))
                 END,
      'total_floors', b.total_floors,
      'images', COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
          FROM public.building_services bs
          JOIN public.services s ON s.id = bs.service_id
         WHERE bs.building_id = b.id AND bs.is_active = true
           AND s.deleted_at IS NULL AND s.unit ILIKE 'kwh'
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
     WHERE a.organization_id = p_organization_id AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
      FROM public.hotlines h
     WHERE h.organization_id = p_organization_id
       AND COALESCE(h.is_active, true) = true
       AND (v_hotline IS NULL OR h.id = v_hotline)
     ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j),  '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
