-- Hermes đọc đầy đủ — ĐỢT 2, Gói B: sổ quỹ, dòng tiền, kết quả kinh doanh, lợi nhuận cổ đông, ví cá
-- nhân, biến động số dư (18/10/2026). Chạy SAU 20261018000000_hermes_w2_foundation_v1. Thay thân hai hàm
-- khung của gói (app_private.hermes_w2b_catalog_v1, hermes_w2b_read_v1), thêm hàm phụ app_private.hermes_w2b_*
-- và BỐN hàm đọc dùng chung public.<miền>_*_v1 (web gọi được sau này) cho màn web đang đọc bảng thẳng.
-- Mô hình INVOKER + RLS (quyết định kiến trúc 18/10, hai review độc lập):
--  * Hàm dùng chung: SECURITY INVOKER, search_path='', từ chối khi current_user<>'authenticated' hoặc
--    auth.uid() NULL; đọc bảng gốc dưới RLS của chính người dùng, KHÔNG chép policy; p_building_ids chỉ
--    thu hẹp (NULL = toàn phạm vi RLS, '{}' = rỗng).
--  * Hàm gói: cũng INVOKER (cổng dựng ctx bằng phần DEFINER rồi gọi gói dưới vai authenticated) và tự từ
--    chối khi không chạy dưới vai authenticated. RPC web sẵn có (DEFINER tự kiểm auth.uid()) gọi THẲNG,
--    luôn truyền danh sách toà/sổ tường minh và lọc đúng công ty kết nối (RPC sổ quỹ lọc my_org_ids()).
--    ctx bị giả cũng chỉ ra được những gì RLS/RPC web đã cho chính người đó.
-- Chỗ web hở thì Hermes chặt hơn (ghi lại để báo chủ):
--  * Hạng mục/phiếu HẠN CHẾ (lương, cổ đông…) chỉ hiện khi income_expenses.restricted_view (CRM ∩ Read
--    kết nối ∩ overlay, ctx.scopes) phủ MỌI toà của báo cáo. Web: fa_type_breakdown (SECURITY DEFINER,
--    chỉ can_access_building) lộ tổng hạng mục hạn chế cho mọi người có reports_finance.analysis.
--  * Chốt sổ: chỉ sổ người hỏi nhìn thấy (RLS accounts). Web: list_cashbook_closings_v1
--    (20260730170000:499) chỉ kiểm thành viên ACTIVE ⇒ mọi thành viên thấy chênh lệch mọi sổ.
-- Biến động số dư: số tiền/số dư/nội dung chỉ giải mã được ở Edge bank-event-admin (AES-GCM, khoá ở
-- secret Edge) — SQL không đọc, Hermes chỉ trả siêu dữ liệu.
-- Không DROP, không đổi chữ ký hàm đã phát hành, không gọi hàm của trợ lý cũ, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Chỉ đòi nền đợt 2: RPC web (sổ quỹ, fa_*, Hiệu quả kinh doanh, ví, biến động số dư)
-- đều có trên production từ trước; hàm của gói gọi chúng lúc chạy (plpgsql), thiếu thì chỉ báo cáo đó lỗi.
DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2_gate_v1(jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_w2_catalog_v1(text)') IS NULL
    OR to_regprocedure('app_private.hermes_w2b_read_v1(text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2b_requires_foundation';
  END IF;
END $requires$;

-- ===== Hàm đọc dùng chung (public, web gọi được sau này; chuông báo web ↔ Hermes: Gói Z) =====

-- B3 — danh sách sổ quỹ như /finance/cashbooks (useAccounts.ts:115-202): view accounts_with_balance
-- (security_invoker) + profiles + RPC list_cashbook_visibility_v2, tất cả dưới RLS của người gọi, đúng một
-- công ty, bỏ sổ mã DEMO như phiên thường. Số dư đầu kỳ/tồn quỹ chỉ khi balance_visible như web (không thì
-- NULL). Không trả số tài khoản/ngân hàng/chủ tài khoản. Khoá web: cashbooks.view (settingsRoutes.tsx:61).
CREATE OR REPLACE FUNCTION public.cashbook_list_v1(p_organization_id uuid,p_query text DEFAULT NULL)
RETURNS TABLE(cashbook_id uuid,code text,name text,owner_id uuid,owner_name text,is_virtual boolean,balance_visible boolean,
  initial_amount numeric,current_amount numeric,description text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_query text:=NULLIF(btrim(COALESCE(p_query,'')),'');
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
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

-- B7 — "Top 10 khoản chi" của Phân tích tài chính (ExpenseTab.tsx:61-83: income_expenses EXPENSE, APPROVED,
-- kqkd_amount>0 trong kỳ, đọc qua RLS — kể cả policy phiếu hạn chế). Khác web: xếp theo số tiền trên CẢ tháng
-- (web lấy 100 phiếu mới nhất rồi mới xếp, nên sai khi tháng có >100 phiếu chi). Trả has_restricted_item và
-- user_id để người gọi siết thêm.
CREATE OR REPLACE FUNCTION public.finance_analysis_top_expenses_v1(p_organization_id uuid,p_start_date date,p_end_date date,
  p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 10)
RETURNS TABLE(voucher_id uuid,voucher_date date,code text,name text,building_id uuid,building_name text,item_types text,
  total_amount numeric,has_restricted_item boolean,user_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'top_expenses_denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT ie.id,ie.voucher_date,ie.code,ie.name,ie.building_id,b.name,
    (SELECT string_agg(DISTINCT t.name,', ' ORDER BY t.name) FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE it.income_expense_id=ie.id),
    ie.total_amount,ie.has_restricted_item,ie.user_id
  FROM public.income_expenses ie
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL
    AND ie.type='EXPENSE' AND ie.approval_status='APPROVED' AND ie.kqkd_amount>0
    AND ie.voucher_date BETWEEN p_start_date AND p_end_date
    AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids))
  ORDER BY ie.total_amount DESC,ie.voucher_date DESC,ie.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),100);
END $fn$;

-- B10 (tự xem) — tab "Tổng quan" của cổ đông (ShareholderSelfView.tsx; useShareholderProfit.ts:233-282): phân
-- bổ kèm kỳ chốt, phiếu chi chia LN gắn cổ đông, tên toà qua RPC get_my_share_buildings (cổ đông không đọc
-- được bảng buildings) — dưới RLS. CHỈ phần của người gọi trong đúng công ty. Khoá web của tab:
-- reports_finance.profit_distribution (ProfitHubPage.tsx:44,57).
CREATE OR REPLACE FUNCTION public.profit_my_share_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_id uuid; v_name text; v_allocations jsonb; v_payouts jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
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

