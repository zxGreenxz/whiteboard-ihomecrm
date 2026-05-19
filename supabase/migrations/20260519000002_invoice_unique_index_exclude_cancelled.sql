-- =============================================
-- Migration: nới lỏng unique index (contract_id, billing_month)
-- =============================================
-- Trước đây partial unique index chỉ exclude soft-deleted (deleted_at IS NULL).
-- Nếu HĐ bị "Huỷ" (status = CANCELLED) thay vì xoá thì index vẫn coi là
-- duplicate → không tạo lại HĐ mới cho cùng hợp đồng + kỳ thanh toán được.
-- Giờ loại trừ thêm status = CANCELLED để khi huỷ HĐ cũ vẫn tạo lại HĐ mới
-- cùng (contract_id, billing_month) bình thường.
-- =============================================

BEGIN;

DROP INDEX IF EXISTS idx_invoices_unique_contract_billing;

CREATE UNIQUE INDEX idx_invoices_unique_contract_billing
  ON invoices(contract_id, billing_month)
  WHERE deleted_at IS NULL AND status <> 'CANCELLED';

NOTIFY pgrst, 'reload schema';

COMMIT;
