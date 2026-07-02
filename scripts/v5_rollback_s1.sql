-- ============================================================
-- V5 ROLLBACK S1 — hoàn nguyên TOÀN BỘ migration 20260703000001_v5_foundation.sql
-- Chạy thủ công qua Management API (Node UTF-8) khi cần revert.
-- Code FE revert bằng git: git revert các commit feat(salary-v5) hoặc reset về tag pre-v5-salary.
-- AN TOÀN: chỉ đụng object v5; không đụng dữ liệu/hàm hệ hiện tại.
-- ============================================================

DROP FUNCTION IF EXISTS public.set_salary_v5_config(JSONB);
DROP FUNCTION IF EXISTS public.get_salary_v5_config();
DROP FUNCTION IF EXISTS public.v5_n_chuan(DATE, UUID);
DROP FUNCTION IF EXISTS public.vn_workdays(DATE);

DROP VIEW IF EXISTS public.building_coverage;

DROP TABLE IF EXISTS public.inspection_photos;
DROP TABLE IF EXISTS public.inspection_sessions;
DROP TABLE IF EXISTS public.salary_attendance_day;
DROP TABLE IF EXISTS public.salary_streak_state;
DROP TABLE IF EXISTS public.cron_runs;
DROP TABLE IF EXISTS public.salary_award_errors;

ALTER TABLE public.income_expenses
  DROP COLUMN IF EXISTS collect_lat,
  DROP COLUMN IF EXISTS collect_lng,
  DROP COLUMN IF EXISTS collect_distance_m,
  DROP COLUMN IF EXISTS collect_geofence_status;

ALTER TABLE public.buildings DROP COLUMN IF EXISTS cluster_id;

-- Trả CHECK salary_adjustments.source về nguyên trạng (MANUAL/ADVANCE_IE/ROOM_RENT/KPI)
ALTER TABLE public.salary_adjustments DROP CONSTRAINT IF EXISTS salary_adjustments_source_check;
ALTER TABLE public.salary_adjustments ADD CONSTRAINT salary_adjustments_source_check
  CHECK (source IN ('MANUAL','ADVANCE_IE','ROOM_RENT','KPI'));

-- Gỡ khối settings v5 khỏi rules (giữ nguyên key cũ)
UPDATE public.salary_bonus_rules
SET rules = rules - 'attendance_v5' - 'streak_v5' - 'coverage_v5' - 'system_v5';
