-- =============================================
-- Migration: Trang công khai "Phòng trống" (Sale view) tại /r/:token.
-- - Bảng token chia sẻ công khai, scope theo owner (multi-tenant): token chỉ
--   ghi owner_id ở phía server để RPC biết trả phòng của CHỦ nào. Chuỗi token
--   trên URL là ngẫu nhiên, không chứa thông tin chủ, không gửi owner_id ra client.
-- - RPC SECURITY DEFINER get_public_available_rooms(p_token) trả jsonb
--   { areas, buildings, rooms, contact } cho anon. Trả NULL nếu token sai/thu hồi.
-- - status_public mỗi phòng — HỢP ĐỒNG là nguồn sự thật (cờ rooms.status có thể
--   stale: phòng đang có HĐ nhưng vẫn để AVAILABLE):
--     'soon'   = có HĐ đang hiệu lực (ACTIVE/EXTENDED, chưa xoá) hết hạn ≤30 ngày tới
--     'rented' = có HĐ đang hiệu lực (không sắp hết) — KỂ CẢ khi rooms.status=AVAILABLE
--     'free'   = KHÔNG có HĐ đang hiệu lực VÀ rooms.status = AVAILABLE
--     'rented' = còn lại (không HĐ nhưng OCCUPIED/RESERVED/MAINTENANCE/UNAVAILABLE)
-- - Chỉ trả toà có ≥1 phòng free/soon (nhưng trả ĐỦ phòng của toà đó để vẽ sơ đồ).
-- - KHÔNG expose dữ liệu nhạy cảm (user_id, hợp đồng, khách thuê, công nợ).
-- =============================================

-- 1) Bảng token chia sẻ công khai.
CREATE TABLE IF NOT EXISTS public.public_room_share_tokens (
  token       text PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label       text,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_room_share_tokens IS
'Token chia sẻ công khai cho trang "Phòng trống" (/r/:token). owner_id = chủ data
được lộ ra (chỉ phía server, KHÔNG gửi ra client). revoked=true để thu hồi link.';

ALTER TABLE public.public_room_share_tokens ENABLE ROW LEVEL SECURITY;

-- Chủ tài khoản tự quản token của mình (qua app, role authenticated). anon KHÔNG
-- truy cập bảng trực tiếp — chỉ đọc gián tiếp qua RPC SECURITY DEFINER bên dưới.
DROP POLICY IF EXISTS prst_owner_all ON public.public_room_share_tokens;
CREATE POLICY prst_owner_all ON public.public_room_share_tokens
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- 2) RPC public: token -> danh sách phòng trống của owner.
CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner  uuid;
  v_result jsonb;
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
                BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
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
              BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
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
      -- street_address của data thật không nhất quán: có cái đã là địa chỉ đầy đủ
      -- (chứa dấu phẩy), có cái chỉ là mã toà ("111PVC"). Nếu đã đầy đủ thì dùng
      -- nguyên (tránh lặp phường/quận/tp); nếu không thì ghép thêm phường/quận/tp.
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors
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
    WHERE h.user_id = v_owner AND COALESCE(h.is_active, true) = true
    ORDER BY h.created_at
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
{areas, buildings, rooms, contact}, chỉ toà có phòng free/soon. status_public:
free=AVAILABLE, soon=OCCUPIED+HĐ hiệu lực hết hạn <=30 ngày, rented=còn lại.
Trả NULL nếu token sai/đã thu hồi. Không expose user_id/hợp đồng/khách thuê.';

-- anon (khách) + authenticated đều gọi được (link public).
GRANT EXECUTE ON FUNCTION public.get_public_available_rooms(text) TO anon, authenticated;
