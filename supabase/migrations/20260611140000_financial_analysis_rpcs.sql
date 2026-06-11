-- =====================================================================
-- Báo cáo Phân tích tài chính (/report/finance/analysis) — 6 RPC chỉ-đọc
-- prefix fa_.
--
-- Quy tắc P&L chuẩn (đồng bộ monthly_building_profit / ProfitDistributionReport):
--   doanh thu = SUM(income_expenses.total_amount) WHERE type='INCOME'
--   chi phí   = ... type='EXPENSE'
--   điều kiện = approval_status='APPROVED' AND deleted_at IS NULL
--               AND counts_in_business_result = true
--   (cọc / chia LN cổ đông / hoàn cọc tự loại nhờ counts_in_business_result)
--
-- Authz: SECURITY DEFINER + CTE `allowed` lọc public.can_access_building(b.id)
-- (pattern get_invoice_statistics_v2 — nhưng đánh giá 1 lần/toà thay vì 1
-- lần/dòng). KHÔNG lọc user_id (phiếu staff tạo vẫn tính — đồng bộ stats FE).
-- p_building_ids NULL = mọi toà caller thấy được. Toà ảo "Chung" CÓ trong
-- fa_monthly_pnl/fa_type_breakdown (FE tự ẩn/hiện), KHÔNG trong các RPC
-- phòng/HĐ/hoá đơn (toà ảo không có phòng).
-- =====================================================================

BEGIN;

-- ── 1. fa_monthly_pnl: P&L KQKD theo tháng × toà ─────────────────────
CREATE OR REPLACE FUNCTION public.fa_monthly_pnl(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month         date,
  building_id   uuid,
  building_name text,
  is_virtual    boolean,
  revenue       numeric,
  expense       numeric,
  net           numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name, b.is_virtual
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  )
  SELECT
    date_trunc('month', ie.voucher_date)::date,
    a.id,
    a.name,
    a.is_virtual,
    COALESCE(SUM(ie.total_amount) FILTER (WHERE ie.type = 'INCOME'),  0)::numeric,
    COALESCE(SUM(ie.total_amount) FILTER (WHERE ie.type = 'EXPENSE'), 0)::numeric,
    (COALESCE(SUM(ie.total_amount) FILTER (WHERE ie.type = 'INCOME'),  0)
   - COALESCE(SUM(ie.total_amount) FILTER (WHERE ie.type = 'EXPENSE'), 0))::numeric
  FROM allowed a
  JOIN public.income_expenses ie ON ie.building_id = a.id
  WHERE ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND ie.counts_in_business_result = true
    AND ie.voucher_date >= p_start_date
    AND ie.voucher_date <= p_end_date
  GROUP BY 1, a.id, a.name, a.is_virtual
  ORDER BY 1, a.name;
