-- Hermes đọc đầy đủ — báo cáo khớp màn web đang hiển thị (đợt 1b, 17/10/2026). Chạy SAU
-- 20261016172206_hermes_full_read_review_fixes_v1 (đã apply TEST nên không sửa; thay thân
-- bằng file này). Chủ chốt 17/10: Hermes KHÔNG phụ thuộc copilot_* (chỉ tham khảo). Mọi
-- đọc đi qua MỘT cổng hermes_domain_read_v3 + bảng hermes_report_catalog_v1; bên trong:
-- màn web có RPC riêng ⇒ gọi thẳng đúng RPC đó; web đọc bảng qua PostgREST ⇒ SQL theo đúng
-- bộ lọc web (dẫn file:line). File này không gọi hàm copilot_* nào.
--   occupancy_report snapshot → occupancy_snapshot_v2   (src/hooks/reports/useOccupancyDashboard.ts:83)
--   occupancy_report upcoming → occupancy_upcoming_vacancy_v2 (useOccupancyDashboard.ts:108)
--   miền occupancy (crm_read_occupancy) → occupancy_snapshot_v2, thay đếm rooms.status
--   invoice_report search → SQL theo src/hooks/useInvoices.ts:194-214 (mặc định ẩn huỷ;
--     unpaid = chưa thu đồng nào, không huỷ) và 230-257 (số HĐ hoặc tên khách)
--   invoice_report stats → SQL riêng (20261016172206) theo quyền invoices.view thật
--   monthly_pnl → fa_monthly_pnl_accrual / fa_monthly_pnl (src/hooks/useFinancialAnalysis.ts:96-98),
--     mặc định dồn tích; kèm thu/chi CHỜ DUYỆT (ALL_ACTIVE của BC Doanh Thu Chi Phí,
--     src/hooks/useAccrualReport.ts:185-186) cùng cách phân bổ, tách riêng
--   pending_approvals → list_my_pending_approvals_v1 (src/hooks/useApprovals.ts:51)
--   zalo_conversations → SQL theo src/hooks/useZaloChat.ts:170-176 + RLS web
--     (zalo_authorized_org_ids('view'))
--   contract_search → SQL theo src/hooks/useContracts.ts:253-298 (tìm số HĐ, tên/SĐT khách,
--     tên phòng) và 322-344 (lọc vòng đời/sắp hết hạn/quá hạn) + nhãn getContractDisplayStatus
--     (src/types/contract.ts:180-196)
-- Phạm vi: quyền CRM thật (authorized_scope_v3 của đúng khoá) ∩ Read kết nối ∩ toà kết nối;
-- RPC nhận tham số toà ⇒ truyền tập toà đã giao; không nhận ⇒ chỉ kết nối Toàn tổ chức.
-- Không DROP, không đổi chữ ký hàm đã phát hành, không thêm khoá quyền.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Tổng thu/chi CHỜ DUYỆT (UNAPPROVED) trong kỳ trên tập toà đã giao — phần mà BC Doanh Thu Chi
-- Phí cộng thêm (ALL_ACTIVE) so với fa_monthly_pnl*. Dồn tích: chép nguyên cách phân bổ của
-- public.fa_accrual_allocations (bản 20260721080000) chỉ đổi approval_status; tiền mặt: như
-- public.fa_monthly_pnl. Không ghi gì.
CREATE OR REPLACE FUNCTION app_private.hermes_pnl_pending_v1(p_start_date date,p_end_date date,p_building_ids uuid[],p_accrual boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_start_date IS NULL OR p_end_date IS NULL THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF COALESCE(p_accrual,true) THEN
    WITH allowed AS (
      SELECT b.id FROM public.buildings b
      WHERE b.deleted_at IS NULL AND b.id=ANY(COALESCE(p_building_ids,'{}'::uuid[])) AND public.can_access_building(b.id)
    ),
    win AS (SELECT date_trunc('month',p_start_date)::date AS w_start,date_trunc('month',p_end_date)::date AS w_end),
    vouchers AS (
      SELECT voucher.id,voucher.type::text AS side,voucher.voucher_date,voucher.total_amount,voucher.business_result_accounting AS override,
        CASE WHEN voucher.invoice_id IS NOT NULL AND invoice.billing_month ~ '^\d{4}-\d{2}$' THEN to_date(invoice.billing_month,'YYYY-MM') END AS inv_month
      FROM allowed JOIN public.income_expenses voucher ON voucher.building_id=allowed.id
      LEFT JOIN public.invoices invoice ON invoice.id=voucher.invoice_id AND invoice.deleted_at IS NULL
      WHERE voucher.deleted_at IS NULL AND voucher.approval_status='UNAPPROVED' AND voucher.business_result_accounting IS DISTINCT FROM false
    ),
    invoice_items AS (
      SELECT v.inv_month AS m,v.id,v.side,COALESCE(item.amount,item.unit_price*item.quantity)::numeric AS amt
      FROM vouchers v JOIN public.income_expense_items item ON item.income_expense_id=v.id
      JOIN public.income_expense_types type_row ON type_row.id=item.income_expense_type_id
      WHERE v.inv_month IS NOT NULL AND (v.override IS TRUE OR item.accounting_class='PNL')
    ),
    invoice_no_item AS (
      SELECT v.inv_month AS m,v.id,v.side,v.total_amount AS amt FROM vouchers v
      WHERE v.inv_month IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id=v.id)
    ),
    period_items AS (
      SELECT (date_trunc('month',item.start_date)+(series.i||' month')::interval)::date AS m,v.id,v.side,
        (round(COALESCE(item.amount,item.unit_price*item.quantity)*(series.i+1)/count_months.n)
         -round(COALESCE(item.amount,item.unit_price*item.quantity)*series.i/count_months.n))::numeric AS amt
      FROM vouchers v JOIN public.income_expense_items item ON item.income_expense_id=v.id
      JOIN public.income_expense_types type_row ON type_row.id=item.income_expense_type_id
      CROSS JOIN LATERAL (SELECT GREATEST(extract(year FROM item.end_date)::int*12+extract(month FROM item.end_date)::int
        -extract(year FROM item.start_date)::int*12-extract(month FROM item.start_date)::int+1,1) AS n) count_months
      CROSS JOIN LATERAL generate_series(0,count_months.n-1) AS series(i)
      WHERE v.inv_month IS NULL AND (v.override IS TRUE OR item.accounting_class='PNL')
        AND item.start_date IS NOT NULL AND item.end_date IS NOT NULL AND item.end_date>=item.start_date
    ),
    invalid_period_items AS (
      SELECT date_trunc('month',item.start_date)::date AS m,v.id,v.side,COALESCE(item.amount,item.unit_price*item.quantity)::numeric AS amt
      FROM vouchers v JOIN public.income_expense_items item ON item.income_expense_id=v.id
      JOIN public.income_expense_types type_row ON type_row.id=item.income_expense_type_id
      WHERE v.inv_month IS NULL AND (v.override IS TRUE OR item.accounting_class='PNL')
        AND item.start_date IS NOT NULL AND item.end_date IS NOT NULL AND item.end_date<item.start_date
    ),
    no_period_items AS (
      SELECT date_trunc('month',v.voucher_date)::date AS m,v.id,v.side,COALESCE(item.amount,item.unit_price*item.quantity)::numeric AS amt
      FROM vouchers v JOIN public.income_expense_items item ON item.income_expense_id=v.id
      JOIN public.income_expense_types type_row ON type_row.id=item.income_expense_type_id
      WHERE v.inv_month IS NULL AND (v.override IS TRUE OR item.accounting_class='PNL') AND (item.start_date IS NULL OR item.end_date IS NULL)
    ),
    no_item AS (
      SELECT date_trunc('month',v.voucher_date)::date AS m,v.id,v.side,v.total_amount AS amt FROM vouchers v
      WHERE v.inv_month IS NULL AND NOT EXISTS(SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id=v.id)
    ),
    unioned AS (
      SELECT * FROM invoice_items UNION ALL SELECT * FROM invoice_no_item UNION ALL SELECT * FROM period_items
      UNION ALL SELECT * FROM invalid_period_items UNION ALL SELECT * FROM no_period_items UNION ALL SELECT * FROM no_item
    )
    SELECT jsonb_build_object('pendingIncome',COALESCE(sum(u.amt) FILTER (WHERE u.side='INCOME'),0)::text,
        'pendingExpense',COALESCE(sum(u.amt) FILTER (WHERE u.side='EXPENSE'),0)::text,'pendingVouchers',count(DISTINCT u.id))
      INTO v_result FROM unioned u,win WHERE u.m BETWEEN win.w_start AND win.w_end;
  ELSE
    SELECT jsonb_build_object('pendingIncome',COALESCE(sum(ie.kqkd_amount) FILTER (WHERE ie.type='INCOME'),0)::text,
        'pendingExpense',COALESCE(sum(ie.kqkd_amount) FILTER (WHERE ie.type='EXPENSE'),0)::text,'pendingVouchers',count(DISTINCT ie.id))
      INTO v_result FROM public.buildings b JOIN public.income_expenses ie ON ie.building_id=b.id
      WHERE b.deleted_at IS NULL AND b.id=ANY(COALESCE(p_building_ids,'{}'::uuid[])) AND public.can_access_building(b.id)
        AND ie.deleted_at IS NULL AND ie.approval_status='UNAPPROVED' AND ie.kqkd_amount>0
        AND ie.voucher_date>=p_start_date AND ie.voucher_date<=p_end_date;
  END IF;
  RETURN v_result;
