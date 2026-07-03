-- =============================================================================
-- get_dashboard_summary(p_building_id): gộp ~15 truy vấn widget Dashboard
-- thành 1 RPC / 1 round-trip.
--
-- Dashboard hiện bắn ~40-50 request/lần mở (useDashboardStats 8 query +
-- useOccupancyChart 4 query TRÙNG số liệu + OperationsSummary kéo TOÀN BỘ
-- leads+deposits chỉ để đếm + useContractDashboardCounts 4 head-count).
-- RPC này trả đủ số liệu cho cả 3 nhóm widget trong 1 jsonb.
--
-- SECURITY INVOKER (điểm mấu chốt): mọi SELECT bên trong chạy DƯỚI RLS của
-- chính user gọi — tập dòng nhìn thấy Y HỆT các query client hiện tại, không
-- phải mô phỏng lại logic phân quyền (không drift). RLS các bảng nóng đã
-- set-based (20260702150000/20260703161000) nên từng câu bên trong đều rẻ.
--
-- Ngữ nghĩa từng con số SAO CHÉP 1:1 từ hook cũ (useDashboard.ts /
-- OperationsSummary.tsx / useContractDashboardCounts):
--   • Mốc tháng = đầu tháng theo giờ VN (JS startOfMonth cục bộ máy user VN).
--   • p_building_id NULL → scope = mọi tòa visible (deleted_at IS NULL);
--     ngược lại đúng 1 tòa (không kiểm visible — giống getBuildingIds cũ).
--   • v_bids rỗng → total/reserved/debt… = 0 nhưng occupied/revenue theo
--     nhánh "không filter" — giữ nguyên hành vi cũ từng nhánh.
--   • new_contracts_this_month: KHÔNG lọc deleted_at/tòa (như cũ).
--   • leads/deposits: đếm toàn bộ visible, không lọc tòa (như cũ).
-- Verify: scratchpad dashboard-summary-verify.mjs — chạy RPC vs từng query
-- cũ (impersonate role authenticated) 6 user × {NULL, 1 tòa} phải khớp 100%.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_summary(p_building_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
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
    v_pay_from date := (v_month_start AT TIME ZONE 'UTC')::date;
    v_pay_to   date := ((v_next_month - interval '1 millisecond') AT TIME ZONE 'UTC')::date;
  BEGIN
    IF v_scoped THEN
      SELECT COALESCE(sum(p.amount), 0) INTO r_revenue
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id AND i.building_id = p_building_id
      WHERE p.payment_date >= v_pay_from AND p.payment_date <= v_pay_to;
    ELSE
      SELECT COALESCE(sum(p.amount), 0) INTO r_revenue
      FROM payments p
      WHERE p.payment_date >= v_pay_from AND p.payment_date <= v_pay_to;
    END IF;
  END;

  -- công nợ: lọc tòa khi v_bids không rỗng (như cũ)
  SELECT COALESCE(sum(COALESCE(total_amount,0) - COALESCE(paid_amount,0)), 0) INTO r_debt
  FROM invoices
  WHERE status IN ('APPROVED','PARTIAL_PAID') AND deleted_at IS NULL
    AND (cardinality(v_bids) = 0 OR building_id = ANY(v_bids));

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
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(uuid) TO authenticated;
