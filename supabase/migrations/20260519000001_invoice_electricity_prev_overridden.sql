-- =============================================
-- Migration: cờ chỉ số điện đầu bị sửa tay
-- =============================================
-- "CHỈ SỐ ĐẦU" trong dialog tạo HĐ được auto-fill từ meter reading APPROVED
-- gần nhất. Nếu nhân viên bấm cây bút và sửa tay (vd: meter đếm sai, chốt
-- lại theo công tơ), set cờ này = true. List view sẽ tô đỏ ô Tiền điện
-- để dễ audit.
-- =============================================

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS electricity_prev_overridden BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.invoices.electricity_prev_overridden IS
  'Cờ NV sửa tay chỉ số điện đầu khi tạo HĐ (vd: chốt lại meter).';

NOTIFY pgrst, 'reload schema';

COMMIT;
