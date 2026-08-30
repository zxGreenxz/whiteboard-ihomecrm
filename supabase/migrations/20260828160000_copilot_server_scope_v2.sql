-- Server-derived organization boundaries for Copilot read tools.
-- Every public wrapper resolves the effective scope from the authenticated actor;
-- client-provided building arrays are intentionally not accepted.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1(
  p_permission_key text,
  p_organization_id uuid
)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_scope uuid[];
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id AND o.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  SELECT CASE WHEN s.org_wide THEN COALESCE((SELECT array_agg(b.id) FROM public.buildings b WHERE b.organization_id = p_organization_id AND b.deleted_at IS NULL), '{}'::uuid[]) ELSE COALESCE(s.building_ids, '{}'::uuid[]) END
    INTO v_scope FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s;
  IF COALESCE(cardinality(v_scope), 0) = 0 THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  RETURN v_scope;
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_available_rooms_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_buildings uuid[]; v_today date;
BEGIN
  v_buildings := public.copilot_org_scope_buildings_v1('rooms.view', p_organization_id);
  IF COALESCE(cardinality(v_buildings), 0) = 0 THEN RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL); END IF;
  v_today := public.org_today_v1(p_organization_id);
  RETURN jsonb_build_object(
    'areas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name)
      FROM public.areas a
      WHERE a.organization_id = p_organization_id
        AND a.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM public.area_buildings ab WHERE ab.area_id = a.id AND ab.building_id = ANY(v_buildings))
    ), '[]'::jsonb),
    'buildings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code,
        'area_ids', COALESCE((SELECT jsonb_agg(ab.area_id ORDER BY ab.area_id) FROM public.area_buildings ab WHERE ab.building_id = b.id AND ab.organization_id = p_organization_id), '[]'::jsonb),
        'district', b.district, 'ward', b.ward,
        'address', CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address ELSE concat_ws(', ', NULLIF(b.street_address, ''), NULLIF(b.ward, ''), NULLIF(b.district, ''), NULLIF(b.province, '')) END,
        'total_floors', b.total_floors, 'floor_layouts', b.floor_layouts, 'images', COALESCE(b.images,'[]'::jsonb),
        'public_contact_name', b.public_contact_name, 'public_contact_phone', b.public_contact_phone, 'public_map_url', b.public_map_url, 'public_lift_type', b.public_lift_type
      ) ORDER BY b.name)
      FROM public.buildings b
      WHERE b.id = ANY(v_buildings)
        AND b.organization_id = p_organization_id
        AND b.deleted_at IS NULL
        AND b.is_virtual = false
        AND EXISTS (
          SELECT 1
          FROM public.rooms br
          LEFT JOIN public.room_pass_listings bpl ON bpl.room_id = br.id AND bpl.user_id = b.user_id AND (bpl.organization_id = p_organization_id OR bpl.organization_id IS NULL) AND bpl.active = true
          WHERE br.building_id = b.id AND br.deleted_at IS NULL
            AND (bpl.id IS NOT NULL OR (NOT public.room_has_holding_deposit(br.id) AND br.status = 'AVAILABLE') OR (NOT public.room_has_holding_deposit(br.id) AND EXISTS (
              SELECT 1 FROM public.contracts bc
              WHERE bc.room_id = br.id AND bc.deleted_at IS NULL AND bc.status IN ('ACTIVE','EXTENDED')
                AND ((bc.expected_move_out_date IS NOT NULL AND bc.expected_move_out_date BETWEEN v_today AND v_today + COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id = b.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL) LIMIT 1), 30))
                  OR COALESCE(bc.actual_end_date, bc.end_date) BETWEEN v_today AND v_today + COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id = b.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL) LIMIT 1), 30))
            )))
        )
    ), '[]'::jsonb),
    'rooms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', rs.id, 'building_id', rs.building_id, 'floor', rs.floor, 'name', rs.name, 'code', rs.code,
        'area', rs.area, 'rent_price', rs.rent_price, 'deposit_amount', rs.deposit_amount, 'max_occupants', rs.max_occupants,
        'amenities', COALESCE(rs.amenities,'[]'::jsonb), 'images', COALESCE(rs.images,'[]'::jsonb), 'description', rs.description,
        'sale_note', rs.sale_note, 'room_type', rs.room_type,
        'pass_sale_policy', rs.pass_sale_policy, 'pass_price', rs.pass_price, 'pass_avail_date', rs.pass_avail_date, 'pass_contact_manager', rs.pass_contact_manager,
        'status_public', rs.status_public, 'avail_date', rs.avail_date
      ) ORDER BY rs.floor DESC, rs.name)
      FROM (
        SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price, r.deposit_amount, r.max_occupants,
               r.amenities, r.images, r.description, r.sale_note, r.room_type,
               pl.sale_policy AS pass_sale_policy,
               pl.pass_price, pl.avail_date AS pass_avail_date, COALESCE(pl.contact_manager, false) AS pass_contact_manager,
               CASE
                 WHEN pl.id IS NOT NULL THEN 'pass'
                 WHEN public.room_has_holding_deposit(r.id) THEN 'rented'
                 WHEN EXISTS (
                   SELECT 1 FROM public.contracts c
                   WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
                     AND ((c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                       OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                 ) THEN 'soon'
                 WHEN EXISTS (SELECT 1 FROM public.contracts c WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')) THEN 'rented'
                 WHEN r.status = 'AVAILABLE' THEN 'free'
                 ELSE 'rented'
               END AS status_public,
               CASE
                 WHEN pl.id IS NOT NULL THEN pl.avail_date
                 ELSE (
                   SELECT MIN(CASE WHEN c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30) THEN c.expected_move_out_date ELSE COALESCE(c.actual_end_date, c.end_date) END)
                   FROM public.contracts c
                   WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
                     AND ((c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                       OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                 )
               END AS avail_date
        FROM public.rooms r
        JOIN public.buildings b ON b.id = r.building_id
        LEFT JOIN public.public_room_settings prs ON prs.owner_id = b.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL)
        LEFT JOIN public.room_pass_listings pl ON pl.room_id = r.id AND pl.user_id = b.user_id AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL) AND pl.active = true
        WHERE r.building_id = ANY(v_buildings)
          AND b.organization_id = p_organization_id AND b.deleted_at IS NULL AND b.is_virtual = false
          AND r.deleted_at IS NULL
      ) rs
      WHERE rs.status_public IN ('free','soon','pass')
    ), '[]'::jsonb),
    'contact', NULL
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_invoice_search_v1(p_organization_id uuid, p_billing_month text DEFAULT NULL, p_payment_status text DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'invoice_number',i.invoice_number,'billing_month',i.billing_month,'total_amount',i.total_amount,'status',i.status,'building_id',i.building_id,'building_name',b.name,'room_id',i.room_id,'room_name',r.name) ORDER BY i.billing_month DESC, i.created_at DESC), '[]'::jsonb) FROM public.invoices i
  JOIN public.rooms r ON r.id = i.room_id
  JOIN public.buildings b ON b.id = r.building_id
  WHERE i.organization_id = p_organization_id AND i.deleted_at IS NULL
    AND r.building_id = ANY(public.copilot_org_scope_buildings_v1('invoices.view', p_organization_id))
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (p_payment_status IS NULL OR (p_payment_status = 'paid' AND i.status = 'PAID') OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID') OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID','PARTIAL_PAID')))
    AND (p_search IS NULL OR i.invoice_number ILIKE '%' || p_search || '%'
      OR EXISTS (SELECT 1 FROM public.contract_customers cc JOIN public.customers c ON c.id = cc.customer_id WHERE cc.contract_id = i.contract_id AND c.full_name ILIKE '%' || p_search || '%'));
