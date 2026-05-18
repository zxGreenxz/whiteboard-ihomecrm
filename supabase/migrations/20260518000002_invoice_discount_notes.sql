-- =============================================
-- Migration: thêm cột discount_notes cho invoices
-- =============================================
-- UI cho phép gắn ghi chú vào ô "Giảm trừ" (tooltip + popover ở góc trên phải
-- ô input). Khi tự động prefill từ tiền nợ khách (excess_amounts) thì note
-- mặc định là "Nợ X Tiền Thối".
-- =============================================

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS discount_notes TEXT;

COMMENT ON COLUMN public.invoices.discount_notes IS
  'Ghi chú gắn liền ô Giảm trừ — auto fill khi áp credit từ excess_amounts.';

NOTIFY pgrst, 'reload schema';

COMMIT;
