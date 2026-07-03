-- ============================================================
-- REVERT của scripts/v5_seed_trial_start_2026_07_03.sql
-- Gỡ seed khởi động thử: xoá phiên FULL seed + ngày-công seed 01/07 & 02/07,
-- rồi recompute streak để đưa SSS về đúng trạng thái tự nhiên (không có 2 ngày đó).
-- ============================================================

-- 1) Gỡ 17 phiên inspection seed (theo marker)
DELETE FROM public.inspection_sessions
WHERE session_date = DATE '2026-07-01'
  AND condition_note = 'OK — seed khởi động thử v5 (2026-07-03)';

-- 2) Gỡ ngày-công seed 01/07 & 02/07 (CHỈ dòng do seed sinh — evidence chứa note seed)
DELETE FROM public.salary_attendance_day
WHERE user_id IN ('d45a7506-5250-4d99-ac94-9f73cbd4df17','df8d1df5-1c24-4723-9733-4640c43c382b')
  AND work_date IN (DATE '2026-07-01', DATE '2026-07-02')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) e
              WHERE e->>'note' LIKE 'seed khởi động thử%');

-- 3) Recompute streak về trạng thái thật (không còn 2 ngày tick seed)
SELECT public.v5_recompute_streak('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, DATE '2026-07-01');
SELECT public.v5_recompute_streak('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, DATE '2026-07-01');
