-- =============================================
-- Migration: Đơn giản hoá vòng đời công việc
-- Created: 2026-05-16
-- Description: Bỏ flow nghiệm thu. Chỉ còn 2 trạng thái:
--   IN_PROGRESS (đang làm) và COMPLETED (hoàn thành).
--   - Tạo phiếu → IN_PROGRESS ngay (default mới).
--   - Bấm "Hoàn thành" → COMPLETED, completion_time = now().
--   - Không còn NOT_STARTED / PENDING_ACCEPTANCE / ACCEPTED / FAILED / OVERDUE.
-- =============================================

-- 1. Drop CHECK constraint cũ
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_status_check;

-- 2. Migrate dữ liệu sang 2 trạng thái mới
--    - NOT_STARTED → IN_PROGRESS (tạo phiếu vào thẳng đang làm)
--    - PENDING_ACCEPTANCE / ACCEPTED / FAILED / OVERDUE → COMPLETED
UPDATE public.jobs
SET status = 'IN_PROGRESS'
WHERE status = 'NOT_STARTED';

UPDATE public.jobs
SET status = 'COMPLETED'
WHERE status IN ('PENDING_ACCEPTANCE', 'ACCEPTED', 'FAILED', 'OVERDUE');

-- 3. Thêm CHECK constraint mới chỉ cho phép 2 giá trị
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('IN_PROGRESS', 'COMPLETED'));

-- 4. Đổi default sang IN_PROGRESS
ALTER TABLE public.jobs
  ALTER COLUMN status SET DEFAULT 'IN_PROGRESS';

-- 5. Cập nhật comment cột
COMMENT ON COLUMN public.jobs.status IS 'Job status: IN_PROGRESS (đang làm), COMPLETED (hoàn thành)';
