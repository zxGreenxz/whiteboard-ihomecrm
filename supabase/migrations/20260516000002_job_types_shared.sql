-- =============================================
-- Migration: Job types dùng chung toàn user
-- Created: 2026-05-16
-- Description: Bỏ scope theo user_id cho job_types. Mọi user
--   authenticated đều SELECT/INSERT/UPDATE/DELETE được, để loại
--   công việc do bất kỳ ai tạo cũng dùng được trong form Thêm công việc.
--   Vẫn lưu user_id để biết người tạo, không dùng để filter.
-- =============================================

DROP POLICY IF EXISTS "Users can manage own job types" ON public.job_types;

CREATE POLICY "Authenticated users can manage job types"
  ON public.job_types
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
