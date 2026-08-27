-- =====================================================================
-- Plan 2 Task 6A — READ MODEL "chu trình phòng": toàn bộ vòng đời hợp đồng
-- của MỘT phòng trên trục thời gian, kèm các mốc tiền suy được từ dữ liệu
-- hôm nay. Panel "Chu trình phòng" trên /thu-tien đọc hàm này.
--
-- PHẠM VI 6A (đã khoá trong plan): chỉ những sự kiện suy được từ dữ liệu hiện
-- có. KHÔNG có DEPOSIT_REFUND_PENDING và ba summary cọc (6B — cần obligation
-- đầy đủ + Plan 1). DEPOSIT_REFUND_POSTED thì suy được ngay hôm nay từ phiếu
-- termination.refund đã POSTED + posting sống — cùng vị ngữ với /deposits.
--
-- HAI SỰ THẬT NỀN, đo trên production 27-28/08/2026:
--   · contracts.parent_contract_id = 0/366, contract_extensions.new_contract_id
--     = 0/101 — KHÔNG tồn tại liên kết cha-con giữa các hợp đồng. Gia hạn sửa
--     ngày trên chính hợp đồng cũ. Vì thế read model này là TIMELINE THEO PHÒNG
--     (mỗi hợp đồng một thanh, khoảng hở = bỏ trống), không phải cây hợp đồng.
--   · Thanh cư trú lấy từ get_room_residence_segments_v1 (Task 0, nằm không từ
--     31/07 — đây là client đầu tiên của nó), kèm cờ trusted + source_path.
--
-- Cổng quyền: FAIL-CLOSED theo toà — không thấy toà thì 42501, không trả rỗng
-- im lặng (một phòng cụ thể mà trả rỗng thì người dùng tưởng phòng chưa có gì).
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_room_residence_segments_v1(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'Thiếu get_room_residence_segments_v1 — chạy 20260731051000 trước. DỪNG.';
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

  -- Cổng quyền theo toà — cùng bộ vị ngữ với get_room_residence_segments_v1,
  -- nhưng fail-closed tường minh thay vì lọc im lặng.
  IF NOT (public.can_access_building(v_room.building_id)
          OR public.ie_all_buildings_scope(v_room.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;

  -- Hợp đồng từng dính tới phòng: đang ở (room_id hiện tại) HOẶC từng ở/chuyển
  -- đến theo sổ audit chuyển phòng. KHÔNG chỉ nhìn room_id hiện tại — đó đúng
  -- là lối tắt mà plan cấm ("không join room hiện tại để gán lịch sử").
  SELECT COALESCE(array_agg(DISTINCT c.id), '{}') INTO v_ids
    FROM contracts c
   WHERE c.deleted_at IS NULL
     AND (c.room_id = p_room_id
          OR EXISTS (SELECT 1 FROM contract_transfers tr
                      WHERE tr.contract_id = c.id
                        AND tr.status IN ('COMPLETED','APPROVED')
                        AND (tr.old_room_id = p_room_id OR tr.new_room_id = p_room_id)));

  WITH seg AS (
    -- Thanh cư trú TRÊN PHÒNG NÀY (segment ở phòng khác bị lọc): nguồn sự thật
    -- cho các thanh timeline + vacancy. from_date NULL = không biết mốc vào.
    SELECT s.contract_id, s.contract_number, s.seg_index, s.from_date, s.to_date,
           s.source_path, s.trusted, s.diagnostic
      FROM public.get_room_residence_segments_v1(v_ids) s
     WHERE s.room_id = p_room_id
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
  -- ── Sự kiện (taxonomy 6A) ────────────────────────────────────────────
  ev AS (
    -- CONTRACT_OPENED — mốc vào của từng segment trên phòng này (không phải
    -- start_date mù quáng: hợp đồng chuyển ĐẾN thì mốc mở tại phòng là ngày vào)
    SELECT 'CONTRACT_OPENED' AS type, s.from_date AS date, s.contract_id,
           NULL::numeric AS amount, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path) AS meta
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index = 0
    UNION ALL
    SELECT 'ROOM_CHANGED_IN', s.from_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path)
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index > 0
    UNION ALL
    -- CONTRACT_CLOSED / ROOM_CHANGED_OUT — mốc rời phòng của segment
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
    -- DEPOSIT_RECEIVED — phiếu thu cọc; trusted = tiền đã vào sổ thật
    SELECT 'DEPOSIT_RECEIVED', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source IN ('contract.deposit','deposit.reservation')
       AND ie.approval_status = 'APPROVED'
    UNION ALL
    -- INVOICE_ISSUED — hoá đơn phát hành cho phòng này (room snapshot của hoá đơn)
    SELECT 'INVOICE_ISSUED', COALESCE(i.issue_date::date, (i.billing_month || '-01')::date),
           i.contract_id, i.total_amount, true,
           jsonb_build_object('billingMonth', i.billing_month, 'status', i.status)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status NOT IN ('CANCELLED','DRAFT')
    UNION ALL
    -- INVOICE_COLLECTION_POSTED — hoá đơn đã thu (một mốc mỗi hoá đơn, số =
    -- paid_amount tương thích legacy; sự thật posting chi tiết là việc của 6B)
    SELECT 'INVOICE_COLLECTION_POSTED', COALESCE(i.paid_date::date, i.updated_at::date),
           i.contract_id, i.paid_amount, true,
           jsonb_build_object('billingMonth', i.billing_month)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status IN ('PAID','PARTIAL_PAID')
       AND COALESCE(i.paid_amount,0) > 0
    UNION ALL
    -- TERMINATION_REQUESTED — hồ sơ thanh lý (mọi trạng thái, meta nói rõ)
    SELECT 'TERMINATION_REQUESTED', COALESCE(t.termination_date::date, t.created_at::date),
           t.contract_id, t.refund_amount,
           (t.status IN ('APPROVED','COMPLETED')),
           jsonb_build_object('status', t.status, 'type', t.termination_type)
      FROM contract_terminations t
     WHERE t.contract_id = ANY(v_ids)
    UNION ALL
    -- SETTLEMENT_OFFSET_POSTED — cấn cọc/doanh thu thanh lý (bút toán nội bộ);
    -- chỉ lấy chân offset để không đếm đôi một cặp
    SELECT 'SETTLEMENT_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    -- DEPOSIT_FORFEIT_POSTED — bỏ cọc (chân offset của cặp forfeit)
    SELECT 'DEPOSIT_FORFEIT_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.forfeit_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    -- DEPOSIT_REFUND_POSTED — hoàn cọc TIỀN THẬT đã ra két: đúng vị ngữ /deposits
    SELECT 'DEPOSIT_REFUND_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.refund' AND ie.approval_status = 'APPROVED'
       AND ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL
    UNION ALL
    -- BROKER_COMMISSION_PAID / SALE_BONUS_PAID — chung nguồn contract.commission
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
  -- ── Bỏ trống: khoảng hở giữa các segment ĐÁNG TIN, cộng đuôi mở ─────
  seg_sorted AS (
    SELECT s.*, lead(s.from_date) OVER (ORDER BY s.from_date NULLS FIRST) AS next_from
      FROM seg s WHERE s.trusted
  ),
  vac AS (
    SELECT s.to_date AS from_date, s.next_from AS to_date,
           (s.next_from - s.to_date) AS days
      FROM seg_sorted s
     WHERE s.to_date IS NOT NULL AND s.next_from IS NOT NULL AND s.next_from > s.to_date
    UNION ALL
    -- Đuôi mở: segment cuối đã đóng và không segment nào đang chạy ⇒ phòng
    -- trống từ đó tới nay
    SELECT max(s.to_date), NULL, (CURRENT_DATE - max(s.to_date))
      FROM seg s
     WHERE NOT EXISTS (SELECT 1 FROM seg s2 WHERE s2.to_date IS NULL)
       AND EXISTS (SELECT 1 FROM seg s3 WHERE s3.to_date IS NOT NULL)
    HAVING max(s.to_date) IS NOT NULL
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

COMMENT ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) IS
  'Task 6A: read model chu trình phòng — segment cư trú (từ '
  'get_room_residence_segments_v1) + sự kiện tiền suy được hôm nay + khoảng bỏ '
  'trống. Fail-closed theo toà (42501). KHÔNG có refund-pending/summary cọc (6B). '
  'Timeline theo phòng, không phải cây hợp đồng — prod không có liên kết cha-con '
  'nào giữa hợp đồng (parent_contract_id 0/366, đo 27/08/2026).';

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_room_cash_lifecycle_v1';
  IF position('get_room_residence_segments_v1' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không dùng segment projection của Task 0 — thanh timeline sẽ sai với hợp đồng chuyển phòng. DỪNG.';
  END IF;
  IF position('can_access_building' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Thiếu cổng quyền theo toà. DỪNG.';
  END IF;
  IF position('active_posting_id_v2' IN v_code) = 0 THEN
    RAISE EXCEPTION 'DEPOSIT_REFUND_POSTED không theo vị ngữ posting sống — sẽ lệch với /deposits. DỪNG.';
  END IF;
  -- Read model tuyệt đối không ghi
  IF position('insert into' IN v_code) > 0 OR position('update ' IN v_code) > 0
     OR position('delete from' IN v_code) > 0 THEN
    RAISE EXCEPTION 'Read model đang có lệnh ghi. DỪNG.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='get_room_cash_lifecycle_v1'
                AND p.provolatile <> 'v') THEN
    RAISE EXCEPTION 'Hàm phải VOLATILE (chuẩn read RPC của repo). DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
