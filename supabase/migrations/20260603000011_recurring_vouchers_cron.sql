-- =============================================
-- Migration: TỰ ĐỘNG sinh phiếu lặp lại hằng ngày qua pg_cron
-- Job chạy 01:00 giờ VN (= 18:00 UTC) gọi generate_recurring_vouchers(NULL)
-- → xử lý phiếu lặp của MỌI owner. Không gọi _v2 vì v2 cần auth.uid() (NULL
-- trong ngữ cảnh cron/superuser ⇒ trả rỗng).
-- pg_cron + pg_net đã available trên project; migration này bật pg_cron.
-- =============================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Wrapper cho job nền: SECURITY DEFINER (chạy quyền owner postgres, bỏ qua RLS).
-- generate_recurring_vouchers tự set user_id = parent.user_id nên không vi phạm
-- NOT NULL dù auth.uid() là NULL.
CREATE OR REPLACE FUNCTION public.run_recurring_vouchers_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.generate_recurring_vouchers(NULL);
  RAISE NOTICE 'run_recurring_vouchers_job: generated % child voucher(s)', v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.run_recurring_vouchers_job() FROM PUBLIC;

-- Đăng ký job idempotent: gỡ job cũ (nếu có) rồi tạo lại để migration re-runnable.
DO $$
BEGIN
  PERFORM cron.unschedule('recurring_vouchers_daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'recurring_vouchers_daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- 01:00 Asia/Ho_Chi_Minh = 18:00 UTC (pg_cron dùng UTC).
SELECT cron.schedule(
  'recurring_vouchers_daily',
  '0 18 * * *',
  $$ SELECT public.run_recurring_vouchers_job(); $$
);

COMMENT ON FUNCTION public.run_recurring_vouchers_job() IS
  'Job pg_cron hằng ngày (01:00 VN): sinh phiếu lặp lại cho mọi owner qua generate_recurring_vouchers(NULL).';