-- B10 (quản lý) — "Tổng quan" quản lý của Phân bổ lợi nhuận (ProfitOverviewTab.tsx:61-168): được chia/đã
-- ứng/còn lại luỹ kế từng cổ đông còn hiệu lực + tổng LN đã chốt, đọc profit_*/shareholders/income_expenses
-- dưới RLS (dòng nhìn thấy: người tạo, chủ công ty, super admin, chính cổ đông — do policy quyết). Khoá web
-- của tab: shareholder_profit.view (ProfitHubPage.tsx:45,65).
CREATE OR REPLACE FUNCTION public.profit_shareholder_summary_v1(p_organization_id uuid,p_year integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_locked numeric; v_rows jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
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

-- ===== Hàm phụ của gói =====

-- Chữ an toàn (cùng luật app_private.hermes_full_text_v1 — hàm đó là DEFINER, không mở cho vai authenticated).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
   translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
   '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END
$fn$;

-- Toà của báo cáo = ctx.buildings do cổng tính (CRM ∩ overlay, đã thu hẹp theo buildingId).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_buildings_v1(p_ctx jsonb)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT COALESCE(array_agg(DISTINCT x::uuid ORDER BY x::uuid),'{}'::uuid[])
   FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx->'buildings')='array' THEN p_ctx->'buildings' ELSE '[]'::jsonb END) x
$fn$;

-- Sổ quỹ của báo cáo: sổ của ĐÚNG công ty kết nối mà người hỏi nhìn thấy dưới RLS accounts (chủ sổ, giữ/biết
-- sổ, chủ công ty, super admin — như trang Sổ quỹ); cổng có ctx.cashbookIds thì giao thêm (có khoá mà không
-- phải mảng ⇒ không sổ nào).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_cashbooks_v1(p_ctx jsonb)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 RETURN (SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) FROM public.accounts a
  WHERE a.organization_id=(p_ctx->>'organizationId')::uuid AND a.deleted_at IS NULL
    AND (NOT (p_ctx ? 'cashbookIds') OR jsonb_typeof(p_ctx->'cashbookIds')='array' AND p_ctx->'cashbookIds' ? a.id::text));
END $fn$;

-- Hạng mục/phiếu hạn chế: chỉ khi income_expenses.restricted_view (cổng tính sẵn ở ctx.scopes: CRM ∩
-- registry ∩ Read kết nối ∩ overlay) phủ MỌI toà được đưa vào (chặt hơn can_view_restricted_ie của web:
-- có quyền ở bất kỳ đâu là xem được mọi nơi).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_restricted_ok_v1(p_ctx jsonb,p_buildings uuid[])
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT cardinality(COALESCE(p_buildings,'{}'::uuid[]))>0
   AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'
   AND NOT EXISTS(SELECT 1 FROM unnest(p_buildings) b(id) WHERE NOT (p_ctx->'scopes'->'income_expenses.restricted_view') ? b.id::text)
$fn$;

-- Sổ và toà cần gọi RPC sổ quỹ của web (một sổ/một toà mỗi lượt, tham số đơn như web). Sổ: cashbookId,
-- hoặc NULL (= "Tất cả" của web) khi tập sổ người hỏi nhìn thấy trên MỌI công ty đúng bằng tập sổ của
-- báo cáo, không thì gọi từng sổ (RPC web lọc my_org_ids(): NULL sẽ trộn công ty khác). Toà: NULL (=
-- "Tất cả", gồm bút toán không gắn toà) khi kết nối Toàn tổ chức với khoá toàn công ty; không thì từng toà.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_cashbook_targets_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_books uuid[]:=app_private.hermes_w2b_cashbooks_v1(p_ctx); v_book uuid; v_accounts uuid[]; v_buildings uuid[];
BEGIN
  IF p_params ? 'cashbookId' AND p_params->'cashbookId'<>'null'::jsonb THEN
    v_book:=(p_params->>'cashbookId')::uuid;
    IF NOT v_book=ANY(v_books) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    v_accounts:=ARRAY[v_book];
  ELSIF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  ELSIF EXISTS(SELECT 1 FROM public.accounts v WHERE v.deleted_at IS NULL AND NOT v.id=ANY(v_books)) THEN v_accounts:=v_books;
  ELSE v_accounts:=ARRAY[NULL::uuid];
  END IF;
  v_buildings:=CASE WHEN p_ctx->'orgWide'='true'::jsonb THEN ARRAY[NULL::uuid] ELSE app_private.hermes_w2b_buildings_v1(p_ctx) END;
  RETURN jsonb_build_object('cashbookId',v_book,'accounts',to_jsonb(v_accounts),'buildings',to_jsonb(v_buildings));
END $fn$;

-- B1 — RPC web cashbook_opening_balance + cashflow_by_day (useCashBook.ts:72,114); tồn từng ngày như
-- DailyCashbookReport.tsx:68-88 (ngày không phát sinh = 0, tồn cuối = tồn đầu + thu − chi).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_cashbook_daily_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_today date:=(p_ctx->>'today')::date; v_from date; v_to date; v_targets jsonb; v_accounts uuid[]; v_buildings uuid[];
  v_opening numeric; v_rows jsonb; v_in numeric; v_out numeric;
