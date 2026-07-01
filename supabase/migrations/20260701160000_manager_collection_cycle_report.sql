-- =====================================================================
-- Báo cáo CHU KỲ THU → BÀN GIAO theo tòa quản lý.
-- Gắn tiền đã thu vào các mốc bàn giao; mỗi mốc chốt lại số CHƯA THU
-- (point-in-time) trên toàn bộ hóa đơn của các tòa mà quản lý phụ trách.
--
-- Phạm vi tòa = staff_assignments (building_id cụ thể) ∪ area_buildings (LIVE);
-- full-scope / super admin ⇒ tất cả tòa. "Đã thu"/"chưa thu" theo TÒA (khớp
-- công nợ hóa đơn). "Đã bàn giao" = cash_handovers net (giver = quản lý).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.manager_collection_cycle_report(
  p_manager_id uuid DEFAULT NULL,
  p_from       date DEFAULT NULL,
  p_to         date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_mgr        uuid;
  v_mgr_name   text;
  v_full       boolean;
  v_bids       uuid[];
  v_billed     numeric;
  v_outstanding numeric;
  v_collected_all numeric;
  v_collected_period numeric;
  v_handed     numeric;
  v_buildings  jsonb;
  v_timeline   jsonb := '[]'::jsonb;
  v_prev       date;
  v_this       date;
  v_seg        numeric;
  v_ar         numeric;
  rec          record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  v_mgr := COALESCE(p_manager_id, auth.uid());
  IF v_mgr <> auth.uid() AND NOT (public.is_super_admin() OR public.is_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem báo cáo của người khác';
  END IF;
  p_from := COALESCE(p_from, date_trunc('month', CURRENT_DATE)::date);
  p_to   := COALESCE(p_to, CURRENT_DATE);

  SELECT COALESCE(full_name, '') INTO v_mgr_name FROM profiles WHERE id = v_mgr;

  -- ── Phạm vi tòa của quản lý ──
  v_full := EXISTS (SELECT 1 FROM staff_assignments sa
                     WHERE sa.staff_id = v_mgr AND sa.building_id IS NULL AND sa.area_id IS NULL)
            OR EXISTS (SELECT 1 FROM super_admins s WHERE s.user_id = v_mgr);
  IF v_full THEN
    v_bids := ARRAY(SELECT id FROM buildings WHERE deleted_at IS NULL);
  ELSE
    v_bids := ARRAY(
      SELECT DISTINCT bid FROM (
        SELECT sa.building_id AS bid FROM staff_assignments sa
         WHERE sa.staff_id = v_mgr AND sa.building_id IS NOT NULL
        UNION
        SELECT ab.building_id FROM staff_assignments sa
          JOIN area_buildings ab ON ab.area_id = sa.area_id
         WHERE sa.staff_id = v_mgr AND sa.area_id IS NOT NULL
      ) x WHERE bid IS NOT NULL
    );
  END IF;
  -- Chỉ giữ tòa THẬT còn tồn tại (bỏ assignment trỏ tòa đã xóa/mồ côi + tòa ảo "Chung").
  v_bids := ARRAY(SELECT b.id FROM buildings b
                   WHERE b.id = ANY(v_bids) AND b.deleted_at IS NULL
                     AND NOT COALESCE(b.is_virtual, false));
  IF v_bids IS NULL THEN v_bids := ARRAY[]::uuid[]; END IF;

  -- ── Tổng hiện tại (chỉ HĐ đã chốt: bỏ DRAFT/PENDING/CANCELLED) ──
  SELECT COALESCE(sum(total_amount), 0), COALESCE(sum(remaining_amount), 0), COALESCE(sum(paid_amount), 0)
    INTO v_billed, v_outstanding, v_collected_all
    FROM invoices
   WHERE building_id = ANY(v_bids) AND deleted_at IS NULL
     AND status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED');

  -- ── Đã thu trong kỳ (payments của tòa) ──
  SELECT COALESCE(sum(p.amount), 0) INTO v_collected_period
    FROM payments p JOIN invoices i ON i.id = p.invoice_id
   WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
     AND p.payment_date BETWEEN p_from AND p_to;

  -- ── Đã bàn giao trong kỳ (net, giver = quản lý) ──
  SELECT COALESCE(sum(total_amount), 0) INTO v_handed
    FROM cash_handovers
   WHERE giver_id = v_mgr AND status = 'CONFIRMED'
     AND confirmed_at::date BETWEEN p_from AND p_to;

  -- ── Theo từng tòa (hiện tại) ──
  SELECT jsonb_agg(jsonb_build_object(
           'building_id', b.id, 'name', b.name,
           'total_billed', bs.billed, 'collected', bs.paid,
           'outstanding', bs.remaining, 'unpaid_count', bs.unpaid
         ) ORDER BY bs.remaining DESC NULLS LAST, b.name)
    INTO v_buildings
    FROM buildings b
    JOIN LATERAL (
      SELECT COALESCE(sum(i.total_amount), 0) AS billed,
             COALESCE(sum(i.paid_amount), 0) AS paid,
             COALESCE(sum(i.remaining_amount), 0) AS remaining,
             count(*) FILTER (WHERE i.remaining_amount > 0) AS unpaid
        FROM invoices i
       WHERE i.building_id = b.id AND i.deleted_at IS NULL
         AND i.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED')
    ) bs ON true
   WHERE b.id = ANY(v_bids) AND b.deleted_at IS NULL;

  -- ── Timeline: từng mốc bàn giao (tăng dần) + chốt CHƯA THU point-in-time ──
  v_prev := p_from - 1;   -- để đoạn đầu = [p_from, mốc1]
  FOR rec IN
    SELECT ch.code, ch.confirmed_at, ch.total_amount AS net, fa.name AS from_account
      FROM cash_handovers ch
      LEFT JOIN accounts fa ON fa.id = ch.from_account_id
     WHERE ch.giver_id = v_mgr AND ch.status = 'CONFIRMED'
       AND ch.confirmed_at::date BETWEEN p_from AND p_to
     ORDER BY ch.confirmed_at ASC
  LOOP
    v_this := rec.confirmed_at::date;
    SELECT COALESCE(sum(p.amount), 0) INTO v_seg
      FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
       AND p.payment_date > v_prev AND p.payment_date <= v_this;
    -- Chưa thu TẠI NGÀY v_this: HĐ tồn tại (issue_date ≤ v_this), trừ payments ≤ v_this.
    -- Cộng RÒNG (không floor 0) để đồng quy ước với remaining_amount ("chưa thu hiện tại"):
    -- HĐ trả dư cấn trừ HĐ nợ khác, khớp cách app tính công nợ.
    SELECT COALESCE(sum(i.total_amount - COALESCE(pp.paid, 0)), 0) INTO v_ar
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT sum(p.amount) AS paid FROM payments p
         WHERE p.invoice_id = i.id AND p.payment_date <= v_this
      ) pp ON true
     WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
       AND i.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED')
       AND i.issue_date <= v_this;
    v_timeline := v_timeline || jsonb_build_object(
      'type', 'HANDOVER', 'code', rec.code, 'confirmed_at', rec.confirmed_at,
      'net', rec.net, 'from_account', rec.from_account,
      'collected_in_segment', v_seg, 'outstanding_as_of', v_ar);
    v_prev := v_this;
  END LOOP;

  -- ── Đoạn hiện tại (từ mốc cuối → p_to) ──
  SELECT COALESCE(sum(p.amount), 0) INTO v_seg
    FROM payments p JOIN invoices i ON i.id = p.invoice_id
   WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
     AND p.payment_date > v_prev AND p.payment_date <= p_to;
  v_timeline := v_timeline || jsonb_build_object(
    'type', 'CURRENT', 'confirmed_at', NULL, 'code', NULL, 'net', NULL, 'from_account', NULL,
    'collected_in_segment', v_seg, 'outstanding_as_of', v_outstanding);

  RETURN jsonb_build_object(
    'manager', jsonb_build_object('id', v_mgr, 'name', v_mgr_name),
    'from', p_from, 'to', p_to,
    'building_count', COALESCE(array_length(v_bids, 1), 0),
    'summary', jsonb_build_object(
      'collected_period', v_collected_period,
      'handed_over_period', v_handed,
      'outstanding_current', v_outstanding,
      'total_billed_current', v_billed,
      'collected_all', v_collected_all),
    'buildings', COALESCE(v_buildings, '[]'::jsonb),
    'timeline', v_timeline);
END;
$function$;

REVOKE ALL ON FUNCTION public.manager_collection_cycle_report(uuid,date,date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.manager_collection_cycle_report(uuid,date,date) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
