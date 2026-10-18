-- Đọc báo cáo tài chính dùng chung (web + trợ lý AI, đợt 2 Gói B, 18/10/2026): sổ quỹ, dòng tiền, phân tích tài
-- chính, lợi nhuận cổ đông. Hàm CRM thường — KHÔNG phải hàm của trợ lý — để web chuyển sang gọi sau này (công
-- thức dùng chung đặt trong database). Mô hình INVOKER + RLS (quyết định kiến trúc 18/10, hai review độc lập):
--  * Hàm báo cáo: SECURITY INVOKER, search_path='', từ chối khi current_user<>'authenticated' hoặc auth.uid() NULL;
--    đọc bảng gốc dưới RLS của chính người gọi (KHÔNG chép policy); tự kiểm khoá web của màn tương ứng; lọc đúng
--    một công ty (super admin và người nhiều công ty nhìn được nhiều công ty qua RLS); p_building_ids chỉ thu hẹp
--    (NULL = toàn phạm vi khoá ∩ RLS, '{}' = rỗng). Màn web có RPC thì gọi thẳng RPC đó bên trong.
--  * DEFINER duy nhất: public.finance_my_scope_v1 — helper nhỏ trả phạm vi (toà/sổ) của MỘT khoá cho CHÍNH người
--    gọi (app_private.authorized_scope_v3 không mở cho authenticated).
-- Chỗ web hở thì chặt hơn: hạng mục hạn chế cần restricted_view phủ mọi toà; chốt sổ chỉ sổ nhìn thấy; sổ quỹ đúng
-- một công ty (RPC sổ quỹ của web lọc my_org_ids()). Không DROP, không đổi chữ ký đã phát hành, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.authorized_scope_v3(text,uuid)') IS NULL
    OR to_regprocedure('public.cashflow_by_day(date,date,uuid,uuid)') IS NULL
    OR to_regprocedure('public.list_cashbook_closings_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'finance_shared_requires_crm';
  END IF;
END $requires$;

-- ===== Helper nhỏ =====

-- Phạm vi của MỘT khoá web cho CHÍNH người gọi trong một công ty: orgWide, toà (org_wide ⇒ mọi toà còn sống của
-- công ty), sổ quỹ (scope CASHBOOK). DEFINER vì app_private.authorized_scope_v3 không mở cho authenticated; chỉ các
-- khoá của các màn tài chính dưới đây. Không nhận user khác: luôn auth.uid().
CREATE OR REPLACE FUNCTION public.finance_my_scope_v1(p_organization_id uuid,p_permission text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org_wide boolean; v_buildings uuid[]; v_cashbooks uuid[];
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_permission IS NULL OR NOT p_permission=ANY(ARRAY['reports_finance.daily_cashbook',
      'reports_finance.cash_flow','cashbooks.view','reports_finance.analysis','income_expenses.restricted_view',
      'reports_finance.profit_distribution','shareholder_profit.view']) THEN
    RAISE EXCEPTION 'finance_scope_invalid' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(bool_or(s.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_permission,p_organization_id) s;
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (v_org_wide OR EXISTS(
      SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_organization_id) s WHERE b.id=ANY(COALESCE(s.building_ids,'{}'::uuid[]))));
  SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) INTO v_cashbooks FROM public.accounts a
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND EXISTS(
      SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_organization_id) s WHERE a.id=ANY(COALESCE(s.cashbook_ids,'{}'::uuid[])));
  RETURN jsonb_build_object('allowed',v_org_wide OR cardinality(v_buildings)>0 OR cardinality(v_cashbooks)>0,'orgWide',v_org_wide,
    'buildingIds',to_jsonb(v_buildings),'cashbookIds',to_jsonb(v_cashbooks));
END $fn$;

-- Chữ an toàn cho đầu ra báo cáo: giữ xuống dòng, bỏ ký tự điều khiển, cắt theo ký tự — hàm thuần, gọi được từ hàm
-- INVOKER (bản tương đương phía trợ lý nằm ở app_private, không mở cho authenticated).
CREATE OR REPLACE FUNCTION public.report_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
   translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
   '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END
$fn$;

-- ===== Hàm báo cáo dùng chung (INVOKER + RLS) =====

