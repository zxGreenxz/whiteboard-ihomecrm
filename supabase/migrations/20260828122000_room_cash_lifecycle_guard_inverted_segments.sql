-- =====================================================================
-- Forward-fix v3 cho get_room_cash_lifecycle_v1 — segment NGƯỢC MỐC.
--
-- Đo trên phòng 401 (org thật) sau bản 121000: 4 hợp đồng rác tạo 12-14/05
-- rồi thanh lý ngay 12/05 — hai cái có from_date SAU actual_end_date, nên thanh
-- bị đóng thành [13/05 → 12/05): ngược. Chúng đầu độc phép island: 3 khoảng
-- trống ma cùng xuất phát 12/05.
--
-- Luật mới: mốc đóng suy ra (actual_end/end_date) mà SỚM HƠN mốc mở thì kẹp
-- thành thanh 0 ngày, HẠ trusted và gắn diagnostic SEGMENT_END_BEFORE_START —
-- dữ liệu bẩn phải LỘ RA trên UI (thanh cảnh báo), không được âm thầm vẽ thành
-- khoảng trống. Vacancy chỉ ăn segment trusted nên hết bị đầu độc; thêm
-- DISTINCT chống trùng tuyệt đối.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_room_cash_lifecycle_v1(uuid,date,date)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu get_room_cash_lifecycle_v1 — chạy 20260828121000 trước. DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_room_cash_lifecycle_v1(
  p_room_id uuid,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_room  record;
  v_ids   uuid[];
  v_out   jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT r.id, r.name, r.building_id, b.name AS building_name
    INTO v_room
    FROM rooms r JOIN buildings b ON b.id = r.building_id
   WHERE r.id = p_room_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phòng' USING ERRCODE='P0002';
  END IF;

  IF NOT (public.can_access_building(v_room.building_id)
          OR public.ie_all_buildings_scope(v_room.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), '{}') INTO v_ids
    FROM contracts c
   WHERE c.deleted_at IS NULL
     AND (c.room_id = p_room_id
          OR EXISTS (SELECT 1 FROM contract_transfers tr
                      WHERE tr.contract_id = c.id
                        AND tr.status IN ('COMPLETED','APPROVED')
                        AND (tr.old_room_id = p_room_id OR tr.new_room_id = p_room_id)));

  WITH seg_raw AS (
    -- Thanh cư trú trên phòng này. to_date NULL từ projection nghĩa là "không
    -- có mốc chuyển đi" — hợp đồng đã kết thúc thì đóng tại ngày kết thúc.
    SELECT s.contract_id, s.contract_number, s.seg_index, s.from_date,
           CASE
             WHEN s.to_date IS NOT NULL THEN s.to_date
             ELSE COALESCE(c.actual_end_date::date,
                    CASE WHEN c.status::text IN ('TERMINATED','EXPIRED')
                         THEN c.end_date::date END)
           END AS to_date,
           s.source_path, s.trusted, s.diagnostic
      FROM public.get_room_residence_segments_v1(v_ids) s
      JOIN contracts c ON c.id = s.contract_id
     WHERE s.room_id = p_room_id
  ),
  seg AS (
    -- Mốc đóng SỚM HƠN mốc mở = dữ liệu bẩn (hợp đồng rác kết thúc trước khi
    -- bắt đầu — có thật trên prod, phòng 401). Kẹp 0 ngày + hạ trusted + gắn
    -- diagnostic: UI vẽ thanh cảnh báo, vacancy bỏ qua.
    SELECT r.contract_id, r.contract_number, r.seg_index, r.from_date,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN r.from_date ELSE r.to_date END AS to_date,
           r.source_path,
           (r.trusted AND NOT (r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                               AND r.to_date < r.from_date)) AS trusted,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN 'SEGMENT_END_BEFORE_START' ELSE r.diagnostic END AS diagnostic
      FROM seg_raw r
  ),
  hd AS (
    SELECT c.id, c.contract_number, c.status::text AS status,
           c.start_date, c.end_date, c.actual_end_date,
           c.rent_price, c.total_deposit,
           t.full_name AS tenant_name
      FROM contracts c
      LEFT JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = ANY(v_ids)
  ),
  ev AS (
    SELECT 'CONTRACT_OPENED' AS type, s.from_date AS date, s.contract_id,
           NULL::numeric AS amount, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path) AS meta
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index = 0
    UNION ALL
    SELECT 'ROOM_CHANGED_IN', s.from_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path)
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index > 0
    UNION ALL
    SELECT CASE WHEN tr.id IS NOT NULL THEN 'ROOM_CHANGED_OUT' ELSE 'CONTRACT_CLOSED' END,
           s.to_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index)
      FROM seg s
      LEFT JOIN contract_transfers tr
        ON tr.contract_id = s.contract_id AND tr.old_room_id = p_room_id
       AND tr.status IN ('COMPLETED','APPROVED')
       AND COALESCE(tr.move_out_date, tr.transfer_date) = s.to_date
     WHERE s.to_date IS NOT NULL
    UNION ALL
    SELECT 'DEPOSIT_RECEIVED', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source IN ('contract.deposit','deposit.reservation')
       AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'INVOICE_ISSUED', COALESCE(i.issue_date::date, (i.billing_month || '-01')::date),
           i.contract_id, i.total_amount, true,
           jsonb_build_object('billingMonth', i.billing_month, 'status', i.status)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status NOT IN ('CANCELLED','DRAFT')
    UNION ALL
    SELECT 'INVOICE_COLLECTION_POSTED', COALESCE(i.paid_date::date, i.updated_at::date),
           i.contract_id, i.paid_amount, true,
           jsonb_build_object('billingMonth', i.billing_month)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status IN ('PAID','PARTIAL_PAID')
       AND COALESCE(i.paid_amount,0) > 0
    UNION ALL
    SELECT 'TERMINATION_REQUESTED', COALESCE(t.termination_date::date, t.created_at::date),
           t.contract_id, t.refund_amount,
           (t.status IN ('APPROVED','COMPLETED')),
           jsonb_build_object('status', t.status, 'type', t.termination_type)
      FROM contract_terminations t
     WHERE t.contract_id = ANY(v_ids)
    UNION ALL
    SELECT 'SETTLEMENT_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_FORFEIT_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.forfeit_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_REFUND_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.refund' AND ie.approval_status = 'APPROVED'
       AND ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL
    UNION ALL
    SELECT 'COMMISSION_PAID', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code, 'name', ie.name)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'contract.commission' AND ie.approval_status = 'APPROVED'
  ),
  ev_loc AS (
    SELECT * FROM ev
     WHERE date IS NOT NULL
       AND (p_from IS NULL OR date >= p_from)
       AND (p_to   IS NULL OR date <= p_to)
  ),
  -- Vacancy theo chuẩn island (fix #2): running max của to_date đã thấy, NULL
  -- (đang ở) coi là infinity — sau một segment mở thì không bao giờ còn gap.
  seg_sorted AS (
    SELECT s.from_date, s.to_date,
           max(COALESCE(s.to_date, 'infinity'::date)) OVER (
             ORDER BY s.from_date NULLS FIRST
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_max_to,
           lead(s.from_date) OVER (ORDER BY s.from_date NULLS FIRST) AS next_from
      FROM seg s WHERE s.trusted
  ),
  vac AS (
    SELECT DISTINCT ss.run_max_to AS from_date, ss.next_from AS to_date,
           (ss.next_from - ss.run_max_to) AS days
      FROM seg_sorted ss
     WHERE ss.next_from IS NOT NULL
       AND ss.run_max_to <> 'infinity'::date
       AND ss.next_from > ss.run_max_to
    UNION ALL
    -- Đuôi mở: mọi segment tin cậy đều đã đóng ⇒ phòng trống từ mốc đóng muộn
    -- nhất tới hôm nay (chỉ khi thật sự đã qua ngày đó)
    SELECT max(s.to_date), NULL, (CURRENT_DATE - max(s.to_date))
      FROM seg s
     WHERE s.trusted
    HAVING count(*) > 0
       AND bool_and(s.to_date IS NOT NULL)
       AND max(s.to_date) < CURRENT_DATE
  )
  SELECT jsonb_build_object(
    'room', jsonb_build_object(
      'id', v_room.id, 'name', v_room.name,
      'buildingId', v_room.building_id, 'buildingName', v_room.building_name),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'contracts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'number', h.contract_number, 'status', h.status,
        'startDate', h.start_date, 'endDate', h.end_date,
        'actualEndDate', h.actual_end_date,
        'rentPrice', h.rent_price, 'totalDeposit', h.total_deposit,
        'tenantName', h.tenant_name) ORDER BY h.start_date)
      FROM hd h), '[]'::jsonb),
    'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'contractId', s.contract_id, 'contractNumber', s.contract_number,
        'segIndex', s.seg_index, 'fromDate', s.from_date, 'toDate', s.to_date,
        'sourcePath', s.source_path, 'trusted', s.trusted, 'diagnostic', s.diagnostic)
        ORDER BY s.from_date NULLS FIRST, s.seg_index)
      FROM seg s), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type', e.type, 'date', e.date, 'contractId', e.contract_id,
        'amount', e.amount, 'trusted', e.trusted, 'meta', e.meta)
        ORDER BY e.date, e.type)
      FROM ev_loc e), '[]'::jsonb),
    'vacancies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'fromDate', v.from_date, 'toDate', v.to_date, 'days', v.days)
        ORDER BY v.from_date)
      FROM vac v), '[]'::jsonb),
    'generatedAt', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) TO authenticated, service_role;

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_room_cash_lifecycle_v1';
  IF position('actual_end_date' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Fix #1 hỏng: segment không đóng theo ngày kết thúc hợp đồng. DỪNG.';
  END IF;
  IF position('run_max_to' IN v_code) = 0 OR position('''infinity''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Fix #2 hỏng: vacancy không theo chuẩn island. DỪNG.';
  END IF;
  IF position('segment_end_before_start' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Fix v3 hỏng: segment ngược mốc không bị kẹp + hạ trusted. DỪNG.';
  END IF;
  IF position('get_room_residence_segments_v1' IN v_code) = 0
     OR position('can_access_building' IN v_code) = 0
     OR position('active_posting_id_v2' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Mất invariant của 20260828120000. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
