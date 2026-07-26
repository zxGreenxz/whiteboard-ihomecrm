-- =====================================================================
-- M7 (audit hiệu năng 2026-07-26): RPC gộp doanh thu theo tháng cho
-- chart Dashboard. Trước đây useRevenueChart fetchAllRows TOÀN BỘ bút
-- toán P&L 12 tháng (tuần tự từng trang 1000 trên view security_invoker)
-- về client chỉ để cộng ra 12 con số.
--
-- SECURITY INVOKER trên view invoice_pnl_cash_entries (security_invoker)
-- → RLS income_expenses (set-based từ 20260702150000) áp dụng y hệt
-- đường cũ; cùng mẫu với get_dashboard_summary (20260703180000).
-- Range ngày do client truyền (giữ đúng cách client tính đầu/cuối tháng
-- theo múi giờ máy user — tránh lệch UTC nếu tính now() ở server).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.revenue_by_month(
  p_start date,
  p_end date,
  p_building_id uuid DEFAULT NULL
)
RETURNS TABLE (month_start date, revenue numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT
    date_trunc('month', entry.revenue_date)::date AS month_start,
    COALESCE(sum(entry.pnl_amount), 0) AS revenue
  FROM public.invoice_pnl_cash_entries entry
  WHERE entry.revenue_date >= p_start
    AND entry.revenue_date <= p_end
    AND (p_building_id IS NULL OR entry.building_id = p_building_id)
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.revenue_by_month(date, date, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revenue_by_month(date, date, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.revenue_by_month(date, date, uuid) IS
  'Doanh thu P&L gắn hoá đơn gộp theo tháng (chart Dashboard) — security invoker, RLS như đường fetch cũ.';

COMMIT;

NOTIFY pgrst, 'reload schema';
