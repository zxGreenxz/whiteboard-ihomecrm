-- Dòng tiền ra/vào công ty: tách khỏi chuyển động sổ quỹ dùng đối chiếu số dư.
-- Không thay cashflow_by_day, opening balance, posting hay dữ liệu phiếu.
-- Báo cáo trình bày lịch sử đã điều chỉnh theo trạng thái hiện tại: một bút toán
-- đã hoàn tác và bút toán đảo không tạo thu/chi, kể cả hai ngày khác tháng/năm.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- DEFINER để nhận ra cặp hoàn tác và hạng mục nội bộ dù dòng đối ứng bị RLS
-- che. Mọi dòng trả về vẫn tự kiểm org, quyền báo cáo, toà, quyền giữ/xem sổ
-- và quyền xem phiếu hạn chế. INVOKER gọi qua public để không cấp USAGE app_private.
CREATE OR REPLACE FUNCTION public.cash_flow_external_rows_v1(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(day date, building_id uuid, signed_amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_scope jsonb;
  v_can_restricted boolean;
  v_demo_users uuid[];
  r record;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
    OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end OR p_end - p_start > 1096 THEN
    RAISE EXCEPTION 'cash_flow_invalid' USING ERRCODE = '22023';
  END IF;
  v_scope := public.finance_my_scope_v1(p_organization_id, 'reports_finance.cash_flow');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  v_can_restricted := COALESCE(public.can_view_restricted_ie(), false);
  v_demo_users := public.demo_user_ids();

  FOR r IN
    SELECT p.posted_on, ie.building_id, pl.signed_amount, pl.line_kind,
      p.voucher_amount_snapshot, items.internal_amount, items.external_amount,
      (SELECT count(*) FROM public.income_expense_posting_lines all_lines
       WHERE all_lines.posting_id = p.id AND all_lines.organization_id = p_organization_id) AS line_count
    FROM public.income_expense_postings p
    JOIN public.organizations org ON org.id = p.organization_id AND NOT org.is_demo
    JOIN public.income_expense_posting_lines pl
      ON pl.posting_id = p.id AND pl.organization_id = p.organization_id
    JOIN public.accounts a ON a.id = pl.account_id AND a.organization_id = p.organization_id
      AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false)
      AND NOT COALESCE(a.user_id = ANY(v_demo_users), false)
    LEFT JOIN public.income_expenses ie
      ON ie.id = p.voucher_id AND ie.organization_id = p.organization_id
    LEFT JOIN public.buildings b ON b.id = ie.building_id AND b.organization_id = p.organization_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(item.amount) FILTER (WHERE item.is_transfer), 0) AS internal_amount,
        COALESCE(sum(item.amount) FILTER (WHERE NOT item.is_transfer), 0) AS external_amount
      FROM (
        SELECT COALESCE(i.amount, i.quantity * i.unit_price, 0) AS amount,
          COALESCE(t.rule_key = 'noi_bo' OR canonical.rule_key = 'noi_bo', false)
          OR public.nrm_vn(t.name) IN ('ban giao tien mat', 'nhan ban giao tien mat', 'chuyen tien noi bo', 'nhan tien noi bo')
          OR public.nrm_vn(canonical.name) IN ('ban giao tien mat', 'nhan ban giao tien mat', 'chuyen tien noi bo', 'nhan tien noi bo') AS is_transfer
        FROM public.income_expense_items i
        JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
          AND t.organization_id = p.organization_id
        LEFT JOIN public.income_expense_types canonical ON canonical.id = t.merged_into_id
          AND canonical.organization_id = p.organization_id
        WHERE i.income_expense_id = ie.id
          AND (i.organization_id = p.organization_id OR i.organization_id IS NULL)
      ) item
    ) items ON true
    WHERE p.organization_id = p_organization_id
      -- Dấu hiệu demo/sandbox chính thức, kể cả dữ liệu thử trong org thật.
      -- DEFINER phải giữ các restriction này của accounts/buildings/income_expenses.
      AND NOT COALESCE(p.organization_id = ANY(public.sandbox_org_ids()), false)
      AND NOT COALESCE(ie.user_id = ANY(v_demo_users), false)
      AND NOT COALESCE(b.user_id = ANY(v_demo_users), false)
      AND p.event_kind = 'POSTING'
      AND p.posted_on BETWEEN p_start AND p_end
      AND (p.voucher_id IS NULL OR ie.id IS NOT NULL)
      AND pl.account_id IN (SELECT visible.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() visible)
      AND (b.id IS NOT NULL AND public.can_access_building(b.id)
          AND (v_scope->'orgWide' = 'true'::jsonb OR v_scope->'buildingIds' ? b.id::text)
        OR ie.building_id IS NULL AND v_scope->'orgWide' = 'true'::jsonb)
      AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
      AND (NOT COALESCE(ie.has_restricted_item, false) OR ie.user_id = auth.uid() OR v_can_restricted)
      -- handover_id nằm trên phiếu thu gốc: phải GIỮ phiếu đó. Chỉ loại phiếu chuyển.
      AND ie.handover_transfer_id IS NULL
      AND COALESCE(ie.system_source, '') <> 'handover.transfer'
      -- Không giới hạn ngày/sổ/toà của dòng đảo: đổi kỳ hoặc che dòng đối ứng
      -- không được làm sống lại khoản đã huỷ. Không ghép bằng số tiền/ngày/tên.
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_postings reversal
        WHERE reversal.organization_id = p.organization_id
          AND reversal.reversal_of_id = p.id AND reversal.event_kind = 'REVERSAL'
      )
      -- Chế độ cũ tạo phiếu chi đối ứng thay vì chỉ một event REVERSAL.
      -- Phiếu hoàn cọc/hoàn tiền thật không có liên kết này, vẫn được giữ.
      AND ie.reversal_of_income_expense_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expenses counter
        JOIN public.income_expense_postings counter_posting
          ON counter_posting.voucher_id = counter.id AND counter_posting.organization_id = counter.organization_id
          AND counter_posting.event_kind = 'POSTING'
        WHERE counter.organization_id = p.organization_id AND counter.reversal_of_income_expense_id = ie.id
          AND NOT EXISTS (
            SELECT 1 FROM public.income_expense_postings counter_reversal
            WHERE counter_reversal.organization_id = counter_posting.organization_id
              AND counter_reversal.reversal_of_id = counter_posting.id AND counter_reversal.event_kind = 'REVERSAL'
          )
      )
  LOOP
    IF r.internal_amount > 0 THEN
      IF r.external_amount = 0 THEN CONTINUE; END IF;
      -- Dòng posting không nối từng item. Chỉ tách phiếu trộn khi phép khớp
      -- là chính xác: một MAIN, không thối/làm tròn, tổng item khớp snapshot.
      -- Không suy tỷ lệ hay loại luôn cả phần thu/chi thật của phiếu trộn.
      IF r.line_count <> 1 OR r.line_kind IS DISTINCT FROM 'MAIN'
        OR abs(r.signed_amount) <> r.internal_amount + r.external_amount
        OR r.voucher_amount_snapshot IS DISTINCT FROM r.internal_amount + r.external_amount THEN
        RAISE EXCEPTION 'cash_flow_mixed_transfer_items: Cần tách hạng mục chuyển tiền nội bộ khỏi phiếu thu/chi có nhiều dòng tiền.'
          USING ERRCODE = '22023';
      END IF;
      signed_amount := sign(r.signed_amount) * r.external_amount;
    ELSE
      signed_amount := r.signed_amount;
    END IF;
    day := r.posted_on;
    building_id := r.building_id;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- Chữ ký/output giữ nguyên để web và Hermes dùng một công thức. NULL + quyền
