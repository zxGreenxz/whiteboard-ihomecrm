-- ============================================================
-- V5 ROLLBACK S2 — hoàn nguyên engine (20260703000002) + jobs (20260703000003)
-- Chạy SAU KHI đã rollback code bằng git (revert commit feat(salary-v5): S2).
-- Phần ngoài DB: gỡ edge fn `salary-v5-jobs` trên dashboard (hoặc supabase functions delete),
-- git revert tự trả lại worker/index.js + vercel.json + api/salary-v5-cron.js.
-- ============================================================

DROP FUNCTION IF EXISTS public.v5_run_job(TEXT);
DROP FUNCTION IF EXISTS public.v5_close_period(DATE);
DROP FUNCTION IF EXISTS public.v5_run_digest();
DROP FUNCTION IF EXISTS public.v5_run_score();
DROP FUNCTION IF EXISTS public.v5_daily_missions(UUID);
DROP FUNCTION IF EXISTS public.v5_run_tier();
DROP FUNCTION IF EXISTS public.v5_cron_finish(TEXT, TEXT, INT, TEXT);
DROP FUNCTION IF EXISTS public.v5_cron_start(TEXT, TEXT);

DROP FUNCTION IF EXISTS public.v5_expire_stale(DATE);
DROP FUNCTION IF EXISTS public.record_payment_gps(UUID, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS public.v5_tick_from_job(UUID);
DROP FUNCTION IF EXISTS public.complete_inspection(UUID, TEXT);
DROP FUNCTION IF EXISTS public.submit_inspection_photo(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.start_quick_check(UUID, UUID);
DROP FUNCTION IF EXISTS public.start_inspection(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.public_v5_effective_milestones(JSONB, JSONB, INT);
DROP FUNCTION IF EXISTS public.v5_recompute_streak(UUID, DATE);
DROP FUNCTION IF EXISTS public.v5_tick_attendance(UUID, DATE, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.v5_checklist_for_building(UUID, DATE, TEXT);
DROP FUNCTION IF EXISTS public.v5_building_reqs(UUID);
DROP FUNCTION IF EXISTS public.v5_distance_m(NUMERIC, NUMERIC, NUMERIC, NUMERIC);
-- 20260704150000 đổi signature sang float8 (buildings.lat/lng là double precision)
DROP FUNCTION IF EXISTS public.v5_distance_m(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);

DROP INDEX IF EXISTS public.uq_notif_v5_digest;
DROP INDEX IF EXISTS public.uq_notif_v5_pending_check;

ALTER TABLE public.salary_streak_state DROP COLUMN IF EXISTS reset_from_date;

-- Dọn dữ liệu job/notify v5 phát sinh (an toàn — chỉ dữ liệu v5)
DELETE FROM public.notifications WHERE metadata->>'v5' IN ('pending_check','digest');
DELETE FROM public.cron_runs WHERE job IN ('tier','score','digest','close_period','test');