BEGIN
  v_from:=COALESCE((p_params->>'fromDate')::date,date_trunc('month',v_today)::date);
  v_to:=COALESCE((p_params->>'toDate')::date,v_today);
  IF v_to<v_from OR v_to-v_from>366 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_targets:=app_private.hermes_w2b_cashbook_targets_v1(p_params,p_ctx);
  SELECT COALESCE(array_agg(CASE WHEN e='null'::jsonb THEN NULL ELSE (e#>>'{}')::uuid END),'{}'::uuid[]) INTO v_accounts FROM jsonb_array_elements(v_targets->'accounts') e;
  SELECT COALESCE(array_agg(CASE WHEN e='null'::jsonb THEN NULL ELSE (e#>>'{}')::uuid END),'{}'::uuid[]) INTO v_buildings FROM jsonb_array_elements(v_targets->'buildings') e;
  SELECT COALESCE(sum(public.cashbook_opening_balance(v_from,b.id,a.id)),0) INTO v_opening
    FROM unnest(v_accounts) a(id) CROSS JOIN unnest(v_buildings) b(id);
  WITH flows AS (
    SELECT c.day,sum(c.income) income,sum(c.expense) expense
    FROM unnest(v_accounts) a(id) CROSS JOIN unnest(v_buildings) b(id)
    CROSS JOIN LATERAL public.cashflow_by_day(v_from,v_to,b.id,a.id) c GROUP BY c.day
  ), days AS (
    SELECT d::date AS day,COALESCE(f.income,0) income,COALESCE(f.expense,0) expense
    FROM generate_series(v_from::timestamp,v_to::timestamp,interval '1 day') d LEFT JOIN flows f ON f.day=d::date
  ), running AS (
    SELECT day,income,expense,v_opening+sum(income-expense) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING) closing FROM days
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date',day,'opening',(closing-income+expense)::text,'income',income::text,
      'expense',expense::text,'closing',closing::text) ORDER BY day),'[]'::jsonb),COALESCE(sum(income),0),COALESCE(sum(expense),0)
    INTO v_rows,v_in,v_out FROM running;
  RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('fromDate',v_from,'toDate',v_to,'cashbookId',v_targets->'cashbookId',
      'openingBalance',v_opening::text,'totalIncome',v_in::text,'totalExpense',v_out::text,'closingBalance',(v_opening+v_in-v_out)::text),
    'sourceCapped',false,'unavailable',NULL);
END $fn$;

-- B2 — RPC web cashflow_by_day cho cả năm, không chọn sổ (CashFlowReport.tsx:40), gộp 12 tháng + 4 quý.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_cash_flow_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_year integer; v_targets jsonb; v_accounts uuid[]; v_buildings uuid[]; v_rows jsonb; v_in numeric; v_out numeric;
BEGIN
  v_year:=COALESCE(CASE WHEN p_params->'year'<>'null'::jsonb THEN (p_params->>'year')::integer END,extract(year FROM (p_ctx->>'today')::date)::integer);
  v_targets:=app_private.hermes_w2b_cashbook_targets_v1(p_params-'year',p_ctx);
  SELECT COALESCE(array_agg(CASE WHEN e='null'::jsonb THEN NULL ELSE (e#>>'{}')::uuid END),'{}'::uuid[]) INTO v_accounts FROM jsonb_array_elements(v_targets->'accounts') e;
  SELECT COALESCE(array_agg(CASE WHEN e='null'::jsonb THEN NULL ELSE (e#>>'{}')::uuid END),'{}'::uuid[]) INTO v_buildings FROM jsonb_array_elements(v_targets->'buildings') e;
  WITH flows AS (
    SELECT c.day,c.income,c.expense FROM unnest(v_accounts) a(id) CROSS JOIN unnest(v_buildings) b(id)
    CROSS JOIN LATERAL public.cashflow_by_day(make_date(v_year,1,1),make_date(v_year,12,31),b.id,a.id) c
  ), months AS (
    SELECT m.n,COALESCE(sum(f.income),0) income,COALESCE(sum(f.expense),0) expense
    FROM generate_series(1,12) m(n) LEFT JOIN flows f ON extract(month FROM f.day)=m.n GROUP BY m.n
  ), periods AS (
    SELECT n AS ord,to_char(make_date(v_year,n,1),'YYYY-MM') period,income,expense FROM months
    UNION ALL
    SELECT 12+q.n,v_year::text||'-Q'||q.n,sum(m.income),sum(m.expense) FROM generate_series(1,4) q(n) JOIN months m ON (m.n-1)/3+1=q.n GROUP BY q.n
  )
  SELECT jsonb_agg(jsonb_build_object('period',period,'income',income::text,'expense',expense::text,'net',(income-expense)::text) ORDER BY ord),
      sum(income) FILTER (WHERE ord<=12),sum(expense) FILTER (WHERE ord<=12)
    INTO v_rows,v_in,v_out FROM periods;
  RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('year',v_year,'income',v_in::text,'expense',v_out::text,
    'net',(v_in-v_out)::text),'sourceCapped',false,'unavailable',NULL);
END $fn$;

-- B3 — hàm dùng chung public.cashbook_list_v1, chỉ sổ của báo cáo.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_cashbooks_report_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_books uuid[]:=app_private.hermes_w2b_cashbooks_v1(p_ctx); v_rows jsonb; v_capped boolean;
BEGIN
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
    SELECT row_number() OVER () ord,jsonb_build_object('cashbookId',l.cashbook_id,'code',app_private.hermes_w2b_text_v1(l.code,50),
        'name',app_private.hermes_w2b_text_v1(l.name,200),'ownerName',app_private.hermes_w2b_text_v1(l.owner_name,200),
        'isVirtual',l.is_virtual,'balanceVisible',l.balance_visible,'initialAmount',l.initial_amount::text,'currentAmount',l.current_amount::text,
        'note',app_private.hermes_w2b_text_v1(l.description,300)) item
    FROM public.cashbook_list_v1((p_ctx->>'organizationId')::uuid,p_params->>'query') l
    WHERE l.cashbook_id=ANY(v_books) LIMIT 2000) x;
  RETURN jsonb_build_object('rows',v_rows,'summary',NULL,'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

-- B4 — RPC web list_cashbook_closings_v1 (CashbookClosureRecord.tsx:126), lọc CHẶT HƠN web: chỉ sổ
-- của báo cáo (sổ người hỏi nhìn thấy, đúng công ty).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_cashbook_closings_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_books uuid[]:=app_private.hermes_w2b_cashbooks_v1(p_ctx); v_book uuid; v_status text:=p_params->>'status'; v_raw jsonb; v_rows jsonb;
BEGIN
  IF p_params->'cashbookId'<>'null'::jsonb THEN
    v_book:=(p_params->>'cashbookId')::uuid;
    IF NOT v_book=ANY(v_books) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  END IF;
  v_raw:=public.list_cashbook_closings_v1(v_book);
  WITH items AS (
    SELECT 0 AS grp,(e->>'created_at')::timestamptz sort_at,NULL::bigint sort_id,jsonb_build_object('state','PENDING','closureId',NULL,
        'requestId',(e->>'request_id')::uuid,'cashbookId',(e->>'cashbook_id')::uuid,'cashbookName',app_private.hermes_w2b_text_v1(e->>'cashbook_name',200),
        'closedThrough',(e->>'closed_through')::date,'countedBalance',(e->>'counted_balance')::numeric::text,'systemBalance',(e->>'system_balance')::numeric::text,
        'difference',(e->>'difference')::numeric::text,'basis',NULL,'proposedByName',app_private.hermes_w2b_text_v1(e->>'proposed_by_name',200),
        'confirmerName',app_private.hermes_w2b_text_v1(e->>'confirmer_name',200),'confirmedAt',NULL,
        'createdAt',to_char((e->>'created_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'mineToConfirm',COALESCE((e->>'is_mine_to_confirm')::boolean,false),'note',app_private.hermes_w2b_text_v1(e->>'note',300)) item
    FROM jsonb_array_elements(COALESCE(v_raw->'pending','[]'::jsonb)) e
    WHERE (v_status IS NULL OR v_status='PENDING') AND (e->>'cashbook_id')::uuid=ANY(v_books)
    UNION ALL
    SELECT 1,(e->>'closed_through')::timestamptz,(e->>'closure_id')::bigint,jsonb_build_object('state','CONFIRMED','closureId',(e->>'closure_id')::bigint,
        'requestId',NULL,'cashbookId',(e->>'cashbook_id')::uuid,'cashbookName',app_private.hermes_w2b_text_v1(e->>'cashbook_name',200),
        'closedThrough',(e->>'closed_through')::date,'countedBalance',(e->>'counted_balance')::numeric::text,'systemBalance',(e->>'system_balance')::numeric::text,
        'difference',(e->>'difference')::numeric::text,'basis',app_private.hermes_w2b_text_v1(e->>'basis',60),
        'proposedByName',app_private.hermes_w2b_text_v1(e->>'proposed_by_name',200),'confirmerName',app_private.hermes_w2b_text_v1(e->>'confirmed_by_name',200),
        'confirmedAt',CASE WHEN e->>'confirmed_at' IS NOT NULL THEN to_char((e->>'confirmed_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'createdAt',NULL,'mineToConfirm',false,'note',NULL)
    FROM jsonb_array_elements(COALESCE(v_raw->'closures','[]'::jsonb)) e
    WHERE (v_status IS NULL OR v_status='CONFIRMED') AND (e->>'cashbook_id')::uuid=ANY(v_books)
  )
  SELECT COALESCE(jsonb_agg(item ORDER BY grp,sort_at DESC,sort_id DESC NULLS LAST,item->>'requestId'),'[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM items ORDER BY grp,sort_at DESC,sort_id DESC NULLS LAST LIMIT 2000) capped;
  RETURN jsonb_build_object('rows',v_rows,'summary',NULL,'sourceCapped',jsonb_array_length(v_rows)>=2000,'unavailable',NULL);
END $fn$;

-- B7 — RPC web fa_type_breakdown_accrual / fa_type_breakdown (useFinancialAnalysis.ts:134-135; mặc
-- định dồn tích như FinancialAnalysisReport.tsx:36) trên toà của báo cáo; hạng mục hạn chế chỉ khi
-- restricted_view phủ mọi toà (chặt hơn web).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_fa_type_breakdown_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_buildings uuid[]:=app_private.hermes_w2b_buildings_v1(p_ctx); v_from date:=(p_params->>'fromDate')::date;
  v_to date:=(p_params->>'toDate')::date; v_basis text:=COALESCE(p_params->>'basis','accrual'); v_ok boolean; v_rows jsonb; v_capped boolean;
BEGIN
  v_ok:=app_private.hermes_w2b_restricted_ok_v1(p_ctx,v_buildings);
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.month,x.side,x.total DESC,x.type_name,x.type_id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
    SELECT t.month,t.side,t.total_amount total,t.type_name,t.type_id,jsonb_build_object('month',t.month,'side',t.side,'typeId',t.type_id,
        'typeName',app_private.hermes_w2b_text_v1(t.type_name,200),'category',app_private.hermes_w2b_text_v1(t.category,100),
        'totalAmount',COALESCE(t.total_amount,0)::text,'voucherCount',COALESCE(t.voucher_count,0)) item
    FROM (SELECT * FROM public.fa_type_breakdown_accrual(v_from,v_to,v_buildings) WHERE v_basis='accrual'
      UNION ALL SELECT * FROM public.fa_type_breakdown(v_from,v_to,v_buildings) WHERE v_basis='cash') t
    WHERE v_ok OR t.type_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.income_expense_types it WHERE it.id=t.type_id AND it.is_restricted)
    ORDER BY t.month,t.side,t.total_amount DESC,t.type_name,t.type_id LIMIT 2000) x;
  RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('basis',v_basis,'restrictedIncluded',v_ok),'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

-- B7 — bốn RPC web còn lại của Phân tích tài chính (useFinancialAnalysis.ts:159,181,207,235), toà của báo cáo.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_fa_rows_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_buildings uuid[]:=app_private.hermes_w2b_buildings_v1(p_ctx); v_from date:=(p_params->>'fromDate')::date;
  v_to date:=(p_params->>'toDate')::date; v_rows jsonb; v_capped boolean;
BEGIN
  IF p_report='fa_snapshot_kpis' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.n,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT k.building_name n,k.building_id id,jsonb_build_object('buildingId',k.building_id,'buildingName',app_private.hermes_w2b_text_v1(k.building_name,200),
          'totalRooms',k.total_rooms,'roomsAvailable',k.rooms_available,'roomsOccupied',k.rooms_occupied,'roomsReserved',k.rooms_reserved,
          'roomsMaintenance',k.rooms_maintenance,'roomsUnavailable',k.rooms_unavailable,'vacancyLossMonth',k.vacancy_loss_month::text,
          'activeContracts',k.active_contracts,'avgRent',round(k.avg_rent,2)::text,'depositHeld',k.deposit_held::text,'receivableTotal',k.receivable_total::text,
          'agingNotDue',k.aging_not_due::text,'aging1To30',k.aging_1_30::text,'aging31To60',k.aging_31_60::text,'aging61To90',k.aging_61_90::text,
          'agingOver90',k.aging_over_90::text) item
      FROM public.fa_snapshot_kpis(v_buildings) k WHERE k.building_id=ANY(v_buildings) ORDER BY k.building_name,k.building_id LIMIT 2000) x;
  ELSIF p_report='fa_occupancy_monthly' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.m,x.n,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT o.month m,o.building_name n,o.building_id id,jsonb_build_object('month',o.month,'buildingId',o.building_id,
          'buildingName',app_private.hermes_w2b_text_v1(o.building_name,200),'totalRooms',o.total_rooms,'occupiedRooms',o.occupied_rooms,
          'occupancyPct',o.occupancy_pct::text) item
      FROM public.fa_occupancy_monthly(v_from,v_to,v_buildings) o WHERE o.building_id=ANY(v_buildings)
      ORDER BY o.month,o.building_name,o.building_id LIMIT 2000) x;
  ELSIF p_report='fa_lease_events' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.m,x.n,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT e.month m,e.building_name n,e.building_id id,jsonb_build_object('month',e.month,'buildingId',e.building_id,
          'buildingName',app_private.hermes_w2b_text_v1(e.building_name,200),'newContracts',e.new_contracts,'renewals',e.renewals,
          'terminations',e.terminations) item
      FROM public.fa_lease_events(v_from,v_to,v_buildings) e WHERE e.building_id=ANY(v_buildings)
      ORDER BY e.month,e.building_name,e.building_id LIMIT 2000) x;
  ELSIF p_report='fa_invoice_collection' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.m,x.n,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT i.billing_month m,i.building_name n,i.building_id id,jsonb_build_object('billingMonth',app_private.hermes_w2b_text_v1(i.billing_month,7),
          'buildingId',i.building_id,'buildingName',app_private.hermes_w2b_text_v1(i.building_name,200),'billed',i.billed::text,
          'collected',i.collected::text,'remaining',i.remaining::text,'invoiceCount',i.invoice_count,'draftCount',i.draft_count,
          'pendingCount',i.pending_count,'approvedCount',i.approved_count,'paidCount',i.paid_count,'partialCount',i.partial_count,
          'overdueCount',i.overdue_count) item
      FROM public.fa_invoice_collection(to_char(v_from,'YYYY-MM'),to_char(v_to,'YYYY-MM'),v_buildings) i WHERE i.building_id=ANY(v_buildings)
      ORDER BY i.billing_month,i.building_name,i.building_id LIMIT 2000) x;
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('rows',v_rows,'summary',NULL,'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

-- B7 — 10 khoản chi lớn nhất của tháng qua hàm dùng chung; phiếu hạn chế (trừ phiếu của chính người
-- hỏi) chỉ khi restricted_view phủ mọi toà.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_top_expenses_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_buildings uuid[]:=app_private.hermes_w2b_buildings_v1(p_ctx); v_start date:=to_date(p_params->>'month'||'-01','YYYY-MM-DD');
  v_ok boolean; v_rows jsonb;
BEGIN
  v_ok:=app_private.hermes_w2b_restricted_ok_v1(p_ctx,v_buildings);
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb) INTO v_rows FROM (
    SELECT row_number() OVER (ORDER BY t.total_amount DESC,t.voucher_date DESC,t.voucher_id) ord,jsonb_build_object('voucherId',t.voucher_id,
        'voucherDate',t.voucher_date,'code',app_private.hermes_w2b_text_v1(t.code,60),'name',app_private.hermes_w2b_text_v1(t.name,200),
        'buildingId',t.building_id,'buildingName',app_private.hermes_w2b_text_v1(t.building_name,200),
        'itemTypes',app_private.hermes_w2b_text_v1(t.item_types,300),'totalAmount',t.total_amount::text) item
    FROM public.finance_analysis_top_expenses_v1((p_ctx->>'organizationId')::uuid,v_start,(v_start+interval '1 month'-interval '1 day')::date,v_buildings,100) t
    WHERE t.building_id=ANY(v_buildings) AND (NOT t.has_restricted_item OR t.user_id=auth.uid() OR v_ok)
    ORDER BY t.total_amount DESC,t.voucher_date DESC,t.voucher_id LIMIT 10) x;
  RETURN jsonb_build_object('rows',v_rows,'summary',NULL,'sourceCapped',false,'unavailable',NULL);
END $fn$;

-- B8 — toà đưa vào RPC Hiệu quả kinh doanh: ctx.buildings ∩ danh sách toà web cho phép
-- (business_performance_organizations_v1, như trang chọn toà ở BusinessPerformanceReportPage.tsx:264) vì
-- RPC web là "tất cả hoặc không" (42501); báo cáo cần phiếu hạn chế thì thêm restricted_allowed của web
-- ∩ restricted_view của kết nối. Không còn toà thật nào ⇒ '{}' (no_building_scope); có toà nhưng thiếu
-- quyền hạn chế ⇒ 42501 như web.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_bp_buildings_v1(p_ctx jsonb,p_restricted boolean)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_buildings uuid[]:=app_private.hermes_w2b_buildings_v1(p_ctx); v_roster jsonb; v_base uuid[]; v_allowed uuid[];
BEGIN
  SELECT o.authorized_buildings INTO v_roster FROM public.business_performance_organizations_v1() o
    WHERE o.organization_id=(p_ctx->>'organizationId')::uuid;
  SELECT COALESCE(array_agg(DISTINCT (e->>'id')::uuid),'{}'::uuid[]),
      COALESCE(array_agg(DISTINCT (e->>'id')::uuid) FILTER (WHERE NOT p_restricted OR (e->>'restricted_allowed')::boolean IS TRUE
        AND app_private.hermes_w2b_restricted_ok_v1(p_ctx,ARRAY[(e->>'id')::uuid])),'{}'::uuid[])
    INTO v_base,v_allowed
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_roster)='array' THEN v_roster ELSE '[]'::jsonb END) e
    WHERE (e->>'id')::uuid=ANY(v_buildings);
  IF cardinality(v_base)>0 AND cardinality(v_allowed)=0 THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN ARRAY(SELECT unnest(v_allowed) ORDER BY 1);
END $fn$;

-- B8 — bốn RPC web của Hiệu quả kinh doanh (useBusinessPerformance.ts:897; useBusinessPerformanceGatedData.ts:756,785,816).
-- Tiền/tỷ lệ tính trong RPC (thương, tỷ lệ) làm tròn 2 chữ số để vừa khuôn tiền của broker.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_bp_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_org uuid:=(p_ctx->>'organizationId')::uuid; v_allowed uuid[]; v_from date:=(p_params->>'fromDate')::date; v_to date:=(p_params->>'toDate')::date;
  v_basis text:=CASE p_params->>'basis' WHEN 'cash' THEN 'VOUCHER_DATE' ELSE 'ACCRUAL' END; v_month date; v_rows jsonb; v_capped boolean:=false;
BEGIN
  v_allowed:=app_private.hermes_w2b_bp_buildings_v1(p_ctx,true);
  IF cardinality(v_allowed)=0 THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','no_building_scope');
  END IF;
  IF p_params ? 'month' THEN v_month:=to_date(p_params->>'month'||'-01','YYYY-MM-DD'); END IF;
  IF p_report='bp_pnl' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.m,x.n,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT p.month m,p.building_name n,p.building_id id,jsonb_build_object('month',p.month,'buildingId',p.building_id,
          'buildingName',app_private.hermes_w2b_text_v1(p.building_name,200),'revenue',p.revenue::text,'expense',p.expense::text,'net',p.net::text) item
      FROM public.business_performance_pnl_v1(v_org,v_basis,v_from,v_to,v_allowed) p
      WHERE p.building_id=ANY(v_allowed) AND NOT COALESCE(p.is_virtual,false) ORDER BY p.month,p.building_name,p.building_id LIMIT 2000) x;
  ELSIF p_report='bp_cohort' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.n,x.id),'[]'::jsonb) INTO v_rows FROM (
      SELECT c.building_name n,c.building_id id,jsonb_build_object('buildingId',c.building_id,'buildingName',app_private.hermes_w2b_text_v1(c.building_name,200),
          'cohortMonth',c.cohort_month,'cohortAvailable',COALESCE(c.cohort_available,false),'billed',round(COALESCE(c.billed_current_charge,0),2)::text,
          'collected',round(COALESCE(c.collected_current_charge,0),2)::text,'remaining',round(COALESCE(c.remaining_current_charge,0),2)::text,
          'collectionRatePct',round(c.collection_rate_pct,2)::text,'invoiceCount',COALESCE(c.invoice_count,0),
          'carriedInvoiceDebt',round(COALESCE(c.carried_invoice_debt,0),2)::text,'carriedDepositDebt',round(COALESCE(c.carried_deposit_debt,0),2)::text,
          'currentDeposit',round(COALESCE(c.current_deposit,0),2)::text,'draftPendingCount',COALESCE(c.draft_pending_count,0),
          'draftPendingAmount',round(COALESCE(c.draft_pending_amount,0),2)::text,'settlementCount',COALESCE(c.settlement_count,0),
          'settlementAmount',round(COALESCE(c.settlement_amount,0),2)::text) item
      FROM public.business_performance_invoice_cohort_v1(v_org,v_month,v_allowed) c WHERE c.building_id=ANY(v_allowed)) x;
  ELSIF p_report='bp_cash_received' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.n,x.id),'[]'::jsonb) INTO v_rows FROM (
      SELECT r.building_name n,r.building_id id,jsonb_build_object('buildingId',r.building_id,'buildingName',app_private.hermes_w2b_text_v1(r.building_name,200),
          'cashMonth',r.cash_month,'cashReceived',round(COALESCE(r.cash_received,0),2)::text,'paymentEventCount',COALESCE(r.payment_event_count,0),
          'firstPaymentDate',r.first_payment_date,'lastPaymentDate',r.last_payment_date) item
      FROM public.business_performance_cash_received_v1(v_org,v_month,v_allowed) r WHERE r.building_id=ANY(v_allowed)) x;
  ELSIF p_report='bp_categories' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.m,x.s,x.total DESC,x.n,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT k.month m,k.side s,k.total_amount total,k.type_name n,k.type_id id,jsonb_build_object('month',k.month,'side',k.side,'typeId',k.type_id,
          'typeName',app_private.hermes_w2b_text_v1(k.type_name,200),'category',app_private.hermes_w2b_text_v1(k.category,100),
          'totalAmount',COALESCE(k.total_amount,0)::text,'voucherCount',COALESCE(k.voucher_count,0)) item
      FROM public.business_performance_category_breakdown_v1(v_org,v_basis,v_from,v_to,v_allowed) k
      ORDER BY k.month,k.side,k.total_amount DESC,k.type_name,k.type_id LIMIT 2000) x;
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('rows',v_rows,'summary',NULL,'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

-- B10 — hai hàm dùng chung lợi nhuận cổ đông.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_profit_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_org uuid:=(p_ctx->>'organizationId')::uuid; v_buildings uuid[]; v_year integer; v_raw jsonb; v_rows jsonb; v_capped boolean:=false;
  v_accrued numeric; v_paid numeric;
BEGIN
  IF p_params->'year'<>'null'::jsonb THEN v_year:=(p_params->>'year')::integer; END IF;
  IF p_report='profit_my_share' THEN
    v_buildings:=app_private.hermes_w2b_buildings_v1(p_ctx);
    v_raw:=public.profit_my_share_v1(v_org,v_buildings);
    IF v_raw->'shareholder'='null'::jsonb THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',jsonb_build_object('isShareholder',false,'shareholderName',NULL,'accrued','0',
        'paid','0','remaining','0','allocations',0,'payouts',0),'sourceCapped',false,'unavailable',NULL);
    END IF;
    SELECT COALESCE(sum((a->>'amount')::numeric),0) INTO v_accrued FROM jsonb_array_elements(v_raw->'allocations') a
      WHERE (a->>'building_id')::uuid=ANY(v_buildings);
    SELECT COALESCE(sum((p->>'total_amount')::numeric),0) INTO v_paid FROM jsonb_array_elements(v_raw->'payouts') p
      WHERE (p->>'building_id')::uuid=ANY(v_buildings);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT a.ord,jsonb_build_object('periodMonth',(a.e->>'period_month')::date,'buildingId',(a.e->>'building_id')::uuid,
          'buildingName',app_private.hermes_w2b_text_v1(a.e->>'building_name',200),'status',a.e->>'status',
          'percent',(a.e->>'percent')::numeric::text,'amount',(a.e->>'amount')::numeric::text) item
      FROM jsonb_array_elements(v_raw->'allocations') WITH ORDINALITY a(e,ord)
      WHERE (a.e->>'building_id')::uuid=ANY(v_buildings) AND (v_year IS NULL OR extract(year FROM (a.e->>'period_month')::date)=v_year)
      ORDER BY a.ord LIMIT 2000) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('isShareholder',true,
        'shareholderName',app_private.hermes_w2b_text_v1(v_raw->'shareholder'->>'name',200),'accrued',v_accrued::text,'paid',v_paid::text,
        'remaining',(v_accrued-v_paid)::text,
        'allocations',(SELECT count(*) FROM jsonb_array_elements(v_raw->'allocations') a WHERE (a->>'building_id')::uuid=ANY(v_buildings)),
        'payouts',(SELECT count(*) FROM jsonb_array_elements(v_raw->'payouts') p WHERE (p->>'building_id')::uuid=ANY(v_buildings))),
      'sourceCapped',v_capped,'unavailable',NULL);
  ELSIF p_report='profit_shareholders' THEN
    v_raw:=public.profit_shareholder_summary_v1(v_org,v_year);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT s.ord,jsonb_build_object('shareholderId',(s.e->>'shareholder_id')::uuid,'name',app_private.hermes_w2b_text_v1(s.e->>'name',200),
          'accrued',(s.e->>'accrued')::numeric::text,'paid',(s.e->>'paid')::numeric::text,'remaining',(s.e->>'remaining')::numeric::text,
          'yearAccrued',(s.e->>'year_accrued')::numeric::text) item
      FROM jsonb_array_elements(v_raw->'shareholders') WITH ORDINALITY s(e,ord) ORDER BY s.ord LIMIT 2000) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('lockedProfit',(v_raw->>'locked_profit')::numeric::text,
        'accrued',(SELECT COALESCE(sum((e->>'accrued')::numeric),0) FROM jsonb_array_elements(v_raw->'shareholders') e)::text,
        'paid',(SELECT COALESCE(sum((e->>'paid')::numeric),0) FROM jsonb_array_elements(v_raw->'shareholders') e)::text,
        'remaining',(SELECT COALESCE(sum((e->>'remaining')::numeric),0) FROM jsonb_array_elements(v_raw->'shareholders') e)::text),
      'sourceCapped',v_capped,'unavailable',NULL);
  END IF;
  RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
