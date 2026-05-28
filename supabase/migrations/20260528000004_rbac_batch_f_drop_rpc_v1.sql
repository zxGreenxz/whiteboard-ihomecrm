-- =============================================
-- Batch F (tiếp): Drop RPC v1 không còn dùng
-- =============================================
-- Frontend đã chuyển hết sang v2 (xác minh qua grep: 0 ref).
-- DB functions không gọi v1.
--
-- KHÔNG drop current_visible_owner_ids() vì còn dùng trong policies trên các
-- bảng chưa có RBAC: accounts, notifications, roles, settings, invoice_audit_log.
-- =============================================

DROP FUNCTION IF EXISTS public.get_invoice_statistics(uuid, uuid, uuid, public.invoice_status, date, date, text, text, uuid, uuid);

-- record_invoice_payment v1: KHÔNG drop vì v2 không có (v2 dùng quyền RBAC nhưng
-- không có wrapper riêng - v2 chính là implementation độc lập). Để v1 tồn tại
-- cho legacy script/edge function nếu có.
-- Decision: vẫn drop để đơn giản schema. Frontend đã switch.
DROP FUNCTION IF EXISTS public.record_invoice_payment(uuid, uuid, numeric, public.payment_method, date, text, text);

-- generate_recurring_vouchers v1: vẫn được v2 call internally → KEEP.
-- generate_invoices_for_building v1: vẫn được v2 call internally → KEEP.
-- get_meters_without_readings v1: vẫn được v2 call internally → KEEP.
