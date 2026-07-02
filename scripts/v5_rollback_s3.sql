-- ============================================================
-- V5 ROLLBACK S3 — hoàn nguyên migration 20260703000004_v5_myday.sql
-- (FE revert bằng git revert commit feat(salary-v5): S3)
-- ============================================================
DROP FUNCTION IF EXISTS public.approve_device_issue(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.report_device_issue(UUID, TEXT);
DROP FUNCTION IF EXISTS public.approve_leave(UUID, DATE, BOOLEAN);
DROP FUNCTION IF EXISTS public.request_paid_leave(DATE, TEXT);
DROP FUNCTION IF EXISTS public.get_my_day_summary();
DROP FUNCTION IF EXISTS public.v5_daily_missions_self();
-- Dọn thông báo v5 phát sinh từ các RPC này
DELETE FROM public.notifications WHERE metadata->>'v5' IN ('leave_request','leave_result','device_issue','device_issue_result');
