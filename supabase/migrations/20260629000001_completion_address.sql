-- =============================================
-- Migration: Lưu địa chỉ quy đổi từ GPS khi hoàn thành job
-- Created: 2026-06-29
-- Description:
--   Watermark ảnh nghiệm thu hiển thị địa chỉ reverse-geocode từ toạ độ GPS
--   thực tế (không phải địa chỉ tòa). Lưu lại địa chỉ đó để audit/đọc nhanh.
-- =============================================
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS completion_address text;

COMMENT ON COLUMN public.jobs.completion_address IS
  'Địa chỉ reverse-geocode từ completion_lat/lng lúc chụp ảnh hoàn thành (không phải địa chỉ tòa)';
