-- =============================================
-- Migration: Thêm end_billing_date vào contracts
--
-- Cho phép nhập "Đến ngày" của kỳ tính tiền đầu tiên khi tạo hợp đồng
-- (mặc định ngày 5 tháng kế tiếp). Dùng làm to_date của các item trong
-- hoá đơn cọc + tháng đầu được sinh tự động sau khi lưu hợp đồng.
-- =============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contracts'
      AND column_name = 'end_billing_date'
  ) THEN
    ALTER TABLE public.contracts ADD COLUMN end_billing_date DATE;
    COMMENT ON COLUMN public.contracts.end_billing_date IS
      'Ngày kết thúc kỳ tính tiền đầu tiên (mặc định 5/tháng kế tiếp start_billing_date) — dùng cho hoá đơn cọc + tháng đầu.';
  END IF;
END $$;
