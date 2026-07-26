-- =====================================================================
-- M8 (audit hiệu năng 2026-07-26): index còn thiếu cho luồng thu tiền v5
-- + chuỗi view legacy_payment_receipt_semantics / payment_receipt_events.
--
-- 1) income_expenses.reversal_of_income_expense_id: FK không index —
--    lateral LEGACY_REVERSAL trong payment_receipt_events (20260721102000)
--    join reversal_voucher.reversal_of_income_expense_id = source_voucher.id
--    → seq scan mỗi payment bị đảo. Partial vì đa số dòng NULL.
-- 2) excess_amounts.source_payment_id: nằm trên hot path lateral credit
--    của legacy_payment_receipt_semantics (chạy cho MỌI payment legacy).
-- 3) invoice_payment_collections(organization_id, collection_date): các
--    query báo cáo thu tiền v5 lọc theo org + khoảng ngày thu.
-- 4) income_expenses.payment_id: index cũ partial (WHERE deleted_at IS NULL)
--    KHÔNG phủ lateral LEGACY_REVERSAL (source_voucher.payment_id = legacy.id
--    — không có điều kiện deleted_at) → seq scan. Thay bằng partial
--    payment_id IS NOT NULL: phủ CẢ query có lẫn không có deleted_at.
-- =====================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_income_expenses_reversal_of
  ON public.income_expenses (reversal_of_income_expense_id)
  WHERE reversal_of_income_expense_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_excess_amounts_source_payment_id
  ON public.excess_amounts (source_payment_id)
  WHERE source_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoice_payment_collections_org_date_idx
  ON public.invoice_payment_collections (organization_id, collection_date);

CREATE INDEX IF NOT EXISTS idx_income_expenses_payment_id_all
  ON public.income_expenses (payment_id)
  WHERE payment_id IS NOT NULL;

-- Bản cũ (payment_id WHERE deleted_at IS NULL) bị bản mới phủ hoàn toàn
-- (payment_id = X suy ra payment_id IS NOT NULL; lọc deleted_at rẻ ở heap
-- vì payment_id đã rất chọn lọc) — bỏ để đỡ chi phí write trên bảng nóng.
DROP INDEX IF EXISTS public.idx_income_expenses_payment_id;

COMMIT;
