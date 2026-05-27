-- =============================================
-- Migration: Fix generate_job_code() to bypass RLS + handle race condition
-- Created: 2026-05-27
-- Description:
--   Bug: trigger generate_job_code() chạy với SECURITY INVOKER, nên SELECT MAX(code)
--        bên trong bị RLS lọc theo user_id của caller. Staff user khi tạo job đầu tiên
--        sẽ tính ra code = JOB-YYYYMMDD-0001 đã tồn tại của owner -> UNIQUE conflict (23505).
--   Fix: chuyển sang SECURITY DEFINER + cố định search_path để bypass RLS khi đọc.
--        Thêm pg_advisory_xact_lock để serialize việc cấp số trong cùng 1 ngày,
--        tránh race khi 2 INSERT đồng thời cùng tính ra cùng số.
-- =============================================

CREATE OR REPLACE FUNCTION public.generate_job_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today TEXT := TO_CHAR(NOW(), 'YYYYMMDD');
  v_lock_key BIGINT;
  v_next INT;
BEGIN
  -- Khoá theo "ngày" để 2 INSERT đồng thời trong cùng ngày phải xếp hàng.
  -- hashtext trả về int4 → cast sang bigint cho pg_advisory_xact_lock.
  v_lock_key := hashtext('jobs_code:' || v_today)::BIGINT;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'JOB-\d{8}-(\d+)') AS INTEGER)), 0) + 1
    INTO v_next
    FROM public.jobs
   WHERE code LIKE 'JOB-' || v_today || '-%';

  NEW.code := 'JOB-' || v_today || '-' || LPAD(v_next::TEXT, 4, '0');
  RETURN NEW;
END;
$$;
