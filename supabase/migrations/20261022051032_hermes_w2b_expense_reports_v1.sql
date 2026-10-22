-- Hermes đọc đầy đủ — ĐỢT 2, Gói B, sửa SAU phát hành (Đợt 2 Thu chi — Mốc 3, 22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 17):
-- hai báo cáo thu chi theo kết quả ma trận đọc lượt 2 (SOUL v4.8: Thu chi 23/29, trượt do CÔNG CỤ).
--  * expense_vouchers — phiếu CHI theo số tiền (lớn trước) hoặc theo tuổi (kind=oldest): khoảng ngày bất kỳ, ngưỡng tiền minAmount, trạng
--    thái, chữ tìm, toà kể cả TOÀ ẢO; summary đếm/tổng/lớn nhất/theo toà trên MỌI phiếu khớp, hàng phân trang. Thay chỗ trượt của top_expenses
--    (chỉ nhận month, tối đa 10 dòng, chỉ phiếu KQKD đã duyệt ⇒ "tuần trước khoản chi nào lớn nhất" ra 35,9tr thay vì 94,2tr ở Kho Văn Phòng
--    Chung; "các khoản chi trên 10 triệu tháng này" ra 10 khoản). top_expenses giữ nguyên (khớp tab Chi phí của Phân tích tài chính).
--  * expense_categories — tổng chi theo hạng mục ("tháng trước trả tiền nhà tổng cộng": bot cộng mọi phiếu 1,207 tỉ; đúng = hạng mục Tiền
--    nhà, đối chiếu production 22/10: 289.552.000 đã duyệt + 57.000.000 chờ duyệt = 346.552.000 / 9 phiếu, mặc định ALL_ACTIVE như web).
-- Khoá income_expenses.view (khoá đợt 1 dùng lại, ĐÃ BẬT ⇒ báo cáo sống ngay khi phát hành SQL + connector, wave2-kit.mjs W2_REUSED_KEYS);
-- khoá phụ income_expenses.restricted_view như top_expenses. Áp SAU 20261022044126_hermes_w2_min_amount_param_v1 (tham số minAmount) và
-- 20261022051029_hermes_w2b_expense_shared_v1 (hai hàm dùng chung public.ie_expense_vouchers_v1 / ie_expense_categories_v1).
-- Thay thân hai hàm của gói (cùng chữ ký, cùng ACL), chép nguyên bản production (catalog = 20261018020200 md5 80e6f676…, đọc =
-- 20261018080200 md5 4cdb4ef8…) bằng script, thêm đúng hai mục catalog và một nhánh đọc. Không DROP, không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2b_read_v1(text,jsonb,jsonb)') IS NULL OR to_regprocedure('app_private.hermes_w2b_catalog_v1()') IS NULL
    OR to_regprocedure('public.report_text_v1(text,integer)') IS NULL
    OR to_regprocedure('public.ie_expense_vouchers_v1(uuid,uuid[],date,date,text,numeric,text,boolean)') IS NULL
    OR to_regprocedure('public.ie_expense_categories_v1(uuid,uuid[],date,date,text,boolean)') IS NULL
    OR NOT ('minAmount'=ANY(app_private.hermes_w2_param_names_v1())) THEN
    RAISE EXCEPTION 'hermes_w2b_expense_reports_dependency_invalid'; END IF;
  -- Ghim thân đang chạy (review Mốc 2+3): hai thân dưới dựng từ bản production; thân đang chạy KHÁC bản đó (một bản vá khác đã thay
  -- hàm) ⇒ dừng thay vì đè mất vá. Cho phép: thân production + TEST đo 22/10/2026 bằng md5(replace(prosrc,chr(13),'')) (npm run
  -- db:query, chỉ đọc; hai môi trường trùng nhau) hoặc chính thân của file này (chạy lại idempotent).
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2b_catalog_v1()')),'')
      NOT IN ('80e6f676997d9330471e8c8dc603f304','73e2d106a40067dec256258c1da38ded') THEN
    RAISE EXCEPTION 'hermes_w2b_expense_reports_body_drift: app_private.hermes_w2b_catalog_v1'; END IF;
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2b_read_v1(text,jsonb,jsonb)')),'')
      NOT IN ('4cdb4ef8a8914a34b0aec3e08ddc16e4','a4ea14ab90fa72323e24ae8b69e4398a') THEN
    RAISE EXCEPTION 'hermes_w2b_expense_reports_body_drift: app_private.hermes_w2b_read_v1'; END IF;
END $requires$;

