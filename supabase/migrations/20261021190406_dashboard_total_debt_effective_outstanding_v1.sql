-- "Công nợ tổng" của Bảng tin (22/10/2026): public.get_dashboard_summary.total_debt cộng thẳng (total − paid) của hoá
-- đơn APPROVED/PARTIAL_PAID ⇒ (1) bỏ sót mọi hoá đơn OVERDUE (N-A4-04, P1 kiểm thử 07/10 + 11/10: chỉ thấy ~39 % nợ),
-- (2) đếm hai lần nợ cũ đã kéo sang hoá đơn sau. Nay: một định nghĩa "còn nợ" với KPI phải thu (fa_snapshot_kpis) và
-- Hermes crm_read_receivables — APPROVED/PARTIAL_PAID/OVERDUE, còn nợ > 0, cộng nợ thực
-- (public.invoice_effective_outstanding_v1, 20261021183549). Đây là phần SQL của mục 1.5 plan
-- docs/superpowers/plans/2026-10-07-sua-loi-sau-kiem-thu-test.md; DebtChart/AlertsList/nhắc nợ (frontend) CHƯA đổi.
-- NGUỒN: định nghĩa SỐNG production (pg_get_functiondef 22/10, md5 prosrc ab00ff7341ceee35d31fdf31e7c8116c) — repo lệch (bản cuối
-- 20260703180000 không khớp), file này đưa repo về đúng bản đang chạy + một khối đổi (đánh dấu 20261021190406).
-- Chữ ký, kiểu trả về, INVOKER, STABLE, search_path, ACL giữ nguyên (CREATE OR REPLACE, không GRANT/REVOKE).
-- THỨ TỰ ÁP: 20261021183549_invoice_effective_outstanding_v1 TRƯỚC. Có thể bỏ riêng file này (không file nào phụ thuộc).
-- LÙI: áp lại định nghĩa production cũ (md5 ab00ff7341ceee35d31fdf31e7c8116c); không có dữ liệu phải khôi phục.

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.invoice_effective_outstanding_v1(uuid[])');
  IF NOT FOUND OR p.prosecdef OR p.provolatile <> 's' THEN
    RAISE EXCEPTION 'dashboard_total_debt_requires_shared_function';
  END IF;
  -- Chống đè bản khác: chỉ thay đúng định nghĩa production đã đo, hoặc chính bản này (chạy lại).
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.get_dashboard_summary(uuid)');
  IF NOT FOUND OR md5(p.prosrc) NOT IN ('ab00ff7341ceee35d31fdf31e7c8116c', 'e15d58ab3d3010a60fbd958598c9919e') THEN
    RAISE EXCEPTION 'dashboard_total_debt_live_body_changed: %', CASE WHEN FOUND THEN md5(p.prosrc) END;
  END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.get_dashboard_summary(p_building_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Mốc thời gian theo giờ VN (khớp JS chạy trên máy user VN)
  v_vn_now        timestamp   := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_month_start   timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_next_month    timestamptz := (date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '1 month') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_today         date;
  v_month_start_d date;
  v_in30          date;
  v_bids          uuid[];
  v_scoped        boolean;

  r_total_rooms   int := 0;
  r_occupied      int := 0;
  r_reserved      int := 0;
  r_revenue       numeric := 0;
  r_debt          numeric := 0;
  r_new_contracts int := 0;
  r_issues        int := 0;
  l_total int := 0; l_converted int := 0; l_new int := 0;
  d_total int := 0; d_moved int := 0; d_new int := 0;
  c_active int := 0; c_new int := 0; c_expiring int := 0; c_terminated int := 0;
BEGIN
  v_today         := v_vn_now::date;
  v_month_start_d := date_trunc('month', v_vn_now)::date;
  v_in30          := v_today + 30;
  v_scoped        := p_building_id IS NOT NULL;

  -- getBuildingIds(): buildingId cụ thể → [id]; không → mọi tòa visible chưa xoá
  IF v_scoped THEN
    v_bids := ARRAY[p_building_id];
  ELSE
    SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_bids
    FROM buildings WHERE deleted_at IS NULL;
  END IF;

  -- ===== useDashboardStats =====
  IF cardinality(v_bids) > 0 THEN
    SELECT count(*) INTO r_total_rooms
    FROM rooms WHERE building_id = ANY(v_bids) AND deleted_at IS NULL;

    SELECT count(*) INTO r_reserved
    FROM rooms WHERE building_id = ANY(v_bids) AND deleted_at IS NULL AND status = 'RESERVED';
  END IF;

  -- occupied: HĐ ACTIVE có phòng; lọc theo tòa CHỈ khi v_bids không rỗng (như cũ)
  SELECT count(*) INTO r_occupied
  FROM contracts c
  JOIN rooms r ON r.id = c.room_id
  WHERE c.status = 'ACTIVE' AND c.room_id IS NOT NULL
    AND (cardinality(v_bids) = 0 OR r.building_id = ANY(v_bids));

  -- revenue tháng: lọc tòa CHỈ khi chọn tòa cụ thể (như cũ — không chọn = mọi payment visible).
  -- QUIRK GIỮ NGUYÊN: payment_date là DATE; client cũ gửi ISO-UTC nên PostgREST
  -- cast '2026-06-30T17:00:00Z'::date = ngày CUỐI tháng trước (VN=UTC+7) →
  -- khoảng thật là [cuối-tháng-trước .. cuối-tháng-này]. Sao chép để khớp 100%;
  -- muốn sửa quirk thì đổi CẢ hai nơi sau (ngoài phạm vi refactor này).
  DECLARE
    v_pay_from date := v_month_start_d;
    v_pay_to   date := (v_month_start_d + interval '1 month - 1 day')::date;
  BEGIN
    IF v_scoped THEN
      SELECT COALESCE(sum(entry.pnl_amount), 0) INTO r_revenue
      FROM public.invoice_pnl_cash_entries entry
      WHERE entry.building_id = p_building_id
        AND entry.revenue_date >= v_pay_from
        AND entry.revenue_date <= v_pay_to;
    ELSE
      SELECT COALESCE(sum(entry.pnl_amount), 0) INTO r_revenue
      FROM public.invoice_pnl_cash_entries entry
      WHERE entry.revenue_date >= v_pay_from
        AND entry.revenue_date <= v_pay_to;
    END IF;
  END;

  -- công nợ (20261021190406): một định nghĩa "còn nợ" với KPI phải thu (fa_snapshot_kpis) và Hermes
  -- crm_read_receivables — hoá đơn APPROVED/PARTIAL_PAID/OVERDUE còn nợ > 0 (trước bỏ sót OVERDUE: N-A4-04), cộng NỢ
  -- THỰC (public.invoice_effective_outstanding_v1: không đếm hai lần nợ đã kéo sang hoá đơn gánh còn mở).
  -- Lọc tòa khi v_bids không rỗng (như cũ). INVOKER: RLS người gọi như mọi khối khác của hàm.
  SELECT COALESCE(sum(o.effective_outstanding), 0) INTO r_debt
  FROM public.invoice_effective_outstanding_v1(ARRAY(
    SELECT i.id FROM invoices i
    WHERE i.status IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND i.deleted_at IS NULL AND i.remaining_amount > 0
      AND (cardinality(v_bids) = 0 OR i.building_id = ANY(v_bids)))) o
  WHERE o.effective_outstanding > 0;

  -- HĐ mới trong tháng: như cũ — KHÔNG lọc deleted_at, KHÔNG lọc tòa
  SELECT count(*) INTO r_new_contracts
  FROM contracts
  WHERE created_at >= v_month_start AND created_at < v_next_month;

  -- công việc chưa xử lý: như cũ — không lọc gì thêm
  SELECT count(*) INTO r_issues
  FROM issues WHERE status NOT IN ('RESOLVED','CLOSED');

  -- ===== OperationsSummary: leads + deposits (toàn bộ visible, như useLeads/useDeposits) =====
  SELECT count(*),
         count(*) FILTER (WHERE status = 'CONVERTED'),
         count(*) FILTER (WHERE created_at >= v_month_start)
    INTO l_total, l_converted, l_new
  FROM leads;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'CONVERTED'),
         count(*) FILTER (WHERE created_at >= v_month_start)
    INTO d_total, d_moved, d_new
  FROM deposits;

  -- ===== useContractDashboardCounts (deleted_at IS NULL; scope qua PHÒNG khi chọn tòa) =====
  IF v_scoped THEN
    SELECT
      count(*) FILTER (WHERE c.status = 'ACTIVE'),
      count(*) FILTER (WHERE c.start_date >= v_month_start_d),
      count(*) FILTER (WHERE c.status = 'ACTIVE' AND c.end_date >= v_today AND c.end_date <= v_in30),
      count(*) FILTER (WHERE c.status = 'TERMINATED' AND c.end_date >= v_month_start_d)
      INTO c_active, c_new, c_expiring, c_terminated
    FROM contracts c
    JOIN rooms r ON r.id = c.room_id AND r.building_id = p_building_id
    WHERE c.deleted_at IS NULL;
  ELSE
    SELECT
      count(*) FILTER (WHERE c.status = 'ACTIVE'),
      count(*) FILTER (WHERE c.start_date >= v_month_start_d),
      count(*) FILTER (WHERE c.status = 'ACTIVE' AND c.end_date >= v_today AND c.end_date <= v_in30),
      count(*) FILTER (WHERE c.status = 'TERMINATED' AND c.end_date >= v_month_start_d)
      INTO c_active, c_new, c_expiring, c_terminated
    FROM contracts c
    WHERE c.deleted_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'total_rooms', r_total_rooms,
    'occupied_rooms', r_occupied,
    'reserved_rooms', r_reserved,
    'revenue_this_month', r_revenue,
    'total_debt', r_debt,
    'new_contracts_this_month', r_new_contracts,
    'unresolved_issues', r_issues,
    'leads_total', l_total,
    'leads_converted', l_converted,
    'leads_new_month', l_new,
    'deposits_total', d_total,
    'deposits_moved_in', d_moved,
    'deposits_new_month', d_new,
    'contracts_active', c_active,
    'contracts_new_month', c_new,
    'contracts_expiring_soon', c_expiring,
    'contracts_terminated_month', c_terminated
  );
END;
$function$;

DO $assert$
DECLARE p record; sig text := 'public.get_dashboard_summary(uuid)';
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure(sig);
  IF NOT FOUND OR p.prosecdef OR p.provolatile <> 's' OR md5(p.prosrc) <> 'e15d58ab3d3010a60fbd958598c9919e'
     OR replace(COALESCE(array_to_string(p.proconfig, ','), ''), '"', '') <> 'search_path=public'
     OR NOT has_function_privilege('authenticated', sig, 'EXECUTE') OR has_function_privilege('anon', sig, 'EXECUTE')
     OR (SELECT count(*) FROM pg_proc WHERE proname = 'get_dashboard_summary') <> 1 THEN
    RAISE EXCEPTION 'dashboard_total_debt_contract_violated';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
