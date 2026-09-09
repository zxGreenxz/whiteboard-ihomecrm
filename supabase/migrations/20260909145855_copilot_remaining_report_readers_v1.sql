-- G1-C: remaining reports. Business rules follow usePromotionsReport,
-- cashbook_settlement_report and manager_collection_cycle_report (receipt events).
-- The legacy RPCs aggregate across organizations, so scope is applied BEFORE
-- aggregation here. Lists are bounded independently; totals cover the full scope.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_report_promotions_v1(
  p_organization_id uuid, p_tu date DEFAULT NULL, p_den date DEFAULT NULL,
  p_building_id uuid DEFAULT NULL, p_limit integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_buildings uuid[];
  v_allowed boolean;
  v_limit integer := least(greatest(coalesce(p_limit,20),1),50);
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('reports.real-estate',p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE='42501';
  END IF;
  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.promotions',p_organization_id);
  SELECT s.org_wide OR cardinality(s.building_ids)>0 INTO v_allowed
    FROM app_private.authorized_scope_v3('reports_real_estate.promotions',p_organization_id) s;
  IF NOT coalesce(v_allowed,false) THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  IF p_tu > p_den OR p_den-p_tu > 1096 THEN RAISE EXCEPTION 'invalid_date_window' USING ERRCODE='22023'; END IF;
  WITH eligible AS (
    SELECT c.id, c.contract_number, b.name AS building_name, r.name AS room_name,
      c.signed_date, c.status, c.rent_price,
      coalesce(nullif(c.discounts->>'name',''),c.discounts->>'description') AS promotion_name,
      CASE WHEN c.discounts->>'type'='percent' THEN c.rent_price / 100 ELSE 1 END *
        coalesce(nullif((c.discounts->>'amount')::numeric,0),(c.discounts->>'value')::numeric,0) AS savings
    FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=p_organization_id AND r.deleted_at IS NULL
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
    WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL
      AND c.discounts IS NOT NULL AND c.discounts <> 'null'::jsonb
      AND b.id=ANY(v_buildings) AND (p_building_id IS NULL OR b.id=p_building_id)
      AND (p_tu IS NULL OR c.signed_date::date>=p_tu) AND (p_den IS NULL OR c.signed_date::date<=p_den)
  ), bounded AS (SELECT * FROM eligible ORDER BY signed_date DESC NULLS LAST,id LIMIT v_limit)
  SELECT jsonb_build_object('gioi_han',v_limit,'tu',p_tu,'den',p_den,
    'tong_hop',jsonb_build_object('so_hop_dong',count(*),'dang_hoat_dong',count(*) FILTER(WHERE status='ACTIVE'),
      'tong_giam_gia',coalesce(sum(savings),0)),
    'khuyen_mai',coalesce((SELECT jsonb_agg(jsonb_build_object('so_hop_dong',contract_number,
      'toa_nha',building_name,'phong',room_name,'ten',promotion_name,'tien_thue',rent_price,
      'giam_gia',savings,'thuc_thue',greatest(rent_price-savings,0),'ngay_ky',signed_date)
      ORDER BY signed_date DESC NULLS LAST,id) FROM bounded),'[]'::jsonb)) INTO v_result FROM eligible;
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_report_handover_v1(
  p_organization_id uuid, p_tu date DEFAULT NULL, p_den date DEFAULT NULL, p_limit integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_cashbooks uuid[];
  v_report_cashbooks uuid[];
  v_allowed boolean;
  v_limit integer := least(greatest(coalesce(p_limit,20),1),50);
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('reports.finance',p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE='42501';
  END IF;
  v_cashbooks := app_private.copilot_scope_cashbooks_v1('cashbooks.view',p_organization_id);
  -- A handover/account balance can span buildings. A scoped report DENY
  -- cannot be safely subtracted from it; require unrestricted report scope.
  SELECT s.org_wide,s.cashbook_ids INTO v_allowed,v_report_cashbooks
    FROM app_private.authorized_scope_v3('reports_finance.handover_report',p_organization_id) s;
  IF NOT coalesce(v_allowed,false) THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  p_tu := coalesce(p_tu,date_trunc('month',public.org_today_v1(p_organization_id))::date);
  p_den := coalesce(p_den,public.org_today_v1(p_organization_id));
  IF p_tu>p_den OR p_den-p_tu>1096 THEN RAISE EXCEPTION 'invalid_date_window' USING ERRCODE='22023'; END IF;
  WITH scope AS MATERIALIZED (
    SELECT a.id,a.name,coalesce(ab.current_amount,0) AS balance
    FROM public.accounts a LEFT JOIN public.accounts_with_balance ab ON ab.id=a.id
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual
      AND a.id=ANY(v_cashbooks) AND a.id=ANY(v_report_cashbooks)
      AND a.id IN (SELECT cashbook_id FROM app_private.ie_visible_cashbook_ids_v1())
      AND (btrim(a.name) LIKE '%Thu' OR a.name ILIKE 'tk%' OR a.bank_name IS NOT NULL
        OR EXISTS(SELECT 1 FROM public.cash_handovers h WHERE h.from_account_id=a.id AND h.organization_id=p_organization_id))
  ), sessions AS MATERIALIZED (
    SELECT h.* FROM public.cash_handovers h JOIN scope a ON a.id=h.from_account_id
    JOIN public.accounts dest ON dest.id=h.to_account_id AND dest.organization_id=p_organization_id
    WHERE h.organization_id=p_organization_id AND h.status='CONFIRMED'
      AND h.confirmed_at::date BETWEEN p_tu AND p_den
  ), accounts AS (
    SELECT a.*,
      coalesce((SELECT sum(ie.total_amount) FROM public.income_expenses ie WHERE ie.account_id=a.id
        AND ie.organization_id=p_organization_id AND ie.type='INCOME' AND ie.approval_status='APPROVED'
        AND ie.deleted_at IS NULL AND ie.handover_transfer_id IS NULL AND ie.voucher_date BETWEEN p_tu AND p_den),0) AS collected,
      coalesce((SELECT sum(ie.total_amount) FROM public.income_expenses ie WHERE ie.account_id=a.id
        AND ie.organization_id=p_organization_id AND ie.type='EXPENSE' AND ie.approval_status='APPROVED'
        AND ie.deleted_at IS NULL AND ie.handover_transfer_id IS NULL AND ie.voucher_date BETWEEN p_tu AND p_den),0) AS spent,
      coalesce((SELECT sum(s.total_amount) FROM sessions s WHERE s.from_account_id=a.id),0) AS handed
    FROM scope a
  ), recons AS (
    SELECT r.*,a.name AS account_name FROM public.cashbook_reconciliations r JOIN scope a ON a.id=r.account_id
    WHERE r.organization_id=p_organization_id AND r.status='CONFIRMED' AND r.as_of_date BETWEEN p_tu AND p_den
    ORDER BY r.as_of_date DESC,r.id LIMIT v_limit
  )
  SELECT jsonb_build_object('gioi_han',v_limit,'tu',p_tu,'den',p_den,
    'tong_hop',jsonb_build_object('so_so_quy',count(*),'da_thu',coalesce(sum(collected),0),
      'da_chi',coalesce(sum(spent),0),'da_ban_giao',coalesce(sum(handed),0),'dang_giu',coalesce(sum(balance),0),
      'so_phien',(SELECT count(*) FROM sessions)),
    'so_quy',coalesce((SELECT jsonb_agg(jsonb_build_object('ten',a.name,'da_thu',a.collected,'da_chi',a.spent,
      'da_ban_giao',a.handed,'dang_giu',a.balance) ORDER BY a.name,a.id)
      FROM (SELECT * FROM accounts ORDER BY name,id LIMIT v_limit) a),'[]'::jsonb),
    'phien',coalesce((SELECT jsonb_agg(jsonb_build_object('ma',h.code,'ngay',h.confirmed_at,
      'thu',h.gross_amount,'chi',h.expense_amount,'rong',h.total_amount) ORDER BY h.confirmed_at DESC,h.id)
      FROM (SELECT * FROM sessions ORDER BY confirmed_at DESC,id LIMIT v_limit) h),'[]'::jsonb),
    'doi_soat',coalesce((SELECT jsonb_agg(jsonb_build_object('so_quy',r.account_name,'ngay',r.as_of_date,
      'so_he_thong',r.system_balance,'kiem_dem',r.counted_balance,'chenh_lech',r.diff) ORDER BY r.as_of_date DESC,r.id)
      FROM recons r),'[]'::jsonb)) INTO v_result FROM accounts;
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_report_collection_cycle_v1(
  p_organization_id uuid, p_tu date DEFAULT NULL, p_den date DEFAULT NULL, p_limit integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_buildings uuid[];
  v_cashbooks uuid[];
  v_allowed boolean;
  v_limit integer := least(greatest(coalesce(p_limit,20),1),50);
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('reports.finance',p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE='42501';
  END IF;
  v_buildings := public.copilot_org_scope_buildings_v1('reports_finance.collection_cycle',p_organization_id);
  -- The handed-over amount cannot be partitioned by building, even for self.
  SELECT s.org_wide INTO v_allowed
    FROM app_private.authorized_scope_v3('reports_finance.collection_cycle',p_organization_id) s;
  IF NOT coalesce(v_allowed,false) THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  v_cashbooks := app_private.copilot_scope_cashbooks_v1('cashbooks.view',p_organization_id);
  p_tu := coalesce(p_tu,date_trunc('month',public.org_today_v1(p_organization_id))::date);
  p_den := coalesce(p_den,public.org_today_v1(p_organization_id));
  IF p_tu>p_den OR p_den-p_tu>1096 THEN RAISE EXCEPTION 'invalid_date_window' USING ERRCODE='22023'; END IF;
  WITH buildings AS MATERIALIZED (
    SELECT b.id,b.name FROM public.buildings b WHERE b.organization_id=p_organization_id
      AND b.id=ANY(v_buildings) AND b.deleted_at IS NULL AND NOT coalesce(b.is_virtual,false)
      AND (public.is_super_admin() OR EXISTS (
        SELECT 1 FROM public.staff_assignments sa
        WHERE sa.organization_id=p_organization_id AND sa.staff_id=auth.uid()
          AND ((sa.building_id IS NULL AND sa.area_id IS NULL) OR sa.building_id=b.id
            OR EXISTS (SELECT 1 FROM public.area_buildings ab
              WHERE ab.organization_id=p_organization_id AND ab.area_id=sa.area_id AND ab.building_id=b.id))
      ))
  ), invoices AS MATERIALIZED (
    SELECT i.* FROM public.invoices i JOIN buildings b ON b.id=i.building_id
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL
  ), receipts AS MATERIALIZED (
    SELECT p.* FROM public.payment_receipt_events p JOIN invoices i ON i.id=p.invoice_id
    WHERE p.organization_id=p_organization_id
  ), sessions AS MATERIALIZED (
    SELECT h.* FROM public.cash_handovers h
    JOIN public.accounts a ON a.id=h.from_account_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual
    JOIN public.accounts dest ON dest.id=h.to_account_id AND dest.organization_id=p_organization_id
    WHERE h.organization_id=p_organization_id AND h.giver_id=auth.uid() AND h.status='CONFIRMED'
      AND h.from_account_id=ANY(v_cashbooks)
      AND h.from_account_id IN (SELECT cashbook_id FROM app_private.ie_visible_cashbook_ids_v1())
      AND h.confirmed_at::date BETWEEN p_tu AND p_den
  ), balances AS (
    SELECT b.id,b.name,coalesce(sum(i.total_amount),0) AS billed,coalesce(sum(i.paid_amount),0) AS paid,
      coalesce(sum(i.remaining_amount),0) AS outstanding,count(i.id) FILTER(WHERE i.remaining_amount>0) AS unpaid
    FROM buildings b LEFT JOIN invoices i ON i.building_id=b.id AND i.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED') GROUP BY b.id,b.name
  ), milestones AS (
    -- Calculate predecessor over ALL sessions before limiting output. CURRENT
    -- always starts at the real last handover, never the last displayed row.
    SELECT h.id,h.code,h.confirmed_at,h.total_amount,h.confirmed_at::date AS until_date,
      lag(h.confirmed_at::date,1,p_tu-1) OVER(ORDER BY h.confirmed_at,h.id) AS prev_date
    FROM sessions h
  ), bounded AS (
    SELECT * FROM milestones ORDER BY confirmed_at DESC,id LIMIT v_limit
  ), timeline AS (
    SELECT h.*,coalesce((SELECT sum(p.collected_amount) FROM receipts p WHERE p.payment_method<>'CT'
      AND p.payment_date>h.prev_date AND p.payment_date<=h.until_date),0) AS collected,
      coalesce((SELECT sum(i.total_amount-coalesce((SELECT sum(p.applied_amount) FROM receipts p
        WHERE p.invoice_id=i.id AND p.payment_date<=h.until_date),0)) FROM invoices i
        WHERE i.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED') AND i.issue_date<=h.until_date),0) AS outstanding
    FROM bounded h
  )
  SELECT jsonb_build_object('gioi_han',v_limit,'tu',p_tu,'den',p_den,'pham_vi','Các toà bạn quản lý trong phạm vi được cấp quyền; bàn giao của chính bạn trong các sổ được xem.',
    'tong_hop',jsonb_build_object('so_toa',count(*),'tong_len_hoa_don',coalesce(sum(billed),0),
      'da_thu_tat_ca',coalesce(sum(paid),0),'chua_thu_hien_tai',coalesce(sum(outstanding),0),
      'da_thu_trong_ky',coalesce((SELECT sum(p.collected_amount) FROM receipts p WHERE p.payment_method<>'CT' AND p.payment_date BETWEEN p_tu AND p_den),0),
      'da_ban_giao',coalesce((SELECT sum(h.total_amount) FROM sessions h),0),'so_moc',(SELECT count(*) FROM sessions)),
    'toa_nha',coalesce((SELECT jsonb_agg(jsonb_build_object('ten',b.name,'tong_len_hoa_don',b.billed,
      'da_thu',b.paid,'chua_thu',b.outstanding,'hoa_don_chua_xong',b.unpaid) ORDER BY b.outstanding DESC,b.id)
      FROM (SELECT * FROM balances ORDER BY outstanding DESC,id LIMIT v_limit) b),'[]'::jsonb),
    'moc_ban_giao',coalesce((SELECT jsonb_agg(jsonb_build_object('ma',h.code,'ngay',h.confirmed_at,
      'rong',h.total_amount,'thu_trong_doan',h.collected,'chua_thu_tai_moc',h.outstanding) ORDER BY h.confirmed_at DESC,h.id)
      FROM timeline h),'[]'::jsonb),
    'hien_tai',jsonb_build_object('thu_trong_doan',coalesce((SELECT sum(p.collected_amount) FROM receipts p
      WHERE p.payment_method<>'CT' AND p.payment_date>coalesce((SELECT max(h.confirmed_at::date) FROM sessions h),p_tu-1)
      AND p.payment_date<=p_den),0),'chua_thu',coalesce(sum(outstanding),0))) INTO v_result FROM balances;
  RETURN v_result;
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_report_promotions_v1(uuid,date,date,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_promotions_v1(uuid,date,date,uuid,integer) FROM anon;
REVOKE ALL ON FUNCTION public.copilot_report_promotions_v1(uuid,date,date,uuid,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.copilot_report_promotions_v1(uuid,date,date,uuid,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.copilot_report_promotions_v1(uuid,date,date,uuid,integer) TO authenticated;
REVOKE ALL ON FUNCTION public.copilot_report_handover_v1(uuid,date,date,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_handover_v1(uuid,date,date,integer) FROM anon;
REVOKE ALL ON FUNCTION public.copilot_report_handover_v1(uuid,date,date,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.copilot_report_handover_v1(uuid,date,date,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.copilot_report_handover_v1(uuid,date,date,integer) TO authenticated;
REVOKE ALL ON FUNCTION public.copilot_report_collection_cycle_v1(uuid,date,date,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_collection_cycle_v1(uuid,date,date,integer) FROM anon;
REVOKE ALL ON FUNCTION public.copilot_report_collection_cycle_v1(uuid,date,date,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.copilot_report_collection_cycle_v1(uuid,date,date,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.copilot_report_collection_cycle_v1(uuid,date,date,integer) TO authenticated;
COMMIT;