END $fn$;

-- Bảng báo cáo: phải khớp REPORTS trong infra/hermes-broker/full-read-contract.mjs.
CREATE OR REPLACE FUNCTION app_private.hermes_report_catalog_v1(p_domain text,p_report text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT CASE WHEN p_report IS NULL THEN (CASE WHEN p_domain IN ('occupancy_report','invoice_report','monthly_pnl','pending_approvals',
   'zalo_conversations','contract_search') THEN '{}'::jsonb END) ELSE (CASE p_domain||':'||p_report
   WHEN 'occupancy_report:snapshot' THEN '{"permission":"reports_real_estate.occupancy","source":"crm.occupancy_snapshot_v2","scope":"rows","fromDate":true,"buildingFilter":true}'
   WHEN 'occupancy_report:upcoming' THEN '{"permission":"reports_real_estate.occupancy","source":"crm.occupancy_upcoming_vacancy_v2","scope":"rows","fromDate":true,"days":true,"buildingFilter":true}'
   WHEN 'invoice_report:search' THEN '{"permission":"invoices.view","source":"crm.invoices","scope":"rows","month":true,"statuses":["paid","partial","unpaid","cancelled"],"buildingFilter":true}'
   WHEN 'invoice_report:stats' THEN '{"permission":"invoices.view","source":"crm.invoices","scope":"buildings","month":true,"buildingFilter":true}'
   WHEN 'monthly_pnl:by_month' THEN '{"permission":"reports_finance.analysis","source":"crm.fa_monthly_pnl","scope":"rows","fromDate":true,"toDate":true,"requiresDates":true,"basis":true,"buildingFilter":true}'
   WHEN 'pending_approvals:inbox' THEN '{"permission":"income_expenses.view","source":"crm.list_my_pending_approvals_v1","scope":"organization"}'
   WHEN 'zalo_conversations:list' THEN '{"permission":"chat_zalo.view","source":"crm.zalo_conversations","scope":"organization"}'
   WHEN 'contract_search:search' THEN '{"permission":"contracts.view","source":"crm.contracts","scope":"rows","statuses":["ACTIVE","TERMINATED","EXPIRING","EXPIRED"],"buildingFilter":true}'
 END)::jsonb END
$fn$;

-- Họ v3: như 20261016172206, cộng miền occupancy theo snapshot web (5), tham số basis (2)
-- và khoá customers.view cho tìm hoá đơn theo tên khách (1).
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v3(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean; org_wide boolean:=false; overlay_org boolean:=false;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_target uuid; v_report jsonb; v_from date; v_to date;
  rows jsonb; next_cursor uuid; v_item jsonb; v_result jsonb; v_customer_scope uuid[]; v_contract_scope uuid[];
BEGIN
  IF p_domain IN ('customers','occupancy') THEN
    permission:=CASE p_domain WHEN 'customers' THEN 'customers.view' ELSE 'reports_real_estate.occupancy' END;
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
  ELSIF p_domain='customer_detail' THEN permission:='customers.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['customerId']);
  ELSIF p_domain='contract_detail' THEN permission:='contracts.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['contractId']);
  ELSIF app_private.hermes_report_catalog_v1(p_domain,NULL) IS NOT NULL THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['report','query','status','month','fromDate','toDate','days','basis','buildingId','limit','offset']);
    IF jsonb_typeof(p_input->'report') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_report:=app_private.hermes_report_catalog_v1(p_domain,p_input->>'report');
    permission:=v_report->>'permission';
  END IF;
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_domain NOT IN ('customer_detail','contract_detail') THEN
    row_limit:=app_private.hermes_integer_v1(p_input->'limit'); query:=p_input->>'query';
    IF row_limit NOT BETWEEN 1 AND 50 OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(query)>200
      OR query ~ '[[:cntrl:]]' OR position(chr(8232) IN query)>0 OR position(chr(8233) IN query)>0
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    query:=lower(btrim(query));
    IF p_input->'buildingId'<>'null'::jsonb THEN requested_building:=app_private.hermes_uuid_v1(p_input->'buildingId'); END IF;
  END IF;
  IF p_domain IN ('customers','occupancy') THEN
    IF p_input->'status'<>'null'::jsonb THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    IF p_input->'cursor'<>'null'::jsonb THEN cursor_id:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  ELSIF p_domain='customer_detail' THEN v_target:=app_private.hermes_uuid_v1(p_input->'customerId');
  ELSIF p_domain='contract_detail' THEN v_target:=app_private.hermes_uuid_v1(p_input->'contractId');
  ELSE
    -- Báo cáo: mọi khoá đều có mặt (null = không dùng); bảng catalog nói khoá nào hợp lệ.
    v_from:=app_private.hermes_domain_date_v2(p_input->'fromDate');
    v_to:=app_private.hermes_domain_date_v2(p_input->'toDate');
    IF jsonb_typeof(p_input->'offset') IS DISTINCT FROM 'number' OR (p_input->>'offset') !~ '^[0-9]{1,4}$' OR (p_input->>'offset')::integer>2000
      OR (v_from IS NOT NULL AND v_to IS NOT NULL AND (v_to<v_from OR v_to-v_from>366))
      OR (v_report->>'fromDate')::boolean IS NOT TRUE AND v_from IS NOT NULL
      OR (v_report->>'toDate')::boolean IS NOT TRUE AND v_to IS NOT NULL
      OR (v_report->>'requiresDates')::boolean AND (v_from IS NULL OR v_to IS NULL)
      OR p_input->'days'<>'null'::jsonb AND ((v_report->>'days')::boolean IS NOT TRUE OR jsonb_typeof(p_input->'days') IS DISTINCT FROM 'number'
        OR (p_input->>'days') !~ '^[0-9]{1,3}$' OR (p_input->>'days')::integer NOT BETWEEN 1 AND 365)
      OR p_input->'month'<>'null'::jsonb AND ((v_report->>'month')::boolean IS NOT TRUE OR jsonb_typeof(p_input->'month') IS DISTINCT FROM 'string'
        OR (p_input->>'month') !~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$')
      OR p_input->'status'<>'null'::jsonb AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string'
        OR NOT COALESCE(v_report->'statuses' ? (p_input->>'status'),false))
      OR p_input->'basis'<>'null'::jsonb AND ((v_report->>'basis')::boolean IS NOT TRUE OR jsonb_typeof(p_input->'basis') IS DISTINCT FROM 'string'
        OR (p_input->>'basis') NOT IN ('accrual','cash'))
      OR (v_report->>'buildingFilter')::boolean IS NOT TRUE AND requested_building IS NOT NULL
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR session.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR session.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
    SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
  state:=app_private.hermes_domain_grant_v2(c.organization_id,permission,enabled,context);
  IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND state->'buildingIds' ? b.id::text
    AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id
      AND scope.cashbook_id IS NULL AND (
      scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
      OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
        ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
        WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
  buildings:=COALESCE(buildings,'{}'::uuid[]);
  -- overlay_org: kết nối (∩ chính sách) đã chọn Toàn tổ chức nên overlay không thu hẹp.
  -- org_wide thêm CRM org_wide của đúng khoá: điều kiện cho bản ghi KHÔNG gắn toà.
  overlay_org:=EXISTS(SELECT 1 FROM public.authorization_scopes overlay
    WHERE overlay.id=ANY(scopes) AND overlay.organization_id=c.organization_id AND overlay.scope_type='ORGANIZATION' AND overlay.cashbook_id IS NULL);
  org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;
  IF requested_building IS NOT NULL THEN
    IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested_building]; org_wide:=false; overlay_org:=false;
  END IF;
  -- Khoá thứ hai, như RLS các embed của web: người ở / tên khách cần customers.view,
  -- hợp đồng của khách cần contracts.view (quyền CRM ∩ Read kết nối ∩ toà overlay).
  IF p_domain IN ('customers','customer_detail') THEN
    v_contract_scope:=COALESCE(app_private.hermes_full_read_scope_v1(c,policy,context,'contracts.view'),'{}'::uuid[]);
  ELSIF p_domain IN ('contract_detail','contract_search','invoice_report') THEN
    v_customer_scope:=app_private.hermes_full_read_scope_v1(c,policy,context,'customers.view');
  END IF;

  IF p_domain='customers' THEN
    -- Như hermes_domain_read_v1 nhưng SĐT đầy đủ; kết nối Toàn tổ chức thấy cả
    -- khách chưa có hợp đồng (như danh sách /customers), chỉ chủ sở hữu nhìn thấy được.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT customer.id,jsonb_build_object('id',customer.id,'name',app_private.hermes_domain_text_v1(COALESCE(customer.full_name,'')),
        'phone',app_private.hermes_domain_text_v1(customer.phone),'contractId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.id END,'buildingId',latest.building_id,'roomId',latest.room_id,
        'roomName',app_private.hermes_domain_text_v1(latest.room_name)) item
      FROM public.customers customer LEFT JOIN LATERAL (
        SELECT contract.id,room.id room_id,room.building_id,room.name room_name FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
        WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(contract.actual_end_date,contract.end_date) DESC NULLS LAST,contract.id LIMIT 1) latest ON true
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL AND (cursor_id IS NULL OR customer.id>cursor_id)
        AND (latest.id IS NOT NULL OR (org_wide AND customer.user_id=ANY(public.current_visible_owner_ids())))
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0
          OR position(regexp_replace(query,'[^0-9]','','g') IN regexp_replace(COALESCE(customer.phone,''),'[^0-9]','','g'))>0
            AND regexp_replace(query,'[^0-9]','','g')<>'')
      ORDER BY customer.id LIMIT row_limit+1) found;
    IF jsonb_array_length(rows)>row_limit THEN
      SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
      next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
    END IF;
    v_result:=jsonb_build_object('items',rows,'nextCursor',next_cursor);
  ELSIF p_domain='occupancy' THEN
    -- (5) Như trang Báo cáo lấp đầy (src/hooks/reports/useOccupancyDashboard.ts:83): RPC web
    -- occupancy_snapshot_v2 tại hôm nay theo giờ công ty, với tập toà đã giao (CRM ∩ overlay);
    -- không đếm rooms.status như hermes_domain_read_v1.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT snapshot.building_id id,jsonb_build_object('id',snapshot.building_id,'buildingId',snapshot.building_id,
        'name',app_private.hermes_domain_text_v1(COALESCE(snapshot.building_name,'')),'total',COALESCE(snapshot.total,0),
        'occupied',COALESCE(snapshot.occupied,0),'available',COALESCE(snapshot.available,0)) item
      FROM public.occupancy_snapshot_v2(public.org_today_v1(c.organization_id),buildings) snapshot
      WHERE snapshot.building_id=ANY(buildings) AND (cursor_id IS NULL OR snapshot.building_id>cursor_id)
        AND (query='' OR position(query IN lower(COALESCE(snapshot.building_name,'')))>0)
      ORDER BY snapshot.building_id LIMIT row_limit+1) found;
    IF jsonb_array_length(rows)>row_limit THEN
      SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
      next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
    END IF;
    v_result:=jsonb_build_object('items',rows,'nextCursor',next_cursor);
  ELSIF p_domain='customer_detail' THEN
    -- Đúng các trường /customers/:id hiển thị; KHÔNG ảnh CCCD (id_images), không
    -- tài khoản ngân hàng/vân tay. Khách thấy được khi có hợp đồng ở toà được
    -- giao, hoặc kết nối Toàn tổ chức và chủ sở hữu nằm trong phạm vi nhìn thấy.
    SELECT jsonb_build_object('id',cu.id,'name',app_private.hermes_full_text_v1(cu.full_name,200),'phone',app_private.hermes_full_text_v1(cu.phone,40),
      'email',app_private.hermes_full_text_v1(cu.email,200),'customerType',cu.customer_type::text,'status',COALESCE(cu.status_v2::text,cu.status::text),
      'idType',cu.id_type::text,'idNumber',app_private.hermes_full_text_v1(cu.id_number,40),'idIssueDate',cu.id_issue_date,
      'idIssuePlace',app_private.hermes_full_text_v1(cu.id_issue_place,200),'dateOfBirth',cu.date_of_birth,'gender',app_private.hermes_full_text_v1(cu.gender,20),
      'isForeign',cu.is_foreign,'occupation',app_private.hermes_full_text_v1(cu.occupation,200),'workplace',app_private.hermes_full_text_v1(cu.workplace,300),
      'detailedAddress',app_private.hermes_full_text_v1(cu.detailed_address,500),'ward',app_private.hermes_full_text_v1(cu.ward,100),
      'district',app_private.hermes_full_text_v1(cu.district,100),'province',app_private.hermes_full_text_v1(cu.province,100),
      'currentResidence',app_private.hermes_full_text_v1(cu.current_residence,500),'permanentAddress',app_private.hermes_full_text_v1(cu.permanent_address,500),
      'companyName',app_private.hermes_full_text_v1(cu.company_name,200),'contactPerson',app_private.hermes_full_text_v1(cu.contact_person,200),
      'contactPersonPhone',app_private.hermes_full_text_v1(cu.contact_person_phone,40),
      'emergencyContact',CASE WHEN COALESCE(cu.emergency_contact_name,cu.emergency_contact_phone) IS NULL THEN NULL ELSE jsonb_build_object(
        'name',app_private.hermes_full_text_v1(cu.emergency_contact_name,200),'phone',app_private.hermes_full_text_v1(cu.emergency_contact_phone,40),
        'relationship',app_private.hermes_full_text_v1(cu.emergency_contact_relationship,100)) END,
      'notes',app_private.hermes_full_text_v1(cu.notes,2000),'contractsVisible',cardinality(v_contract_scope)>0,
      'contracts',(SELECT COALESCE(jsonb_agg(link.item ORDER BY link.active,link.start_date DESC NULLS LAST,link.id),'[]'::jsonb) FROM (
        SELECT contract.id,contract.start_date,CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END active,
          jsonb_build_object('id',contract.id,'number',app_private.hermes_full_text_v1(contract.contract_number,100),'status',contract.status::text,
            'buildingId',room.building_id,'buildingName',app_private.hermes_full_text_v1(building.name,200),'roomId',room.id,
            'roomName',app_private.hermes_full_text_v1(room.name,100),'startDate',contract.start_date,
            'endDate',COALESCE(contract.actual_end_date,contract.end_date),'rentPrice',COALESCE(contract.rent_price,0)::text,
            'isRepresentative',COALESCE(cc.is_representative,false)) item
        FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(v_contract_scope)
        JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
        WHERE cc.customer_id=cu.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,contract.start_date DESC NULLS LAST,contract.id LIMIT 20) link))
      INTO v_item FROM public.customers cu
      WHERE cu.id=v_target AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM public.contract_customers cc
            JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
            JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
            WHERE cc.customer_id=cu.id AND cc.organization_id=c.organization_id)
          OR (org_wide AND cu.user_id=ANY(public.current_visible_owner_ids())));
    v_result:=jsonb_build_object('item',v_item);
  ELSIF p_domain='contract_detail' THEN
    -- Đúng các trường /contracts/:id hiển thị; KHÔNG file hợp đồng, ảnh CCCD, mã
    -- công khai (public_code), tài khoản ngân hàng khách.
    SELECT jsonb_build_object('id',ct.id,'number',app_private.hermes_full_text_v1(ct.contract_number,100),'status',ct.status::text,
      'buildingId',room.building_id,'buildingName',app_private.hermes_full_text_v1(building.name,200),
      'buildingAddress',app_private.hermes_full_text_v1(concat_ws(', ',building.street_address,building.ward,building.district,building.province),500),
      'roomId',room.id,'roomName',app_private.hermes_full_text_v1(room.name,100),
      'signedDate',ct.signed_date,'startDate',ct.start_date,'endDate',ct.end_date,'actualEndDate',ct.actual_end_date,
      'expectedMoveOutDate',ct.expected_move_out_date,'startBillingDate',ct.start_billing_date,'endBillingDate',ct.end_billing_date,
      'rentPrice',COALESCE(ct.rent_price,0)::text,'paymentCycle',ct.payment_cycle::text,
      'totalDeposit',COALESCE(ct.total_deposit,0)::text,'depositPaid',COALESCE(ct.deposit_paid,0)::text,'depositRemaining',COALESCE(ct.deposit_remaining,0)::text,
      'depositDebtMode',app_private.hermes_full_text_v1(ct.deposit_debt_mode,40),'depositDebtReason',app_private.hermes_full_text_v1(ct.deposit_debt_reason,500),
      'depositTopupDueDate',ct.deposit_topup_due_date,
      'initialElectricityReading',ct.initial_electricity_reading::text,'initialWaterReading',ct.initial_water_reading::text,
      'notes',app_private.hermes_full_text_v1(ct.notes,2000),'parentContractId',ct.parent_contract_id,
      'tenantsVisible',room.building_id=ANY(COALESCE(v_customer_scope,'{}'::uuid[])),
      'tenants',CASE WHEN room.building_id=ANY(COALESCE(v_customer_scope,'{}'::uuid[])) THEN (SELECT COALESCE(jsonb_agg(person.item ORDER BY person.representative DESC,person.name,person.id),'[]'::jsonb) FROM (
        SELECT cu.id,cu.full_name name,COALESCE(cc.is_representative,false) representative,jsonb_build_object('customerId',cu.id,
          'name',app_private.hermes_full_text_v1(cu.full_name,200),'phone',app_private.hermes_full_text_v1(cu.phone,40),
          'isRepresentative',COALESCE(cc.is_representative,false),'idNumber',app_private.hermes_full_text_v1(cu.id_number,40),
          'idIssueDate',cu.id_issue_date,'idIssuePlace',app_private.hermes_full_text_v1(cu.id_issue_place,200),
          'dateOfBirth',cu.date_of_birth,'gender',app_private.hermes_full_text_v1(cu.gender,20),'isForeign',cu.is_foreign,
          'permanentAddress',app_private.hermes_full_text_v1(cu.permanent_address,300),'currentResidence',app_private.hermes_full_text_v1(cu.current_residence,300),
          'occupation',app_private.hermes_full_text_v1(cu.occupation,200),'workplace',app_private.hermes_full_text_v1(cu.workplace,200),
          'note',app_private.hermes_full_text_v1(cc.notes,300)) item
        FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL
        WHERE cc.contract_id=ct.id AND cc.organization_id=c.organization_id
        ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 10) person) ELSE '[]'::jsonb END,
      'services',(SELECT COALESCE(jsonb_agg(line.item ORDER BY line.name,line.id),'[]'::jsonb) FROM (
        SELECT cs.id,service.name,jsonb_build_object('serviceId',service.id,'name',app_private.hermes_full_text_v1(service.name,200),
          'unit',app_private.hermes_full_text_v1(service.unit,40),'type',service.type::text,'pricingType',service.pricing_type::text,
          'unitPrice',COALESCE(cs.unit_price,0)::text,'initialReading',cs.initial_reading::text) item
        FROM public.contract_services cs JOIN public.services service ON service.id=cs.service_id AND service.organization_id=c.organization_id
        WHERE cs.contract_id=ct.id AND (cs.organization_id IS NULL OR cs.organization_id=c.organization_id)
        ORDER BY service.name,cs.id LIMIT 50) line))
      INTO v_item FROM public.contracts ct
      JOIN public.rooms room ON room.id=ct.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
      JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE ct.id=v_target AND ct.organization_id=c.organization_id AND ct.deleted_at IS NULL;
    v_result:=jsonb_build_object('item',v_item);
  ELSE
    -- Báo cáo cấp công ty dùng nguồn tự giới hạn theo người gọi (hộp duyệt của chính họ;
    -- RLS Chat Zalo toàn công ty); Hermes đòi thêm overlay không thu hẹp (overlay_org).
    -- Tên khách trong hàng báo cáo: chỉ khi customers.view phủ MỌI toà của báo cáo.
    v_result:=app_private.hermes_report_read_v2(p_domain,p_input,c.organization_id,buildings,overlay_org,
      COALESCE(v_customer_scope@>buildings,false));
  END IF;
  IF octet_length(v_result::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;

-- Báo cáo: mọi nguồn là RPC web hoặc SQL theo bộ lọc web; không gọi hàm copilot_* nào.
CREATE OR REPLACE FUNCTION app_private.hermes_report_read_v2(p_domain text,p_input jsonb,p_org uuid,p_buildings uuid[],p_overlay_org boolean,
  p_customers_visible boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_report text:=p_input->>'report'; v_spec jsonb; v_query text:=NULLIF(btrim(COALESCE(p_input->>'query','')),'');
  v_status text:=p_input->>'status'; v_month text:=p_input->>'month'; v_from date; v_to date; v_days integer; v_today date;
  v_limit integer; v_offset integer; v_raw jsonb; v_rows jsonb:='[]'::jsonb; v_summary jsonb; v_capped boolean:=false;
  v_page jsonb:='[]'::jsonb; v_bytes integer:=0; v_total integer; v_next integer; v_item jsonb; i integer;
  v_count bigint; v_amount numeric; v_paid numeric; v_remaining numeric; v_refunded numeric;
  v_rent numeric; v_electric numeric; v_water numeric; v_service numeric; v_basis text:=COALESCE(p_input->>'basis','accrual');
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_spec:=app_private.hermes_report_catalog_v1(p_domain,v_report);
  IF v_spec IS NULL OR v_spec='{}'::jsonb THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_limit:=app_private.hermes_integer_v1(p_input->'limit'); v_offset:=(p_input->>'offset')::integer;
  v_from:=app_private.hermes_domain_date_v2(p_input->'fromDate'); v_to:=app_private.hermes_domain_date_v2(p_input->'toDate');
  IF p_input->'days'<>'null'::jsonb THEN v_days:=(p_input->>'days')::integer; END IF;
  p_buildings:=COALESCE(p_buildings,'{}'::uuid[]);
  IF v_spec->>'scope'='organization' AND NOT COALESCE(p_overlay_org,false) THEN
    RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','organization_scope_required',
      'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
  END IF;
  -- Báo cáo theo toà mà kết nối không còn toà nào: nói rõ, không trả số 0 như dữ liệu thật.
  IF v_spec->>'scope' IN ('rows','buildings') AND cardinality(p_buildings)=0 THEN
    RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','no_building_scope',
      'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
  END IF;
  v_today:=public.org_today_v1(p_org);
  IF p_domain='occupancy_report' AND v_report='snapshot' THEN
    -- RPC web của trang Báo cáo lấp đầy (useOccupancyDashboard.ts:83), tập toà đã giao.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',o.building_id,'buildingName',app_private.hermes_full_text_v1(o.building_name,200),
        'total',COALESCE(o.total,0),'occupied',COALESCE(o.occupied,0),'reserved',COALESCE(o.reserved,0),'maintenance',COALESCE(o.maintenance,0),
        'unavailable',COALESCE(o.unavailable,0),'available',COALESCE(o.available,0),'occupancyPct',round(o.occupancy_pct,2)::text,
        'committedPct',round(o.committed_pct,2)::text,'missedRevenue',round(o.missed_revenue,2)::text) ORDER BY o.building_name,o.building_id),'[]'::jsonb)
      INTO v_rows FROM public.occupancy_snapshot_v2(COALESCE(v_from,v_today),p_buildings) o
      WHERE o.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(o.building_name,'')))>0);
  ELSIF p_domain='occupancy_report' THEN
    -- RPC web phòng sắp trống (useOccupancyDashboard.ts:108), tập toà đã giao.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('contractId',u.contract_id,'contractNumber',app_private.hermes_full_text_v1(u.contract_number,100),
        'buildingId',u.building_id,'buildingName',app_private.hermes_full_text_v1(u.building_name,200),'roomId',u.room_id,
        'roomName',app_private.hermes_full_text_v1(u.room_name,100),'effectiveEndDate',u.effective_end_date,'daysRemaining',u.days_remaining,
        'rentPrice',u.rent_price::text,'extensionApplied',u.extension_applied) ORDER BY u.effective_end_date,u.building_name,u.room_name,u.contract_id),'[]'::jsonb)
      INTO v_rows FROM public.occupancy_upcoming_vacancy_v2(COALESCE(v_from,v_today),COALESCE(v_days,30),p_buildings) u
      WHERE u.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN
        lower(concat_ws(' ',u.building_name,u.room_name,u.contract_number)))>0);
  ELSIF p_domain='invoice_report' AND v_report='search' THEN
    -- (1) Như danh sách /invoices (useInvoices.ts:194-214): mặc định ẩn hoá đơn huỷ (view_status
    -- active); paid=PAID, partial=PARTIAL_PAID, unpaid = chưa thu đồng nào (không PAID/PARTIAL_PAID)
    -- và không huỷ, cancelled = chỉ hoá đơn huỷ; tìm số HĐ hoặc tên khách (useInvoices.ts:230-257;
    -- tên khách cần customers.view như RLS bảng customers của web).
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.billing_month DESC NULLS LAST,x.bname,x.rname,x.created_at DESC,x.id),'[]'::jsonb),count(*)>=2000
      INTO v_rows,v_capped FROM (
      SELECT inv.id,inv.billing_month,b.name bname,r.name rname,inv.created_at,jsonb_build_object('id',inv.id,
          'number',app_private.hermes_full_text_v1(inv.invoice_number,100),'billingMonth',app_private.hermes_full_text_v1(inv.billing_month,20),
          'dueDate',inv.due_date,'totalAmount',COALESCE(inv.total_amount,0)::text,'paidAmount',COALESCE(inv.paid_amount,0)::text,
          'remainingAmount',COALESCE(inv.remaining_amount,0)::text,'status',inv.status::text,'buildingId',inv.building_id,
          'buildingName',app_private.hermes_full_text_v1(b.name,200),'roomId',inv.room_id,'roomName',app_private.hermes_full_text_v1(r.name,100)) item
      FROM public.invoices inv
      JOIN public.buildings b ON b.id=inv.building_id AND b.organization_id=p_org
      LEFT JOIN public.rooms r ON r.id=inv.room_id AND r.organization_id=p_org
      WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND (v_month IS NULL OR inv.billing_month=v_month)
        AND CASE v_status WHEN 'paid' THEN inv.status::text='PAID' WHEN 'partial' THEN inv.status::text='PARTIAL_PAID'
          WHEN 'unpaid' THEN inv.status::text NOT IN ('PAID','PARTIAL_PAID','CANCELLED') WHEN 'cancelled' THEN inv.status::text='CANCELLED'
          ELSE inv.status::text<>'CANCELLED' END
        AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(inv.invoice_number,'')))>0
          OR COALESCE(p_customers_visible,false) AND EXISTS(SELECT 1 FROM public.contract_customers cc
            JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_org AND cu.deleted_at IS NULL
            WHERE cc.contract_id=inv.contract_id AND cc.organization_id=p_org AND position(lower(v_query) IN lower(COALESCE(cu.full_name,'')))>0))
      ORDER BY inv.billing_month DESC NULLS LAST,b.name,r.name,inv.created_at DESC,inv.id LIMIT 2000) x;
  ELSIF p_domain='invoice_report' THEN
    -- Cùng bộ lọc hai khối tổng của get_invoice_statistics_v2 (không tính hoá đơn huỷ,
    -- lọc kỳ billing_month, nhóm điện/nước/dịch vụ theo mô tả dòng), nhưng phạm vi là
    -- quyền invoices.view thật ∩ toà kết nối thay vì staff_assignments.
    SELECT COALESCE(sum(inv.total_amount),0),COALESCE(sum(inv.paid_amount),0),COALESCE(sum(GREATEST(inv.remaining_amount,0)),0),
        COALESCE(sum(GREATEST(-inv.remaining_amount,0)),0),count(*)
      INTO v_amount,v_paid,v_remaining,v_refunded,v_count
      FROM public.invoices inv WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND inv.status::text<>'CANCELLED' AND (v_month IS NULL OR inv.billing_month=v_month);
    SELECT COALESCE(sum(CASE WHEN ii.type::text='RENT' THEN ii.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN ii.type::text NOT IN ('RENT','DISCOUNT') AND lower(COALESCE(ii.description,'')) LIKE '%điện%' THEN ii.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN ii.type::text NOT IN ('RENT','DISCOUNT') AND lower(COALESCE(ii.description,'')) LIKE '%nước%' THEN ii.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN ii.type::text NOT IN ('RENT','DISCOUNT') AND lower(COALESCE(ii.description,'')) NOT LIKE '%điện%'
          AND lower(COALESCE(ii.description,'')) NOT LIKE '%nước%' THEN ii.amount ELSE 0 END),0)
      INTO v_rent,v_electric,v_water,v_service
      FROM public.invoices inv JOIN public.invoice_items ii ON ii.invoice_id=inv.id
      WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND inv.status::text<>'CANCELLED' AND (v_month IS NULL OR inv.billing_month=v_month);
    v_summary:=jsonb_build_object('totalCount',v_count,'totalAmount',v_amount::text,'totalPaid',v_paid::text,'totalRemaining',v_remaining::text,
      'totalRefunded',v_refunded::text,'rentAmount',v_rent::text,'electricAmount',v_electric::text,'waterAmount',v_water::text,'serviceAmount',v_service::text);
  ELSIF p_domain='monthly_pnl' THEN
    -- (2) RPC web của "Phân tích tài chính" (useFinancialAnalysis.ts:96-98): mặc định dồn tích
    -- (fa_monthly_pnl_accrual), basis=cash ⇒ fa_monthly_pnl; tập toà đã giao. Hàng chỉ gồm phiếu
    -- ĐÃ DUYỆT; phần CHỜ DUYỆT mà BC Doanh Thu Chi Phí cộng thêm (ALL_ACTIVE) trả riêng.
    IF v_basis='accrual' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month',pnl.month,'buildingId',pnl.building_id,
          'buildingName',app_private.hermes_full_text_v1(pnl.building_name,200),'revenue',COALESCE(pnl.revenue,0)::text,
          'expense',COALESCE(pnl.expense,0)::text,'net',COALESCE(pnl.net,0)::text) ORDER BY pnl.month,pnl.building_name,pnl.building_id),'[]'::jsonb)
        INTO v_rows FROM public.fa_monthly_pnl_accrual(v_from,v_to,p_buildings) pnl
        WHERE pnl.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(pnl.building_name,'')))>0);
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month',pnl.month,'buildingId',pnl.building_id,
          'buildingName',app_private.hermes_full_text_v1(pnl.building_name,200),'revenue',COALESCE(pnl.revenue,0)::text,
          'expense',COALESCE(pnl.expense,0)::text,'net',COALESCE(pnl.net,0)::text) ORDER BY pnl.month,pnl.building_name,pnl.building_id),'[]'::jsonb)
        INTO v_rows FROM public.fa_monthly_pnl(v_from,v_to,p_buildings) pnl
        WHERE pnl.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(pnl.building_name,'')))>0);
    END IF;
    v_summary:=jsonb_build_object('basis',v_basis)||app_private.hermes_pnl_pending_v1(v_from,v_to,p_buildings,v_basis='accrual');
  ELSIF p_domain='pending_approvals' THEN
    -- (4) RPC web của hộp /approvals (useApprovals.ts:51): việc chờ CHÍNH người hỏi duyệt,
    -- không nhận tham số toà ⇒ chỉ kết nối Toàn tổ chức (đã chặn ở trên).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',p.request_id,'submissionNo',p.submission_no,
        'submittedAt',to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'amount',p.amount::text,
        'voucherId',p.voucher_id,'voucherCode',app_private.hermes_full_text_v1(p.voucher_code,100),
        'voucherName',app_private.hermes_full_text_v1(p.voucher_name,200),'voucherType',p.voucher_type,
        'makerName',app_private.hermes_full_text_v1(p.maker_name,200),'stepNo',p.step_no) ORDER BY p.submitted_at,p.request_id),'[]'::jsonb)
      INTO v_rows FROM public.list_my_pending_approvals_v1() p
      WHERE p.organization_id=p_org
        AND (v_query IS NULL OR position(lower(v_query) IN lower(concat_ws(' ',p.voucher_code,p.voucher_name,p.maker_name)))>0);
  ELSIF p_domain='zalo_conversations' THEN
    -- Như trang Chat Zalo (useZaloChat.ts:170-176): hội thoại của công ty, tin mới nhất trước,
    -- ghim lên đầu; cùng điều kiện RLS web (công ty trong zalo_authorized_org_ids('view')).
    -- Tìm theo tên/SĐT/nhãn người nhắn (không tìm nội dung tin); tin cuối cắt 160 ký tự.
    -- Web chỉ mở Chat Zalo khi quyền chat_zalo.view phủ toàn công ty: thiếu thì nói rõ,
    -- không trả "0 hội thoại" như số thật.
    IF NOT EXISTS(SELECT 1 FROM public.zalo_authorized_org_ids('view') allowed(org_id) WHERE allowed.org_id=p_org) THEN
      RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','organization_scope_required',
        'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
    END IF;
    SELECT jsonb_build_object('conversations',count(*),'unreadConversations',count(*) FILTER (WHERE z.unread_count>0 OR z.marked_unread),
        'unreadMessages',COALESCE(sum(z.unread_count),0),'pinned',count(*) FILTER (WHERE z.is_pinned))
      INTO v_summary FROM public.zalo_conversations z
      WHERE z.organization_id=p_org AND p_org IN (SELECT public.zalo_authorized_org_ids('view'))
        AND (v_query IS NULL OR position(app_private.hermes_zalo_fold_v1(v_query) IN
          app_private.hermes_zalo_fold_v1(concat_ws(' ',z.peer_name,z.peer_phone,z.sub_label)))>0);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.pinned DESC,x.last_at DESC NULLS LAST,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT z.id,COALESCE(z.is_pinned,false) pinned,z.last_message_at last_at,jsonb_build_object('conversationId',z.id,
          'peerName',app_private.hermes_full_text_v1(z.peer_name,200),'phone',app_private.hermes_full_text_v1(z.peer_phone,40),
          'threadType',app_private.hermes_full_text_v1(z.thread_type,40),'kind',app_private.hermes_full_text_v1(z.kind,40),
          'unread',COALESCE(z.unread_count,0),'markedUnread',COALESCE(z.marked_unread,false),'pinned',COALESCE(z.is_pinned,false),
          'roomName',app_private.hermes_full_text_v1(r.name,100),'buildingName',app_private.hermes_full_text_v1(b.name,200),
          'label',app_private.hermes_full_text_v1(z.sub_label,200),
          'lastMessageAt',CASE WHEN z.last_message_at IS NULL THEN NULL ELSE to_char(z.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'lastMessageDir',app_private.hermes_full_text_v1(z.last_message_dir,20),
          'lastMessage',app_private.hermes_full_text_v1(left(COALESCE(z.last_message_text,''),160),160)) item
      FROM public.zalo_conversations z
      LEFT JOIN public.rooms r ON r.id=z.room_id AND r.organization_id=p_org
      LEFT JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_org
      WHERE z.organization_id=p_org AND p_org IN (SELECT public.zalo_authorized_org_ids('view'))
        AND (v_query IS NULL OR position(app_private.hermes_zalo_fold_v1(v_query) IN
          app_private.hermes_zalo_fold_v1(concat_ws(' ',z.peer_name,z.peer_phone,z.sub_label)))>0)
      ORDER BY COALESCE(z.is_pinned,false) DESC,z.last_message_at DESC NULLS LAST,z.id LIMIT 2000) x;
  ELSE
    -- (3) Như danh sách Hợp đồng: tìm số HĐ, tên/SĐT khách (customers.view), tên phòng
    -- (useContracts.ts:253-298); lọc ACTIVE = mọi trạng thái trừ thanh lý, TERMINATED, EXPIRING/
    -- EXPIRED như thẻ thống kê (useContracts.ts:322-344); nhãn getContractDisplayStatus
    -- (src/types/contract.ts:180-196) từ end_date + expected_move_out_date; mới tạo trước.
    v_today:=COALESCE(v_today,current_date);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.created_at DESC NULLS LAST,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT ct.id,ct.created_at,jsonb_build_object('contractId',ct.id,
          'number',app_private.hermes_full_text_v1(ct.contract_number,100),
          'customerName',CASE WHEN p_customers_visible THEN app_private.hermes_full_text_v1(rep.full_name,200) END,
          'buildingId',r.building_id,'buildingName',app_private.hermes_full_text_v1(b.name,200),'roomId',r.id,
          'roomName',app_private.hermes_full_text_v1(r.name,100),'startDate',ct.start_date,'endDate',ct.end_date,
          'actualEndDate',ct.actual_end_date,'expectedMoveOutDate',ct.expected_move_out_date,'status',ct.status::text,
          'displayStatus',d.code,'displayLabel',d.label,'rentPrice',COALESCE(ct.rent_price,0)::text,
          'totalDeposit',COALESCE(ct.total_deposit,0)::text,'depositPaid',COALESCE(ct.deposit_paid,0)::text) item
      FROM public.contracts ct
      JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=p_org AND r.deleted_at IS NULL AND r.building_id=ANY(p_buildings)
      JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_org
      LEFT JOIN LATERAL (SELECT cu.full_name FROM public.contract_customers cc
          JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_org AND cu.deleted_at IS NULL
          WHERE cc.contract_id=ct.id AND cc.organization_id=p_org
          ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 1) rep ON true
      CROSS JOIN LATERAL (SELECT CASE
          WHEN ct.status::text='TERMINATED' THEN 'TERMINATED' WHEN ct.status::text='TRANSFERRED' THEN 'TRANSFERRED'
          WHEN ct.status::text='DRAFT' THEN 'DRAFT' WHEN ct.expected_move_out_date IS NOT NULL THEN 'MOVING_OUT'
          WHEN ct.end_date<v_today THEN 'EXPIRED' WHEN ct.end_date-v_today<=30 THEN 'EXPIRING' ELSE 'ACTIVE' END AS code) d0
      CROSS JOIN LATERAL (SELECT d0.code,CASE d0.code WHEN 'ACTIVE' THEN 'Còn hạn' WHEN 'EXPIRING' THEN 'Sắp hết hạn' WHEN 'EXPIRED' THEN 'Quá hạn'
          WHEN 'MOVING_OUT' THEN 'Sắp chuyển đi' WHEN 'TERMINATED' THEN 'Đã thanh lý' WHEN 'TRANSFERRED' THEN 'Đã nhượng' ELSE 'Nháp' END AS label) d
      WHERE ct.organization_id=p_org AND ct.deleted_at IS NULL
        AND CASE v_status WHEN 'ACTIVE' THEN ct.status::text<>'TERMINATED' WHEN 'TERMINATED' THEN ct.status::text='TERMINATED'
          WHEN 'EXPIRING' THEN ct.status::text NOT IN ('TERMINATED','TRANSFERRED','DRAFT') AND ct.expected_move_out_date IS NULL
            AND ct.end_date>=v_today AND ct.end_date<=v_today+30
          WHEN 'EXPIRED' THEN ct.status::text NOT IN ('TERMINATED','TRANSFERRED','DRAFT') AND ct.expected_move_out_date IS NULL
            AND ct.end_date<v_today
          ELSE true END
        AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(ct.contract_number,'')))>0
          OR position(lower(v_query) IN lower(COALESCE(r.name,'')))>0
          OR COALESCE(p_customers_visible,false) AND EXISTS(SELECT 1 FROM public.contract_customers cc2
            JOIN public.customers cu2 ON cu2.id=cc2.customer_id AND cu2.organization_id=p_org AND cu2.deleted_at IS NULL
            WHERE cc2.contract_id=ct.id AND cc2.organization_id=p_org
              AND (position(lower(v_query) IN lower(COALESCE(cu2.full_name,'')))>0 OR position(lower(v_query) IN lower(COALESCE(cu2.phone,'')))>0)))
      ORDER BY ct.created_at DESC NULLS LAST,ct.id LIMIT 2000) x;
  END IF;
  -- Phân trang trong ảnh chụp vừa đọc; dừng sớm khi chạm trần byte (≈40 KB) để kết quả
  -- luôn lọt trần 60 KB SQL / 64 KB broker; nextOffset báo phần còn lại.
  v_total:=jsonb_array_length(v_rows);
  i:=v_offset;
  WHILE i<v_total AND jsonb_array_length(v_page)<v_limit LOOP
    v_item:=v_rows->i;
    EXIT WHEN jsonb_array_length(v_page)>0 AND v_bytes+octet_length(v_item::text)>40000;
    v_page:=v_page||jsonb_build_array(v_item); v_bytes:=v_bytes+octet_length(v_item::text); i:=i+1;
  END LOOP;
  IF i<v_total THEN v_next:=i; END IF;
  RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable',NULL,'summary',v_summary,'items',v_page,
    'offset',v_offset,'nextOffset',v_next,'sourceCapped',v_capped);
END $fn$;

ALTER FUNCTION app_private.hermes_pnl_pending_v1(date,date,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_report_catalog_v1(text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_report_read_v2(text,jsonb,uuid,uuid[],boolean,boolean) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_pnl_pending_v1(date,date,uuid[],boolean),app_private.hermes_report_catalog_v1(text,text),
  app_private.hermes_report_read_v2(text,jsonb,uuid,uuid[],boolean,boolean),public.hermes_domain_read_v3(jsonb,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
