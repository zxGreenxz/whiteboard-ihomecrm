-- =============================================
-- Migration: backfill quyền invoices.record_payment cho role hiện có
-- Created: 2026-05-25
-- Description:
--   Trước đây quyền "Ghi nhận thanh toán" ngầm hiểu chung với invoices.create
--   (UI gộp Tạo/Sửa/Xoá vào nhóm "Quản lý"). Sau khi tách thành 5 quyền chi
--   tiết (Xem/Tạo/Sửa/Xoá/Thanh Toán), các role hiện có chưa được set
--   record_payment → nhân viên đang dùng tốt bị mất nút "Thu tiền".
--   Migration này backfill: với mọi role có invoices.create = true, bổ sung
--   record_payment = true. Role chưa có invoices ở permissions thì để nguyên.
-- =============================================

BEGIN;

UPDATE roles
SET permissions = jsonb_set(
  permissions,
  '{invoices,record_payment}',
  'true'::jsonb,
  true
)
WHERE COALESCE((permissions -> 'invoices' ->> 'create')::boolean, false) = true
  AND COALESCE((permissions -> 'invoices' ->> 'record_payment')::boolean, false) = false;

NOTIFY pgrst, 'reload schema';
COMMIT;