END $fn$;

-- B12 — RPC web personal_finance_snapshot (src/lib/personalFinance/service.ts:28-29; INVOKER, mọi bảng lọc
-- user_id=auth.uid()). KHÔNG gọi personal_finance_bootstrap (ghi dữ liệu). Không theo công ty/toà.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_personal_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_snap jsonb; v_rows jsonb; v_capped boolean:=false; v_from date; v_to date; v_kind text; v_query text;
  v_income numeric; v_expense numeric; v_count bigint;
BEGIN
  v_snap:=public.personal_finance_snapshot();
  IF v_snap->>'owner_id' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_report='personal_wallets' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('walletId',(w->>'id')::uuid,'name',app_private.hermes_w2b_text_v1(w->>'name',200),
        'kind',w->>'kind','openingBalance',COALESCE((w->>'opening_balance')::numeric,0)::text,'balance',COALESCE((w->>'balance')::numeric,0)::text,
        'isDefault',COALESCE((w->>'is_default')::boolean,false),'hidden',COALESCE((w->>'hidden')::boolean,false)) ORDER BY ord),'[]'::jsonb),
      COALESCE(sum((w->>'balance')::numeric) FILTER (WHERE NOT COALESCE((w->>'hidden')::boolean,false)),0),count(*)
      INTO v_rows,v_income,v_count FROM jsonb_array_elements(COALESCE(v_snap->'wallets','[]'::jsonb)) WITH ORDINALITY x(w,ord);
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('totalBalance',v_income::text,'wallets',v_count),'sourceCapped',false,'unavailable',NULL);
  ELSIF p_report='personal_transactions' THEN
    v_from:=(p_params->>'fromDate')::date; v_to:=(p_params->>'toDate')::date;
    v_kind:=p_params->>'kind'; v_query:=NULLIF(lower(btrim(COALESCE(p_params->>'query',''))),'');
    WITH tx AS (
      SELECT t.ord,t.e,(t.e->>'txn_date')::date d,t.e->>'type' typ,(t.e->>'amount')::numeric amt,
        COALESCE((SELECT c->>'name' FROM jsonb_array_elements(COALESCE(v_snap->'categories','[]'::jsonb)) c WHERE c->>'id'=t.e->>'resolved_category_id'),t.e->>'category') cat,
        (SELECT w->>'name' FROM jsonb_array_elements(COALESCE(v_snap->'wallets','[]'::jsonb)) w WHERE w->>'id'=t.e->>'resolved_wallet_id') wallet
      FROM jsonb_array_elements(COALESCE(v_snap->'transactions','[]'::jsonb)) WITH ORDINALITY t(e,ord)
    ), picked AS (
      SELECT * FROM tx WHERE (v_from IS NULL OR d>=v_from) AND (v_to IS NULL OR d<=v_to) AND (v_kind IS NULL OR typ=v_kind)
        AND (v_query IS NULL OR position(v_query IN lower(concat_ws(' ',e->>'description',cat)))>0)
    )
    SELECT (SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb) FROM (SELECT p.ord,jsonb_build_object('transactionId',(p.e->>'id')::uuid,
          'date',p.d,'type',p.typ,'amount',p.amt::text,'description',app_private.hermes_w2b_text_v1(p.e->>'description',300),
          'categoryName',app_private.hermes_w2b_text_v1(p.cat,100),'walletName',app_private.hermes_w2b_text_v1(p.wallet,100)) item
        FROM picked p ORDER BY p.ord LIMIT 2000) x),
      COALESCE(sum(amt) FILTER (WHERE typ='INCOME'),0),COALESCE(sum(amt) FILTER (WHERE typ='EXPENSE'),0),count(*)
      INTO v_rows,v_income,v_expense,v_count FROM picked;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('income',v_income::text,'expense',v_expense::text,'transactions',v_count),
      'sourceCapped',v_count>2000,'unavailable',NULL);
  END IF;
  RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