-- B1 — Sổ quỹ theo ngày như /reports/finance/daily-cashbook (DailyCashbookReport.tsx:50-88; useCashBook.ts:72,114):
-- RPC web cashbook_opening_balance + cashflow_by_day, ngày không phát sinh = 0, tồn cuối = tồn đầu + thu − chi.
-- Sổ: sổ nhìn thấy dưới RLS accounts của ĐÚNG công ty; một sổ (p_cashbook_id) hoặc "Tất cả" — RPC web lọc
-- my_org_ids() nên khi người gọi còn nhìn thấy sổ ngoài tập này (công ty khác) thì gọi từng sổ. Toà: NULL +
-- khoá toàn công ty = MỘT chuỗi building_id NULL ("Tất cả" của web, gồm bút toán không gắn toà); có danh sách thì
-- MỘT chuỗi cho từng toà (tồn đầu/cuối riêng từng toà). Khoá web: reports_finance.daily_cashbook (financeReportRoutes.tsx:41-42).
CREATE OR REPLACE FUNCTION public.cashbook_daily_v1(p_organization_id uuid,p_from date,p_to date,p_cashbook_id uuid DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(building_id uuid,day date,opening numeric,income numeric,expense numeric,closing numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_scope jsonb; v_books uuid[]; v_accounts uuid[]; v_buildings uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'cashbook_daily_denied' USING ERRCODE='42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366 THEN RAISE EXCEPTION 'cashbook_daily_invalid' USING ERRCODE='22023'; END IF;
  v_scope:=public.finance_my_scope_v1(p_organization_id,'reports_finance.daily_cashbook');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'cashbook_daily_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) INTO v_books FROM public.accounts a
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL;
  IF p_cashbook_id IS NOT NULL THEN
    IF NOT p_cashbook_id=ANY(v_books) THEN RAISE EXCEPTION 'cashbook_daily_denied' USING ERRCODE='42501'; END IF;
    v_accounts:=ARRAY[p_cashbook_id];
  ELSIF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  ELSIF EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;
  ELSE v_accounts:=ARRAY[NULL::uuid];
  END IF;
  IF p_building_ids IS NULL AND v_scope->'orgWide'='true'::jsonb THEN v_buildings:=ARRAY[NULL::uuid];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
      FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x
      WHERE v_scope->'buildingIds' ? x::text;
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT b.id AS bid FROM unnest(v_buildings) b(id)
  ), opening AS (
    SELECT bl.bid,COALESCE(sum(public.cashbook_opening_balance(p_from,bl.bid,a.id)),0) AS o FROM bl CROSS JOIN unnest(v_accounts) a(id) GROUP BY bl.bid
  ), flows AS (
    SELECT bl.bid,c.day AS d,sum(c.income) AS i,sum(c.expense) AS e
    FROM bl CROSS JOIN unnest(v_accounts) a(id) CROSS JOIN LATERAL public.cashflow_by_day(p_from,p_to,bl.bid,a.id) c GROUP BY bl.bid,c.day
  ), days AS (
    SELECT bl.bid,g::date AS d,COALESCE(f.i,0) AS i,COALESCE(f.e,0) AS e
    FROM bl CROSS JOIN generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') g
    LEFT JOIN flows f ON f.bid IS NOT DISTINCT FROM bl.bid AND f.d=g::date
  ), running AS (
    SELECT days.bid,days.d,days.i,days.e,COALESCE(opening.o,0)+sum(days.i-days.e) OVER (PARTITION BY days.bid ORDER BY days.d ROWS UNBOUNDED PRECEDING) AS cl
    FROM days LEFT JOIN opening ON opening.bid IS NOT DISTINCT FROM days.bid
  )
  SELECT running.bid,running.d,running.cl-running.i+running.e,running.i,running.e,running.cl FROM running ORDER BY running.bid NULLS FIRST,running.d;
END $fn$;

-- B2 — Dòng tiền năm như /reports/finance/cash-flow (CashFlowReport.tsx:38-75): cashflow_by_day cả năm, không chọn
-- sổ, gộp 12 tháng (YYYY-MM) + 4 quý (YYYY-Q1..Q4) cho từng chuỗi toà như B1. Khoá web: reports_finance.cash_flow (:43).
CREATE OR REPLACE FUNCTION public.cashbook_cash_flow_v1(p_organization_id uuid,p_year integer,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(building_id uuid,period text,income numeric,expense numeric,net numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_scope jsonb; v_books uuid[]; v_accounts uuid[]; v_buildings uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE='42501';
  END IF;
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 THEN RAISE EXCEPTION 'cash_flow_invalid' USING ERRCODE='22023'; END IF;
  v_scope:=public.finance_my_scope_v1(p_organization_id,'reports_finance.cash_flow');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) INTO v_books FROM public.accounts a
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL;
  IF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  ELSIF EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;
  ELSE v_accounts:=ARRAY[NULL::uuid];
  END IF;
  IF p_building_ids IS NULL AND v_scope->'orgWide'='true'::jsonb THEN v_buildings:=ARRAY[NULL::uuid];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
      FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x
      WHERE v_scope->'buildingIds' ? x::text;
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT b.id AS bid FROM unnest(v_buildings) b(id)
  ), flows AS (
    SELECT bl.bid,c.day AS d,c.income AS i,c.expense AS e FROM bl CROSS JOIN unnest(v_accounts) a(id)
    CROSS JOIN LATERAL public.cashflow_by_day(make_date(p_year,1,1),make_date(p_year,12,31),bl.bid,a.id) c
  ), months AS (
    SELECT bl.bid,m.n,COALESCE(sum(f.i),0) AS i,COALESCE(sum(f.e),0) AS e
    FROM bl CROSS JOIN generate_series(1,12) m(n) LEFT JOIN flows f ON f.bid IS NOT DISTINCT FROM bl.bid AND extract(month FROM f.d)=m.n
    GROUP BY bl.bid,m.n
  ), periods AS (
    SELECT months.bid,months.n AS ord,to_char(make_date(p_year,months.n,1),'YYYY-MM') AS p,months.i,months.e FROM months
    UNION ALL
    SELECT months.bid,12+q.n,p_year::text||'-Q'||q.n,sum(months.i),sum(months.e) FROM generate_series(1,4) q(n)
      JOIN months ON (months.n-1)/3+1=q.n GROUP BY months.bid,q.n
  )
  SELECT periods.bid,periods.p,periods.i,periods.e,periods.i-periods.e FROM periods ORDER BY periods.bid NULLS FIRST,periods.ord;
END $fn$;

-- B3 — Danh sách sổ quỹ như /finance/cashbooks (useAccounts.ts:115-202): view accounts_with_balance (security_invoker)
-- + profiles + RPC list_cashbook_visibility_v2, dưới RLS, đúng một công ty, bỏ sổ mã DEMO như phiên thường. Số dư đầu
-- kỳ/tồn quỹ chỉ khi balance_visible như web (không thì NULL). Không trả số tài khoản/ngân hàng/chủ tài khoản. Khoá
-- web: cashbooks.view (settingsRoutes.tsx:61).
CREATE OR REPLACE FUNCTION public.cashbook_list_v1(p_organization_id uuid,p_query text DEFAULT NULL)
RETURNS TABLE(cashbook_id uuid,code text,name text,owner_id uuid,owner_name text,is_virtual boolean,balance_visible boolean,
  initial_amount numeric,current_amount numeric,description text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_query text:=NULLIF(btrim(COALESCE(p_query,'')),'');
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'cashbook_list_denied' USING ERRCODE='42501';
  END IF;
  IF public.finance_my_scope_v1(p_organization_id,'cashbooks.view')->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cashbook_list_denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT a.id,a.code,a.name,a.user_id,p.full_name,COALESCE(a.is_virtual,false),COALESCE(v.balance_visible,false),
    CASE WHEN v.balance_visible THEN a.initial_amount END,CASE WHEN v.balance_visible THEN a.current_amount END,a.description,a.created_at
  FROM public.accounts_with_balance a
  JOIN public.accounts o ON o.id=a.id AND o.organization_id=p_organization_id
  LEFT JOIN public.list_cashbook_visibility_v2() v ON v.cashbook_id=a.id
  LEFT JOIN public.profiles p ON p.id=a.user_id
  WHERE a.deleted_at IS NULL AND COALESCE(a.code,'') NOT ILIKE 'DEMO%'
    AND (v_query IS NULL OR position(lower(v_query) IN lower(concat_ws(' ',a.name,a.code)))>0)
  ORDER BY COALESCE(a.is_virtual,false),a.created_at DESC,a.id;
END $fn$;

-- B4 — Chốt sổ như /finance/cashbooks/closure/:id (CashbookClosureRecord.tsx:126-132; useCashbookClosing.ts): RPC web
-- list_cashbook_closings_v1 (biên bản + đề nghị chờ xác nhận) lọc CHẶT HƠN web — chỉ sổ người gọi nhìn thấy dưới RLS
-- accounts của đúng công ty (web trả mọi sổ cho mọi thành viên); p_cashbook_ids thu hẹp. Khoá web: cashbooks.view.
CREATE OR REPLACE FUNCTION public.cashbook_closings_v1(p_organization_id uuid,p_cashbook_ids uuid[] DEFAULT NULL,p_status text DEFAULT NULL)
RETURNS TABLE(state text,closure_id bigint,request_id uuid,cashbook_id uuid,cashbook_name text,closed_through date,counted_balance numeric,
  system_balance numeric,difference numeric,basis text,proposed_by_name text,confirmer_name text,confirmed_at timestamptz,created_at timestamptz,
  mine_to_confirm boolean,note text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_books uuid[]; v_raw jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'cashbook_closings_denied' USING ERRCODE='42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('PENDING','CONFIRMED') THEN RAISE EXCEPTION 'cashbook_closings_invalid' USING ERRCODE='22023'; END IF;
  IF public.finance_my_scope_v1(p_organization_id,'cashbooks.view')->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cashbook_closings_denied' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(array_agg(a.id),'{}'::uuid[]) INTO v_books FROM public.accounts a
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND (p_cashbook_ids IS NULL OR a.id=ANY(p_cashbook_ids));
  v_raw:=public.list_cashbook_closings_v1(CASE WHEN cardinality(v_books)=1 THEN v_books[1] END);
  RETURN QUERY
  SELECT x.state,x.closure_id,x.request_id,x.cashbook_id,x.cashbook_name,x.closed_through,x.counted_balance,x.system_balance,x.difference,
    x.basis,x.proposed_by_name,x.confirmer_name,x.confirmed_at,x.created_at,x.mine_to_confirm,x.note
  FROM (
    SELECT 0 AS grp,'PENDING'::text AS state,NULL::bigint AS closure_id,(e->>'request_id')::uuid AS request_id,(e->>'cashbook_id')::uuid AS cashbook_id,
      e->>'cashbook_name' AS cashbook_name,(e->>'closed_through')::date AS closed_through,(e->>'counted_balance')::numeric AS counted_balance,
      (e->>'system_balance')::numeric AS system_balance,(e->>'difference')::numeric AS difference,NULL::text AS basis,
      e->>'proposed_by_name' AS proposed_by_name,e->>'confirmer_name' AS confirmer_name,NULL::timestamptz AS confirmed_at,
      (e->>'created_at')::timestamptz AS created_at,COALESCE((e->>'is_mine_to_confirm')::boolean,false) AS mine_to_confirm,e->>'note' AS note
    FROM jsonb_array_elements(COALESCE(v_raw->'pending','[]'::jsonb)) e
    WHERE (p_status IS NULL OR p_status='PENDING') AND (e->>'cashbook_id')::uuid=ANY(v_books)
    UNION ALL
    SELECT 1,'CONFIRMED',(e->>'closure_id')::bigint,NULL::uuid,(e->>'cashbook_id')::uuid,e->>'cashbook_name',(e->>'closed_through')::date,
      (e->>'counted_balance')::numeric,(e->>'system_balance')::numeric,(e->>'difference')::numeric,e->>'basis',e->>'proposed_by_name',
      e->>'confirmed_by_name',(e->>'confirmed_at')::timestamptz,NULL::timestamptz,false,NULL::text
    FROM jsonb_array_elements(COALESCE(v_raw->'closures','[]'::jsonb)) e
    WHERE (p_status IS NULL OR p_status='CONFIRMED') AND (e->>'cashbook_id')::uuid=ANY(v_books)
  ) x
  ORDER BY x.grp,COALESCE(x.created_at,x.closed_through::timestamptz) DESC,x.closure_id DESC NULLS LAST,x.request_id;
END $fn$;

-- B7 — Thu/chi theo hạng mục như "Phân tích tài chính" (useFinancialAnalysis.ts:134-135, mặc định dồn tích như
-- FinancialAnalysisReport.tsx:36): RPC web fa_type_breakdown_accrual / fa_type_breakdown trên toà của khoá
-- reports_finance.analysis: p_building_ids NULL ⇒ gộp mọi toà của khoá (building_id NULL), có danh sách ⇒ từng toà
-- (building_id). Hạng mục hạn chế (income_expense_types.is_restricted) chỉ khi người gọi có
-- income_expenses.restricted_view phủ MỌI toà đó và p_include_restricted không false (chặt hơn web, nơi
-- fa_type_breakdown lộ tổng hạng mục hạn chế cho mọi người có quyền Phân tích tài chính).
CREATE OR REPLACE FUNCTION public.finance_analysis_type_breakdown_v1(p_organization_id uuid,p_from date,p_to date,p_accrual boolean DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,p_include_restricted boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_scope jsonb; v_restricted jsonb; v_buildings uuid[]; v_ok boolean; v_rows jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'type_breakdown_denied' USING ERRCODE='42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to<p_from THEN RAISE EXCEPTION 'type_breakdown_invalid' USING ERRCODE='22023'; END IF;
  v_scope:=public.finance_my_scope_v1(p_organization_id,'reports_finance.analysis');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'type_breakdown_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
    FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x WHERE v_scope->'buildingIds' ? x::text;
  v_restricted:=public.finance_my_scope_v1(p_organization_id,'income_expenses.restricted_view');
  v_ok:=COALESCE(p_include_restricted,true) AND cardinality(v_buildings)>0
    AND NOT EXISTS(SELECT 1 FROM unnest(v_buildings) b(id) WHERE NOT (v_restricted->'buildingIds') ? b.id::text);
  WITH groups AS (
    SELECT NULL::uuid AS bid,v_buildings AS ids WHERE p_building_ids IS NULL AND cardinality(v_buildings)>0
    UNION ALL SELECT b.id,ARRAY[b.id] FROM unnest(v_buildings) b(id) WHERE p_building_ids IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('building_id',g.bid,'month',t.month,'side',t.side,'type_id',t.type_id,'type_name',t.type_name,
      'category',t.category,'total_amount',COALESCE(t.total_amount,0),'voucher_count',COALESCE(t.voucher_count,0))
      ORDER BY g.bid NULLS FIRST,t.month,t.side,t.total_amount DESC,t.type_name,t.type_id),'[]'::jsonb)
    INTO v_rows
    FROM groups g CROSS JOIN LATERAL (SELECT * FROM public.fa_type_breakdown_accrual(p_from,p_to,g.ids) WHERE COALESCE(p_accrual,true)
      UNION ALL SELECT * FROM public.fa_type_breakdown(p_from,p_to,g.ids) WHERE NOT COALESCE(p_accrual,true)) t
    WHERE v_ok OR t.type_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.income_expense_types it WHERE it.id=t.type_id AND it.is_restricted);
  RETURN jsonb_build_object('restricted_included',v_ok,'rows',v_rows);
END $fn$;

-- B7 — "Top 10 khoản chi" của Phân tích tài chính (ExpenseTab.tsx:61-83: income_expenses EXPENSE, APPROVED, kqkd_amount>0
-- trong kỳ, đọc qua RLS — kể cả policy phiếu hạn chế) trên toà của khoá reports_finance.analysis ∩ p_building_ids.
-- Khác web: xếp theo số tiền trên CẢ kỳ (web lấy 100 phiếu mới nhất rồi mới xếp, nên sai khi tháng có >100 phiếu chi).
-- Trả has_restricted_item và user_id để người gọi siết thêm.
CREATE OR REPLACE FUNCTION public.finance_analysis_top_expenses_v1(p_organization_id uuid,p_start_date date,p_end_date date,
  p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT NULL)
RETURNS TABLE(voucher_id uuid,voucher_date date,code text,name text,building_id uuid,building_name text,item_types text,
  total_amount numeric,has_restricted_item boolean,user_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_scope jsonb; v_buildings uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'top_expenses_denied' USING ERRCODE='42501';
  END IF;
  v_scope:=public.finance_my_scope_v1(p_organization_id,'reports_finance.analysis');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'top_expenses_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
    FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x WHERE v_scope->'buildingIds' ? x::text;
  RETURN QUERY
  SELECT ie.id,ie.voucher_date,ie.code,ie.name,ie.building_id,b.name,
    (SELECT string_agg(DISTINCT t.name,', ' ORDER BY t.name) FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE it.income_expense_id=ie.id),
    ie.total_amount,ie.has_restricted_item,ie.user_id
  FROM public.income_expenses ie
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL
    AND ie.type='EXPENSE' AND ie.approval_status='APPROVED' AND ie.kqkd_amount>0
    AND ie.voucher_date BETWEEN p_start_date AND p_end_date AND ie.building_id=ANY(v_buildings)
  ORDER BY ie.total_amount DESC,ie.voucher_date DESC,ie.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),100);
END $fn$;

-- B10 (tự xem) — tab "Tổng quan" của cổ đông (ShareholderSelfView.tsx; useShareholderProfit.ts:233-282): phân bổ kèm kỳ
-- chốt, phiếu chi chia LN gắn cổ đông, tên toà qua RPC get_my_share_buildings (cổ đông không đọc được bảng buildings) —
-- dưới RLS. CHỈ phần của người gọi trong đúng công ty. Khoá web của tab: reports_finance.profit_distribution
-- (ProfitHubPage.tsx:44,57).
CREATE OR REPLACE FUNCTION public.profit_my_share_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_id uuid; v_name text; v_allocations jsonb; v_payouts jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_share_denied' USING ERRCODE='42501';
  END IF;
  IF public.finance_my_scope_v1(p_organization_id,'reports_finance.profit_distribution')->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'profit_share_denied' USING ERRCODE='42501';
  END IF;
  SELECT s.id,s.name INTO v_id,v_name FROM public.shareholders s
    WHERE s.auth_user_id=auth.uid() AND s.organization_id=p_organization_id AND s.deleted_at IS NULL ORDER BY s.created_at,s.id LIMIT 1;
  IF v_id IS NULL THEN RETURN jsonb_build_object('shareholder',NULL,'allocations','[]'::jsonb,'payouts','[]'::jsonb); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('allocation_id',pa.id,'period_month',pm.period_month,'building_id',pm.building_id,
      'building_name',b.name,'status',pm.status,'percent',pa.percent,'amount',pa.amount) ORDER BY pm.period_month DESC,b.name,pa.id),'[]'::jsonb)
    INTO v_allocations
    FROM public.profit_allocations pa
    LEFT JOIN public.profit_monthly pm ON pm.id=pa.profit_monthly_id
    LEFT JOIN public.get_my_share_buildings() b ON b.id=pm.building_id
    WHERE pa.shareholder_id=v_id AND pa.organization_id=p_organization_id
      AND (p_building_ids IS NULL OR pm.building_id=ANY(p_building_ids));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('voucher_id',ie.id,'voucher_date',ie.voucher_date,'name',ie.name,'building_id',ie.building_id,
      'total_amount',ie.total_amount) ORDER BY ie.voucher_date DESC,ie.id),'[]'::jsonb)
    INTO v_payouts
    FROM public.income_expenses ie
    WHERE ie.organization_id=p_organization_id AND ie.shareholder_id=v_id AND ie.type='EXPENSE' AND ie.approval_status='APPROVED'
      AND ie.deleted_at IS NULL AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids));
  RETURN jsonb_build_object('shareholder',jsonb_build_object('id',v_id,'name',v_name),'allocations',v_allocations,'payouts',v_payouts);
