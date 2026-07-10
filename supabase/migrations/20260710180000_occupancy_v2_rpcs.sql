-- ============================================================================
-- Phase 8 — Báo cáo Lấp đầy v2: chuyển tổng hợp xuống database (2 RPC chỉ-đọc)
--
-- Thay client-side aggregation của useOccupancyReport/useOccupancyTrend
-- (fetch toàn bộ rooms+contracts rồi tính JS — dính cap-1000, không phân
-- biệt UNAVAILABLE, trend đếm HĐ chồng lấn ra >100%).
--
-- ĐỊNH NGHĨA (khoá tại đây — UI/export phải trích dẫn đúng):
-- Tại ngày p_as_of_date, mỗi phòng thuộc ĐÚNG MỘT nhóm:
--   occupied    = có ≥1 HĐ ACTIVE "đang hiệu lực": start_date <= as_of và
--                 (actual_end_date IS NULL OR actual_end_date >= as_of).
--                 CHỦ Ý không cắt theo end_date: HĐ quá hạn chưa thanh lý/gia hạn
--                 nghĩa là khách VẪN Ở — khớp hành vi nghiệp vụ + hook cũ.
--   reserved    = không occupied và rooms.status = 'RESERVED' (đã cọc giữ chỗ)
--   maintenance = không occupied và rooms.status = 'MAINTENANCE'
--   unavailable = không occupied và rooms.status = 'UNAVAILABLE',
--                 HOẶC trạng thái bất thường (VD status='OCCUPIED' nhưng không
--                 còn HĐ ACTIVE — dữ liệu lệch, KHÔNG được gom vào available)
--   available   = không occupied và rooms.status = 'AVAILABLE'
-- Invariant: total = occupied + reserved + maintenance + unavailable + available.
-- occupancy_pct = occupied/total; committed_pct = (occupied+reserved)/total;
-- total=0 → 0 (không NaN). missed_revenue = Σ GREATEST(rent_price,0) của
-- RIÊNG nhóm available (không tính reserved/maintenance/unavailable).
--
-- effective_end_date (chỉ dùng cho upcoming vacancy) =
--   GREATEST(contracts.end_date, MAX(new_end_date của contract_extensions
--   status APPROVED|COMPLETED)) — DRAFT/REJECTED/CANCELLED bị bỏ qua.
--   KHÔNG dùng contracts.status='EXTENDED' (deprecated).
--
-- BẢO MẬT: SECURITY INVOKER (RLS vẫn áp) + lọc tường minh
-- can_access_building(b.id) như fa_occupancy_monthly. p_building_ids chỉ
-- THU HẸP trong tập được phép — id ngoài scope bị loại im lặng (không lỗi,
-- không lộ). REVOKE anon.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.occupancy_snapshot_v2(date, uuid[]);
--   DROP FUNCTION IF EXISTS public.occupancy_upcoming_vacancy_v2(date, integer, uuid[]);
-- ============================================================================

-- ── 1. occupancy_snapshot_v2: snapshot theo toà tại 1 ngày ──────────────────
DROP FUNCTION IF EXISTS public.occupancy_snapshot_v2(date, uuid[]);
CREATE FUNCTION public.occupancy_snapshot_v2(
  p_as_of_date   date   DEFAULT CURRENT_DATE,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  building_id    uuid,
  building_name  text,
  total          integer,
  occupied       integer,
  reserved       integer,
  maintenance    integer,
  unavailable    integer,
  available      integer,
  occupancy_pct  numeric,
  committed_pct  numeric,
  missed_revenue numeric,
  generated_at   timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  classified AS (
    SELECT
      r.building_id AS bid,
      r.rent_price,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = r.id
            AND c.deleted_at IS NULL
            AND c.status = 'ACTIVE'
            AND c.start_date <= p_as_of_date
            AND (c.actual_end_date IS NULL OR c.actual_end_date >= p_as_of_date)
        ) THEN 'occupied'
        WHEN r.status = 'RESERVED'    THEN 'reserved'
        WHEN r.status = 'MAINTENANCE' THEN 'maintenance'
        WHEN r.status = 'AVAILABLE'   THEN 'available'
        -- UNAVAILABLE + mọi trạng thái bất thường (VD OCCUPIED mồ côi HĐ):
        ELSE 'unavailable'
      END AS grp
    FROM public.rooms r
    JOIN allowed a ON a.id = r.building_id
    WHERE r.deleted_at IS NULL
  ),
  agg AS (
    SELECT
      bid,
      COUNT(*)::int                                   AS total,
      COUNT(*) FILTER (WHERE grp = 'occupied')::int    AS occupied,
      COUNT(*) FILTER (WHERE grp = 'reserved')::int    AS reserved,
      COUNT(*) FILTER (WHERE grp = 'maintenance')::int AS maintenance,
      COUNT(*) FILTER (WHERE grp = 'unavailable')::int AS unavailable,
      COUNT(*) FILTER (WHERE grp = 'available')::int   AS available,
      COALESCE(SUM(GREATEST(rent_price, 0)) FILTER (WHERE grp = 'available'), 0)::numeric
        AS missed_revenue
    FROM classified
    GROUP BY bid
  )
  SELECT
    a.id,
    a.name,
    COALESCE(g.total, 0),
    COALESCE(g.occupied, 0),
    COALESCE(g.reserved, 0),
    COALESCE(g.maintenance, 0),
    COALESCE(g.unavailable, 0),
    COALESCE(g.available, 0),
    CASE WHEN COALESCE(g.total, 0) = 0 THEN 0
         ELSE ROUND(g.occupied * 100.0 / g.total, 1) END::numeric,
    CASE WHEN COALESCE(g.total, 0) = 0 THEN 0
         ELSE ROUND((g.occupied + g.reserved) * 100.0 / g.total, 1) END::numeric,
    COALESCE(g.missed_revenue, 0),
    now()
  FROM allowed a
  LEFT JOIN agg g ON g.bid = a.id
  ORDER BY a.name;