-- 1. Bảng báo cáo gói B (khớp W2B_REPORTS của infra/hermes-broker/wave2-b-contract.mjs; test so khớp): bản production + hai mục.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT jsonb_build_object(
   'cashbook_daily','{"permission":"reports_finance.daily_cashbook","source":"crm.cashbook_daily_v1","scope":"buildings","params":["fromDate","toDate","cashbookId","buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'cash_flow','{"permission":"reports_finance.cash_flow","source":"crm.cashbook_cash_flow_v1","scope":"buildings","params":["year","buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'cashbooks','{"permission":"cashbooks.view","source":"crm.cashbook_list_v1","scope":"cashbooks","params":["query"],"required":[],"statuses":null,"kinds":null,"scopeKeys":[]}'::jsonb,
   'cashbook_closings','{"permission":"cashbooks.view","source":"crm.cashbook_closings_v1","scope":"cashbooks","params":["cashbookId","status"],"required":[],"statuses":["PENDING","CONFIRMED"],"kinds":null,"scopeKeys":[]}'::jsonb,
   'fa_type_breakdown','{"permission":"reports_finance.analysis","source":"crm.finance_analysis_type_breakdown_v1","scope":"buildings","params":["fromDate","toDate","basis","buildingId"],"required":["fromDate","toDate"],"statuses":null,"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
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
   'bank_event_feed','{"permission":"assistant.bank_events.read","source":"crm.bank_event_admin_v1","scope":"platform","params":["fromDate","toDate","kind"],"required":[],"statuses":null,"kinds":["sms","notification","email","test"],"scopeKeys":[]}'::jsonb,
   'expense_vouchers','{"permission":"income_expenses.view","source":"crm.income_expenses","scope":"rows","params":["fromDate","toDate","minAmount","status","kind","query","buildingId"],"required":[],"statuses":["APPROVED","UNAPPROVED","CANCELLED"],"kinds":["largest","oldest"],"scopeKeys":["income_expenses.restricted_view"]}'::jsonb,
   'expense_categories','{"permission":"income_expenses.view","source":"crm.income_expense_items","scope":"rows","params":["fromDate","toDate","status","buildingId"],"required":[],"statuses":["APPROVED","UNAPPROVED","CANCELLED"],"kinds":null,"scopeKeys":["income_expenses.restricted_view"]}'::jsonb)
$fn$;

-- 2. Hàm đọc gói B (INVOKER; GIỮ dòng đầu của khung): bản production + nhánh expense_vouchers/expense_categories.
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_today date; v_org_wide boolean; v_buildings uuid[]; v_cashbooks uuid[]; v_ok boolean;
  v_from date; v_to date; v_rows jsonb; v_summary jsonb; v_capped boolean:=false; v_raw jsonb; v_list jsonb; v_status jsonb;
  v_allowed uuid[]; v_base uuid[]; v_month date; v_basis text; v_year integer; v_kind text; v_query text; v_tz text;
  v_a numeric; v_b numeric; v_n bigint; v_borg jsonb:='{}'::jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_ctx->>'report' IS DISTINCT FROM p_report OR jsonb_typeof(p_ctx->'buildings') IS DISTINCT FROM 'array' OR p_ctx->>'organizationId' IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid; v_today:=(p_ctx->>'today')::date; v_org_wide:=p_ctx->'orgWide'='true'::jsonb;
  v_buildings:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx->'buildings') x ORDER BY 1);
  v_cashbooks:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx->'cashbooks')='array' THEN p_ctx->'cashbooks'
    ELSE '[]'::jsonb END) x ORDER BY 1);
  -- Phiếu/hạng mục hạn chế: restricted_view của kết nối (ctx.scopes) phủ MỌI toà của báo cáo.
  -- (Gói Z) Đóng khi thiếu: ctx.scopes không có khoá (bảng báo cáo thiếu scopeKeys) ⇒ jsonb_typeof(NULL) là NULL ⇒ biểu thức
  -- NULL, mà hàm dùng chung đọc p_include_restricted NULL là "theo RLS" (mở) ⇒ COALESCE(…,false).
  v_ok:=COALESCE(cardinality(v_buildings)>0 AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'
    AND NOT EXISTS(SELECT 1 FROM unnest(v_buildings) b(id) WHERE NOT (p_ctx->'scopes'->'income_expenses.restricted_view') ? b.id::text),false);
  v_from:=(p_params->>'fromDate')::date; v_to:=(p_params->>'toDate')::date;
  v_basis:=COALESCE(p_params->>'basis','accrual');
  -- Công ty của từng toà (RLS buildings) cho hàng lấy từ RPC web không nêu công ty. Toà không nhìn thấy ⇒ thiếu ⇒
  -- organizationId null ⇒ cổng từ chối (42501), không lặng lẽ bỏ hàng.
  IF p_report IN ('fa_snapshot_kpis','fa_occupancy_monthly','fa_lease_events','fa_invoice_collection','bp_pnl','bp_cohort',
      'bp_cash_received','bp_categories') THEN
    SELECT COALESCE(jsonb_object_agg(b.id::text,b.organization_id),'{}'::jsonb) INTO v_borg FROM public.buildings b WHERE b.id=ANY(v_buildings);
  END IF;

  IF p_report='cashbook_daily' THEN
    v_from:=COALESCE(v_from,date_trunc('month',v_today)::date); v_to:=COALESCE(v_to,v_today);
    IF v_to<v_from OR v_to-v_from>366 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    -- buildingId null = hàng tổng hợp toàn công ty, chỉ khi kết nối Toàn tổ chức (orgWide): một chuỗi "Tất cả"; không thì một
    -- chuỗi cho từng toà của kết nối. organizationId = công ty hàm dùng chung đã lọc tường minh (p_organization_id).
    WITH d AS MATERIALIZED (
      SELECT * FROM public.cashbook_daily_v1(v_org,v_from,v_to,(p_params->>'cashbookId')::uuid,CASE WHEN v_org_wide THEN NULL ELSE v_buildings END)
    )
    SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',x.organization_id,'buildingId',x.building_id,'date',x.day,'opening',x.opening::text,'income',x.income::text,
          'expense',x.expense::text,'closing',x.closing::text) ORDER BY x.building_id NULLS FIRST,x.day),'[]'::jsonb)
        FROM (SELECT * FROM d ORDER BY d.building_id NULLS FIRST,d.day LIMIT 2000) x),
      (SELECT count(*) FROM d)>2000,
      (SELECT jsonb_build_object('fromDate',v_from,'toDate',v_to,'cashbookId',(p_params->>'cashbookId')::uuid,
          'openingBalance',COALESCE(sum(d.opening) FILTER (WHERE d.day=v_from),0)::text,'totalIncome',COALESCE(sum(d.income),0)::text,
          'totalExpense',COALESCE(sum(d.expense),0)::text,'closingBalance',COALESCE(sum(d.closing) FILTER (WHERE d.day=v_to),0)::text) FROM d)
      INTO v_rows,v_capped,v_summary;
  ELSIF p_report='cash_flow' THEN
    v_year:=COALESCE((p_params->>'year')::integer,extract(year FROM v_today)::integer);
    -- buildingId null = hàng tổng hợp toàn công ty, chỉ khi kết nối Toàn tổ chức (orgWide); không thì từng toà.
    -- 16 hàng mỗi chuỗi toà: trần 2000 hàng như mọi báo cáo (sourceCapped), tổng năm vẫn trên mọi hàng.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',f.organization_id,'buildingId',f.building_id,'period',f.period,'income',f.income::text,'expense',f.expense::text,
          'net',f.net::text) ORDER BY f.ord) FILTER (WHERE f.ord<=2000),'[]'::jsonb),
        COALESCE(sum(f.income) FILTER (WHERE f.period NOT LIKE '%Q%'),0),COALESCE(sum(f.expense) FILTER (WHERE f.period NOT LIKE '%Q%'),0),count(*)>2000
      INTO v_rows,v_a,v_b,v_capped FROM (SELECT x.*,row_number() OVER () AS ord
        FROM public.cashbook_cash_flow_v1(v_org,v_year,CASE WHEN v_org_wide THEN NULL ELSE v_buildings END) x) f;
    v_summary:=jsonb_build_object('year',v_year,'income',v_a::text,'expense',v_b::text,'net',(v_a-v_b)::text);
  ELSIF p_report='cashbooks' THEN
    -- Phạm vi sổ quỹ của cổng: Toàn tổ chức ⇒ mọi sổ nhìn thấy; không thì chỉ sổ CRM cấp (ctx.cashbooks).
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT row_number() OVER () ord,jsonb_build_object('organizationId',l.organization_id,'cashbookId',l.cashbook_id,'code',public.report_text_v1(l.code,50),
          'name',public.report_text_v1(l.name,200),'ownerName',public.report_text_v1(l.owner_name,200),'isVirtual',l.is_virtual,
          'balanceVisible',l.balance_visible,'initialAmount',l.initial_amount::text,'currentAmount',l.current_amount::text,
          'note',public.report_text_v1(l.description,300)) item
      FROM public.cashbook_list_v1(v_org,p_params->>'query') l WHERE v_org_wide OR l.cashbook_id=ANY(v_cashbooks) LIMIT 2000) x;
  ELSIF p_report='cashbook_closings' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',c.organization_id,'state',c.state,'closureId',c.closure_id,'requestId',c.request_id,'cashbookId',c.cashbook_id,
        'cashbookName',public.report_text_v1(c.cashbook_name,200),'closedThrough',c.closed_through,'countedBalance',c.counted_balance::text,
        'systemBalance',c.system_balance::text,'difference',c.difference::text,'basis',public.report_text_v1(c.basis,60),
        'proposedByName',public.report_text_v1(c.proposed_by_name,200),'confirmerName',public.report_text_v1(c.confirmer_name,200),
        'confirmedAt',to_char(c.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'mineToConfirm',c.mine_to_confirm,
        'note',public.report_text_v1(c.note,300))),'[]'::jsonb)
      INTO v_rows FROM (SELECT * FROM public.cashbook_closings_v1(v_org,
        CASE WHEN p_params->>'cashbookId' IS NOT NULL THEN ARRAY[(p_params->>'cashbookId')::uuid] WHEN v_org_wide THEN NULL ELSE v_cashbooks END,
        p_params->>'status') LIMIT 2000) c;
    v_capped:=jsonb_array_length(v_rows)>=2000;
  ELSIF p_report='fa_type_breakdown' THEN
    -- buildingId null = hàng tổng hợp toàn công ty (gộp mọi toà), chỉ khi kết nối Toàn tổ chức (orgWide); không thì từng toà.
    v_raw:=public.finance_analysis_type_breakdown_v1(v_org,v_from,v_to,v_basis<>'cash',CASE WHEN v_org_wide THEN NULL ELSE v_buildings END,v_ok);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT t.ord,jsonb_build_object('organizationId',(t.e->>'organization_id')::uuid,'buildingId',(t.e->>'building_id')::uuid,'month',(t.e->>'month')::date,'side',t.e->>'side','typeId',(t.e->>'type_id')::uuid,
          'typeName',public.report_text_v1(t.e->>'type_name',200),'category',public.report_text_v1(t.e->>'category',100),
          'totalAmount',(t.e->>'total_amount')::numeric::text,'voucherCount',(t.e->>'voucher_count')::bigint) item
      FROM jsonb_array_elements(v_raw->'rows') WITH ORDINALITY t(e,ord) ORDER BY t.ord LIMIT 2000) x;
    v_summary:=jsonb_build_object('basis',v_basis,'restrictedIncluded',COALESCE((v_raw->>'restricted_included')::boolean,false));
  ELSIF p_report='fa_snapshot_kpis' THEN
    -- RPC web fa_snapshot_kpis (useFinancialAnalysis.ts:235) trên toà của báo cáo.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(k.building_id::text),'buildingId',k.building_id,
        'buildingName',public.report_text_v1(k.building_name,200),'totalRooms',k.total_rooms,'roomsAvailable',k.rooms_available,'roomsOccupied',k.rooms_occupied,'roomsReserved',k.rooms_reserved,
        'roomsMaintenance',k.rooms_maintenance,'roomsUnavailable',k.rooms_unavailable,'vacancyLossMonth',k.vacancy_loss_month::text,
        'activeContracts',k.active_contracts,'avgRent',round(k.avg_rent,2)::text,'depositHeld',k.deposit_held::text,
        'receivableTotal',k.receivable_total::text,'agingNotDue',k.aging_not_due::text,'aging1To30',k.aging_1_30::text,
        'aging31To60',k.aging_31_60::text,'aging61To90',k.aging_61_90::text,'agingOver90',k.aging_over_90::text)
        ORDER BY k.building_name,k.building_id),'[]'::jsonb)
      INTO v_rows FROM public.fa_snapshot_kpis(v_buildings) k WHERE k.building_id=ANY(v_buildings);
  ELSIF p_report='fa_occupancy_monthly' THEN
    -- RPC web fa_occupancy_monthly (useFinancialAnalysis.ts:159).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(o.building_id::text),'month',o.month,'buildingId',o.building_id,'buildingName',public.report_text_v1(o.building_name,200),
        'totalRooms',o.total_rooms,'occupiedRooms',o.occupied_rooms,'occupancyPct',o.occupancy_pct::text) ORDER BY o.month,o.building_name,o.building_id),'[]'::jsonb),
        count(*)>=2000
      INTO v_rows,v_capped FROM (SELECT * FROM public.fa_occupancy_monthly(v_from,v_to,v_buildings) WHERE building_id=ANY(v_buildings) LIMIT 2000) o;
  ELSIF p_report='fa_lease_events' THEN
    -- RPC web fa_lease_events (useFinancialAnalysis.ts:181).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(e.building_id::text),'month',e.month,'buildingId',e.building_id,'buildingName',public.report_text_v1(e.building_name,200),
        'newContracts',e.new_contracts,'renewals',e.renewals,'terminations',e.terminations) ORDER BY e.month,e.building_name,e.building_id),'[]'::jsonb),
        count(*)>=2000
      INTO v_rows,v_capped FROM (SELECT * FROM public.fa_lease_events(v_from,v_to,v_buildings) WHERE building_id=ANY(v_buildings) LIMIT 2000) e;
  ELSIF p_report='fa_invoice_collection' THEN
    -- RPC web fa_invoice_collection (useFinancialAnalysis.ts:207), các kỳ từ tháng của fromDate tới tháng của toDate.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(i.building_id::text),'billingMonth',public.report_text_v1(i.billing_month,7),
        'buildingId',i.building_id,
        'buildingName',public.report_text_v1(i.building_name,200),'billed',i.billed::text,'collected',i.collected::text,'remaining',i.remaining::text,
        'invoiceCount',i.invoice_count,'draftCount',i.draft_count,'pendingCount',i.pending_count,'approvedCount',i.approved_count,
        'paidCount',i.paid_count,'partialCount',i.partial_count,'overdueCount',i.overdue_count) ORDER BY i.billing_month,i.building_name,i.building_id),'[]'::jsonb),
        count(*)>=2000
      INTO v_rows,v_capped FROM (SELECT * FROM public.fa_invoice_collection(to_char(v_from,'YYYY-MM'),to_char(v_to,'YYYY-MM'),v_buildings)
        WHERE building_id=ANY(v_buildings) LIMIT 2000) i;
  ELSIF p_report='top_expenses' THEN
    -- Hàm dùng chung _v2: phiếu hạn chế của người khác bị loại TRONG hàm nguồn, trước khi xếp/cắt 10 — p_include_restricted =
    -- v_ok (restricted_view của kết nối phủ mọi toà; chỉ thu hẹp RLS). Phiếu hạn chế của CHÍNH mình vẫn thấy như RLS web.
    v_month:=to_date(p_params->>'month'||'-01','YYYY-MM-DD');
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb) INTO v_rows FROM (
      SELECT row_number() OVER (ORDER BY t.total_amount DESC,t.voucher_date DESC,t.voucher_id) ord,jsonb_build_object('organizationId',t.organization_id,
          'voucherId',t.voucher_id,
          'voucherDate',t.voucher_date,'code',public.report_text_v1(t.code,60),'name',public.report_text_v1(t.name,200),'buildingId',t.building_id,
          'buildingName',public.report_text_v1(t.building_name,200),'itemTypes',public.report_text_v1(t.item_types,300),'totalAmount',t.total_amount::text) item
      FROM public.finance_analysis_top_expenses_v2(v_org,v_month,(v_month+interval '1 month'-interval '1 day')::date,v_buildings,10,v_ok) t) x;
  ELSIF p_report IN ('bp_pnl','bp_cohort','bp_cash_received','bp_categories') THEN
    -- Hiệu quả kinh doanh (useBusinessPerformance.ts:897; useBusinessPerformanceGatedData.ts:756,785,816): RPC web "tất cả
    -- hoặc không" (42501) chỉ nhận toà mà danh sách web (business_performance_organizations_v1, như trang chọn toà
    -- BusinessPerformanceReportPage.tsx:264) cho phép kèm restricted_allowed, ∩ ctx.buildings ∩ restricted_view của kết
    -- nối. Không toà thật nào ⇒ no_building_scope; có toà nhưng thiếu quyền phiếu hạn chế ⇒ 42501 như web.
    SELECT COALESCE(array_agg(DISTINCT (e->>'id')::uuid),'{}'::uuid[]),
        COALESCE(array_agg(DISTINCT (e->>'id')::uuid) FILTER (WHERE (e->>'restricted_allowed')::boolean IS TRUE
          AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'
          AND (p_ctx->'scopes'->'income_expenses.restricted_view') ? (e->>'id')),'{}'::uuid[])
      INTO v_base,v_allowed
      FROM public.business_performance_organizations_v1() o CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(o.authorized_buildings)='array' THEN o.authorized_buildings ELSE '[]'::jsonb END) e
      WHERE o.organization_id=v_org AND (e->>'id')::uuid=ANY(v_buildings);
    IF cardinality(v_base)=0 THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','no_building_scope');
    END IF;
    IF cardinality(v_allowed)=0 THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    v_allowed:=ARRAY(SELECT unnest(v_allowed) ORDER BY 1);
    IF p_params ? 'month' THEN v_month:=to_date(p_params->>'month'||'-01','YYYY-MM-DD'); END IF;
    IF p_report='bp_pnl' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(p.building_id::text),'month',p.month,'buildingId',p.building_id,'buildingName',public.report_text_v1(p.building_name,200),
          'revenue',p.revenue::text,'expense',p.expense::text,'net',p.net::text) ORDER BY p.month,p.building_name,p.building_id),'[]'::jsonb),count(*)>=2000
        INTO v_rows,v_capped FROM (SELECT * FROM public.business_performance_pnl_v1(v_org,CASE v_basis WHEN 'cash' THEN 'VOUCHER_DATE' ELSE 'ACCRUAL' END,
          v_from,v_to,v_allowed) WHERE building_id=ANY(v_allowed) AND NOT COALESCE(is_virtual,false) LIMIT 2000) p;
    ELSIF p_report='bp_cohort' THEN
      -- Tiền/tỷ lệ tính trong RPC (thương, tỷ lệ) làm tròn 2 chữ số để vừa khuôn tiền của broker.
      SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(c.building_id::text),'buildingId',c.building_id,
          'buildingName',public.report_text_v1(c.building_name,200),'cohortMonth',c.cohort_month,'cohortAvailable',COALESCE(c.cohort_available,false),'billed',round(COALESCE(c.billed_current_charge,0),2)::text,
          'collected',round(COALESCE(c.collected_current_charge,0),2)::text,'remaining',round(COALESCE(c.remaining_current_charge,0),2)::text,
          'collectionRatePct',round(c.collection_rate_pct,2)::text,'invoiceCount',COALESCE(c.invoice_count,0),
          'carriedInvoiceDebt',round(COALESCE(c.carried_invoice_debt,0),2)::text,'carriedDepositDebt',round(COALESCE(c.carried_deposit_debt,0),2)::text,
          'currentDeposit',round(COALESCE(c.current_deposit,0),2)::text,'draftPendingCount',COALESCE(c.draft_pending_count,0),
          'draftPendingAmount',round(COALESCE(c.draft_pending_amount,0),2)::text,'settlementCount',COALESCE(c.settlement_count,0),
          'settlementAmount',round(COALESCE(c.settlement_amount,0),2)::text) ORDER BY c.building_name,c.building_id),'[]'::jsonb)
        INTO v_rows FROM public.business_performance_invoice_cohort_v1(v_org,v_month,v_allowed) c WHERE c.building_id=ANY(v_allowed);
    ELSIF p_report='bp_cash_received' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(r.building_id::text),'buildingId',r.building_id,
          'buildingName',public.report_text_v1(r.building_name,200),'cashMonth',r.cash_month,'cashReceived',round(COALESCE(r.cash_received,0),2)::text,'paymentEventCount',COALESCE(r.payment_event_count,0),
          'firstPaymentDate',r.first_payment_date,'lastPaymentDate',r.last_payment_date) ORDER BY r.building_name,r.building_id),'[]'::jsonb)
        INTO v_rows FROM public.business_performance_cash_received_v1(v_org,v_month,v_allowed) r WHERE r.building_id=ANY(v_allowed);
    ELSE
      -- Cơ cấu theo hạng mục cho TỪNG toà được phép (mọi hàng nêu toà).
      SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_borg->(k.bid::text),'buildingId',k.bid,'month',k.month,'side',k.side,'typeId',k.type_id,
          'typeName',public.report_text_v1(k.type_name,200),'category',public.report_text_v1(k.category,100),
          'totalAmount',COALESCE(k.total_amount,0)::text,'voucherCount',COALESCE(k.voucher_count,0))
          ORDER BY k.bid,k.month,k.side,k.total_amount DESC,k.type_name,k.type_id),'[]'::jsonb),count(*)>=2000
        INTO v_rows,v_capped FROM (SELECT b.id AS bid,c.* FROM unnest(v_allowed) b(id)
          CROSS JOIN LATERAL public.business_performance_category_breakdown_v1(v_org,CASE v_basis WHEN 'cash' THEN 'VOUCHER_DATE' ELSE 'ACCRUAL' END,
            v_from,v_to,ARRAY[b.id]) c LIMIT 2000) k;
    END IF;
  ELSIF p_report='profit_my_share' THEN
    v_raw:=public.profit_my_share_v1(v_org,v_buildings);
    IF v_raw->'shareholder'='null'::jsonb THEN
      v_rows:='[]'::jsonb;
      v_summary:=jsonb_build_object('isShareholder',false,'shareholderName',NULL,'accrued','0','paid','0','remaining','0','allocations',0,'payouts',0);
    ELSE
      v_year:=(p_params->>'year')::integer;
      SELECT COALESCE(sum((a->>'amount')::numeric),0),count(*) INTO v_a,v_n FROM jsonb_array_elements(v_raw->'allocations') a
        WHERE (a->>'building_id')::uuid=ANY(v_buildings);
      SELECT COALESCE(sum((p->>'total_amount')::numeric),0) INTO v_b FROM jsonb_array_elements(v_raw->'payouts') p
        WHERE (p->>'building_id')::uuid=ANY(v_buildings);
      SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
        SELECT a.ord,jsonb_build_object('organizationId',(a.e->>'organization_id')::uuid,'periodMonth',(a.e->>'period_month')::date,'buildingId',(a.e->>'building_id')::uuid,
            'buildingName',public.report_text_v1(a.e->>'building_name',200),'status',a.e->>'status',
            'percent',(a.e->>'percent')::numeric::text,'amount',(a.e->>'amount')::numeric::text) item
        FROM jsonb_array_elements(v_raw->'allocations') WITH ORDINALITY a(e,ord)
        WHERE (a.e->>'building_id')::uuid=ANY(v_buildings) AND (v_year IS NULL OR extract(year FROM (a.e->>'period_month')::date)=v_year)
        ORDER BY a.ord LIMIT 2000) x;
      v_summary:=jsonb_build_object('isShareholder',true,'shareholderName',public.report_text_v1(v_raw->'shareholder'->>'name',200),
        'accrued',v_a::text,'paid',v_b::text,'remaining',(v_a-v_b)::text,'allocations',v_n,
        'payouts',(SELECT count(*) FROM jsonb_array_elements(v_raw->'payouts') p WHERE (p->>'building_id')::uuid=ANY(v_buildings)));
    END IF;
  ELSIF p_report='profit_shareholders' THEN
    v_raw:=public.profit_shareholder_summary_v1(v_org,(p_params->>'year')::integer);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT s.ord,jsonb_build_object('organizationId',(s.e->>'organization_id')::uuid,'shareholderId',(s.e->>'shareholder_id')::uuid,'name',public.report_text_v1(s.e->>'name',200),
          'accrued',(s.e->>'accrued')::numeric::text,'paid',(s.e->>'paid')::numeric::text,'remaining',(s.e->>'remaining')::numeric::text,
          'yearAccrued',(s.e->>'year_accrued')::numeric::text) item
      FROM jsonb_array_elements(v_raw->'shareholders') WITH ORDINALITY s(e,ord) ORDER BY s.ord LIMIT 2000) x;
    v_summary:=jsonb_build_object('lockedProfit',(v_raw->>'locked_profit')::numeric::text,
      'accrued',(SELECT COALESCE(sum((e->>'accrued')::numeric),0) FROM jsonb_array_elements(v_raw->'shareholders') e)::text,
      'paid',(SELECT COALESCE(sum((e->>'paid')::numeric),0) FROM jsonb_array_elements(v_raw->'shareholders') e)::text,
      'remaining',(SELECT COALESCE(sum((e->>'remaining')::numeric),0) FROM jsonb_array_elements(v_raw->'shareholders') e)::text);
  ELSIF p_report IN ('personal_wallets','personal_transactions') THEN
    -- Ví cá nhân: RPC web personal_finance_snapshot (src/lib/personalFinance/service.ts:28-29; INVOKER, mọi bảng lọc
    -- user_id=auth.uid()). KHÔNG gọi personal_finance_bootstrap (ghi dữ liệu). Không theo công ty/toà.
    v_raw:=public.personal_finance_snapshot();
    IF v_raw->>'owner_id' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    IF p_report='personal_wallets' THEN
      -- Tổng như selectBalance của trang Ví cá nhân (src/lib/personalFinance/selectors.ts): cộng MỌI ví của snapshot, kể cả ví ẩn,
      -- không chỉ phần trả về. Hàng sắp ổn định như snapshot (mặc định trước, tên, id), cắt 2000 (trần của cổng); sourceCapped
      -- theo tổng thật.
      WITH wal AS (
        SELECT x.j,COALESCE((x.j->>'is_default')::boolean,false) is_default,x.j->>'name' wname,(x.j->>'id')::uuid wid
        FROM jsonb_array_elements(COALESCE(v_raw->'wallets','[]'::jsonb)) x(j)
      )
      SELECT (SELECT COALESCE(jsonb_agg(p.item ORDER BY p.is_default DESC,p.wname,p.wid),'[]'::jsonb) FROM (
            SELECT wal.is_default,wal.wname,wal.wid,jsonb_build_object('walletId',wal.wid,'name',public.report_text_v1(wal.wname,200),
                'kind',wal.j->>'kind','openingBalance',COALESCE((wal.j->>'opening_balance')::numeric,0)::text,
                'balance',COALESCE((wal.j->>'balance')::numeric,0)::text,'isDefault',wal.is_default,
                'hidden',COALESCE((wal.j->>'hidden')::boolean,false)) item
            FROM wal ORDER BY wal.is_default DESC,wal.wname,wal.wid LIMIT 2000) p),
        COALESCE(sum((wal.j->>'balance')::numeric),0),count(*)
        INTO v_rows,v_a,v_n FROM wal;
      v_summary:=jsonb_build_object('totalBalance',v_a::text,'wallets',v_n);
      v_capped:=v_n>2000;
    ELSE
      v_kind:=p_params->>'kind'; v_query:=NULLIF(lower(btrim(COALESCE(p_params->>'query',''))),'');
      WITH tx AS (
        SELECT t.ord,t.e,(t.e->>'txn_date')::date d,t.e->>'type' typ,(t.e->>'amount')::numeric amt,
          COALESCE((SELECT c->>'name' FROM jsonb_array_elements(COALESCE(v_raw->'categories','[]'::jsonb)) c WHERE c->>'id'=t.e->>'resolved_category_id'),
            t.e->>'category') cat,
          (SELECT w->>'name' FROM jsonb_array_elements(COALESCE(v_raw->'wallets','[]'::jsonb)) w WHERE w->>'id'=t.e->>'resolved_wallet_id') wallet
        FROM jsonb_array_elements(COALESCE(v_raw->'transactions','[]'::jsonb)) WITH ORDINALITY t(e,ord)
      ), picked AS (
        SELECT * FROM tx WHERE (v_from IS NULL OR d>=v_from) AND (v_to IS NULL OR d<=v_to) AND (v_kind IS NULL OR typ=v_kind)
          AND (v_query IS NULL OR position(v_query IN lower(concat_ws(' ',e->>'description',cat)))>0)
      )
      SELECT (SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb) FROM (SELECT p.ord,jsonb_build_object('transactionId',(p.e->>'id')::uuid,
            'date',p.d,'type',p.typ,'amount',p.amt::text,'description',public.report_text_v1(p.e->>'description',300),
            'categoryName',public.report_text_v1(p.cat,100),'walletName',public.report_text_v1(p.wallet,100)) item
          FROM picked p ORDER BY p.ord LIMIT 2000) x),
        COALESCE(sum(amt) FILTER (WHERE typ='INCOME'),0),COALESCE(sum(amt) FILTER (WHERE typ='EXPENSE'),0),count(*)
        INTO v_rows,v_a,v_b,v_n FROM picked;
      v_summary:=jsonb_build_object('income',v_a::text,'expense',v_b::text,'transactions',v_n);
      v_capped:=v_n>2000;
    END IF;
  ELSIF p_report IN ('expense_vouchers','expense_categories') THEN
    -- Thu chi (Mốc 3 Thu chi, 22/10/2026): như trang Thu chi web (src/hooks/income-expenses/queries.ts:298-413: income_expenses dưới RLS,
    -- deleted_at, type, voucher_date, approval_status mặc định ALL_ACTIVE = APPROVED+UNAPPROVED), mọi toà của ctx KỂ CẢ toà ảo (chi phí
    -- chung). Hàm dùng chung public.ie_expense_vouchers_v1 / ie_expense_categories_v1 (INVOKER, file này). Phiếu hạn chế của người khác chỉ
    -- khi v_ok (restricted_view của kết nối phủ mọi toà), như top_expenses. Mặc định tháng này; chỉ fromDate ⇒ tới hôm nay; chỉ toDate ⇒ từ
    -- đầu tháng của toDate. Tổng (summary) trên MỌI phiếu khớp, hàng cắt 2000 (sourceCapped) rồi cổng phân trang.
    IF v_from IS NULL AND v_to IS NULL THEN
      v_from:=date_trunc('month',v_today)::date; v_to:=(date_trunc('month',v_today)+interval '1 month'-interval '1 day')::date;
    ELSIF v_to IS NULL THEN v_to:=LEAST(GREATEST(v_from,v_today),v_from+366);
    ELSIF v_from IS NULL THEN v_from:=date_trunc('month',v_to)::date;
    END IF;
    IF v_to<v_from OR v_to-v_from>366 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    IF p_report='expense_vouchers' THEN
      v_kind:=COALESCE(p_params->>'kind','largest'); v_tz:=COALESCE(p_ctx->>'timezone','Asia/Ho_Chi_Minh');
      -- largest: số tiền lớn trước; oldest: lập sớm nhất trước (phiếu chờ duyệt theo tuổi). pendingDays chỉ cho phiếu chờ duyệt.
      WITH v AS MATERIALIZED (
        SELECT e.*,row_number() OVER (ORDER BY CASE WHEN v_kind='oldest' THEN extract(epoch FROM e.created_at)::numeric ELSE -e.total_amount END,
            e.voucher_date DESC,e.voucher_id) ord
          FROM public.ie_expense_vouchers_v1(v_org,v_buildings,v_from,v_to,p_params->>'status',(p_params->>'minAmount')::numeric,
            p_params->>'query',v_ok) e)
      SELECT (SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb) FROM (SELECT w.ord,jsonb_build_object('organizationId',w.organization_id,
            'voucherId',w.voucher_id,'code',public.report_text_v1(w.code,60),'voucherDate',w.voucher_date,'name',public.report_text_v1(w.name,200),
            'buildingId',w.building_id,'buildingName',public.report_text_v1(w.building_name,200),'roomName',public.report_text_v1(w.room_name,100),
            'categories',public.report_text_v1(w.categories,300),'totalAmount',w.total_amount::text,'approvalStatus',w.approval_status,
            'postingStatus',w.posting_status,
            'pendingDays',CASE WHEN w.approval_status='UNAPPROVED' THEN GREATEST(v_today-(w.created_at AT TIME ZONE v_tz)::date,0) END) item
          FROM v w WHERE w.ord<=2000) x),
        count(*)>2000,
        jsonb_build_object('fromDate',v_from,'toDate',v_to,'count',count(*),'totalAmount',COALESCE(sum(v.total_amount),0)::text,
          'maxAmount',max(v.total_amount)::text,'restrictedIncluded',v_ok,'buildings',count(DISTINCT v.building_id),
          'byBuilding',(SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',g.building_id,'buildingName',public.report_text_v1(g.building_name,200),
              'count',g.n,'totalAmount',g.total::text) ORDER BY g.total DESC,g.building_id),'[]'::jsonb)
            FROM (SELECT w.building_id,max(w.building_name) building_name,count(*) n,sum(w.total_amount) total FROM v w
              GROUP BY w.building_id ORDER BY sum(w.total_amount) DESC,w.building_id LIMIT 30) g))
        INTO v_rows,v_capped,v_summary FROM v;
    ELSE
      -- Hàng: hạng mục × toà (tiền = dòng hạng mục của phiếu); summary.categories: tổng cả phạm vi từng hạng mục (≤ 100, lớn trước).
      WITH c AS MATERIALIZED (SELECT * FROM public.ie_expense_categories_v1(v_org,v_buildings,v_from,v_to,p_params->>'status',v_ok))
      SELECT (SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord),'[]'::jsonb) FROM (
            SELECT row_number() OVER (ORDER BY k.total_amount DESC,k.building_id,k.type_id) ord,jsonb_build_object('organizationId',k.organization_id,
              'buildingId',k.building_id,'buildingName',public.report_text_v1(k.building_name,200),'typeId',k.type_id,
              'typeName',public.report_text_v1(k.type_name,200),'voucherCount',k.voucher_count,'totalAmount',k.total_amount::text) item
            FROM c k ORDER BY k.total_amount DESC,k.building_id,k.type_id LIMIT 2000) x),
        count(*)>2000,
        jsonb_build_object('fromDate',v_from,'toDate',v_to,'restrictedIncluded',v_ok,'totalAmount',COALESCE(sum(c.total_amount),0)::text,
          'categories',(SELECT COALESCE(jsonb_agg(jsonb_build_object('typeId',g.type_id,'typeName',public.report_text_v1(g.type_name,200),
              'voucherCount',g.n,'totalAmount',g.total::text) ORDER BY g.total DESC,g.type_id),'[]'::jsonb)
            FROM (SELECT k.type_id,max(k.type_name) type_name,sum(k.voucher_count)::bigint n,sum(k.total_amount) total FROM c k
              GROUP BY k.type_id ORDER BY sum(k.total_amount) DESC,k.type_id LIMIT 100) g))
        INTO v_rows,v_capped,v_summary FROM c;
    END IF;
  ELSIF p_report='bank_event_feed' THEN
    -- Biến động số dư: RPC web bank_event_admin_v1 (chỉ is_super_admin(); 20261009103855) 'status' + 'list_events' KHÔNG
    -- kèm withPayload (không lấy bản mã, không ghi dấu vết xem nội dung). Số tiền/số dư/4 số cuối/nội dung chỉ có sau
    -- giải mã ở Edge ⇒ amountsAvailable=false. Ngày theo ctx.timezone (cổng chưa cấp ⇒ giờ Việt Nam).
    IF p_ctx->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    v_tz:=COALESCE(p_ctx->>'timezone','Asia/Ho_Chi_Minh');
    v_status:=public.bank_event_admin_v1('status','{}'::jsonb);
    v_list:=public.bank_event_admin_v1('list_events',jsonb_strip_nulls(jsonb_build_object('limit',100,
      'from',CASE WHEN v_from IS NOT NULL THEN v_from::timestamp AT TIME ZONE v_tz END,
      'to',CASE WHEN v_to IS NOT NULL THEN (v_to+1)::timestamp AT TIME ZONE v_tz END,
      'eventType',CASE p_params->>'kind' WHEN 'sms' THEN 'sms.received' WHEN 'notification' THEN 'notification.received'
        WHEN 'email' THEN 'email.received' WHEN 'test' THEN 'gateway.test' END)));
    v_raw:=CASE WHEN jsonb_typeof(v_list->'events')='array' THEN v_list->'events' ELSE '[]'::jsonb END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('eventId',(e->>'id')::uuid,'sourceName',public.report_text_v1(e->>'sourceName',200),
        'eventType',public.report_text_v1(e->>'eventType',40),
        'occurredAt',to_char((e->>'occurredAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'receivedAt',to_char((e->>'receivedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'duplicateCount',COALESCE((e->>'duplicateCount')::bigint,0)) ORDER BY ord),'[]'::jsonb)
      INTO v_rows FROM jsonb_array_elements(v_raw) WITH ORDINALITY x(e,ord) WHERE ord<=100;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('totalSources',COALESCE((v_status->>'totalSources')::bigint,0),
        'enabledSources',COALESCE((v_status->>'enabledSources')::bigint,0),'totalEvents',COALESCE((v_status->>'totalEvents')::bigint,0),
        'lastReceivedAt',to_char((v_status->>'lastReceivedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'amountsAvailable',false),
      'sourceCapped',jsonb_array_length(v_raw)>100,'unavailable',NULL);
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('rows',COALESCE(v_rows,'[]'::jsonb),'summary',v_summary,'sourceCapped',COALESCE(v_capped,false),'unavailable',NULL);
END $fn$;

ALTER FUNCTION app_private.hermes_w2b_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_read_v1(text,jsonb,jsonb) OWNER TO postgres;

DO $check$
BEGIN
  IF app_private.hermes_w2b_catalog_v1()->'expense_vouchers'->>'permission' IS DISTINCT FROM 'income_expenses.view'
    OR app_private.hermes_w2b_catalog_v1()->'expense_categories'->>'permission' IS DISTINCT FROM 'income_expenses.view'
    OR position('expense_vouchers' IN (SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_w2b_read_v1(text,jsonb,jsonb)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'hermes_w2b_expense_reports_catalog_invalid'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
