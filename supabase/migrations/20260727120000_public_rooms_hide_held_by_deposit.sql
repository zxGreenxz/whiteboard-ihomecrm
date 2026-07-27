-- =============================================================================
-- Cọc giữ chỗ KHOÁ luôn phòng "Sắp trống" (đang có HĐ) trên bảng phòng trống
-- =============================================================================
-- BỆNH (báo 27/07/2026, phòng 103/102LVT):
--   Tạo phiếu thu cọc giữ chỗ cho phòng SẮP TRỐNG (HĐ còn hiệu lực, hết hạn/
--   dọn đi trong cửa sổ soon_days) → phòng VẪN hiện "Sắp trống" trên trang công
--   khai /r/:token và trang Sale in-app. Hai tầng cùng hở:
--
--   1. `recompute_room_reservation` RETURN sớm khi phòng còn HĐ ACTIVE/EXTENDED
--      (HĐ sở hữu OCCUPIED) → `rooms.status` không bao giờ thành RESERVED, nên
--      cờ RESERVED không thể dùng để khoá phòng sắp trống.
--   2. Trong `get_public_available_rooms` / `get_my_available_rooms`, nhánh
--      'soon' (suy từ contracts) đứng TRƯỚC nhánh đọc `rm.status` → kể cả có
--      RESERVED cũng bị nhánh 'soon' nuốt trước.
--
-- CÁCH VÁ: tách predicate "phòng đang có cọc giữ chỗ" thành helper dùng chung
--   `room_has_holding_deposit(room_id)` (đúng predicate cũ trong reconcile:
--   phiếu deposits PENDING/CONFIRMED chưa link HĐ, HOẶC phiếu IE INCOME có item
--   is_deposit chưa link HĐ, KỂ CẢ CHƯA DUYỆT, chỉ loại CANCELLED/đã xoá), rồi:
--   • `recompute_room_reservation` gọi helper (giữ nguyên hành vi, hết trùng lặp);
--   • 2 RPC bảng phòng thêm nhánh `WHEN room_has_holding_deposit(rm.id) → 'rented'`
--     đặt NGAY SAU 'pass' và TRƯỚC 'soon' → phòng đã có cọc rời khỏi danh sách
--     chào khách, đúng như phòng trống-đã-cọc (RESERVED) hôm nay.
--
-- Phòng pass (khách nhờ sale) vẫn ưu tiên nhất — không đổi.
-- Khi HĐ mới được tạo, trigger trg_contract_link_orphan_deposits gắn phiếu cọc
-- vào HĐ → predicate tắt → phòng do HĐ mới sở hữu (rented), không kẹt.
--
-- KHÔNG sửa migration cũ — chỉ CREATE OR REPLACE (giữ grants).
-- BASE: 20260629100000_room_pass_listings_contact_manager.sql (bản mới nhất của
--       2 RPC) + 20260608000000_room_reservation_reconcile.sql (reconcile).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Helper dùng chung: phòng đang bị GIỮ bởi cọc chưa gắn HĐ?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.room_has_holding_deposit(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_room_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.deposits d
      WHERE d.room_id = p_room_id
        AND d.deleted_at IS NULL
        AND d.contract_id IS NULL
        AND d.status IN ('PENDING','CONFIRMED')
    )
    OR EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.room_id = p_room_id
        AND ie.deleted_at IS NULL
        AND ie.contract_id IS NULL
        AND ie.type = 'INCOME'
        AND COALESCE(ie.approval_status, '') <> 'CANCELLED'
        AND public.ie_has_deposit_item(ie.id)
    )
  );
$$;

COMMENT ON FUNCTION public.room_has_holding_deposit(uuid) IS
'TRUE nếu phòng đang bị giữ bởi cọc giữ chỗ chưa gắn HĐ (deposits PENDING/CONFIRMED
hoặc phiếu thu IE có item is_deposit, kể cả chưa duyệt; loại CANCELLED/đã xoá).
Predicate DÙNG CHUNG cho recompute_room_reservation (cờ RESERVED) và 2 RPC bảng
phòng trống (ẩn phòng đã cọc, kể cả phòng "sắp trống" còn HĐ hiệu lực).';

-- Nội bộ: chỉ gọi từ trong các function SECURITY DEFINER (theo án Sprint 0).
REVOKE ALL ON FUNCTION public.room_has_holding_deposit(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) recompute_room_reservation dùng helper (hành vi KHÔNG đổi)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_room_reservation(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      text;
  v_has_active  boolean;
  v_has_holding boolean;
BEGIN
  IF p_room_id IS NULL THEN
    RETURN;
  END IF;

  SELECT status INTO v_status
  FROM rooms
  WHERE id = p_room_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- HĐ đang hiệu lực sở hữu OCCUPIED → reconcile cọc không can thiệp.
  SELECT EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.room_id = p_room_id
      AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE','EXTENDED')
  ) INTO v_has_active;
  IF v_has_active THEN
    RETURN;
  END IF;

  v_has_holding := public.room_has_holding_deposit(p_room_id);

  IF v_status = 'AVAILABLE' AND v_has_holding THEN
    UPDATE rooms SET status = 'RESERVED', updated_at = NOW() WHERE id = p_room_id;
  ELSIF v_status = 'RESERVED' AND NOT v_has_holding THEN
    UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW() WHERE id = p_room_id;
  END IF;
END;
$$;

-- =============================================================================
-- 3) get_public_available_rooms: phòng đã có cọc giữ chỗ → 'rented' (ẩn)
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
        -- Đã có cọc giữ chỗ chưa gắn HĐ → phòng bị KHOÁ, không chào khách nữa.
        -- Đặt TRƯỚC nhánh 'soon' vì phòng sắp trống vẫn còn HĐ hiệu lực nên
        -- rooms.status không thể là RESERVED (reconcile bỏ qua phòng có HĐ).
        WHEN public.room_has_holding_deposit(rm.id) THEN 'rented'
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
-- 4) get_my_available_rooms: đồng bộ y hệt (bản in-app).
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
        -- Đã có cọc giữ chỗ chưa gắn HĐ → phòng bị KHOÁ (xem RPC public ở trên).
        WHEN public.room_has_holding_deposit(rm.id) THEN 'rented'
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