END $fn$;

-- B10 (quản lý) — "Tổng quan" quản lý của Phân bổ lợi nhuận (ProfitOverviewTab.tsx:61-168): được chia/đã ứng/còn lại
-- luỹ kế từng cổ đông còn hiệu lực + tổng LN đã chốt, đọc profit_*/shareholders/income_expenses dưới RLS (dòng nhìn
-- thấy: người tạo, chủ công ty, super admin, chính cổ đông — do policy quyết). Khoá web của tab: shareholder_profit.view
-- (ProfitHubPage.tsx:45,65).
CREATE OR REPLACE FUNCTION public.profit_shareholder_summary_v1(p_organization_id uuid,p_year integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_locked numeric; v_rows jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_summary_denied' USING ERRCODE='42501';
  END IF;
  IF public.finance_my_scope_v1(p_organization_id,'shareholder_profit.view')->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'profit_summary_denied' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(sum(pm.adjusted_profit),0) INTO v_locked FROM public.profit_monthly pm
    WHERE pm.organization_id=p_organization_id AND pm.status='LOCKED';
  WITH sh AS (
    SELECT s.id,s.name FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL
  ), alloc AS (
    SELECT pa.shareholder_id,sum(pa.amount) accrued,
      sum(pa.amount) FILTER (WHERE p_year IS NOT NULL AND extract(year FROM pm.period_month)=p_year) year_accrued
    FROM public.profit_allocations pa LEFT JOIN public.profit_monthly pm ON pm.id=pa.profit_monthly_id
    WHERE pa.organization_id=p_organization_id AND pa.shareholder_id IN (SELECT id FROM sh)
    GROUP BY pa.shareholder_id
  ), paid AS (
    SELECT ie.shareholder_id,sum(ie.total_amount) paid FROM public.income_expenses ie
    WHERE ie.organization_id=p_organization_id AND ie.shareholder_id IN (SELECT id FROM sh) AND ie.type='EXPENSE'
      AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL
    GROUP BY ie.shareholder_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('shareholder_id',sh.id,'name',sh.name,'accrued',COALESCE(alloc.accrued,0),
      'paid',COALESCE(paid.paid,0),'remaining',COALESCE(alloc.accrued,0)-COALESCE(paid.paid,0),
      'year_accrued',CASE WHEN p_year IS NOT NULL THEN COALESCE(alloc.year_accrued,0) END) ORDER BY sh.name,sh.id),'[]'::jsonb)
    INTO v_rows FROM sh LEFT JOIN alloc ON alloc.shareholder_id=sh.id LEFT JOIN paid ON paid.shareholder_id=sh.id;
  RETURN jsonb_build_object('locked_profit',v_locked,'shareholders',v_rows);