$$;

CREATE OR REPLACE FUNCTION public.copilot_financial_pnl_v1(p_organization_id uuid, p_start_date date, p_end_date date, p_accrual boolean DEFAULT false)
RETURNS TABLE(month date, building_id uuid, building_name text, is_virtual boolean, revenue numeric, expense numeric, net numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF p_accrual THEN RETURN QUERY SELECT * FROM public.fa_monthly_pnl_accrual(p_start_date, p_end_date, public.copilot_org_scope_buildings_v1('reports_finance.analysis', p_organization_id));
  ELSE RETURN QUERY SELECT * FROM public.fa_monthly_pnl(p_start_date, p_end_date, public.copilot_org_scope_buildings_v1('reports_finance.analysis', p_organization_id)); END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_occupancy_v1(p_organization_id uuid, p_as_of_date date, p_window_days integer DEFAULT 30)
RETURNS TABLE(building_id uuid, building_name text, total integer, occupied integer, reserved integer, maintenance integer, unavailable integer, available integer, occupancy_pct numeric, committed_pct numeric, missed_revenue numeric, generated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT * FROM public.occupancy_snapshot_v2(p_as_of_date, public.copilot_org_scope_buildings_v1('reports_real_estate.occupancy', p_organization_id)); $$;

CREATE OR REPLACE FUNCTION public.copilot_occupancy_upcoming_v1(p_organization_id uuid, p_as_of_date date, p_window_days integer DEFAULT 30)
RETURNS TABLE(contract_id uuid, contract_number text, building_id uuid, building_name text, room_id uuid, room_name text, effective_end_date date, days_remaining integer, rent_price numeric, extension_applied boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT * FROM public.occupancy_upcoming_vacancy_v2(p_as_of_date, p_window_days, public.copilot_org_scope_buildings_v1('reports_real_estate.occupancy', p_organization_id)); $$;

CREATE OR REPLACE FUNCTION public.copilot_invoice_stats_v1(p_organization_id uuid, p_billing_month text DEFAULT NULL)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT public.get_invoice_statistics_v2(NULL, NULL, NULL, NULL, NULL, p_billing_month, NULL, public.copilot_org_scope_buildings_v1('invoices.view', p_organization_id)); $$;

CREATE OR REPLACE FUNCTION public.copilot_deposit_summary_v1(p_organization_id uuid)
RETURNS TABLE(building_id uuid, building_name text, contract_count bigint, expected numeric, held numeric, shortfall_all numeric, shortfall_short numeric, full_count bigint, short_count bigint, first_invoice_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT * FROM public.get_held_deposit_summary(public.copilot_org_scope_buildings_v1('deposits.view', p_organization_id)); $$;

CREATE OR REPLACE FUNCTION public.copilot_cashbook_settlement_v2(p_organization_id uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_scope uuid[]; v_accounts jsonb; v_sessions jsonb; v_recons jsonb;
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id AND o.status = 'ACTIVE') THEN RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023'; END IF;
  SELECT s.cashbook_ids INTO v_scope FROM app_private.authorized_scope_v3('cashbooks.view', p_organization_id) s;
  IF COALESCE(cardinality(v_scope),0) = 0 THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_agg(jsonb_build_object('account_id',a.id,'name',a.name,'is_bank',(a.name ILIKE 'tk%' OR a.bank_name IS NOT NULL),'current_balance',COALESCE(ab.current_amount,0),'period_collected',COALESCE((SELECT sum(ie.total_amount) FROM public.income_expenses ie WHERE ie.account_id=a.id AND ie.type='INCOME' AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL AND ie.handover_transfer_id IS NULL AND ie.voucher_date BETWEEN p_from AND p_to),0),'period_spent',COALESCE((SELECT sum(ie.total_amount) FROM public.income_expenses ie WHERE ie.account_id=a.id AND ie.type='EXPENSE' AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL AND ie.handover_transfer_id IS NULL AND ie.voucher_date BETWEEN p_from AND p_to),0),'period_handed_over',COALESCE((SELECT sum(ch.total_amount) FROM public.cash_handovers ch WHERE ch.from_account_id=a.id AND ch.status='CONFIRMED' AND ch.confirmed_at::date BETWEEN p_from AND p_to),0),'last_reconciliation',(SELECT jsonb_build_object('as_of_date',r.as_of_date,'system_balance',r.system_balance,'counted_balance',r.counted_balance,'diff',r.diff,'status',r.status,'confirmed_at',r.confirmed_at) FROM public.cashbook_reconciliations r WHERE r.account_id=a.id AND r.status='CONFIRMED' ORDER BY r.as_of_date DESC, r.confirmed_at DESC LIMIT 1)) ORDER BY a.name) INTO v_accounts FROM public.accounts a LEFT JOIN public.accounts_with_balance ab ON ab.id=a.id WHERE a.id=ANY(v_scope) AND a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual AND (btrim(a.name) LIKE '%Thu' OR a.name ILIKE 'tk%' OR a.bank_name IS NOT NULL OR EXISTS (SELECT 1 FROM public.cash_handovers ch WHERE ch.from_account_id=a.id)) AND NOT (public.is_super_admin() AND a.organization_id = ANY(public.sandbox_org_ids())) AND NOT ((public.is_super_admin() OR public.is_admin()) AND a.user_id = ANY(public.demo_user_ids()));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code',ch.code,'gross',ch.gross_amount,'expense',ch.expense_amount,'net',ch.total_amount,'voucher_count',ch.voucher_count,'status',ch.status,'confirmed_at',ch.confirmed_at,'created_at',ch.created_at) ORDER BY ch.confirmed_at DESC NULLS LAST, ch.created_at DESC), '[]'::jsonb) INTO v_sessions FROM public.cash_handovers ch LEFT JOIN public.accounts fa ON fa.id=ch.from_account_id LEFT JOIN public.accounts ta ON ta.id=ch.to_account_id WHERE COALESCE(ch.organization_id, fa.organization_id)=p_organization_id AND ch.status='CONFIRMED' AND ch.confirmed_at::date BETWEEN p_from AND p_to AND ch.from_account_id=ANY(v_scope) AND (ch.giver_id=auth.uid() OR ch.receiver_id=auth.uid() OR public.is_admin() OR public.is_super_admin()) AND NOT fa.is_virtual AND NOT (public.is_super_admin() AND COALESCE(ch.organization_id, fa.organization_id) = ANY(public.sandbox_org_ids())) AND NOT ((public.is_super_admin() OR public.is_admin()) AND (COALESCE(fa.user_id = ANY(public.demo_user_ids()), false) OR COALESCE(ta.user_id = ANY(public.demo_user_ids()), false)));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('as_of_date',r.as_of_date,'system_balance',r.system_balance,'counted_balance',r.counted_balance,'diff',r.diff,'status',r.status,'confirmed_at',r.confirmed_at) ORDER BY r.as_of_date DESC), '[]'::jsonb) INTO v_recons FROM public.cashbook_reconciliations r JOIN public.accounts a ON a.id=r.account_id WHERE COALESCE(r.organization_id, a.organization_id)=p_organization_id AND r.status='CONFIRMED' AND r.as_of_date BETWEEN p_from AND p_to AND r.account_id=ANY(v_scope) AND NOT a.is_virtual AND (a.user_id=auth.uid() OR r.proposed_by=auth.uid() OR r.counterparty_id=auth.uid() OR public.same_team(a.user_id) OR public.is_admin() OR public.is_super_admin()) AND NOT (public.is_super_admin() AND COALESCE(r.organization_id, a.organization_id) = ANY(public.sandbox_org_ids())) AND NOT ((public.is_super_admin() OR public.is_admin()) AND a.user_id = ANY(public.demo_user_ids()));
  RETURN jsonb_build_object('from',p_from,'to',p_to,'accounts',COALESCE(v_accounts,'[]'::jsonb),'sessions',v_sessions,'reconciliations',v_recons);
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_available_rooms_v1(uuid), public.copilot_invoice_search_v1(uuid,text,text,text), public.copilot_financial_pnl_v1(uuid,date,date,boolean), public.copilot_occupancy_v1(uuid,date,integer), public.copilot_occupancy_upcoming_v1(uuid,date,integer), public.copilot_invoice_stats_v1(uuid,text), public.copilot_deposit_summary_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.copilot_cashbook_settlement_v2(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copilot_available_rooms_v1(uuid), public.copilot_invoice_search_v1(uuid,text,text,text), public.copilot_financial_pnl_v1(uuid,date,date,boolean), public.copilot_occupancy_v1(uuid,date,integer), public.copilot_occupancy_upcoming_v1(uuid,date,integer), public.copilot_invoice_stats_v1(uuid,text), public.copilot_deposit_summary_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.copilot_cashbook_settlement_v2(uuid,date,date) TO authenticated;
COMMENT ON FUNCTION public.copilot_cashbook_settlement_v2(uuid,date,date) IS 'Read-only org-scoped settlement report; accounts, sessions and reconciliations are all server-derived.';
COMMIT;
