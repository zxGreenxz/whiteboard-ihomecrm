-- Nợ thực ở KPI phải thu (22/10/2026): public.fa_snapshot_kpis — thẻ "Phải thu"/"Tổng phải thu hiện tại" và tuổi nợ
-- của Phân tích tài chính và Hiệu quả kinh doanh (business_performance_snapshot_v1 bọc hàm này), Hermes
-- crm_read_report report=fa_snapshot_kpis (gọi thẳng cùng RPC). Trước: Σ remaining_amount mọi hoá đơn mở ⇒ phần nợ
-- cũ đã kéo sang hoá đơn sau bị đếm ở cả nguồn lẫn hoá đơn gánh (đo production 22/10: ≈ 23 % tổng, 3 toà).
-- Sau: Σ nợ thực (public.invoice_effective_outstanding_v1, 20261021183549) trên đúng tập cũ (hoá đơn mở, còn nợ, toà
-- được xem); năm khoảng tuổi nợ đọc cùng con số nên receivable_total = Σ khoảng (bất biến client giữ nguyên).
-- Thân = 20260731070000 (định nghĩa sống, md5 prosrc khớp production 22/10) với một chỗ đổi: CTE receivables.
-- Chữ ký, kiểu trả về, SECURITY DEFINER, search_path giữ nguyên (CREATE OR REPLACE). ACL nêu lại đúng bản production 22/10
-- ({postgres, authenticated, service_role}, không PUBLIC/anon): không đổi gì trên production; bản dựng lại từ baseline
-- --no-acl (Restore Drill) mặc định cho PUBLIC/anon EXECUTE nên file phải tự đặt lại.
-- THỨ TỰ ÁP: 20261021183549_invoice_effective_outstanding_v1 TRƯỚC, rồi file này.
-- LÙI: áp lại thân fa_snapshot_kpis của 20260731070000 (CREATE OR REPLACE). Không có dữ liệu phải khôi phục.

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.invoice_effective_outstanding_v1(uuid[])');
  IF NOT FOUND OR p.prosecdef OR p.provolatile <> 's' THEN
    RAISE EXCEPTION 'receivable_kpis_effective_requires_shared_function';
  END IF;
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.fa_snapshot_kpis(uuid[])');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile <> 's' OR position('aging_over_90' IN pg_get_function_result(p.oid)) = 0 THEN
    RAISE EXCEPTION 'receivable_kpis_effective_requires_fa_snapshot_kpis';
  END IF;
  -- Chống đè bản khác: chỉ thay đúng thân 20260731070000 (md5 prosrc production 22/10) hoặc chính bản này (chạy lại).
  IF md5(p.prosrc) NOT IN ('3fda9aa392f6fe7a078558495d0e4acb', '47a170efae29fc3bf4fef2d5b033efd6') THEN
    RAISE EXCEPTION 'receivable_kpis_effective_live_body_changed: %', md5(p.prosrc);
  END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.fa_snapshot_kpis(p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(building_id uuid, building_name text, total_rooms integer, rooms_available integer, rooms_occupied integer, rooms_reserved integer, rooms_maintenance integer, rooms_unavailable integer, vacancy_loss_month numeric, active_contracts bigint, avg_rent numeric, deposit_held numeric, receivable_total numeric, aging_not_due numeric, aging_1_30 numeric, aging_31_60 numeric, aging_61_90 numeric, aging_over_90 numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Nợ thực (20261021190215): nợ cũ đã kéo sang hoá đơn gánh chỉ đếm MỘT lần, ở hoá đơn phát sinh gốc
  -- (public.invoice_effective_outstanding_v1, một lời gọi cho mọi hoá đơn mở của các toà được xem).
  -- receivable_total và năm khoảng tuổi nợ cùng đọc nợ thực ⇒ tổng = Σ khoảng như trước (client kiểm).
  -- Tuổi nợ theo hạn của kỳ phát sinh gốc: tiền thu vào hoá đơn gánh trả phần mới trước, nợ kéo sau cùng.
  open_inv AS MATERIALIZED (
    SELECT i.id, i.building_id, i.due_date
    FROM public.invoices i
    JOIN allowed a ON a.id = i.building_id
    WHERE i.deleted_at IS NULL
      AND i.status IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE')
      AND i.remaining_amount > 0
  ),
  owed AS MATERIALIZED (
    SELECT o.invoice_id, o.effective_outstanding
    FROM public.invoice_effective_outstanding_v1(ARRAY(SELECT oi.id FROM open_inv oi)) o
  ),
  receivables AS (
    SELECT i.building_id AS bid,
           COALESCE(SUM(w.effective_outstanding), 0)::numeric AS total_recv,
           COALESCE(SUM(w.effective_outstanding) FILTER (
             WHERE i.due_date IS NULL OR i.due_date >= public.org_today_v1(NULL)), 0)::numeric AS not_due,
           COALESCE(SUM(w.effective_outstanding) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date BETWEEN 1  AND 30), 0)::numeric AS d1_30,
           COALESCE(SUM(w.effective_outstanding) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date BETWEEN 31 AND 60), 0)::numeric AS d31_60,
           COALESCE(SUM(w.effective_outstanding) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date BETWEEN 61 AND 90), 0)::numeric AS d61_90,
           COALESCE(SUM(w.effective_outstanding) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date > 90), 0)::numeric AS d90p
    FROM open_inv i
    JOIN owed w ON w.invoice_id = i.id AND w.effective_outstanding > 0
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
$function$;

-- ACL như production 22/10 (no-op ở đó); bản dựng lại --no-acl cần hai dòng này để không còn PUBLIC/anon EXECUTE.
REVOKE ALL ON FUNCTION public.fa_snapshot_kpis(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_snapshot_kpis(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.fa_snapshot_kpis(uuid[]) IS
  'KPI thời điểm hiện tại × toà (Phân tích tài chính, Hiệu quả kinh doanh, Hermes fa_snapshot_kpis). receivable_total và tuổi nợ = Σ nợ thực của hoá đơn mở (invoice_effective_outstanding_v1: nợ đã kéo sang hoá đơn gánh chỉ đếm một lần, ở hoá đơn phát sinh gốc); tuổi nợ theo hạn của kỳ phát sinh gốc.';

DO $assert$
DECLARE p record; sig text := 'public.fa_snapshot_kpis(uuid[])';
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure(sig);
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile <> 's'
     OR replace(COALESCE(array_to_string(p.proconfig, ','), ''), '"', '') <> 'search_path=public'
     OR NOT has_function_privilege('authenticated', sig, 'EXECUTE')
     OR has_function_privilege('anon', sig, 'EXECUTE')
     OR position('public.invoice_effective_outstanding_v1(ARRAY(SELECT oi.id FROM open_inv oi))' IN p.prosrc) = 0
     OR md5(p.prosrc) <> '47a170efae29fc3bf4fef2d5b033efd6'
     OR (SELECT count(*) FROM pg_proc WHERE proname = 'fa_snapshot_kpis') <> 1 THEN
    RAISE EXCEPTION 'receivable_kpis_effective_contract_violated';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