-- toàn công ty trả một chuỗi tổng; phạm vi theo toà trả chuỗi cho từng toà.
CREATE OR REPLACE FUNCTION public.cashbook_cash_flow_v1(
  p_organization_id uuid, p_year integer, p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(organization_id uuid, building_id uuid, period text, income numeric, expense numeric, net numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE v_scope jsonb; v_buildings uuid[];
BEGIN
  IF current_user <> 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'cash_flow_invalid' USING ERRCODE = '22023';
  END IF;
  v_scope := public.finance_my_scope_v1(p_organization_id, 'reports_finance.cash_flow');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  IF p_building_ids IS NULL AND v_scope->'orgWide' = 'true'::jsonb THEN
    v_buildings := ARRAY[NULL::uuid];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_buildings
    FROM unnest(COALESCE(p_building_ids, ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x
    WHERE v_scope->'buildingIds' ? x::text;
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT b.id AS bid FROM unnest(v_buildings) b(id)
  ), external_rows AS MATERIALIZED (
    SELECT * FROM public.cash_flow_external_rows_v1(
      p_organization_id, make_date(p_year, 1, 1), make_date(p_year, 12, 31), p_building_ids)
  ), months AS (
    SELECT bl.bid, m.n,
      COALESCE(sum(f.signed_amount) FILTER (WHERE f.signed_amount > 0), 0) AS i,
      COALESCE(sum(-f.signed_amount) FILTER (WHERE f.signed_amount < 0), 0) AS e
    FROM bl CROSS JOIN generate_series(1, 12) m(n)
    LEFT JOIN external_rows f ON (bl.bid IS NULL OR f.building_id = bl.bid) AND extract(month FROM f.day) = m.n
    GROUP BY bl.bid, m.n
  ), periods AS (
    SELECT months.bid, months.n AS ord, to_char(make_date(p_year, months.n, 1), 'YYYY-MM') AS p, months.i, months.e FROM months
    UNION ALL
    SELECT months.bid, 12 + q.n, p_year::text || '-Q' || q.n, sum(months.i), sum(months.e)
    FROM generate_series(1, 4) q(n) JOIN months ON (months.n - 1) / 3 + 1 = q.n GROUP BY months.bid, q.n
  )
  SELECT p_organization_id, periods.bid, periods.p, periods.i, periods.e, periods.i - periods.e
  FROM periods ORDER BY periods.bid NULLS FIRST, periods.ord;
END
$fn$;

ALTER FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) TO authenticated;
ALTER FUNCTION public.cashbook_cash_flow_v1(uuid,integer,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cashbook_cash_flow_v1(uuid,integer,uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_cash_flow_v1(uuid,integer,uuid[]) TO authenticated;
COMMENT ON FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) IS
  'Current corrected external cash movement, selected real organization, real visible cashbooks and report building scope. Reversed posting/counter-voucher pairs and internal handovers excluded. Does not alter cashbook balance readers.';
COMMENT ON FUNCTION public.cashbook_cash_flow_v1(uuid,integer,uuid[]) IS
  'Monthly/quarterly external cash flow for web and Hermes; selected organization, excludes demo/virtual cashbooks/internal handovers/reversed pairs. Income/expense are cash movements, not P&L.';
COMMIT;
