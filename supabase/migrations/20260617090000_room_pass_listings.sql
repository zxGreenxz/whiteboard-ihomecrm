-- =============================================================================
-- Phòng "khách nhờ sale / pass phòng giùm khách"
-- =============================================================================
-- Bối cảnh: trang công khai /r/:token chỉ liệt kê PHÒNG TRỐNG của công ty.
-- Khách đang thuê đôi khi nhờ công ty SALE/PASS phòng giùm. Phòng đó đang có HĐ
-- ACTIVE nên bị get_public_available_rooms ép status_public='rented' và không lên
-- kênh public. Bảng này là lớp dữ liệu ĐỘC LẬP overlay lên trạng thái hợp đồng:
--   • KHÔNG đụng rooms.status / hợp đồng (tránh recompute_room_reservation kéo về).
--   • Nhân viên CÓ QUYỀN quản lý theo scope tòa (giống income_expenses) — ghi qua
--     RPC SECURITY DEFINER tự gán user_id = OWNER (buildings.user_id) + guard quyền.
--   • contact_name/contact_phone là dữ liệu NHẬP TAY (opt-in) của khách, được
--     EXPOSE CÓ Ý qua RPC public — ngoại lệ chủ ý so với quy tắc "anon không thấy
--     khách thuê". KHÔNG bao giờ JOIN tự động từ customers/contracts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.room_pass_listings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,                                            -- = buildings.user_id (OWNER)
  building_id   uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  room_id       uuid NOT NULL REFERENCES public.rooms(id)     ON DELETE CASCADE,
  contact_name  text,                                                     -- TÊN KHÁCH (hiển thị public)
  contact_phone text,                                                     -- SĐT KHÁCH (hiển thị public)
  sale_policy   text,                                                     -- chính sách sale do khách đặt (public)
  pass_price    numeric,                                                  -- giá pass (NULL → fallback rooms.rent_price)
  active        boolean NOT NULL DEFAULT true,                            -- bật/tắt hiển thị
  created_by    uuid,                                                     -- auth.uid() người tạo (audit)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Mỗi phòng tối đa 1 listing đang bật
CREATE UNIQUE INDEX IF NOT EXISTS room_pass_listings_room_active_uniq
  ON public.room_pass_listings(room_id) WHERE active;
CREATE INDEX IF NOT EXISTS room_pass_listings_user_idx     ON public.room_pass_listings(user_id);
CREATE INDEX IF NOT EXISTS room_pass_listings_building_idx ON public.room_pass_listings(building_id);

COMMENT ON TABLE  public.room_pass_listings IS
  'Phòng khách nhờ sale/pass: overlay lên phòng đang có khách để hiển thị trên kênh công khai. KHÔNG đụng rooms.status/HĐ.';
COMMENT ON COLUMN public.room_pass_listings.contact_phone IS
  'SĐT của KHÁCH — EXPOSE CÓ Ý qua RPC public (opt-in). Ngoại lệ so với quy tắc anon không thấy khách thuê.';
COMMENT ON COLUMN public.room_pass_listings.contact_name IS
  'Tên KHÁCH — EXPOSE CÓ Ý qua RPC public (opt-in).';
COMMENT ON COLUMN public.room_pass_listings.user_id IS
  'Owner của tòa (buildings.user_id) — để trang public match buildings.user_id = owner-của-token.';

-- RLS: bật. Việc GHI đi qua các RPC SECURITY DEFINER bên dưới (không có policy
-- write → chặn ghi trực tiếp từ client, ép qua RPC để gán đúng user_id=owner).
ALTER TABLE public.room_pass_listings ENABLE ROW LEVEL SECURITY;

-- SELECT: owner thấy của mình; nhân viên thấy theo scope tòa (giống can_access_building).
DROP POLICY IF EXISTS rpl_select ON public.room_pass_listings;
CREATE POLICY rpl_select ON public.room_pass_listings
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.can_access_building(building_id)
  );

