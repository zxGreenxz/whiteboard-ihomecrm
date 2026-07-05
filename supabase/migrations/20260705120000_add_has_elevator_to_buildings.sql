-- Thêm cờ "có thang máy" cho toà nhà.
-- Dùng để quyết định có cảnh báo thiếu phiếu BẢO TRÌ THANG MÁY hay không ở báo
-- cáo Phân bổ lợi nhuận (chỉ toà có thang máy mới hiện placeholder "chưa có phiếu").
-- Mẫu theo cột boolean is_virtual (20260512000001_thuchi_logic_restructure.sql).

ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS has_elevator BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.buildings.has_elevator IS
  'Toà có thang máy — dùng để cảnh báo thiếu phiếu bảo trì thang máy ở Phân bổ lợi nhuận.';
