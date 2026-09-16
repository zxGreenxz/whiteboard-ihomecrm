-- Hạn ghi trên ảnh "Hợp đồng cho thuê, mượn, ở nhờ" (dòng ảnh kind = LEASE), đọc bằng
-- bộ nhận dạng chữ chạy trong trình duyệt hoặc người dùng sửa tay. Nút "Đăng ký tạm trú
-- trên DVC" lấy hạn tạm trú từ đây thay vì "hôm nay + 12/24 tháng".
--
-- VÌ SAO (đo thật 16/09/2026): tờ khai CT01 và hợp đồng in theo NGÀY CHỦ TẢI GIẤY
-- (14/09/2026 → 14/09/2028), còn nút tính theo NGÀY BẤM (16/09) → hồ sơ đầu tiên nộp
-- lệch một ngày so với giấy. Chữ trên ảnh là nguồn duy nhất còn lại của ngày đó.
--
-- Chỉ thêm cột nullable; quyền đọc/ghi vẫn theo policy hiện có của bảng. Idempotent.
ALTER TABLE public.residence_dossier_files
  ADD COLUMN IF NOT EXISTS lease_term_from date,
  ADD COLUMN IF NOT EXISTS lease_term_to date,
  ADD COLUMN IF NOT EXISTS lease_term_source text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'residence_dossier_files_lease_term_source_chk') THEN
    ALTER TABLE public.residence_dossier_files
      ADD CONSTRAINT residence_dossier_files_lease_term_source_chk
      CHECK (lease_term_source IS NULL OR lease_term_source IN ('ocr', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'residence_dossier_files_lease_term_order_chk') THEN
    ALTER TABLE public.residence_dossier_files
      ADD CONSTRAINT residence_dossier_files_lease_term_order_chk
      CHECK (lease_term_from IS NULL OR lease_term_to IS NULL OR lease_term_to > lease_term_from);
  END IF;
END $$;

COMMENT ON COLUMN public.residence_dossier_files.lease_term_from IS
  'Ngày bắt đầu ghi trên hợp đồng ở nhờ (ảnh LEASE): đọc bằng OCR trong trình duyệt hoặc nhập tay.';
COMMENT ON COLUMN public.residence_dossier_files.lease_term_to IS
  'Ngày hết hạn ghi trên hợp đồng ở nhờ — chính là hạn tạm trú khai trên Cổng DVC.';
COMMENT ON COLUMN public.residence_dossier_files.lease_term_source IS
  'ocr = đọc từ ảnh trong trình duyệt; manual = người dùng sửa tay.';