$$;
REVOKE ALL ON FUNCTION public.fa_monthly_pnl(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_monthly_pnl(date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_monthly_pnl(date, date, uuid[]) IS
'P&L KQKD theo tháng × toà (gồm toà ảo, cờ is_virtual để FE ẩn/hiện). Chỉ trả tháng/toà CÓ dữ liệu — FE tự scaffold tháng trống.';

-- ── 2. fa_type_breakdown: cơ cấu thu/chi theo THÁNG × hạng mục ───────
-- amount từ income_expense_items, CHỈ của phiếu cha APPROVED + KQKD.
-- side = ie.type (item không có type riêng — đồng bộ useIncomeExpenseStats).
-- Loại hạng mục is_deposit phòng hờ (phiếu cọc vốn đã KQKD=false). Phiếu
-- KHÔNG có item gộp vào dòng type_id NULL "Không có hạng mục" để
-- Σ breakdown == Σ fa_monthly_pnl cùng kỳ.
CREATE OR REPLACE FUNCTION public.fa_type_breakdown(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month         date,
  side          text,
  type_id       uuid,
  type_name     text,
  category      text,
  total_amount  numeric,
  voucher_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  base AS (
    SELECT ie.id, ie.type, ie.total_amount,
           date_trunc('month', ie.voucher_date)::date AS m
    FROM public.income_expenses ie
    JOIN allowed a ON a.id = ie.building_id
    WHERE ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND ie.counts_in_business_result = true
      AND ie.voucher_date >= p_start_date
      AND ie.voucher_date <= p_end_date
  )
  SELECT b.m, b.type::text, t.id, t.name, t.category,
         SUM(it.amount)::numeric, COUNT(DISTINCT b.id)
  FROM base b
  JOIN public.income_expense_items it ON it.income_expense_id = b.id
  JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
  WHERE t.is_deposit = false
  GROUP BY b.m, b.type, t.id, t.name, t.category
  UNION ALL
  SELECT b.m, b.type::text, NULL::uuid, 'Không có hạng mục'::text, NULL::text,
         SUM(b.total_amount)::numeric, COUNT(*)
  FROM base b
  WHERE NOT EXISTS (
    SELECT 1 FROM public.income_expense_items x WHERE x.income_expense_id = b.id
  )
  GROUP BY b.m, b.type
  ORDER BY 1, 2, 6 DESC;
$$;
REVOKE ALL ON FUNCTION public.fa_type_breakdown(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_type_breakdown(date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_type_breakdown(date, date, uuid[]) IS
'Cơ cấu thu/chi KQKD theo tháng × income_expense_type (+category). Σ total_amount == Σ fa_monthly_pnl cùng kỳ (Σ item.amount == voucher.total_amount; dòng type_id NULL hứng phiếu thiếu item).';

-- ── 3. fa_occupancy_monthly: tỷ lệ lấp đầy theo tháng × toà ──────────
-- occupied = phòng có ≥1 HĐ non-DRAFT, chưa xoá, có [start_date,
-- COALESCE(actual_end_date, end_date)] GIAO tháng — HĐ TERMINATED/EXPIRED/
-- TRANSFERRED vẫn tính cho tháng quá khứ chúng còn hiệu lực (HĐ gia hạn
-- giữ ACTIVE nên không double-count nhờ COUNT DISTINCT room).
-- total_rooms = số phòng HIỆN TẠI (deleted_at IS NULL) — xấp xỉ chấp nhận
-- được cho tháng quá khứ (phòng hiếm khi thêm/bớt).
-- Scaffold tháng sinh SẴN server-side (generate_series × allowed).
CREATE OR REPLACE FUNCTION public.fa_occupancy_monthly(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month          date,
  building_id    uuid,
  building_name  text,
  total_rooms    integer,
  occupied_rooms integer,
  occupancy_pct  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  months AS (
    SELECT gs::date AS m
    FROM generate_series(
      date_trunc('month', p_start_date),
      date_trunc('month', p_end_date),
      interval '1 month'
    ) gs
  ),
  room_totals AS (
    SELECT r.building_id AS bid, COUNT(*)::int AS total
    FROM public.rooms r
    JOIN allowed a ON a.id = r.building_id
    WHERE r.deleted_at IS NULL
    GROUP BY r.building_id
  ),
  occ AS (
    SELECT mo.m, r.building_id AS bid, COUNT(DISTINCT r.id)::int AS occupied
    FROM months mo
    JOIN public.rooms r ON r.deleted_at IS NULL
    JOIN allowed a ON a.id = r.building_id
    WHERE EXISTS (
      SELECT 1
      FROM public.contracts c
      WHERE c.room_id = r.id
        AND c.deleted_at IS NULL
        AND c.status <> 'DRAFT'
        AND c.start_date <= (mo.m + interval '1 month - 1 day')::date
        AND COALESCE(c.actual_end_date, c.end_date) >= mo.m
    )
    GROUP BY mo.m, r.building_id
  )
  SELECT
    mo.m,
    a.id,
    a.name,
    COALESCE(rt.total, 0),
    COALESCE(o.occupied, 0),
    CASE WHEN COALESCE(rt.total, 0) = 0 THEN 0
         ELSE ROUND(COALESCE(o.occupied, 0) * 100.0 / rt.total, 1)
    END::numeric
  FROM months mo
  CROSS JOIN allowed a
  LEFT JOIN room_totals rt ON rt.bid = a.id
  LEFT JOIN occ o ON o.m = mo.m AND o.bid = a.id
  ORDER BY mo.m, a.name;
$$;
REVOKE ALL ON FUNCTION public.fa_occupancy_monthly(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_occupancy_monthly(date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_occupancy_monthly(date, date, uuid[]) IS
'Lấp đầy theo tháng × toà (loại toà ảo). occupied = HĐ non-DRAFT giao tháng theo [start_date, COALESCE(actual_end_date,end_date)]. total_rooms = phòng hiện tại (xấp xỉ cho quá khứ). Đủ mọi tháng trong khoảng (scaffold server-side).';

-- ── 4. fa_lease_events: HĐ ký mới / gia hạn / thanh lý theo tháng × toà
-- new   = contracts.signed_date (non-DRAFT)
-- renew = contract_extensions APPROVED|COMPLETED theo extension_date
-- term  = contract_terminations COMPLETED theo termination_date
--         (HĐ hết hạn tự nhiên không có bản ghi termination → không tính)
-- So sánh ngày dạng >= start AND < end+1 — an toàn cả DATE lẫn timestamp.
CREATE OR REPLACE FUNCTION public.fa_lease_events(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month         date,
  building_id   uuid,
  building_name text,
  new_contracts bigint,
  renewals      bigint,
  terminations  bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  ev AS (
    SELECT date_trunc('month', c.signed_date)::date AS m, r.building_id AS bid, 'NEW' AS kind
    FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id
    JOIN allowed a ON a.id = r.building_id
    WHERE c.deleted_at IS NULL
      AND c.status <> 'DRAFT'
      AND c.signed_date >= p_start_date
      AND c.signed_date < p_end_date + 1
    UNION ALL
    SELECT date_trunc('month', ce.extension_date)::date, r.building_id, 'RENEW'
    FROM public.contract_extensions ce
    JOIN public.contracts c ON c.id = ce.contract_id AND c.deleted_at IS NULL
    JOIN public.rooms r ON r.id = c.room_id
    JOIN allowed a ON a.id = r.building_id
    WHERE ce.status IN ('APPROVED', 'COMPLETED')
      AND ce.extension_date >= p_start_date
      AND ce.extension_date < p_end_date + 1
    UNION ALL
    SELECT date_trunc('month', ct.termination_date)::date, r.building_id, 'TERM'
    FROM public.contract_terminations ct
    JOIN public.contracts c ON c.id = ct.contract_id AND c.deleted_at IS NULL
    JOIN public.rooms r ON r.id = c.room_id
    JOIN allowed a ON a.id = r.building_id
    WHERE ct.status = 'COMPLETED'
      AND ct.termination_date >= p_start_date
      AND ct.termination_date < p_end_date + 1
  )
  SELECT ev.m, a.id, a.name,
         COUNT(*) FILTER (WHERE ev.kind = 'NEW'),
         COUNT(*) FILTER (WHERE ev.kind = 'RENEW'),
         COUNT(*) FILTER (WHERE ev.kind = 'TERM')
  FROM ev
  JOIN allowed a ON a.id = ev.bid
  GROUP BY ev.m, a.id, a.name
  ORDER BY ev.m, a.name;
$$;
REVOKE ALL ON FUNCTION public.fa_lease_events(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_lease_events(date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_lease_events(date, date, uuid[]) IS
'Sự kiện HĐ theo tháng × toà: ký mới (signed_date, non-DRAFT), gia hạn (contract_extensions APPROVED/COMPLETED), thanh lý (contract_terminations COMPLETED). Chỉ trả tháng có sự kiện — FE scaffold.';

-- ── 5. fa_invoice_collection: thu hồi hoá đơn theo billing_month × toà
-- billing_month TEXT 'YYYY-MM' — so sánh từ điển an toàn. Loại CANCELLED.
-- remaining dùng GREATEST(...,0) (âm = tiền thừa — đồng bộ get_invoice_statistics_v2).
CREATE OR REPLACE FUNCTION public.fa_invoice_collection(
  p_start_month  text,
  p_end_month    text,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  billing_month  text,
  building_id    uuid,
  building_name  text,
  billed         numeric,
  collected      numeric,
  remaining      numeric,
  invoice_count  bigint,
  draft_count    bigint,
  pending_count  bigint,
  approved_count bigint,
  paid_count     bigint,
  partial_count  bigint,
  overdue_count  bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  )
  SELECT
    i.billing_month,
    a.id,
    a.name,
    COALESCE(SUM(i.total_amount), 0)::numeric,
    COALESCE(SUM(i.paid_amount), 0)::numeric,
    COALESCE(SUM(GREATEST(i.remaining_amount, 0)), 0)::numeric,
    COUNT(*),
    COUNT(*) FILTER (WHERE i.status = 'DRAFT'),
    COUNT(*) FILTER (WHERE i.status = 'PENDING_APPROVAL'),
    COUNT(*) FILTER (WHERE i.status = 'APPROVED'),
    COUNT(*) FILTER (WHERE i.status = 'PAID'),
    COUNT(*) FILTER (WHERE i.status = 'PARTIAL_PAID'),
    COUNT(*) FILTER (WHERE i.status = 'OVERDUE')
  FROM public.invoices i
  JOIN allowed a ON a.id = i.building_id
  WHERE i.deleted_at IS NULL
    AND i.status <> 'CANCELLED'
    AND i.billing_month >= p_start_month
    AND i.billing_month <= p_end_month
  GROUP BY i.billing_month, a.id, a.name
  ORDER BY i.billing_month, a.name;
$$;
REVOKE ALL ON FUNCTION public.fa_invoice_collection(text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_invoice_collection(text, text, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_invoice_collection(text, text, uuid[]) IS
'Thu hồi hoá đơn theo billing_month (''YYYY-MM'') × toà: tổng phát hành / đã thu / còn lại + đếm theo status (loại CANCELLED). FE scaffold tháng trống.';

-- ── 6. fa_snapshot_kpis: KPI thời điểm hiện tại × toà ────────────────
-- deposit_held = SUM(deposit_paid) HĐ ACTIVE (trigger recompute từ phiếu
-- thu cọc is_deposit APPROVED — nguồn sự thật cọc; KHÔNG dùng bảng deposits).
-- receivable = SUM(remaining>0) hoá đơn APPROVED/PARTIAL_PAID/OVERDUE; aging
-- theo CURRENT_DATE - due_date (độc lập status OVERDUE vốn chỉ được set
-- client-side); aging_not_due (chưa tới hạn, gồm due_date NULL) để Σ bucket
-- khớp receivable_total.
CREATE OR REPLACE FUNCTION public.fa_snapshot_kpis(
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  building_id        uuid,
  building_name      text,
  total_rooms        integer,
  rooms_available    integer,
  rooms_occupied     integer,
  rooms_reserved     integer,
  rooms_maintenance  integer,
  rooms_unavailable  integer,
  vacancy_loss_month numeric,
  active_contracts   bigint,
  avg_rent           numeric,
  deposit_held       numeric,
  receivable_total   numeric,
  aging_not_due      numeric,
  aging_1_30         numeric,
  aging_31_60        numeric,
  aging_61_90        numeric,
  aging_over_90      numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  room_stats AS (
    SELECT r.building_id AS bid,
           COUNT(*)::int                                          AS total_r,
           COUNT(*) FILTER (WHERE r.status = 'AVAILABLE')::int    AS avail,
           COUNT(*) FILTER (WHERE r.status = 'OCCUPIED')::int     AS occ,
           COUNT(*) FILTER (WHERE r.status = 'RESERVED')::int     AS resv,
           COUNT(*) FILTER (WHERE r.status = 'MAINTENANCE')::int  AS maint,
           COUNT(*) FILTER (WHERE r.status = 'UNAVAILABLE')::int  AS unavail,
           COALESCE(SUM(r.rent_price) FILTER (WHERE r.status = 'AVAILABLE'), 0)::numeric AS vacancy_loss
    FROM public.rooms r
    JOIN allowed a ON a.id = r.building_id
    WHERE r.deleted_at IS NULL
    GROUP BY r.building_id
  ),
  contract_stats AS (
    SELECT r.building_id AS bid,
           COUNT(*)                                  AS actives,
           AVG(c.rent_price)::numeric                AS avg_rent_b,
           COALESCE(SUM(c.deposit_paid), 0)::numeric AS dep_held
    FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id
    JOIN allowed a ON a.id = r.building_id
    WHERE c.deleted_at IS NULL
      AND c.status = 'ACTIVE'
    GROUP BY r.building_id
  ),
  receivables AS (
    SELECT i.building_id AS bid,
           COALESCE(SUM(i.remaining_amount), 0)::numeric AS total_recv,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE i.due_date IS NULL OR i.due_date >= CURRENT_DATE), 0)::numeric AS not_due,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE CURRENT_DATE - i.due_date BETWEEN 1  AND 30), 0)::numeric AS d1_30,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE CURRENT_DATE - i.due_date BETWEEN 31 AND 60), 0)::numeric AS d31_60,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE CURRENT_DATE - i.due_date BETWEEN 61 AND 90), 0)::numeric AS d61_90,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE CURRENT_DATE - i.due_date > 90), 0)::numeric AS d90p
    FROM public.invoices i
    JOIN allowed a ON a.id = i.building_id
    WHERE i.deleted_at IS NULL
      AND i.status IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE')
      AND i.remaining_amount > 0
    GROUP BY i.building_id
  )
  SELECT
    a.id, a.name,
    COALESCE(rs.total_r, 0), COALESCE(rs.avail, 0), COALESCE(rs.occ, 0),
    COALESCE(rs.resv, 0), COALESCE(rs.maint, 0), COALESCE(rs.unavail, 0),
    COALESCE(rs.vacancy_loss, 0),
    COALESCE(cs.actives, 0),
    COALESCE(cs.avg_rent_b, 0),
    COALESCE(cs.dep_held, 0),
    COALESCE(rc.total_recv, 0),
    COALESCE(rc.not_due, 0), COALESCE(rc.d1_30, 0), COALESCE(rc.d31_60, 0),
    COALESCE(rc.d61_90, 0), COALESCE(rc.d90p, 0)
  FROM allowed a
  LEFT JOIN room_stats     rs ON rs.bid = a.id
  LEFT JOIN contract_stats cs ON cs.bid = a.id
  LEFT JOIN receivables    rc ON rc.bid = a.id
  ORDER BY a.name;
$$;
REVOKE ALL ON FUNCTION public.fa_snapshot_kpis(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_snapshot_kpis(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_snapshot_kpis(uuid[]) IS
'KPI thời điểm × toà (loại toà ảo): trạng thái phòng, vacancy loss/tháng, HĐ ACTIVE + ARPU, cọc đang giữ (Σ deposit_paid HĐ ACTIVE), phải thu + aging theo due_date (not_due/1-30/31-60/61-90/>90).';

COMMIT;

NOTIFY pgrst, 'reload schema';
