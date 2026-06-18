-- =============================================================================
-- room_pass_listings: thêm "ngày trống phòng" + RPC lấy khách thuê của phòng
-- =============================================================================
-- 1. Cột avail_date: ngày dự kiến trống (tuỳ chọn) — hiển thị "trống từ …" công khai.
-- 2. upsert_room_pass_listing: thêm tham số p_avail_date (DROP + tạo lại vì đổi chữ ký).
-- 3. pass_listing_room_customers(room_id): trả khách thuê của HĐ active để FE
--    điền sẵn SĐT/tên khách ĐẠI DIỆN + cho chọn khách khác. Chỉ lộ cho user trong
--    scope tòa (owner OR can_access_building) — KHÔNG mở anon.
-- =============================================================================

ALTER TABLE public.room_pass_listings
  ADD COLUMN IF NOT EXISTS avail_date date;

COMMENT ON COLUMN public.room_pass_listings.avail_date IS
  'Ngày dự kiến trống phòng (tuỳ chọn) — hiển thị "trống từ …" trên trang công khai.';

-- ---- upsert (chữ ký mới có p_avail_date) -----------------------------------
DROP FUNCTION IF EXISTS public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean);

CREATE OR REPLACE FUNCTION public.upsert_room_pass_listing(
  p_id            uuid,
  p_room_id       uuid,
  p_contact_name  text,
  p_contact_phone text,
  p_sale_policy   text,
  p_pass_price    numeric,
  p_active        boolean,
  p_avail_date    date DEFAULT NULL
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
      sale_policy, pass_price, avail_date, active, created_by
    ) VALUES (
      v_owner, v_building, p_room_id, p_contact_name, p_contact_phone,
      p_sale_policy, p_pass_price, p_avail_date, COALESCE(p_active, true), auth.uid()
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.room_pass_listings SET
      user_id       = v_owner,
      building_id   = v_building,
      room_id       = p_room_id,
      contact_name  = p_contact_name,
      contact_phone = p_contact_phone,
      sale_policy   = p_sale_policy,
      pass_price    = p_pass_price,
      avail_date    = p_avail_date,
      active        = COALESCE(p_active, active),
      updated_at    = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- ---- khách thuê của phòng (điền sẵn / chọn) --------------------------------
CREATE OR REPLACE FUNCTION public.pass_listing_room_customers(p_room_id uuid)
RETURNS TABLE (
  full_name        text,
  phone            text,
  is_representative boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cu.full_name, cu.phone, COALESCE(cc.is_representative, false)
  FROM public.rooms r
  JOIN public.buildings b ON b.id = r.building_id
  JOIN public.contracts c
    ON c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
  JOIN public.contract_customers cc ON cc.contract_id = c.id
  JOIN public.customers cu ON cu.id = cc.customer_id AND cu.deleted_at IS NULL
  WHERE r.id = p_room_id
    AND (b.user_id = auth.uid() OR public.can_access_building(b.id))
  ORDER BY COALESCE(cc.is_representative, false) DESC, cu.full_name;
$$;

REVOKE ALL ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pass_listing_room_customers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pass_listing_room_customers(uuid) TO authenticated;
