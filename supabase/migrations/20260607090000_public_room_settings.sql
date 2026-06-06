-- =============================================
-- Migration: Cấu hình trang công khai "Phòng trống" (Sale Phòng), theo CHỦ tài khoản.
-- - 1 dòng / owner (PK = owner_id). RPC get_public_available_rooms đọc soon_days
--   (số ngày báo "sắp trống") và hotline_id (override hotline hiển thị).
-- - show_rented: lưu sẵn cho UI; CHƯA wire vào RPC (ẩn phòng đã thuê sẽ làm thủng
--   sơ đồ tầng) — bật lọc sau khi xác nhận.
-- - anon KHÔNG truy cập bảng trực tiếp; RPC SECURITY DEFINER đọc giúp.
-- =============================================

CREATE TABLE IF NOT EXISTS public.public_room_settings (
  owner_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  soon_days   int NOT NULL DEFAULT 30 CHECK (soon_days BETWEEN 0 AND 365),
  show_rented boolean NOT NULL DEFAULT true,
  hotline_id  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_room_settings IS
'Cấu hình trang "Phòng trống" công khai (/r/:token) theo owner. soon_days = số ngày
trước khi hết HĐ thì báo "sắp trống"; hotline_id = hotline hiển thị (NULL = active đầu
tiên). RPC get_public_available_rooms đọc bảng này (SECURITY DEFINER).';

ALTER TABLE public.public_room_settings ENABLE ROW LEVEL SECURITY;

-- Chủ tài khoản tự quản cấu hình của mình (role authenticated).
DROP POLICY IF EXISTS prs_owner_all ON public.public_room_settings;
CREATE POLICY prs_owner_all ON public.public_room_settings
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