$$;
REVOKE ALL ON FUNCTION public.occupancy_snapshot_v2(date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.occupancy_snapshot_v2(date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.occupancy_snapshot_v2(date, uuid[]) IS
'Snapshot lấp đầy theo toà tại p_as_of_date. occupied = HĐ ACTIVE start<=as_of chưa actual_end (KHÔNG cắt end_date — quá hạn chưa thanh lý vẫn là đang ở). 5 nhóm phân hoạch đủ total; trạng thái lạ vào unavailable, KHÔNG vào available. missed_revenue = Σ GREATEST(rent_price,0) nhóm available. INVOKER + can_access_building; p_building_ids chỉ thu hẹp.';

-- ── 2. occupancy_upcoming_vacancy_v2: phòng sắp trống trong cửa sổ N ngày ────
DROP FUNCTION IF EXISTS public.occupancy_upcoming_vacancy_v2(date, integer, uuid[]);
CREATE FUNCTION public.occupancy_upcoming_vacancy_v2(
  p_as_of_date   date    DEFAULT CURRENT_DATE,
  p_window_days  integer DEFAULT 60,
  p_building_ids uuid[]  DEFAULT NULL
)
RETURNS TABLE (
  contract_id        uuid,
  contract_number    text,
  building_id        uuid,
  building_name      text,
  room_id            uuid,
  room_name          text,
  effective_end_date date,
  days_remaining     integer,
  rent_price         numeric,
  extension_applied  boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  eff AS (
    -- 1 dòng / HĐ ACTIVE đang hiệu lực tại as_of, kèm effective_end_date
    SELECT
      c.id,
      c.contract_number,
      c.room_id,
      GREATEST(
        c.end_date,
        COALESCE((
          SELECT MAX(ce.new_end_date::date)
          FROM public.contract_extensions ce
          WHERE ce.contract_id = c.id
            AND ce.status IN ('APPROVED', 'COMPLETED')
        ), c.end_date)
      )::date AS eff_end,
      EXISTS (
        SELECT 1 FROM public.contract_extensions ce
        WHERE ce.contract_id = c.id
          AND ce.status IN ('APPROVED', 'COMPLETED')
          AND ce.new_end_date::date > c.end_date
      ) AS ext_applied
    FROM public.contracts c
    WHERE c.deleted_at IS NULL
      AND c.status = 'ACTIVE'
      AND c.start_date <= p_as_of_date
      AND (c.actual_end_date IS NULL OR c.actual_end_date >= p_as_of_date)
  ),
  per_room AS (
    -- 1 phòng chỉ xuất hiện 1 lần: lấy HĐ có effective_end xa nhất
    SELECT DISTINCT ON (e.room_id)
      e.id, e.contract_number, e.room_id, e.eff_end, e.ext_applied
    FROM eff e
    ORDER BY e.room_id, e.eff_end DESC, e.id
  )
  SELECT
    p.id,
    p.contract_number,
    a.id,
    a.name,
    r.id,
    r.name,
    p.eff_end,
    (p.eff_end - p_as_of_date)::int,
    r.rent_price::numeric,
    p.ext_applied
  FROM per_room p
  JOIN public.rooms r ON r.id = p.room_id AND r.deleted_at IS NULL
  JOIN allowed a ON a.id = r.building_id
  WHERE (p.eff_end - p_as_of_date) BETWEEN 0 AND GREATEST(p_window_days, 0)
  ORDER BY p.eff_end, a.name, r.name;
$$;
REVOKE ALL ON FUNCTION public.occupancy_upcoming_vacancy_v2(date, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.occupancy_upcoming_vacancy_v2(date, integer, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.occupancy_upcoming_vacancy_v2(date, integer, uuid[]) IS
'Phòng sắp trống trong [0..p_window_days] ngày kể từ p_as_of_date. effective_end = GREATEST(end_date, MAX new_end_date của extension APPROVED|COMPLETED) — không dùng status EXTENDED. 1 phòng 1 dòng (HĐ end xa nhất). Chỉ HĐ ACTIVE đang hiệu lực. INVOKER + can_access_building; p_building_ids chỉ thu hẹp.';
