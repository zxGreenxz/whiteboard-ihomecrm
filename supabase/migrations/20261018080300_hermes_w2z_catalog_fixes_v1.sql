-- Hermes đọc đầy đủ — ĐỢT 2, Gói Z (tích hợp, 18/10/2026): sửa Gói D sau soát lại. Áp SAU 20261018040300 (Gói D) và TRƯỚC
-- công tắc 20261018090000_hermes_w2_enable_v1. Không DROP, không đổi chữ ký/kiểu trả về, không GRANT/REVOKE, không ghi dữ liệu.
--  1. public.income_expense_types_list_v1 (thân = 20261018040000, đổi thứ tự khử trùng): trong mỗi (loại, tên) hàng của công ty
--     thắng hàng dùng chung (organization_id NULL) — Hermes bỏ hàng dùng chung (đếm globalRowsOmitted) nên hàng dùng chung
--     cũ hơn từng làm mất hạng mục cùng tên của công ty; rồi hàng của CHÍNH người gọi — (user_id=auth.uid()) IS TRUE, vì
--     "= auth.uid()" ra NULL với user_id NULL và DESC xếp NULL lên đầu (web: ownershipRank). Khác web có chủ ý ở điểm đầu
--     (web-parity w2d-ie-types).
--  2. app_private.hermes_w2d_read_v1 (thân = 20261018040300, đổi re_terminations + một chú thích): siết rào PII theo review
--     nội bộ — ghi chú thanh lý chỉ trả khi MỌI khách của hợp đồng nhìn thấy dưới RLS customers của người hỏi.
-- Kiểm: infra/hermes-broker/wave2-z-d.test.mjs (HĐ hai khách, một khách bị RLS ẩn; hạng mục trùng tên; đột biến về thân cũ).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Loại thu chi (useIncomeExpenseTypes): như 20261018040000, trừ thứ tự khử trùng (xem đầu file).
CREATE OR REPLACE FUNCTION public.income_expense_types_list_v1(p_organization_id uuid,p_type text DEFAULT NULL)
RETURNS TABLE(type_id uuid,type text,name text,category text,description text,is_default boolean,system_only boolean,manual_hidden boolean,
  quick_entry_hidden boolean,archived boolean,sort_order integer,is_restricted boolean,rule_key text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission categories) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('categories','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT x.id,x.type,x.name,x.category,x.description,x.is_default,x.system_only,x.manual_hidden,x.quick_entry_hidden,x.archived,x.sort_order,
    x.is_restricted,x.rule_key,x.organization_id
  FROM (SELECT DISTINCT ON (t.type,lower(btrim(t.name))) t.id,t.type,t.name,t.category,t.description,t.is_default,t.system_only,t.manual_hidden,
      t.quick_entry_hidden,t.archived_at IS NOT NULL archived,t.sort_order,t.is_restricted,t.rule_key,t.organization_id
    FROM public.income_expense_types t
    WHERE (t.organization_id IS NULL OR t.organization_id=p_organization_id) AND (p_type IS NULL OR t.type=p_type)
    ORDER BY t.type,lower(btrim(t.name)),(t.organization_id IS NOT NULL) DESC,(t.user_id=auth.uid()) IS TRUE DESC,t.created_at,t.id) x
  ORDER BY x.archived,x.type='income',x.category NULLS LAST,x.sort_order NULLS LAST,x.name,x.id;
END $fn$;

-- Hàm đọc Gói D: như 20261018040300, trừ ghi chú thanh lý (re_terminations).
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_today date; v_buildings uuid[]; v_customers uuid[]; v_contracts uuid[]; v_restricted uuid[];
  v_cat_visible boolean; v_suppliers boolean; v_groups boolean; v_org_wide boolean;
  v_rows jsonb:='[]'::jsonb; v_summary jsonb; v_capped boolean:=false;
  v_floor integer; v_days integer; v_from date; v_to date; v_from_m date; v_to_m date; v_total bigint;
  v_query text:=NULLIF(btrim(COALESCE(p_params->>'query','')),''); v_search text:=lower(NULLIF(btrim(COALESCE(p_params->>'query','')),''));
  v_status text:=p_params->>'status'; v_kind text:=p_params->>'kind';
  v_room uuid; v_category uuid; v_area uuid; v_room_building uuid; v_room_org uuid; v_lifecycle jsonb; v_tz text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_report IS NULL OR p_ctx->>'report' IS DISTINCT FROM p_report THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid; v_today:=(p_ctx->>'today')::date;
  -- Toà của ctx (cổng: grant của khoá báo cáo ∩ overlay) giao với toà chưa xoá của công ty mà người hỏi thấy qua RLS.
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
    WHERE b.organization_id=v_org AND b.deleted_at IS NULL AND jsonb_typeof(p_ctx->'buildings')='array' AND p_ctx->'buildings' ? b.id::text;
  -- Khoá phụ của kết nối (ctx.scopes: NULL = không được cấp / không có trong Read; mảng = toà được cấp).
  v_customers:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx#>ARRAY['scopes','customers.view'])='array'
    THEN p_ctx#>ARRAY['scopes','customers.view'] ELSE '[]'::jsonb END) x);
  v_contracts:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx#>ARRAY['scopes','contracts.view'])='array'
    THEN p_ctx#>ARRAY['scopes','contracts.view'] ELSE '[]'::jsonb END) x);
  v_restricted:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx#>ARRAY['scopes','income_expenses.restricted_view'])='array'
    THEN p_ctx#>ARRAY['scopes','income_expenses.restricted_view'] ELSE '[]'::jsonb END) x);
  v_cat_visible:=jsonb_typeof(p_ctx#>ARRAY['scopes','categories.view'])='array';
  v_suppliers:=jsonb_typeof(p_ctx#>ARRAY['scopes','suppliers.view'])='array';
  v_groups:=jsonb_typeof(p_ctx#>ARRAY['scopes','tasks.view'])='array';
  v_org_wide:=COALESCE((p_ctx->>'orgWide')::boolean,false) AND COALESCE(p_ctx->'requestedBuildingId','null'::jsonb)='null'::jsonb;
  IF jsonb_typeof(p_params->'floor')='number' THEN v_floor:=(p_params->>'floor')::integer; END IF;
  IF jsonb_typeof(p_params->'days')='number' THEN v_days:=(p_params->>'days')::integer; END IF;
  IF jsonb_typeof(p_params->'fromDate')='string' THEN v_from:=(p_params->>'fromDate')::date; END IF;
  IF jsonb_typeof(p_params->'toDate')='string' THEN v_to:=(p_params->>'toDate')::date; END IF;
  IF jsonb_typeof(p_params->'roomId')='string' THEN v_room:=(p_params->>'roomId')::uuid; END IF;
  IF jsonb_typeof(p_params->'categoryId')='string' THEN v_category:=(p_params->>'categoryId')::uuid; END IF;
  IF jsonb_typeof(p_params->'areaId')='string' THEN v_area:=(p_params->>'areaId')::uuid; END IF;
  -- Phòng phải thuộc toà đã giao và người hỏi thấy được qua RLS (cổng đã giải; đây là hàng rào thứ hai).
  IF v_room IS NOT NULL THEN
    SELECT r.building_id,b.organization_id INTO v_room_building,v_room_org FROM public.rooms r
      JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=v_org
      WHERE r.id=v_room AND r.deleted_at IS NULL;
    IF v_room_building IS NULL OR NOT(v_room_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  END IF;
  -- ID không do cổng giải (loại tài sản): phải thuộc công ty và thấy được qua RLS.
  IF v_category IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.asset_categories c WHERE c.id=v_category
      AND (c.organization_id IS NULL OR c.organization_id=v_org)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_report='re_vacant_rooms' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'vacantUpTo7Days',count(*) FILTER (WHERE x.days<=7),
        'vacant8To30Days',count(*) FILTER (WHERE x.days>7 AND x.days<=30),'vacantOver30Days',count(*) FILTER (WHERE x.days>30),
        'unknownSince',count(*) FILTER (WHERE x.days IS NULL))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.building_name,v.room_name,v.room_id) ord,v.days_vacant days,
        jsonb_build_object('organizationId',v.organization_id,'roomId',v.room_id,'roomName',public.report_text_v1(v.room_name,100),
          'buildingId',v.building_id,'buildingName',public.report_text_v1(v.building_name,200),'floor',v.floor,'area',round(v.area,2)::text,
          'rentPrice',round(COALESCE(v.rent_price,0),2)::text,'status',v.status,'lastEndDate',v.last_end_date,'daysVacant',v.days_vacant) item
        FROM public.real_estate_vacant_rooms_v1(v_org,v_buildings,v_floor,v_today) v WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_expiring' THEN
    v_days:=COALESCE(v_days,30);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('days',v_days,'total',count(*),'within7Days',count(*) FILTER (WHERE x.days<=7),
        'within8To15Days',count(*) FILTER (WHERE x.days>7 AND x.days<=15),'within16To30Days',count(*) FILTER (WHERE x.days>15 AND x.days<=30))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.end_date,v.building_name,v.room_name,v.contract_id) ord,v.days_left days,
        jsonb_build_object('organizationId',v.organization_id,'contractId',v.contract_id,
          'contractNumber',public.report_text_v1(v.contract_number,100),'status',v.status,
          'startDate',v.start_date,'endDate',v.end_date,'daysLeft',v.days_left,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,
          'roomId',v.room_id,'roomName',public.report_text_v1(v.room_name,100),'floor',v.floor,'buildingId',v.building_id,
          'buildingName',public.report_text_v1(v.building_name,200),
          'customerName',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_name,200) END,
          'customerPhone',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_phone,40) END,
          'customerEmail',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_email,200) END) item
        FROM public.real_estate_expiring_contracts_v1(v_org,v_buildings,v_days,v_floor,v_today) v
        CROSS JOIN LATERAL (SELECT v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers) ok) pii
        WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_renewals_transfers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'renewals',count(*) FILTER (WHERE x.kind='RENEWAL'),'transfers',count(*) FILTER (WHERE x.kind='TRANSFER'))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.event_date DESC,v.kind,v.contract_number,v.event_id) ord,v.kind,
        jsonb_build_object('organizationId',v.organization_id,'kind',v.kind,'eventId',v.event_id,'contractId',v.contract_id,
          'contractNumber',public.report_text_v1(v.contract_number,100),'eventDate',v.event_date,
          'rentPrice',round(COALESCE(v.rent_price,0),2)::text,'roomId',v.room_id,'roomName',public.report_text_v1(v.room_name,100),
          'buildingId',v.building_id,'buildingName',public.report_text_v1(v.building_name,200),
          'customerName',CASE WHEN v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers)
            THEN public.report_text_v1(v.customer_name,200) END) item
        FROM public.real_estate_renewals_transfers_v1(v_org,v_buildings,v_from,v_to) v WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_promotions' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'active',count(*) FILTER (WHERE x.status='ACTIVE'),'totalSavings',round(COALESCE(sum(x.savings),0),2)::text,
        'avgSavings',round(CASE WHEN count(*)>0 THEN COALESCE(sum(x.savings),0)/count(*) ELSE 0 END,2)::text,
        'withDiscountTerms',count(*) FILTER (WHERE x.has_terms))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.signed_date DESC,v.contract_number,v.contract_id) ord,v.status,v.savings,
        (v.discount_amount<>0 OR COALESCE(v.amount_per_month,0)<>0) has_terms,
        jsonb_build_object('organizationId',v.organization_id,'contractId',v.contract_id,
          'contractNumber',public.report_text_v1(v.contract_number,100),'status',v.status,
          'signedDate',v.signed_date,'startDate',v.start_date,'endDate',v.end_date,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,
          'discountType',v.discount_type,'discountAmount',round(v.discount_amount,2)::text,'savings',round(v.savings,2)::text,
          'effectiveRent',round(v.effective_rent,2)::text,'promotionName',public.report_text_v1(v.promotion_name,200),
          'discountMonths',v.discount_months,'amountPerMonth',round(v.amount_per_month,2)::text,'roomId',v.room_id,
          'roomName',public.report_text_v1(v.room_name,100),'buildingId',v.building_id,
          'buildingName',public.report_text_v1(v.building_name,200),
          'customerName',CASE WHEN v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers)
            THEN public.report_text_v1(v.customer_name,200) END) item
        FROM public.real_estate_promotions_v1(v_org,v_buildings,v_from,v_to) v WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_new_leases' THEN
    -- Mặc định của web: tháng hiện tại (NewLeasesReport.tsx:22-25).
    IF v_from IS NULL AND v_to IS NULL THEN
      v_from:=date_trunc('month',v_today)::date; v_to:=(date_trunc('month',v_today)+interval '1 month'-interval '1 day')::date;
    END IF;
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('fromDate',v_from,'toDate',v_to,'total',count(*),'totalValue',round(COALESCE(sum(x.total_value),0),2)::text,
        'avgRent',round(CASE WHEN count(*)>0 THEN COALESCE(sum(x.rent),0)/count(*) ELSE 0 END,2)::text,
        'avgDurationMonths',CASE WHEN count(*)>0 THEN round(sum(x.months)::numeric/count(*))::integer ELSE 0 END)
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.signed_date DESC,v.contract_number,v.contract_id) ord,v.total_value,v.rent_price rent,
        v.duration_months months,
        jsonb_build_object('organizationId',v.organization_id,'contractId',v.contract_id,
          'contractNumber',public.report_text_v1(v.contract_number,100),'status',v.status,
          'signedDate',v.signed_date,'startDate',v.start_date,'endDate',v.end_date,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,
          'totalDeposit',round(COALESCE(v.total_deposit,0),2)::text,'paymentCycle',v.payment_cycle,'durationMonths',v.duration_months,
          'totalValue',round(COALESCE(v.total_value,0),2)::text,'roomId',v.room_id,'roomName',public.report_text_v1(v.room_name,100),
          'buildingId',v.building_id,'buildingName',public.report_text_v1(v.building_name,200),
          'customerName',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_name,200) END,
          'customerPhone',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_phone,40) END) item
        FROM public.real_estate_new_leases_v1(v_org,v_buildings,v_from,v_to) v
        CROSS JOIN LATERAL (SELECT v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers) ok) pii
        WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_terminations' THEN
    -- Mặc định của web: đầu tháng tới hôm nay (TerminationsReport.tsx:22-25).
    IF v_from IS NULL AND v_to IS NULL THEN v_from:=date_trunc('month',v_today)::date; v_to:=v_today; END IF;
    -- (Review P2) Tử số và mẫu số cùng MỘT tập toà (v_buildings). Khác web: realEstateReports.ts lọc tử số theo toà nhưng
    -- mẫu số lấy toàn công ty (lỗi của web, ghi ở web-parity w2d-re-terminations).
    v_total:=public.real_estate_contract_count_v1(v_org,v_buildings);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('fromDate',v_from,'toDate',v_to,'total',count(*),'terminated',count(*) FILTER (WHERE x.status='TERMINATED'),
        'expired',count(*) FILTER (WHERE x.status='EXPIRED'),'totalContracts',v_total,
        'terminationRatePct',round(CASE WHEN v_total>0 THEN count(*)*100.0/v_total ELSE 0 END,1)::text)
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.actual_end_date DESC NULLS LAST,v.contract_id) ord,v.status,
        jsonb_build_object('organizationId',v.organization_id,'contractId',v.contract_id,
          'contractNumber',public.report_text_v1(v.contract_number,100),'status',v.status,
          'startDate',v.start_date,'endDate',v.end_date,'actualEndDate',v.actual_end_date,'effectiveEndDate',v.effective_end_date,
          'durationDays',v.duration_days,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,'totalDeposit',round(COALESCE(v.total_deposit,0),2)::text,
          'terminationType',public.report_text_v1(v.termination_type,40),
          'note',CASE WHEN nv.ok THEN public.report_text_v1(v.termination_note,300) END,
          'roomId',v.room_id,'roomName',public.report_text_v1(v.room_name,100),'buildingId',v.building_id,
          'buildingName',public.report_text_v1(v.building_name,200),
          'customerName',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_name,200) END,
          'customerPhone',CASE WHEN pii.ok THEN public.report_text_v1(v.customer_phone,40) END) item
        FROM public.real_estate_terminations_v1(v_org,v_buildings,v_from,v_to) v
        CROSS JOIN LATERAL (SELECT v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers) ok) pii
        -- (Gói Z) Ghi chú thanh lý là chữ tự do có thể nhắc BẤT KỲ khách nào của HĐ: ngoài rào tên khách, đòi MỌI khách của
        -- HĐ nhìn thấy dưới RLS customers (cùng công ty); contract_customers theo RLS hợp đồng nên đếm dòng = đếm khách.
        CROSS JOIN LATERAL (SELECT pii.ok AND COALESCE((SELECT count(*)>0 AND count(*)=count(cu.id) FROM public.contract_customers cc
            LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org WHERE cc.contract_id=v.contract_id),false) ok) nv
        WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_expense_ratio' THEN
    -- Kỳ theo tháng như web (realEstateReports.ts:531-538): mặc định 6 tháng tới tháng hiện tại.
    v_to_m:=date_trunc('month',COALESCE(v_to,v_today))::date;
    v_from_m:=date_trunc('month',COALESCE(v_from,v_to_m-interval '5 months'))::date;
    -- Thẻ số + biểu đồ của web gộp mọi toà (summary, byMonth); hàng chi tiết theo TOÀ (mọi hàng nêu buildingId).
    WITH raw AS MATERIALIZED (SELECT r.row_kind,r.organization_id,r.building_id,r.month,r.category,r.type_name,r.amount
      FROM public.real_estate_expense_ratio_v1(v_org,v_buildings,v_from_m,v_to_m,v_query,v_restricted) r
      WHERE r.building_id=ANY(v_buildings) AND (r.row_kind='revenue' OR v_cat_visible)),
    months AS (SELECT to_char(m,'YYYY-MM') AS month FROM generate_series(v_from_m,v_to_m,interval '1 month') m),
    by_month AS (SELECT mo.month,COALESCE((SELECT sum(t.amount) FROM raw t WHERE t.row_kind='revenue' AND t.month=mo.month),0) revenue,
        COALESCE((SELECT sum(t.amount) FROM raw t WHERE t.row_kind='expense' AND t.month=mo.month),0) expense FROM months mo),
    ratios AS (SELECT b.*,CASE WHEN b.revenue>0 THEN b.expense/b.revenue*100 END ratio FROM by_month b),
    peak AS (SELECT r.month,r.ratio FROM ratios r WHERE r.ratio IS NOT NULL ORDER BY r.ratio DESC,r.month LIMIT 1),
    bld AS (SELECT b.id,b.name,b.organization_id FROM public.buildings b WHERE b.id IN (SELECT t.building_id FROM raw t) AND b.organization_id=v_org),
    bld_month AS (SELECT bl.organization_id,bl.id building_id,bl.name building_name,mo.month,
        COALESCE((SELECT sum(t.amount) FROM raw t WHERE t.row_kind='revenue' AND t.building_id=bl.id AND t.month=mo.month),0) revenue,
        COALESCE((SELECT sum(t.amount) FROM raw t WHERE t.row_kind='expense' AND t.building_id=bl.id AND t.month=mo.month),0) expense
      FROM bld bl CROSS JOIN months mo)
    SELECT jsonb_build_object('fromMonth',to_char(v_from_m,'YYYY-MM'),'toMonth',to_char(v_to_m,'YYYY-MM'),
        'totalRevenue',round((SELECT COALESCE(sum(revenue),0) FROM ratios),2)::text,'totalExpense',round((SELECT COALESCE(sum(expense),0) FROM ratios),2)::text,
        'avgRatioPct',round(COALESCE((SELECT avg(ratio) FROM ratios WHERE ratio IS NOT NULL),0),2)::text,
        'peakMonth',(SELECT month FROM peak),'peakRatioPct',(SELECT round(ratio,2)::text FROM peak),
        'byMonth',(SELECT COALESCE(jsonb_agg(jsonb_build_object('month',r.month,'revenue',round(r.revenue,2)::text,'expense',round(r.expense,2)::text,
          'ratioPct',round(r.ratio,2)::text) ORDER BY r.month),'[]'::jsonb) FROM ratios r),
        'categories',COALESCE((SELECT jsonb_agg(public.report_text_v1(c,200) ORDER BY c) FROM (SELECT DISTINCT t.category c FROM raw t
          WHERE t.row_kind='expense' ORDER BY 1 LIMIT 100) cats),'[]'::jsonb),
        'expenseTypesVisible',v_cat_visible,'category',public.report_text_v1(v_query,200)),
      CASE v_kind
        WHEN 'category' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',g.organization_id,'buildingId',g.building_id,
            'buildingName',public.report_text_v1(bl.name,200),
            'month',g.month,'category',public.report_text_v1(g.category,200),'typeName',NULL,'revenue',NULL,'expense',round(g.amount,2)::text,'ratioPct',NULL)
            ORDER BY bl.name,g.building_id,g.month,g.category),'[]'::jsonb)
          FROM (SELECT t.organization_id,t.building_id,t.month,t.category,sum(t.amount) amount FROM raw t WHERE t.row_kind='expense' GROUP BY 1,2,3,4) g
          JOIN bld bl ON bl.id=g.building_id)
        WHEN 'type' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',g.organization_id,'buildingId',g.building_id,
            'buildingName',public.report_text_v1(bl.name,200),
            'month',NULL,'category',public.report_text_v1(g.category,200),'typeName',public.report_text_v1(g.type_name,200),'revenue',NULL,
            'expense',round(g.amount,2)::text,'ratioPct',NULL) ORDER BY bl.name,g.building_id,g.amount DESC,g.category,g.type_name),'[]'::jsonb)
          FROM (SELECT t.organization_id,t.building_id,t.category,t.type_name,sum(t.amount) amount FROM raw t WHERE t.row_kind='expense' GROUP BY 1,2,3,4) g
          JOIN bld bl ON bl.id=g.building_id)
        ELSE (SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',m.organization_id,'buildingId',m.building_id,
            'buildingName',public.report_text_v1(m.building_name,200),
            'month',m.month,'category',NULL,'typeName',NULL,'revenue',round(m.revenue,2)::text,'expense',round(m.expense,2)::text,
            'ratioPct',round(CASE WHEN m.revenue>0 THEN m.expense/m.revenue*100 END,2)::text) ORDER BY m.building_name,m.building_id,m.month),'[]'::jsonb)
          FROM bld_month m) END
      INTO v_summary,v_rows;
    IF jsonb_array_length(v_rows)>2000 THEN
      v_capped:=true; v_rows:=(SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,o) WHERE o<=2000);
    END IF;
  ELSIF p_report='assets' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'totalValue',round(COALESCE(sum(x.value),0),2)::text,
        'goodOrNew',count(*) FILTER (WHERE COALESCE(x.condition,'GOOD') IN ('GOOD','NEW')),
        'poorOrBroken',count(*) FILTER (WHERE x.condition IN ('POOR','BROKEN')))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY a.created_at DESC,a.asset_id) ord,a.total_value value,a.condition,
        jsonb_build_object('organizationId',a.organization_id,'id',a.asset_id,'code',public.report_text_v1(a.code,100),'name',public.report_text_v1(a.name,200),
          'categoryName',public.report_text_v1(a.category_name,200),'quantity',a.quantity,'totalValue',round(a.total_value,2)::text,
          'condition',a.condition,'buildingId',a.building_id,'buildingName',public.report_text_v1(a.building_name,200),
          'roomId',a.room_id,'roomName',public.report_text_v1(a.room_name,100),
          'supplierName',CASE WHEN v_suppliers THEN public.report_text_v1(a.supplier_name,200) END,'purchaseDate',a.purchase_date) item
        FROM public.assets_list_v1(v_org,v_buildings,v_org_wide AND v_room IS NULL,v_category,v_status,v_room) a
        WHERE (a.building_id=ANY(v_buildings) OR a.building_id IS NULL AND v_org_wide)
          AND (v_search IS NULL OR position(v_search IN lower(COALESCE(a.name,'')))>0 OR position(v_search IN lower(COALESCE(a.code,'')))>0
            OR position(v_search IN lower(COALESCE(a.category_name,'')))>0)) x;
  ELSIF p_report='services' THEN
    -- Một hàng cho mỗi (toà, dịch vụ) đang áp dụng; dịch vụ chưa gắn toà nào (chỉ Toàn tổ chức) có buildingId null.
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(DISTINCT x.service_id),'links',count(x.building_id))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY b.name NULLS FIRST,l.building_id NULLS FIRST,s.name,s.service_id) ord,s.service_id,l.building_id,
        jsonb_build_object('organizationId',s.organization_id,'buildingId',l.building_id,'buildingName',public.report_text_v1(b.name,200),'id',s.service_id,
          'code',public.report_text_v1(s.code,100),'name',public.report_text_v1(s.name,200),
          'feeType',s.fee_type,'pricingType',s.pricing_type,'unit',public.report_text_v1(s.unit,40),
          'unitPrice',round(COALESCE(s.unit_price,0),2)::text,'isDefault',COALESCE(s.is_default,false)) item
        FROM public.services_list_v1(v_org,v_buildings,v_org_wide,v_kind) s
        CROSS JOIN LATERAL (SELECT u building_id FROM unnest(s.building_ids) u WHERE u=ANY(v_buildings)
          UNION ALL SELECT NULL::uuid WHERE v_org_wide AND NOT EXISTS(SELECT 1 FROM unnest(s.building_ids) u WHERE u=ANY(v_buildings))) l
        LEFT JOIN public.buildings b ON b.id=l.building_id AND b.organization_id=v_org) x;
  ELSIF p_report='service_quotas' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY q.name,q.quota_id) ord,
        jsonb_build_object('organizationId',q.organization_id,'id',q.quota_id,'name',public.report_text_v1(q.name,200),
          'description',public.report_text_v1(q.description,500),'tierCount',q.tier_count,
          'tiers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('tierNumber',(t->>'tierNumber')::integer,
              'fromValue',round((t->>'fromValue')::numeric,2)::text,'toValue',round((t->>'toValue')::numeric,2)::text,
              'unitPrice',round((t->>'unitPrice')::numeric,2)::text) ORDER BY o),'[]'::jsonb)
            FROM jsonb_array_elements(q.tiers) WITH ORDINALITY e(t,o) WHERE o<=50)) item
        FROM public.service_quotas_list_v1(v_org) q) x;
  ELSIF p_report='suppliers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY s.name,s.supplier_id) ord,
        jsonb_build_object('organizationId',s.organization_id,'id',s.supplier_id,'name',public.report_text_v1(s.name,200)) item
        FROM public.suppliers_list_v1(v_org) s) x;
  ELSIF p_report='meters' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY m.building_name,m.room_name NULLS FIRST,m.code,m.meter_id) ord,
        jsonb_build_object('organizationId',m.organization_id,'id',m.meter_id,'code',public.report_text_v1(m.code,100),'name',public.report_text_v1(m.name,200),
          'meterType',m.meter_type,'status',public.report_text_v1(m.status,40),'buildingId',m.building_id,
          'buildingName',public.report_text_v1(m.building_name,200),'roomId',m.room_id,'roomName',public.report_text_v1(m.room_name,100),
          'initialReading',round(m.initial_reading,2)::text,'latestReading',round(m.latest_reading,2)::text,'latestReadingDate',m.latest_reading_date) item
        FROM public.meters_list_v1(v_org,v_buildings,v_kind,v_room) m WHERE m.building_id=ANY(v_buildings)) x;
  ELSIF p_report IN ('buildings','building_detail') THEN
    -- Danh sách: ẩn toà ảo (useBuildings mặc định .eq is_virtual false); chi tiết: useBuilding không lọc ảo.
    v_tz:=COALESCE((SELECT t.timezone FROM public.organization_timezones t WHERE t.organization_id=v_org),'Asia/Ho_Chi_Minh');
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000 AND x.shown),'[]'::jsonb),count(*) FILTER (WHERE x.shown)>2000,
      jsonb_build_object('total',count(*),'active',count(*) FILTER (WHERE x.status='ACTIVE'),
        'inactive',count(*) FILTER (WHERE x.status='INACTIVE'))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY b.created_at DESC,b.building_id) ord,b.status,(v_status IS NULL OR b.status=v_status) shown,
        jsonb_build_object('organizationId',b.organization_id,'buildingId',b.building_id,'code',public.report_text_v1(b.code,100),'name',public.report_text_v1(b.name,200),
          'type',b.type,'status',b.status,'totalFloors',b.total_floors,
          'address',public.report_text_v1(NULLIF(concat_ws(', ',NULLIF(btrim(b.street_address),''),NULLIF(btrim(b.ward),''),
            NULLIF(btrim(b.district),''),NULLIF(btrim(b.province),'')),''),500),
          'description',CASE WHEN p_report='building_detail' THEN public.report_text_v1(b.description,1000) END,
          'areaNames',to_jsonb(ARRAY(SELECT public.report_text_v1(n,200) FROM unnest(b.area_names) n LIMIT 20)),
          'roomsTotal',b.rooms_count,'roomsAvailable',b.rooms_available,'roomsOccupied',b.rooms_occupied,'roomsReserved',b.rooms_reserved,
          'roomsMaintenance',b.rooms_maintenance,'roomsUnavailable',b.rooms_unavailable,
          'updatedOn',(COALESCE(b.updated_at,b.created_at) AT TIME ZONE v_tz)::date) item
        FROM public.buildings_list_v1(v_org,v_buildings) b
        WHERE b.building_id=ANY(v_buildings) AND (p_report='building_detail' OR NOT COALESCE(b.is_virtual,false))
          AND (v_area IS NULL OR v_area=ANY(b.area_ids))
          AND (v_search IS NULL OR position(v_search IN lower(concat_ws(' ',b.name,b.code,b.street_address)))>0)) x;
  ELSIF p_report='areas' THEN
    -- Một hàng cho mỗi (khu, toà) trong phạm vi; khu chưa có toà (chỉ Toàn tổ chức) có buildingId null.
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(DISTINCT x.area_id),'links',count(x.building_id))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY a.created_at DESC,a.area_id,b.name NULLS FIRST,l.building_id NULLS FIRST) ord,a.area_id,l.building_id,
        jsonb_build_object('organizationId',a.organization_id,'id',a.area_id,'code',public.report_text_v1(a.code,100),'name',public.report_text_v1(a.name,200),
          'status',public.report_text_v1(a.status,40),'buildingId',l.building_id,'buildingName',public.report_text_v1(b.name,200)) item
        FROM public.areas_list_v1(v_org,v_buildings,v_org_wide) a
        CROSS JOIN LATERAL (SELECT u building_id FROM unnest(a.building_ids) u WHERE u=ANY(v_buildings)
          UNION ALL SELECT NULL::uuid WHERE v_org_wide AND NOT EXISTS(SELECT 1 FROM unnest(a.building_ids) u WHERE u=ANY(v_buildings))) l
        LEFT JOIN public.buildings b ON b.id=l.building_id AND b.organization_id=v_org) x;
  ELSIF p_report='rooms' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'available',count(*) FILTER (WHERE x.display='AVAILABLE'),
        'expiringSoon',count(*) FILTER (WHERE x.display='EXPIRING_SOON'),'reserved',count(*) FILTER (WHERE x.display='RESERVED'))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY r.building_name,r.name,r.room_id) ord,r.display_status display,
        jsonb_build_object('organizationId',r.organization_id,'roomId',r.room_id,'name',public.report_text_v1(r.name,100),
          'code',public.report_text_v1(r.code,100),'buildingId',r.building_id,'buildingName',public.report_text_v1(r.building_name,200),'floor',r.floor,'area',round(r.area,2)::text,
          'rentPrice',round(COALESCE(r.rent_price,0),2)::text,'depositAmount',round(COALESCE(r.deposit_amount,0),2)::text,'maxOccupants',r.max_occupants,
          'status',r.status,'displayStatus',r.display_status) item
        FROM public.rooms_list_v1(v_org,v_buildings,v_today) r
        WHERE r.building_id=ANY(v_buildings) AND (v_floor IS NULL OR r.floor=v_floor)
          AND (v_status IS NULL OR r.status=CASE v_status WHEN 'ACTIVE' THEN 'AVAILABLE' WHEN 'INACTIVE' THEN 'UNAVAILABLE' ELSE 'RESERVED' END)
          AND (v_search IS NULL OR position(v_search IN lower(COALESCE(r.name,'')))>0 OR position(v_search IN lower(COALESCE(r.code,'')))>0)) x;
  ELSIF p_report='room_detail' THEN
    -- Hợp đồng: contracts.view của kết nối phủ toà (như crm_read_contract_detail đợt 1); người ở: customers.view.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',r.organization_id,'roomId',r.room_id,'name',public.report_text_v1(r.name,100),
        'code',public.report_text_v1(r.code,100),'buildingId',r.building_id,'buildingName',public.report_text_v1(r.building_name,200),
        'floor',r.floor,'area',round(r.area,2)::text,'rentPrice',round(COALESCE(r.rent_price,0),2)::text,
        'depositAmount',round(COALESCE(r.deposit_amount,0),2)::text,'maxOccupants',r.max_occupants,'status',r.status,'displayStatus',r.display_status,
        'contractVisible',COALESCE(r.building_id=ANY(v_contracts),false),
        'contract',CASE WHEN r.building_id=ANY(v_contracts) THEN (SELECT jsonb_build_object('contractId',t.contract_id,
            'contractNumber',public.report_text_v1(t.contract_number,100),'startDate',t.start_date,'endDate',t.end_date,
            'rentPrice',round(COALESCE(t.rent_price,0),2)::text)
          FROM public.room_tenancy_v1(v_org,v_buildings,r.room_id) t LIMIT 1) END,
        'tenantsVisible',COALESCE(r.building_id=ANY(v_customers),false),
        'tenants',CASE WHEN r.building_id=ANY(v_customers) THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name',public.report_text_v1(t.customer_name,200),'phone',public.report_text_v1(t.customer_phone,40),
            'isRepresentative',COALESCE(t.is_representative,false)) ORDER BY t.is_representative DESC NULLS LAST,t.customer_name,t.customer_id),'[]'::jsonb)
          FROM (SELECT * FROM public.room_tenancy_v1(v_org,v_buildings,r.room_id) t WHERE t.customer_id IS NOT NULL
            ORDER BY t.is_representative DESC NULLS LAST,t.customer_name,t.customer_id LIMIT 20) t) ELSE '[]'::jsonb END)),'[]'::jsonb),
      NULL
      INTO v_rows,v_summary
      FROM public.rooms_list_v1(v_org,ARRAY[v_room_building],v_today) r WHERE r.room_id=v_room AND r.building_id=ANY(v_buildings);
  ELSIF p_report='room_cash_lifecycle' THEN
    -- RPC web (RoomLifecycleSheet trên /thu-tien, khoá thu_tien.view). RPC tự kiểm can_access_building nhưng KHÔNG
    -- kiểm khoá module ⇒ Hermes chỉ gọi khi đã có đúng khoá web và toà ∈ phạm vi. Bỏ meta, tên khách (bảng
    -- tenants cũ), segments chẩn đoán.
    v_lifecycle:=public.get_room_cash_lifecycle_v1(v_room,CASE WHEN jsonb_typeof(p_params->'fromDate')='string' THEN (p_params->>'fromDate')::date END,
      CASE WHEN jsonb_typeof(p_params->'toDate')='string' THEN (p_params->>'toDate')::date END);
    IF v_lifecycle#>>'{room,buildingId}' IS DISTINCT FROM v_room_building::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',v_room_org,'buildingId',v_room_building,'type',e->>'type','date',e->>'date','contractId',e->>'contractId',
        'amount',CASE WHEN jsonb_typeof(e->'amount')='number' THEN round((e->>'amount')::numeric,2)::text END,'trusted',COALESCE((e->>'trusted')::boolean,false))
        ORDER BY o) FILTER (WHERE o<=2000),'[]'::jsonb),count(*)>2000
      INTO v_rows,v_capped FROM jsonb_array_elements(COALESCE(v_lifecycle->'events','[]'::jsonb)) WITH ORDINALITY ev(e,o);
    v_summary:=jsonb_build_object('roomId',v_room,'roomName',public.report_text_v1(v_lifecycle#>>'{room,name}',100),
      'buildingId',v_room_building,'buildingName',public.report_text_v1(v_lifecycle#>>'{room,buildingName}',200),
      'contracts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c->>'id','number',public.report_text_v1(c->>'number',100),
          'status',c->>'status','startDate',c->>'startDate','endDate',c->>'endDate','actualEndDate',c->>'actualEndDate',
          'rentPrice',round(COALESCE((c->>'rentPrice')::numeric,0),2)::text,'totalDeposit',round(COALESCE((c->>'totalDeposit')::numeric,0),2)::text)
          ORDER BY o),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(v_lifecycle->'contracts','[]'::jsonb)) WITH ORDINALITY ce(c,o) WHERE o<=50),
      'vacancies',(SELECT COALESCE(jsonb_agg(jsonb_build_object('fromDate',v->>'fromDate','toDate',v->>'toDate',
          'days',CASE WHEN jsonb_typeof(v->'days')='number' THEN (v->>'days')::integer END) ORDER BY o),'[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(v_lifecycle->'vacancies','[]'::jsonb)) WITH ORDINALITY va(v,o) WHERE o<=100));
  ELSIF p_report='floors' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY f.floor_number,f.building_name,f.floor_id) ord,
        jsonb_build_object('organizationId',f.organization_id,'id',f.floor_id,'buildingId',f.building_id,'buildingName',public.report_text_v1(f.building_name,200),
          'floorNumber',f.floor_number,'name',public.report_text_v1(f.name,100),'description',public.report_text_v1(f.description,500),
          'status',public.report_text_v1(f.status,40)) item
        FROM public.floors_list_v1(v_org,v_buildings) f WHERE f.building_id=ANY(v_buildings)) x;
  ELSIF p_report='ie_types' THEN
    -- Ẩn hạng mục hạn chế, lương, cổ đông (như crm_read_income_expenses đợt 1) — chặt hơn web cho người có
    -- income_expenses.restricted_view.
    -- (Review P2) Hạng mục dùng chung (organization_id NULL) tạm KHÔNG trả: rào công ty của cổng (000700) đòi mọi hàng
    -- mang đúng công ty kết nối, một hàng NULL làm cả báo cáo 42501. Chỉ trả hạng mục của chính công ty, đếm phần bỏ
    -- vào summary.globalRowsOmitted (cùng bộ lọc hiển thị). Gói Z giữ cách này (ngoại lệ nền, docs/CODEBASE_STRUCTURE.md) và
    -- cho hạng mục của công ty thắng hạng mục dùng chung cùng tên khi khử trùng (income_expense_types_list_v1).
    WITH shown AS MATERIALIZED (SELECT t.* FROM public.income_expense_types_list_v1(v_org,v_kind) t
        WHERE NOT COALESCE(t.is_restricted,true)
          AND COALESCE(t.rule_key,'') NOT IN ('luong_dieu_hanh','luong_quan_ly','ung_luong','chia_loi_nhuan'))
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'globalRowsOmitted',(SELECT count(*) FROM shown g WHERE g.organization_id IS NULL))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY t.archived,t.type='income',t.category NULLS LAST,t.sort_order NULLS LAST,t.name,t.type_id) ord,
        jsonb_build_object('organizationId',t.organization_id,'id',t.type_id,'type',t.type,'name',public.report_text_v1(t.name,200),
          'category',public.report_text_v1(t.category,200),'description',public.report_text_v1(t.description,500),
          'isDefault',COALESCE(t.is_default,false),'systemOnly',COALESCE(t.system_only,false),'manualHidden',COALESCE(t.manual_hidden,false),
          'quickEntryHidden',COALESCE(t.quick_entry_hidden,false),'archived',t.archived) item
        FROM shown t WHERE t.organization_id=v_org) x;
  ELSIF p_report='task_types' THEN
    -- Nhóm việc: RLS job_groups (tasks.view) của web + khoá tasks.view có trong Read của kết nối.
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY j.created_at DESC,j.job_type_id) ord,
        jsonb_build_object('organizationId',j.organization_id,'id',j.job_type_id,'name',public.report_text_v1(j.name,200),
          'departmentName',public.report_text_v1(j.department_name,200),
          'jobGroupName',CASE WHEN v_groups THEN public.report_text_v1(j.job_group_name,200) END,
          'customerContactDeadlineMinutes',j.customer_contact_deadline,'acceptanceDeadlineMinutes',j.acceptance_deadline,
          'completionDeadlineMinutes',j.completion_deadline,'businessHoursOnly',j.business_hours_only,'isActive',j.is_active) item
        FROM public.job_types_list_v1(v_org) j WHERE v_search IS NULL OR position(v_search IN lower(COALESCE(j.name,'')))>0) x;
  ELSIF p_report='hotlines' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY h.created_at DESC,h.hotline_id) ord,
        jsonb_build_object('organizationId',h.organization_id,'id',h.hotline_id,'name',public.report_text_v1(h.name,200),'phoneNumber',public.report_text_v1(h.phone_number,40),
          'description',public.report_text_v1(h.description,500),'isActive',h.is_active) item FROM public.hotlines_list_v1(v_org) h) x;
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

ALTER FUNCTION public.income_expense_types_list_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_read_v1(text,jsonb,jsonb) OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