END $fn$;

-- B11 — RPC web bank_event_admin_v1 (chỉ is_super_admin(); 20261009103855): 'status' + 'list_events' KHÔNG
-- kèm withPayload (không lấy bản mã, không ghi dấu vết xem nội dung). Số tiền/số dư/4 số cuối/nội dung chỉ
-- có sau giải mã ở Edge bank-event-admin ⇒ amountsAvailable=false. Ngày lọc theo múi giờ ctx.timezone (cổng chưa cấp thì giờ Việt Nam).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_bank_events_v1(p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_tz text:=COALESCE(p_ctx->>'timezone','Asia/Ho_Chi_Minh');
  v_from date:=(p_params->>'fromDate')::date; v_to date:=(p_params->>'toDate')::date;
  v_status jsonb; v_list jsonb; v_events jsonb; v_rows jsonb;
BEGIN
  IF p_ctx->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_status:=public.bank_event_admin_v1('status','{}'::jsonb);
  v_list:=public.bank_event_admin_v1('list_events',jsonb_strip_nulls(jsonb_build_object('limit',100,
    'from',CASE WHEN v_from IS NOT NULL THEN v_from::timestamp AT TIME ZONE v_tz END,
    'to',CASE WHEN v_to IS NOT NULL THEN (v_to+1)::timestamp AT TIME ZONE v_tz END,
    'eventType',CASE p_params->>'kind' WHEN 'sms' THEN 'sms.received' WHEN 'notification' THEN 'notification.received'
      WHEN 'email' THEN 'email.received' WHEN 'test' THEN 'gateway.test' END)));
  v_events:=CASE WHEN jsonb_typeof(v_list->'events')='array' THEN v_list->'events' ELSE '[]'::jsonb END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('eventId',(e->>'id')::uuid,'sourceName',app_private.hermes_w2b_text_v1(e->>'sourceName',200),
      'eventType',app_private.hermes_w2b_text_v1(e->>'eventType',40),
      'occurredAt',CASE WHEN e->>'occurredAt' IS NOT NULL THEN to_char((e->>'occurredAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'receivedAt',to_char((e->>'receivedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'duplicateCount',COALESCE((e->>'duplicateCount')::bigint,0)) ORDER BY ord),'[]'::jsonb)
    INTO v_rows FROM jsonb_array_elements(v_events) WITH ORDINALITY x(e,ord) WHERE ord<=100;
  RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('totalSources',COALESCE((v_status->>'totalSources')::bigint,0),
      'enabledSources',COALESCE((v_status->>'enabledSources')::bigint,0),'totalEvents',COALESCE((v_status->>'totalEvents')::bigint,0),
      'lastReceivedAt',CASE WHEN v_status->>'lastReceivedAt' IS NOT NULL
        THEN to_char((v_status->>'lastReceivedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'amountsAvailable',false),
    'sourceCapped',jsonb_array_length(v_events)>100,'unavailable',NULL);
END $fn$;

-- ===== Hai hàm của gói mà cổng nền gọi =====

-- Bảng báo cáo gói B (khớp W2B_REPORTS của infra/hermes-broker/wave2-b-contract.mjs; test so khớp).
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT jsonb_build_object(
   'cashbook_daily','{"permission":"reports_finance.daily_cashbook","source":"crm.cashflow_by_day","scope":"buildings","params":["fromDate","toDate","cashbookId","buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'cash_flow','{"permission":"reports_finance.cash_flow","source":"crm.cashflow_by_day","scope":"buildings","params":["year","buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'cashbooks','{"permission":"cashbooks.view","source":"crm.cashbook_list_v1","scope":"organization","params":["query"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'cashbook_closings','{"permission":"cashbooks.view","source":"crm.list_cashbook_closings_v1","scope":"organization","params":["cashbookId","status"],"required":[],"statuses":["PENDING","CONFIRMED"],"kinds":null,"scopeKeys":[]}'::jsonb,
   'fa_type_breakdown','{"permission":"reports_finance.analysis","source":"crm.fa_type_breakdown","scope":"buildings","params":["fromDate","toDate","basis","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'fa_snapshot_kpis','{"permission":"reports_finance.analysis","source":"crm.fa_snapshot_kpis","scope":"rows","params":["buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'fa_occupancy_monthly','{"permission":"reports_finance.analysis","source":"crm.fa_occupancy_monthly","scope":"rows","params":["fromDate","toDate","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'fa_lease_events','{"permission":"reports_finance.analysis","source":"crm.fa_lease_events","scope":"rows","params":["fromDate","toDate","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'fa_invoice_collection','{"permission":"reports_finance.analysis","source":"crm.fa_invoice_collection","scope":"rows","params":["fromDate","toDate","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'top_expenses','{"permission":"reports_finance.analysis","source":"crm.finance_analysis_top_expenses_v1","scope":"rows","params":["month","buildingId"],"required":["month"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'bp_pnl','{"permission":"reports_finance.analysis","source":"crm.business_performance_pnl_v1","scope":"rows","params":["fromDate","toDate","basis","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'bp_cohort','{"permission":"reports_finance.analysis","source":"crm.business_performance_invoice_cohort_v1","scope":"rows","params":["month","buildingId"],"required":["month"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'bp_cash_received','{"permission":"reports_finance.analysis","source":"crm.business_performance_cash_received_v1","scope":"rows","params":["month","buildingId"],"required":["month"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'bp_categories','{"permission":"reports_finance.analysis","source":"crm.business_performance_category_breakdown_v1","scope":"buildings","params":["fromDate","toDate","basis","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'profit_my_share','{"permission":"reports_finance.profit_distribution","source":"crm.profit_my_share_v1","scope":"rows","params":["year","buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'profit_shareholders','{"permission":"shareholder_profit.view","source":"crm.profit_shareholder_summary_v1","scope":"organization","params":["year"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'personal_wallets','{"permission":"personal_finance.view","source":"crm.personal_finance_snapshot","scope":"self","params":[],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'personal_transactions','{"permission":"personal_finance.view","source":"crm.personal_finance_snapshot","scope":"self","params":["fromDate","toDate","kind","query"],"required":[],"statuses":null,"kinds":["INCOME","EXPENSE"],"scopeKeys":[]}'::jsonb,
   'bank_event_feed','{"permission":"assistant.bank_events.read","source":"crm.bank_event_admin_v1","scope":"self","params":["fromDate","toDate","kind"],"required":[],"statuses":null,"kinds":["sms","notification","email","test"],"scopeKeys":[]}'::jsonb)
$fn$;

-- Định tuyến gói B (INVOKER): cổng dựng ctx (phần DEFINER kiểm quyền) rồi gọi dưới vai authenticated.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_ctx->>'report' IS DISTINCT FROM p_report OR jsonb_typeof(p_ctx->'buildings') IS DISTINCT FROM 'array' OR p_ctx->>'organizationId' IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_result:=CASE
    WHEN p_report='cashbook_daily' THEN app_private.hermes_w2b_cashbook_daily_v1(p_params,p_ctx)
    WHEN p_report='cash_flow' THEN app_private.hermes_w2b_cash_flow_v1(p_params,p_ctx)
    WHEN p_report='cashbooks' THEN app_private.hermes_w2b_cashbooks_report_v1(p_params,p_ctx)
    WHEN p_report='cashbook_closings' THEN app_private.hermes_w2b_cashbook_closings_v1(p_params,p_ctx)
    WHEN p_report='fa_type_breakdown' THEN app_private.hermes_w2b_fa_type_breakdown_v1(p_params,p_ctx)
    WHEN p_report IN ('fa_snapshot_kpis','fa_occupancy_monthly','fa_lease_events','fa_invoice_collection') THEN app_private.hermes_w2b_fa_rows_v1(p_report,p_params,p_ctx)
    WHEN p_report='top_expenses' THEN app_private.hermes_w2b_top_expenses_v1(p_params,p_ctx)
    WHEN p_report IN ('bp_pnl','bp_cohort','bp_cash_received','bp_categories') THEN app_private.hermes_w2b_bp_v1(p_report,p_params,p_ctx)
    WHEN p_report IN ('profit_my_share','profit_shareholders') THEN app_private.hermes_w2b_profit_v1(p_report,p_params,p_ctx)
    WHEN p_report IN ('personal_wallets','personal_transactions') THEN app_private.hermes_w2b_personal_v1(p_report,p_params,p_ctx)
    WHEN p_report='bank_event_feed' THEN app_private.hermes_w2b_bank_events_v1(p_params,p_ctx)
  END;
  IF v_result IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  RETURN v_result;
END $fn$;

ALTER FUNCTION public.cashbook_list_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer) OWNER TO postgres;
ALTER FUNCTION public.profit_my_share_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.profit_shareholder_summary_v1(uuid,integer) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_buildings_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_cashbooks_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_restricted_ok_v1(jsonb,uuid[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_cashbook_targets_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_cashbook_daily_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_cash_flow_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_cashbooks_report_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_cashbook_closings_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_fa_type_breakdown_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_fa_rows_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_top_expenses_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_bp_buildings_v1(jsonb,boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_bp_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_profit_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_personal_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_bank_events_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_read_v1(text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.cashbook_list_v1(uuid,text),public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer),public.profit_my_share_v1(uuid,uuid[]),
  public.profit_shareholder_summary_v1(uuid,integer),app_private.hermes_w2b_text_v1(text,integer),app_private.hermes_w2b_buildings_v1(jsonb),
  app_private.hermes_w2b_cashbooks_v1(jsonb),app_private.hermes_w2b_restricted_ok_v1(jsonb,uuid[]),app_private.hermes_w2b_cashbook_targets_v1(jsonb,jsonb),
  app_private.hermes_w2b_cashbook_daily_v1(jsonb,jsonb),app_private.hermes_w2b_cash_flow_v1(jsonb,jsonb),app_private.hermes_w2b_cashbooks_report_v1(jsonb,jsonb),
  app_private.hermes_w2b_cashbook_closings_v1(jsonb,jsonb),app_private.hermes_w2b_fa_type_breakdown_v1(jsonb,jsonb),app_private.hermes_w2b_fa_rows_v1(text,jsonb,jsonb),
  app_private.hermes_w2b_top_expenses_v1(jsonb,jsonb),app_private.hermes_w2b_bp_buildings_v1(jsonb,boolean),app_private.hermes_w2b_bp_v1(text,jsonb,jsonb),
  app_private.hermes_w2b_profit_v1(text,jsonb,jsonb),app_private.hermes_w2b_personal_v1(text,jsonb,jsonb),app_private.hermes_w2b_bank_events_v1(jsonb,jsonb),
  app_private.hermes_w2b_catalog_v1(),app_private.hermes_w2b_read_v1(text,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- INVOKER: vai authenticated chạy được hàm dùng chung (web) và hàm phụ của gói; quyền thật nằm ở RLS/RPC web.
-- Hai hàm khung (catalog, read) giữ ACL của nền cho tới khi cổng INVOKER mới của Gói 0 cấp EXECUTE.
GRANT EXECUTE ON FUNCTION
  public.cashbook_list_v1(uuid,text),public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer),public.profit_my_share_v1(uuid,uuid[]),
  public.profit_shareholder_summary_v1(uuid,integer),app_private.hermes_w2b_text_v1(text,integer),app_private.hermes_w2b_buildings_v1(jsonb),
  app_private.hermes_w2b_cashbooks_v1(jsonb),app_private.hermes_w2b_restricted_ok_v1(jsonb,uuid[]),app_private.hermes_w2b_cashbook_targets_v1(jsonb,jsonb),
  app_private.hermes_w2b_cashbook_daily_v1(jsonb,jsonb),app_private.hermes_w2b_cash_flow_v1(jsonb,jsonb),app_private.hermes_w2b_cashbooks_report_v1(jsonb,jsonb),
  app_private.hermes_w2b_cashbook_closings_v1(jsonb,jsonb),app_private.hermes_w2b_fa_type_breakdown_v1(jsonb,jsonb),app_private.hermes_w2b_fa_rows_v1(text,jsonb,jsonb),
  app_private.hermes_w2b_top_expenses_v1(jsonb,jsonb),app_private.hermes_w2b_bp_buildings_v1(jsonb,boolean),app_private.hermes_w2b_bp_v1(text,jsonb,jsonb),
  app_private.hermes_w2b_profit_v1(text,jsonb,jsonb),app_private.hermes_w2b_personal_v1(text,jsonb,jsonb),app_private.hermes_w2b_bank_events_v1(jsonb,jsonb)
  TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