-- =============================================================================
-- Guard quyền dùng chung (owner / admin / staff có quyền sale_phong trên tòa).
-- Khớp fallback FE: manage_pass_listings → edit.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.can_manage_pass_listing(_building_id uuid, _owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = _owner
    OR public.can_do_on_building('sale_phong', 'manage_pass_listings', _building_id)
    OR public.can_do_on_building('sale_phong', 'edit', _building_id);
$$;

-- =============================================================================
-- RPC: tạo/sửa listing (id NULL = tạo; nếu phòng đã có listing active thì update).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.upsert_room_pass_listing(
  p_id            uuid,
  p_room_id       uuid,
  p_contact_name  text,
  p_contact_phone text,
  p_sale_policy   text,
  p_pass_price    numeric,
  p_active        boolean
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

  -- Tạo mới nhưng phòng đã có listing active → chuyển sang update để tránh vướng unique.
  IF p_id IS NULL THEN
    SELECT id INTO p_id FROM public.room_pass_listings
    WHERE room_id = p_room_id AND active LIMIT 1;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.room_pass_listings (
      user_id, building_id, room_id, contact_name, contact_phone,
      sale_policy, pass_price, active, created_by
    ) VALUES (
      v_owner, v_building, p_room_id, p_contact_name, p_contact_phone,
      p_sale_policy, p_pass_price, COALESCE(p_active, true), auth.uid()
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
      active        = COALESCE(p_active, active),
      updated_at    = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- =============================================================================
-- RPC: bật/tắt hiển thị
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_room_pass_listing_active(p_id uuid, p_active boolean)
RETURNS public.room_pass_listings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.room_pass_listings;
BEGIN
  SELECT * INTO v_row FROM public.room_pass_listings WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Listing không tồn tại';
  END IF;
  IF NOT public.can_manage_pass_listing(v_row.building_id, v_row.user_id) THEN
    RAISE EXCEPTION 'Không có quyền quản lý phòng khách nhờ sale cho tòa này';
  END IF;

  UPDATE public.room_pass_listings
    SET active = p_active, updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- =============================================================================
-- RPC: xoá listing
-- =============================================================================
CREATE OR REPLACE FUNCTION public.delete_room_pass_listing(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.room_pass_listings;
BEGIN
  SELECT * INTO v_row FROM public.room_pass_listings WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.can_manage_pass_listing(v_row.building_id, v_row.user_id) THEN
    RAISE EXCEPTION 'Không có quyền quản lý phòng khách nhờ sale cho tòa này';
  END IF;

  DELETE FROM public.room_pass_listings WHERE id = p_id;
END;
$$;

-- =============================================================================
-- RPC form: danh sách phòng trong scope (owner + nhân viên), KHÔNG lọc AVAILABLE
-- để chọn được phòng đang có khách. Trả kèm cờ has_active_contract + listing hiện có.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.pass_listing_form_rooms()
RETURNS TABLE (
  room_id             uuid,
  room_code           text,
  room_name           text,
  rent_price          numeric,
  building_id         uuid,
  building_name       text,
  owner_id            uuid,
  has_active_contract boolean,
  current_listing_id  uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id, r.code, r.name, r.rent_price,
    b.id, b.name, b.user_id,
    EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.room_id = r.id AND c.deleted_at IS NULL
        AND c.status IN ('ACTIVE','EXTENDED')
    ) AS has_active_contract,
    (SELECT pl.id FROM public.room_pass_listings pl
       WHERE pl.room_id = r.id AND pl.active LIMIT 1) AS current_listing_id
  FROM public.rooms r
  JOIN public.buildings b ON b.id = r.building_id
  WHERE r.deleted_at IS NULL AND b.deleted_at IS NULL AND b.is_virtual = false
    AND (b.user_id = auth.uid() OR public.can_access_building(b.id))
  ORDER BY b.name, r.floor DESC, r.name;
$$;

-- Quyền: chỉ authenticated; KHÔNG cấp anon.
REVOKE ALL ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_pass_listing_active(uuid,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_room_pass_listing(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pass_listing_form_rooms() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_pass_listing(uuid,uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_room_pass_listing_active(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_room_pass_listing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pass_listing_form_rooms() TO authenticated;
