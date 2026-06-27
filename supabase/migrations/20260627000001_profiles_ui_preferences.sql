-- =============================================================================
-- profiles.ui_preferences — kho lưu tuỳ chọn hiển thị UI theo từng user (jsonb).
-- Dùng cho các trạng thái ẩn/hiện nhỏ mà người dùng muốn GIỮ qua F5 / đa thiết bị
-- (vd: ẩn thẻ thống kê & số tổng ở trang Phân bổ lợi nhuận).
-- RLS sẵn có: user tự update được hàng profiles của mình (id = auth.uid()).
-- =============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ui_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.ui_preferences IS
  'Per-user UI display preferences (small toggles persisted across reload/devices).';

NOTIFY pgrst, 'reload schema';