END $fn$;

ALTER FUNCTION public.finance_my_scope_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.report_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION public.cashbook_daily_v1(uuid,date,date,uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.cashbook_cash_flow_v1(uuid,integer,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.cashbook_list_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.cashbook_closings_v1(uuid,uuid[],text) OWNER TO postgres;
ALTER FUNCTION public.finance_analysis_type_breakdown_v1(uuid,date,date,boolean,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer) OWNER TO postgres;
ALTER FUNCTION public.profit_my_share_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.profit_shareholder_summary_v1(uuid,integer) OWNER TO postgres;
-- Chỉ vai authenticated (web và trợ lý dưới JWT người dùng); anon/service_role không gọi được.
REVOKE ALL ON FUNCTION public.finance_my_scope_v1(uuid,text),public.report_text_v1(text,integer),public.cashbook_daily_v1(uuid,date,date,uuid,uuid[]),
  public.cashbook_cash_flow_v1(uuid,integer,uuid[]),public.cashbook_list_v1(uuid,text),public.cashbook_closings_v1(uuid,uuid[],text),
  public.finance_analysis_type_breakdown_v1(uuid,date,date,boolean,uuid[],boolean),public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer),
  public.profit_my_share_v1(uuid,uuid[]),public.profit_shareholder_summary_v1(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finance_my_scope_v1(uuid,text),public.report_text_v1(text,integer),public.cashbook_daily_v1(uuid,date,date,uuid,uuid[]),
  public.cashbook_cash_flow_v1(uuid,integer,uuid[]),public.cashbook_list_v1(uuid,text),public.cashbook_closings_v1(uuid,uuid[],text),
  public.finance_analysis_type_breakdown_v1(uuid,date,date,boolean,uuid[],boolean),public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer),
  public.profit_my_share_v1(uuid,uuid[]),public.profit_shareholder_summary_v1(uuid,integer) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
