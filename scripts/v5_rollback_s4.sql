-- ============================================================
-- V5 ROLLBACK S4 — hoàn nguyên migration 20260703000005_v5_money_lock.sql
-- (FE revert bằng git revert commit feat(salary-v5): S4+S5)
-- ============================================================
DROP FUNCTION IF EXISTS public.v5_shadow_report(DATE);
DROP FUNCTION IF EXISTS public.v5_apply_lock_adjustments(DATE);
DROP FUNCTION IF EXISTS public.v5_lock_assert(DATE);
DROP FUNCTION IF EXISTS public.v5_verdict(UUID, DATE, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.v5_appeal(DATE, TEXT);
DROP FUNCTION IF EXISTS public.v5_flag_day(UUID, DATE, TEXT);
DROP FUNCTION IF EXISTS public.get_salary_progress_v5(DATE);
DROP FUNCTION IF EXISTS public.v5_month_money(UUID, DATE);
-- Gỡ các dòng tiền v5 đã ghi (nếu có) — CHỈ dòng nguồn v5
DELETE FROM public.salary_adjustments WHERE source IN ('ATTEND_V5','STREAK_V5');
DELETE FROM public.notifications WHERE metadata->>'v5' IN ('flagged','appeal','verdict');
