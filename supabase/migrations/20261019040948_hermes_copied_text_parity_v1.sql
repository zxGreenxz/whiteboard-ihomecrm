-- TG5: copied reservation voucher name/payer and vehicle owner_name use their
-- own canonical source/RLS. Embedded customers retain their current JOIN RLS,
-- CRM scopes and Hermes exclusions. Legacy intent stays conservative. Explicit
-- customer exclusions/company ceilings still suppress copied text and search.
-- Financial notes, termination notes and Network Center customer RLS are kept:
-- this migration does not establish permission to remove those independent fences.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION app_private.hermes_w2_scope_v1(p_binding jsonb,p_domain text,p_input jsonb,p_caller text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean;
  org_wide boolean:=false; overlay_org boolean:=false; requested_building uuid; v_report text; v_spec jsonb; v_params jsonb;
  v_limit integer; v_offset integer; v_topic text; v_catalog jsonb; v_allowed text[]:='{}'::text[]; v_extra jsonb:='{}'::jsonb;
  v_ctx jsonb; v_rows jsonb; v_unavailable text; v_cashbooks uuid[]:='{}'::uuid[]; v_id uuid;
  v_building uuid; v_ids uuid[]; v_scope text; v_fence jsonb; v_plan jsonb;
BEGIN
  -- Hàm gói chạy dưới vai của lối vào INVOKER; vai khác (vd. lời gọi từ một hàm DEFINER: chủ hàm, bỏ qua RLS) ⇒ từ chối.
  IF p_caller IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_domain='report' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['report','params','limit','offset']);
    IF jsonb_typeof(p_input->'report') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'params') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR (p_input->>'limit') !~ '^[0-9]{1,2}$'
      OR jsonb_typeof(p_input->'offset') IS DISTINCT FROM 'number' OR (p_input->>'offset') !~ '^[0-9]{1,4}$'
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_limit:=(p_input->>'limit')::integer; v_offset:=(p_input->>'offset')::integer;
    IF v_limit NOT BETWEEN 1 AND 50 OR v_offset>2000 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_report:=p_input->>'report';
    v_spec:=app_private.hermes_w2_catalog_v1(v_report);
    IF v_spec IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    permission:=v_spec->>'permission'; v_scope:=v_spec->>'scope';
    v_params:=app_private.hermes_w2_params_v1(v_spec,p_input->'params');
  ELSIF p_domain='report_list' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['topic']);
    IF p_input->'topic'<>'null'::jsonb AND (jsonb_typeof(p_input->'topic') IS DISTINCT FROM 'string'
        OR NOT COALESCE(p_input->>'topic' IN ('a','b','c','d'),false))
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_topic:=p_input->>'topic';
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
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
  IF p_domain='report_list' THEN
    v_catalog:=app_private.hermes_w2_catalog_v1(NULL);
    FOR k IN SELECT DISTINCT e.value->>'permission' FROM jsonb_each(v_catalog) e WHERE v_topic IS NULL OR e.value->>'package'=v_topic LOOP
      enabled:=policy.enabled AND k=ANY(policy.read_capabilities) AND EXISTS(
        SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=k AND h.mode='read' AND h.enabled);
      state:=app_private.hermes_w2_grant_v1(c.organization_id,k,enabled,context,member);
      IF state->'allowed'='true'::jsonb AND k=ANY(c.read_capabilities) THEN v_allowed:=v_allowed||k; END IF;
    END LOOP;
    -- (P3) Thứ tự byte (COLLATE "C") như so sánh chuỗi của broker; collation production xếp khác.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('report',e.key,'permission',e.value->>'permission') ORDER BY e.key COLLATE "C"),'[]'::jsonb) INTO v_rows
      FROM jsonb_each(v_catalog) e WHERE (v_topic IS NULL OR e.value->>'package'=v_topic) AND e.value->>'permission'=ANY(v_allowed);
    v_plan:=jsonb_build_object('domain',p_domain,'connectionId',c.id,'organizationId',c.organization_id,'package',NULL,'items',v_rows);
  ELSE
    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_w2_grant_v1(c.organization_id,permission,enabled,context,member);
    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
      THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    -- platform (biến động số dư, toàn nền tảng): chỉ super admin, như RequireSuperAdmin của web.
    IF v_scope='platform' AND member->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb
      THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
      SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
      FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
      AND (v_scope='rls_buildings' OR state->'buildingIds' ? b.id::text)
      AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id
        AND scope.cashbook_id IS NULL AND (
        scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
        OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
          ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
          WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
    buildings:=COALESCE(buildings,'{}'::uuid[]);
    overlay_org:=EXISTS(SELECT 1 FROM public.authorization_scopes overlay
      WHERE overlay.id=ANY(scopes) AND overlay.organization_id=c.organization_id AND overlay.scope_type='ORGANIZATION' AND overlay.cashbook_id IS NULL);
    -- org_wide = CRM toàn công ty của đúng khoá ∩ overlay Toàn tổ chức của kết nối.
    org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;
    -- (19/10) rls_buildings: như route web không truyền toà — khoá trang ở ÍT NHẤT một toà hoặc toàn công ty (không có ⇒
    -- 42501), rồi tập hàng do RLS người hỏi quyết; ctx.buildings = toà của công ty kết nối ∩ phạm vi KẾT NỐI (kết nối chỉ thu
    -- hẹp), KHÔNG giao thêm tập toà của khoá. Từ đây xử lý như rows (tham số toà, unavailable, fence, bước kết thúc).
    IF v_scope='rls_buildings' THEN
      IF jsonb_typeof(state->'buildingIds') IS DISTINCT FROM 'array'
        OR jsonb_array_length(state->'buildingIds')=0 AND state->'orgWide' IS DISTINCT FROM 'true'::jsonb
        THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
      v_scope:='rows';
    END IF;
    -- (P2-3) Sổ quỹ CRM cấp cho khoá (scope CASHBOOK); overlay không có chiều sổ quỹ.
    IF app_private.hermes_w2_permission_kind_v1(permission) IN ('company','organization') THEN
      SELECT COALESCE(array_agg(DISTINCT a.id ORDER BY a.id),'{}'::uuid[]) INTO v_cashbooks
        FROM app_private.authorized_scope_v3(permission,c.organization_id) s
        CROSS JOIN LATERAL unnest(COALESCE(s.cashbook_ids,'{}'::uuid[])) x(id)
        JOIN public.accounts a ON a.id=x.id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL;
    END IF;
    IF v_params->'buildingId' IS NOT NULL AND v_params->'buildingId'<>'null'::jsonb THEN
      requested_building:=app_private.hermes_uuid_v1(v_params->'buildingId');
      IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      buildings:=ARRAY[requested_building]; org_wide:=false; overlay_org:=false;
    END IF;
    v_unavailable:=CASE
      WHEN v_scope='organization' AND NOT org_wide THEN 'organization_scope_required'
      WHEN v_scope='cashbooks' AND NOT (org_wide OR overlay_org AND cardinality(v_cashbooks)>0) THEN 'organization_scope_required'
      WHEN v_scope IN ('rows','buildings') AND cardinality(buildings)=0 THEN 'no_building_scope' END;
    IF v_unavailable IS NULL THEN
      -- (P2-2b) ID gắn toà: thuộc công ty kết nối và toà trong ctx.buildings, thu hẹp ctx.buildings.
      FOREACH k IN ARRAY ARRAY['areaId','roomId','contractId','invoiceId'] LOOP
        CONTINUE WHEN v_params->k IS NULL OR v_params->k='null'::jsonb;
        v_id:=app_private.hermes_uuid_v1(v_params->k);
        IF k='areaId' THEN
          SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_ids FROM unnest(buildings) b(id)
            WHERE EXISTS(SELECT 1 FROM public.areas a JOIN public.area_buildings ab ON ab.area_id=a.id AND ab.organization_id=a.organization_id
              WHERE a.id=v_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL AND ab.building_id=b.id);
          IF cardinality(v_ids)=0 THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
          buildings:=v_ids;
        ELSE
          IF k='roomId' THEN
            SELECT r.building_id INTO v_building FROM public.rooms r
              WHERE r.id=v_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL;
          ELSIF k='contractId' THEN
            SELECT r.building_id INTO v_building FROM public.contracts ct
              JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=c.organization_id
              WHERE ct.id=v_id AND ct.organization_id=c.organization_id AND ct.deleted_at IS NULL;
          ELSE
            SELECT inv.building_id INTO v_building FROM public.invoices inv
              WHERE inv.id=v_id AND inv.organization_id=c.organization_id AND inv.deleted_at IS NULL;
          END IF;
          IF v_building IS NULL OR NOT(v_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
          buildings:=ARRAY[v_building];
        END IF;
        org_wide:=false; overlay_org:=false;
      END LOOP;
      -- ID không gắn toà: thuộc công ty kết nối (khách: chủ hồ sơ nhìn thấy được, như RLS web). IF lồng:
      -- câu SELECT chỉ được lập kế hoạch khi tham số có mặt (AND trong một biểu thức không chặn bảng vắng).
      IF v_params->'customerId' IS NOT NULL AND v_params->'customerId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.customers cu
            WHERE cu.id=app_private.hermes_uuid_v1(v_params->'customerId') AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL
              AND cu.user_id=ANY(COALESCE(public.current_visible_owner_ids(),'{}'::uuid[])))
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      IF v_params->'cashbookId' IS NOT NULL AND v_params->'cashbookId'<>'null'::jsonb THEN
        v_id:=app_private.hermes_uuid_v1(v_params->'cashbookId');
        IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL)
          OR v_scope='cashbooks' AND NOT org_wide AND NOT(v_id=ANY(v_cashbooks))
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
        IF v_scope='cashbooks' AND NOT org_wide THEN v_cashbooks:=ARRAY[v_id]; END IF;
      END IF;
      IF v_params->'staffId' IS NOT NULL AND v_params->'staffId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m
            WHERE m.user_id=app_private.hermes_uuid_v1(v_params->'staffId') AND m.organization_id=c.organization_id
              AND m.status='ACTIVE' AND m.revoked_at IS NULL)
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      IF v_params->'supplierId' IS NOT NULL AND v_params->'supplierId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.suppliers s
            WHERE s.id=app_private.hermes_uuid_v1(v_params->'supplierId') AND s.organization_id=c.organization_id AND s.deleted_at IS NULL)
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      IF v_params->'materialId' IS NOT NULL AND v_params->'materialId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.materials m
            WHERE m.id=app_private.hermes_uuid_v1(v_params->'materialId') AND m.organization_id=c.organization_id AND m.deleted_at IS NULL)
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      -- Khoá phụ (vd. customers.view cho tên khách): cùng cách tính khoá chính; gói tự giao với ctx.buildings.
      FOR k IN SELECT jsonb_array_elements_text(v_spec->'scopeKeys') LOOP
        v_extra:=v_extra||jsonb_build_object(k,to_jsonb(app_private.hermes_full_read_scope_v1(c,policy,context,k)));
      END LOOP;
      v_ctx:=jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'report',v_report,'permission',permission,
        'scope',v_scope,'buildings',to_jsonb(buildings),'requestedBuildingId',requested_building,'overlayOrg',overlay_org,
        'orgWide',org_wide,'isSuperadmin',member->'isSuperadmin'='true'::jsonb,'today',public.org_today_v1(c.organization_id),
        'scopes',v_extra,'cashbooks',to_jsonb(v_cashbooks),
        'allowCopiedCustomerText',c.permission_mode='inherit_crm' AND NOT('customers.view'=ANY(c.excluded_read))
          AND (policy.version=0 OR 'customers.view'=ANY(policy.read_capabilities)));
    END IF;
    -- Phong bì "fence": toà / sổ quỹ / org_wide cổng đã dùng — bước 3 và broker rào đầu ra theo đúng tập này.
    v_fence:=jsonb_build_object('buildings',CASE WHEN v_scope IN ('rows','buildings') THEN to_jsonb(buildings) ELSE '[]'::jsonb END,
      'cashbooks',CASE WHEN v_scope='cashbooks' THEN to_jsonb(v_cashbooks) ELSE '[]'::jsonb END,'orgWide',org_wide);
    -- package chỉ có khi đủ phạm vi: lối vào gọi đúng hàm gói đó với (report, params, ctx).
    v_plan:=jsonb_build_object('domain',p_domain,'connectionId',c.id,'organizationId',c.organization_id,'report',v_report,'source',v_spec->>'source','scope',v_scope,
      'limit',v_limit,'offset',v_offset,'unavailable',v_unavailable,'fence',v_fence,
      'package',CASE WHEN v_unavailable IS NULL THEN v_spec->>'package' END,'params',v_params,'ctx',v_ctx);
  END IF;
  RETURN v_plan;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_b uuid[]; v_cust uuid[]; v_today date; v_rows jsonb:='[]'::jsonb; v_total integer:=0; v_summary jsonb;
  v_status text; v_kind text; v_query text; v_from date; v_to date; v_target uuid; v_detail jsonb; v_page jsonb; v_cursor jsonb;
  v_head jsonb; v_raw jsonb; v_clean jsonb; v_inv_cust boolean; v_inv_text boolean;
  -- Độ dài tối đa của từng trường chữ trong kết quả (khớp longText(n) của wave2-a-contract.mjs).
  v_limits constant jsonb:='{"buildingName":200,"roomName":100,"customerName":200,"payerName":200,"invoiceNumber":100,"contractNumber":100,
    "code":100,"voucherCode":100,"label":300,"name":300,"category":40,"status":40,"person":200,"collectors":300,"notes":1000,"kind":40,
    "billingMonth":20,"reasonCode":40,"debtMode":40,"terminationType":40,"adjustmentReviewStatus":40,"invoiceStatus":40,"approvalStatus":40}';
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  -- Web đọc các bảng này dưới RLS theo buildings.view (invoices/rooms/income_expenses_select_rbac:
  -- has_full_building_scope() OR building_id IN accessible_building_ids()), độc lập với khoá của trang. Khoá
  -- trang có thể rộng hơn (vd. thu_tien.view toàn công ty, buildings.view vài toà) ⇒ giao thêm để không vượt web.
  -- (19/10) reservation_vouchers: web còn hiện phiếu vào sổ quỹ người dùng giữ (policy sổ quỹ của income_expenses, không theo
  -- toà) ⇒ dùng nguyên ctx.buildings, để RLS income_expenses quyết như web.
  SELECT COALESCE(array_agg(x::uuid ORDER BY x),'{}'::uuid[]) INTO v_b FROM jsonb_array_elements_text(p_ctx->'buildings') x
    WHERE p_report='reservation_vouchers' OR public.has_full_building_scope() OR x::uuid IN (SELECT public.accessible_building_ids());
  IF v_org IS NULL OR cardinality(v_b)=0 THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','no_building_scope');
  END IF;
  -- Toà mà người hỏi được xem tên khách: customers.view của kết nối ∩ toà của báo cáo.
  SELECT COALESCE(array_agg(x::uuid),'{}'::uuid[]) INTO v_cust
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx->'scopes'->'customers.view')='array' THEN p_ctx->'scopes'->'customers.view' ELSE '[]'::jsonb END) x
    WHERE x::uuid=ANY(v_b);
  v_today:=(p_ctx->>'today')::date;
  v_status:=p_params->>'status'; v_kind:=p_params->>'kind'; v_query:=lower(NULLIF(btrim(p_params->>'query'),''));
  v_from:=(p_params->>'fromDate')::date; v_to:=(p_params->>'toDate')::date;

  IF p_report='payment_schedule' THEN
    -- Web: due_date ≤ hôm nay + 365 (usePaymentScheduleReport(365)); ngày lọc trên "đã lên hoá đơn đến".
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER w o,count(*) OVER () total,jsonb_build_object('buildingId',s.building_id,
          'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=s.invoice_id),
          'buildingName',s.building_name,'roomId',s.room_id,'roomName',s.room_name,
          'customerName',CASE WHEN s.building_id=ANY(v_cust) THEN s.customer_name END,
          'billedThrough',s.billed_through) item
      FROM public.finance_payment_schedule_v1(v_org,v_today+365,v_b) s
      WHERE (v_from IS NULL OR s.billed_through>=v_from) AND (v_to IS NULL OR s.billed_through<=v_to)
      WINDOW w AS (ORDER BY s.billed_through DESC,s.first_due_date,s.invoice_id)
      ORDER BY s.billed_through DESC,s.first_due_date,s.invoice_id LIMIT 2001) x;
    v_summary:=jsonb_build_object('rooms',v_total);

  ELSIF p_report='overpayment' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY s.invoice_id) o,count(*) OVER () total,jsonb_build_object('invoiceId',s.invoice_id,
          'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=s.invoice_id),
          'invoiceNumber',s.invoice_number,'buildingId',s.building_id,
          'buildingName',s.building_name,'roomId',s.room_id,'roomName',s.room_name,
          'customerName',CASE WHEN s.building_id=ANY(v_cust) THEN s.customer_name END,
          'totalAmount',COALESCE(s.total_amount,0)::text,'paidAmount',COALESCE(s.paid_amount,0)::text,'overpaidAmount',COALESCE(s.overpaid_amount,0)::text) item
      FROM public.finance_overpayment_invoices_v1(v_org,v_b) s ORDER BY s.invoice_id LIMIT 2001) x;
    -- Tổng như web (useOverpaymentSummary): RPC INVOKER, gọi với đúng danh sách toà đã giao.
    v_raw:=public.get_overpayment_summary(v_b);
    v_summary:=jsonb_build_object('total',(v_raw->>'total')::numeric::text,'count',(v_raw->>'count')::integer);

  ELSIF p_report='collection' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o) FILTER (WHERE x.listed),'[]'::jsonb),COALESCE(count(*) FILTER (WHERE x.listed),0)::integer,
        jsonb_build_object('mode',COALESCE(max(x.mode),CASE WHEN v_from IS NULL AND v_to IS NULL THEN 'all'
            WHEN COALESCE(v_from,v_to)=v_today AND COALESCE(v_to,v_from)=v_today THEN 'today' ELSE 'date' END),
          'invoiceCount',count(*)::integer,'collectedSum',COALESCE(sum(x.collected),0)::text,'remainingSum',COALESCE(sum(x.remaining),0)::text,
          'paidRooms',count(*) FILTER (WHERE x.paid)::integer,'dueRooms',count(*) FILTER (WHERE x.due)::integer)
      INTO v_rows,v_total,v_summary FROM (
      SELECT row_number() OVER (ORDER BY t.building_sort,t.building_id,t.room_sort,t.invoice_id) o,t.time_mode mode,t.summary_collected collected,
        t.summary_remaining remaining,t.summary_paid paid,t.summary_due due,
        t.in_scope AND (v_status IS NULL OR v_status='paid' AND t.status_paid OR v_status='unpaid' AND t.status_unpaid) listed,
        jsonb_build_object('invoiceId',t.invoice_id,'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=t.invoice_id),
          'invoiceNumber',t.invoice_number,
          'buildingId',t.building_id,'buildingName',t.building_name,'roomId',t.room_id,
          'roomName',t.room_name,
          'customerName',CASE WHEN t.building_id=ANY(v_cust) THEN t.customer_name END,
          'invoiceStatus',t.invoice_status,'collectStatus',t.collect_status,'totalAmount',t.total_amount::text,'paidAmount',t.paid_amount::text,
          'remainingAmount',t.remaining_amount::text,'collectedInRange',t.collected_in_range::text,
          'collectors',array_to_string(t.collectors,', ')) item
      FROM public.thu_tien_collection_v1(v_org,p_params->>'month',v_from,v_to,v_today,v_b) t) x;
    IF v_total>2000 THEN v_rows:=(SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2001); END IF;

  ELSIF p_report='invoice_detail' THEN
    v_target:=(p_params->>'invoiceId')::uuid;
    v_detail:=public.invoice_detail_v1(v_org,v_target,v_b);
    v_head:=v_detail->'invoice';
    IF v_detail IS NULL OR NOT((v_head->>'buildingId')::uuid=ANY(v_b)) THEN
      v_summary:=jsonb_build_object('found',false,'invoiceId',NULL,'invoiceNumber',NULL,'status',NULL,'kind',NULL,'billingMonth',NULL,'issueDate',NULL,
        'dueDate',NULL,'paidDate',NULL,'buildingId',NULL,'buildingName',NULL,'roomId',NULL,'roomName',NULL,'contractNumber',NULL,'customerName',NULL,
        'subtotal',NULL,'discountAmount',NULL,'previousDebt',NULL,'totalAmount',NULL,'paidAmount',NULL,'remainingAmount',NULL,'notes',NULL,
        'adjustmentCount',NULL,'adjustmentReviewStatus',NULL,'totalReceived',NULL,'totalRefunded',NULL);
    ELSE
      -- Tên khách: toà ∈ customers.view VÀ có hồ sơ khách nhìn thấy dưới RLS, cùng công ty (customerId của
      -- invoice_detail_v1: đại diện, không thấy thì khách đầu) — tên của chính hồ sơ đã qua RLS.
      v_inv_cust:=(v_head->>'buildingId')::uuid=ANY(v_cust) AND v_head->>'customerId' IS NOT NULL;
      -- (Gói Z) Chữ tự do (ghi chú hoá đơn, tên phiếu) có thể nhắc BẤT KỲ khách nào của hợp đồng: thêm điều kiện MỌI khách
      -- của hợp đồng gắn hoá đơn đều nhìn thấy dưới RLS customers (cùng công ty). contract_customers đọc theo RLS hợp đồng
      -- (thấy HĐ ⇒ thấy mọi dòng khách của HĐ) nên đếm dòng khách = đếm dòng nối được hồ sơ. Không HĐ / không dòng khách ⇒ NULL.
      SELECT count(*)>0 AND count(*)=count(cu.id) INTO v_inv_text FROM public.contract_customers cc
        LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org
        WHERE cc.contract_id=(v_head->>'contractId')::uuid;
      v_inv_text:=v_inv_cust AND COALESCE(v_inv_text,false);
      v_summary:=jsonb_build_object('found',true,'invoiceId',v_head->'id','invoiceNumber',to_jsonb(v_head->>'invoiceNumber'),
        'status',v_head->'status','kind',to_jsonb(v_head->>'kind'),
        'billingMonth',to_jsonb(v_head->>'billingMonth'),'issueDate',v_head->'issueDate','dueDate',v_head->'dueDate',
        'paidDate',v_head->'paidDate','buildingId',v_head->'buildingId','buildingName',to_jsonb(v_head->>'buildingName'),
        'roomId',v_head->'roomId','roomName',to_jsonb(v_head->>'roomName'),
        'contractNumber',to_jsonb(v_head->>'contractNumber'),
        'customerName',CASE WHEN v_inv_cust THEN to_jsonb(v_head->>'customerName') ELSE 'null'::jsonb END,
        'subtotal',to_jsonb((v_head->>'subtotal')::numeric::text),'discountAmount',to_jsonb((v_head->>'discountAmount')::numeric::text),
        'previousDebt',to_jsonb((v_head->>'previousDebt')::numeric::text),'totalAmount',to_jsonb(COALESCE((v_head->>'totalAmount')::numeric,0)::text),
        'paidAmount',to_jsonb(COALESCE((v_head->>'paidAmount')::numeric,0)::text),'remainingAmount',to_jsonb(COALESCE((v_head->>'remainingAmount')::numeric,0)::text),
        'notes',CASE WHEN v_inv_text THEN to_jsonb(v_head->>'notes') ELSE 'null'::jsonb END,'adjustmentCount',v_detail->'adjustmentCount',
        'totalReceived',to_jsonb((v_detail->>'totalReceived')::numeric::text),'totalRefunded',to_jsonb((v_detail->>'totalRefunded')::numeric::text),
        'adjustmentReviewStatus',to_jsonb(v_head->>'adjustmentReviewStatus'));
      -- Dòng chi tiết: dòng hoá đơn, khoản thu, phiếu thu/chi đã duyệt (cùng khuôn; trường không dùng = null).
      SELECT COALESCE(jsonb_agg(l.item ORDER BY l.k,l.n),'[]'::jsonb),count(*)::integer INTO v_rows,v_total FROM (
        SELECT 1 k,n,jsonb_build_object('kind','item','id',e->'id','organizationId',v_head->'organizationId','buildingId',v_head->'buildingId','code',NULL,'label',to_jsonb(e->>'description'),
            'category',e->'type','amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',to_jsonb((e->>'unitPrice')::numeric::text),
            'quantity',to_jsonb((e->>'quantity')::numeric::text),'date',e->'fromDate','endDate',e->'toDate','status',NULL,'person',NULL,
            'previousReading',to_jsonb((e->>'previousReading')::numeric::text),'currentReading',to_jsonb((e->>'currentReading')::numeric::text)) item
          FROM jsonb_array_elements(v_detail->'items') WITH ORDINALITY a(e,n)
        UNION ALL
        SELECT 2,n,jsonb_build_object('kind','payment','id',e->'id','organizationId',e->'organizationId','buildingId',v_head->'buildingId','code',to_jsonb(e->>'receiptNumber'),'label',NULL,
            'category',e->'method','amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',NULL,'quantity',NULL,'date',e->'paymentDate',
            'endDate',NULL,'status',to_jsonb(CASE WHEN (e->>'reversed')::boolean THEN 'REVERSED' ELSE 'ACTIVE' END),'person',NULL,
            'previousReading',NULL,'currentReading',NULL)
          FROM jsonb_array_elements(v_detail->'payments') WITH ORDINALITY a(e,n)
        UNION ALL
        SELECT 3,n,jsonb_build_object('kind','voucher','id',e->'id','organizationId',e->'organizationId','buildingId',v_head->'buildingId','code',to_jsonb(e->>'code'),
            'label',CASE WHEN v_inv_text THEN to_jsonb(e->>'name') ELSE 'null'::jsonb END,'category',to_jsonb(e->>'type'),
            'amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',NULL,'quantity',NULL,'date',e->'voucherDate','endDate',NULL,
            'status',to_jsonb(e->>'approvalStatus'),'person',to_jsonb(e->>'creatorName'),
            'previousReading',NULL,'currentReading',NULL)
          FROM jsonb_array_elements(v_detail->'vouchers') WITH ORDINALITY a(e,n)) l;
    END IF;

  ELSIF p_report='reservation_vouchers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY v.voucher_date DESC,v.voucher_id) o,count(*) OVER () total,jsonb_build_object('voucherId',v.voucher_id,
          'organizationId',(SELECT src.organization_id FROM public.income_expenses src WHERE src.id=v.voucher_id),
          -- Copied voucher fields belong to the voucher RLS source, not a customer JOIN.
          -- Explicit Hermes/company customer exclusions still suppress them.
          'code',v.code,'name',CASE WHEN p_ctx->'allowCopiedCustomerText'='true'::jsonb THEN v.name END,
          'payerName',CASE WHEN p_ctx->'allowCopiedCustomerText'='true'::jsonb THEN v.payer_name END,
          'depositAmount',v.deposit_amount::text,'voucherDate',v.voucher_date,'approvalStatus',v.approval_status,'buildingId',v.building_id,
          'buildingName',v.building_name,'roomId',v.room_id,'roomName',v.room_name,
          'settled',v.settled,'holdUntil',v.hold_until,'topupDueDate',v.topup_due_date,'depositTarget',v.deposit_target::text) item
      FROM public.deposit_reservation_vouchers_v1(v_org,v_b) v
      WHERE (v_status IS NULL OR v.approval_status=v_status)
        -- Search follows exactly the copied fields returned under the same intent flag.
        AND (v_query IS NULL OR position(v_query IN lower(COALESCE(v.code,'')))>0
          OR position(v_query IN lower(COALESCE(v.room_name,'')))>0
          OR p_ctx->'allowCopiedCustomerText'='true'::jsonb AND (position(v_query IN lower(COALESCE(v.name,'')))>0 OR position(v_query IN lower(COALESCE(v.payer_name,'')))>0))
      ORDER BY v.voucher_date DESC,v.voucher_id LIMIT 2001) x;
    v_raw:=public.get_reservation_deposit_summary(v_b);
    v_summary:=jsonb_build_object('holdingAmount',(v_raw->>'holding_amount')::numeric::text,'approvedCount',(v_raw->>'approved_count')::integer,
      'unapprovedCount',(v_raw->>'unapproved_count')::integer,'cancelledCount',(v_raw->>'cancelled_count')::integer);

  ELSIF p_report='reservation_settlements' THEN
    -- RPC web (DEFINER, tự kiểm thành viên + can_access_building) theo trang 200 qua con trỏ, tối đa 2001 hàng.
    LOOP
      v_page:=public.get_reservation_settlements_v1(v_b,v_status,v_cursor,200,NULL);
      v_rows:=v_rows||COALESCE(v_page->'rows','[]'::jsonb);
      v_cursor:=v_page->'nextCursor';
      EXIT WHEN v_cursor IS NULL OR v_cursor='null'::jsonb OR jsonb_array_length(v_rows)>2000;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('settlementId',e->'id',
        'organizationId',(SELECT src.organization_id FROM public.reservation_deposit_settlements src WHERE src.id=(e->>'id')::uuid),
        'voucherCode',to_jsonb(e->>'voucherCode'),
        'buildingId',e->'buildingId','buildingName',to_jsonb(e->>'buildingName'),'roomId',e->'roomId',
        'roomName',to_jsonb(e->>'roomName'),
        -- Người nộp của phiếu cọc nguồn: không nối được hồ sơ khách dưới RLS người hỏi ⇒ NULL.
        'payerName',NULL,
        'depositAmount',to_jsonb((e->>'depositAmount')::numeric::text),'retainedAmount',to_jsonb((e->>'retainedAmount')::numeric::text),
        'refundAmount',to_jsonb((e->>'refundAmount')::numeric::text),'refundedAmount',to_jsonb((e->>'refundedAmount')::numeric::text),
        'refundRemaining',to_jsonb((e->>'refundRemaining')::numeric::text),'refundState',e->'refundState','settlementDate',e->'settlementDate',
        'reasonCode',to_jsonb(e->>'reasonCode'),'roomReleased',e->'roomReleased') ORDER BY n),'[]'::jsonb),
      count(*)::integer INTO v_rows,v_total
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2001;
    v_raw:=public.get_reservation_settlement_summary_v1(v_b);
    v_summary:=jsonb_build_object('retainedAmount',(v_raw->>'retainedAmount')::numeric::text,'retainedCount',(v_raw->>'retainedCount')::integer,
      'refundPendingAmount',(v_raw->>'refundPendingAmount')::numeric::text,'refundPendingCount',(v_raw->>'refundPendingCount')::integer,
      'refundPaidAmount',(v_raw->>'refundPaidAmount')::numeric::text,'refundPaidCount',(v_raw->>'refundPaidCount')::integer);

  ELSIF p_report='held_deposits' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY h.building_name,h.building_id,h.room_sort,h.contract_id) o,count(*) OVER () total,
        jsonb_build_object('contractId',h.contract_id,'organizationId',(SELECT src.organization_id FROM public.contracts src WHERE src.id=h.contract_id),
          'contractNumber',h.contract_number,'buildingId',h.building_id,
          'buildingName',h.building_name,'roomId',h.room_id,'roomName',h.room_name,
          'customerName',CASE WHEN h.building_id=ANY(v_cust) THEN h.customer_name END,
          'totalDeposit',h.total_deposit::text,'depositPaid',h.deposit_paid::text,'depositRemaining',h.deposit_remaining::text,
          'debtMode',h.deposit_debt_mode,'topupDueDate',h.deposit_topup_due_date,'state',h.state) item
      FROM public.deposit_held_contracts_v1(v_org,10000,v_b) h WHERE v_status IS NULL OR h.state=v_status
      ORDER BY h.building_name,h.building_id,h.room_sort,h.contract_id LIMIT 2001) x;
    -- KPI như web (useHeldDepositSummary + DepositsPage.tsx:438-452): cộng các toà; "thiếu" = shortfall_short.
    SELECT jsonb_build_object('contractCount',COALESCE(sum(s.contract_count),0)::integer,'expected',COALESCE(sum(s.expected),0)::text,
        'held',COALESCE(sum(s.held),0)::text,'shortfall',COALESCE(sum(s.shortfall_short),0)::text,'shortfallAll',COALESCE(sum(s.shortfall_all),0)::text,
        'fullCount',COALESCE(sum(s.full_count),0)::integer,'shortCount',COALESCE(sum(s.short_count),0)::integer,
        'firstInvoiceCount',COALESCE(sum(s.first_invoice_count),0)::integer)
      INTO v_summary FROM public.get_held_deposit_summary(v_b,10000) s;

  ELSIF p_report='deposit_refunds' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY d.termination_date DESC NULLS LAST,d.termination_id) o,count(*) OVER () total,
        jsonb_build_object('terminationId',d.termination_id,
          'organizationId',(SELECT src.organization_id FROM public.contract_terminations src WHERE src.id=d.termination_id),
          'contractId',d.contract_id,'contractNumber',d.contract_number,
          'buildingId',d.building_id,'buildingName',d.building_name,'roomId',d.room_id,
          'roomName',d.room_name,
          'customerName',CASE WHEN d.building_id=ANY(v_cust) THEN d.customer_name END,
          'terminationDate',d.termination_date,'terminationType',d.termination_type,'kind',d.kind,
          'totalDeposit',d.total_deposit::text,'totalDeductions',d.total_deductions::text,'settlementNet',d.settlement_net::text,
          'status',d.status,'postedRefund',d.posted_refund::text,'postedRefundCount',d.posted_refund_count,
          'refundDone',d.refund_done,'refundDrift',d.refund_drift::text) item
      FROM public.deposit_refunds_forfeits_v1(v_org,v_b) d WHERE v_kind IS NULL OR d.kind=v_kind
      ORDER BY d.termination_date DESC NULLS LAST,d.termination_id LIMIT 2001) x;
    v_raw:=public.get_refund_forfeit_summary(v_b);
    v_summary:=jsonb_build_object('refundTotal',(v_raw->>'refund_total')::numeric::text,'refundCount',(v_raw->>'refund_count')::integer,
      'refundLinkedTotal',(v_raw->>'refund_linked_total')::numeric::text,'refundOrphanTotal',(v_raw->>'refund_posted_orphan_total')::numeric::text,
      'refundPendingTotal',(v_raw->>'refund_pending_total')::numeric::text,'forfeitTotal',(v_raw->>'forfeit_total')::numeric::text,
      'forfeitCount',(v_raw->>'forfeit_count')::integer,'customerDebtTotal',(v_raw->>'customer_debt_total')::numeric::text);

  ELSIF p_report='change_ledger' THEN
    v_target:=(p_params->>'cashbookId')::uuid;
    -- Như web (RefundLogPage.tsx: đọc accounts theo id dưới RLS, không thấy ⇒ báo lỗi): sổ phải nhìn thấy, đúng công ty.
    IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_target AND a.organization_id=v_org AND a.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501';
    END IF;
    -- Mặc định "Tháng này" như web (RefundLogPage.tsx:142-157).
    v_from:=COALESCE(v_from,date_trunc('month',v_today)::date);
    v_to:=COALESCE(v_to,(date_trunc('month',v_today)+interval '1 month -1 day')::date);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o) FILTER (WHERE x.o<=2001),'[]'::jsonb),count(*)::integer,
        jsonb_build_object('mode',COALESCE(max(x.mode),(SELECT CASE WHEN btrim(COALESCE(a.name,''))='Làm tròn tiền thiếu' THEN 'rounding' ELSE 'refund' END
            FROM public.accounts a WHERE a.id=v_target)),'fromDate',v_from,'toDate',v_to,'total',COALESCE(sum(x.amount),0)::text,'count',count(*)::integer)
      INTO v_rows,v_total,v_summary FROM (
      SELECT row_number() OVER (ORDER BY l.voucher_date DESC,l.voucher_id) o,l.amount,l.ledger_mode mode,jsonb_build_object('voucherId',l.voucher_id,
          'organizationId',(SELECT src.organization_id FROM public.income_expenses src WHERE src.id=l.voucher_id),
          'voucherDate',l.voucher_date,'code',l.code,'invoiceId',l.invoice_id,
          'invoiceNumber',l.invoice_number,'buildingId',l.building_id,
          'buildingName',l.building_name,'roomName',l.room_name,
          'payerName',CASE WHEN k.linked THEN l.payer_name END,
          'amount',l.amount::text,'totalAmount',COALESCE(l.total_amount,0)::text,
          'notes',CASE WHEN k.linked THEN l.notes END) item
      FROM public.cashbook_change_ledger_v1(v_org,v_target,v_from,v_to,v_b) l
      -- Người nộp / ghi chú: phiếu nối tới hợp đồng (contract_id, hoặc hoá đơn → contract_id), toà ∈ customers.view và
      -- (Gói Z) MỌI khách của hợp đồng đó nhìn thấy dưới RLS customers, cùng công ty (một bảng một lần trong câu: đếm dòng
      -- khách = đếm dòng nối được hồ sơ); không nối được / có khách bị ẩn ⇒ NULL.
      CROSS JOIN LATERAL (SELECT l.building_id=ANY(v_cust) AND COALESCE((
          SELECT count(*)>0 AND count(*)=count(cu.id)
          FROM public.income_expenses src LEFT JOIN public.invoices inv ON inv.id=src.invoice_id
            JOIN public.contract_customers cc ON cc.contract_id=COALESCE(src.contract_id,inv.contract_id)
            LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org
          WHERE src.id=l.voucher_id),false) linked) k) x;

  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;

  -- Trần 2000 hàng: cắt TOÀN BỘ phần sau 2000 (v_total đã là tổng thật ⇒ sourceCapped đúng).
  IF jsonb_array_length(v_rows)>2000 THEN
    v_rows:=(SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2000);
  END IF;
  -- Làm sạch chữ MỘT lần cho mọi hàng + summary (cùng luật hermes_full_text_v1 của đợt 1: giữ xuống dòng,
  -- bỏ ký tự điều khiển, cắt theo ký tự); hàm đọc INVOKER không gọi được app_private.* (không USAGE).
  SELECT COALESCE(jsonb_agg(c.obj ORDER BY a.n),'[]'::jsonb) INTO v_clean
    FROM jsonb_array_elements(v_rows||jsonb_build_array(COALESCE(v_summary,'{"_":null}'::jsonb))) WITH ORDINALITY a(r,n)
    CROSS JOIN LATERAL (SELECT jsonb_object_agg(e.key,CASE WHEN jsonb_typeof(e.value)='string' AND v_limits ? e.key THEN to_jsonb(left(btrim(regexp_replace(
        translate(replace(e.value#>>'{}',chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
        '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),(v_limits->>e.key)::integer)) ELSE e.value END) obj
      FROM jsonb_each(a.r) e) c;
  v_summary:=CASE WHEN v_summary IS NULL THEN NULL ELSE v_clean->-1 END;
  v_rows:=v_clean - -1;
  RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',v_total>2000,'unavailable',NULL);
END $fn$;

CREATE OR REPLACE FUNCTION public.vehicles_list_core_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_customer_building_ids uuid[] DEFAULT NULL,p_include_unassigned boolean DEFAULT true,p_query text DEFAULT NULL,
  p_vehicle_type text DEFAULT NULL,p_room_id uuid DEFAULT NULL,p_customer_id uuid DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0,p_allow_copied_owner boolean DEFAULT true)
RETURNS TABLE(id uuid,vehicle_type text,vehicle_name text,license_plate text,color text,owner_name text,ticket_number text,parking_fee numeric,
  building_id uuid,building_name text,room_id uuid,room_name text,customer_id uuid,customer_name text,customer_phone text,created_at timestamptz,total_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_pattern text; v_allowed uuid[]; v_unassigned boolean;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'vehicles_list_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'vehicles_list_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_allowed FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('vehicles','view',b.id);
  v_unassigned:=COALESCE(p_include_unassigned,true) AND public.can_access_org_entity('vehicles','view');
  IF NULLIF(btrim(p_query),'') IS NOT NULL THEN
    v_pattern:='%'||replace(replace(replace(btrim(p_query),'\','\\'),'%','\%'),'_','\_')||'%';
  END IF;
  RETURN QUERY
  WITH base AS (
    SELECT v.*,b.name AS b_name,r.name AS r_name,
      (cu.id IS NOT NULL AND (p_customer_building_ids IS NULL OR v.building_id=ANY(p_customer_building_ids))) AS customer_visible,
      cu.full_name AS cu_name,cu.phone AS cu_phone
    FROM public.vehicles v
    LEFT JOIN public.buildings b ON b.id=v.building_id AND b.organization_id=p_organization_id
    LEFT JOIN public.rooms r ON r.id=v.room_id AND r.organization_id=p_organization_id
    LEFT JOIN public.customers cu ON cu.id=v.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
    WHERE v.organization_id=p_organization_id AND v.deleted_at IS NULL
      AND ((v.building_id IS NOT NULL AND v.building_id=ANY(v_allowed)) OR (v.building_id IS NULL AND v_unassigned))
  )
  SELECT x.id,x.vehicle_type::text,x.vehicle_name,x.license_plate,x.color,CASE WHEN p_allow_copied_owner OR x.customer_visible THEN x.owner_name END,x.ticket_number,
    x.parking_fee,x.building_id,x.b_name,x.room_id,x.r_name,
    CASE WHEN x.customer_visible THEN x.customer_id END,CASE WHEN x.customer_visible THEN x.cu_name END,
    CASE WHEN x.customer_visible THEN x.cu_phone END,x.created_at,count(*) OVER (),x.organization_id
  FROM base x
  WHERE (p_vehicle_type IS NULL OR x.vehicle_type::text=p_vehicle_type)
    AND (p_room_id IS NULL OR x.room_id=p_room_id)
    AND (p_customer_id IS NULL OR x.customer_id=p_customer_id AND x.customer_visible)
    AND (v_pattern IS NULL OR x.license_plate ILIKE v_pattern OR x.vehicle_name ILIKE v_pattern
      OR (p_allow_copied_owner OR x.customer_visible) AND x.owner_name ILIKE v_pattern OR x.customer_visible AND x.cu_name ILIKE v_pattern)
  ORDER BY x.created_at DESC,x.id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

CREATE OR REPLACE FUNCTION public.vehicles_list_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_customer_building_ids uuid[] DEFAULT NULL,p_include_unassigned boolean DEFAULT true,p_query text DEFAULT NULL,
  p_vehicle_type text DEFAULT NULL,p_room_id uuid DEFAULT NULL,p_customer_id uuid DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,vehicle_type text,vehicle_name text,license_plate text,color text,owner_name text,ticket_number text,parking_fee numeric,
  building_id uuid,building_name text,room_id uuid,room_name text,customer_id uuid,customer_name text,customer_phone text,created_at timestamptz,total_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 RETURN QUERY SELECT * FROM public.vehicles_list_core_v1(p_organization_id,p_building_ids,p_customer_building_ids,p_include_unassigned,p_query,p_vehicle_type,p_room_id,p_customer_id,p_limit,p_offset,true);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2c_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_uid uuid:=auth.uid(); v_org uuid; v_buildings uuid[]; v_customers uuid[]; v_rows jsonb; v_total bigint; v_extra numeric;
  v_from date; v_to date; v_month date; v_ceiling date; v_overrides jsonb; v_value jsonb; v_row record; v_summary jsonb; v_staff uuid[];
  v_admin boolean; v_locked bigint; v_building uuid; v_payload jsonb; v_items jsonb:='[]'::jsonb; v_page jsonb; v_capped boolean:=false;
  v_query text; i integer; v_at timestamptz; v_id uuid; v_sort integer; v_building_org uuid;
BEGIN
  IF current_user<>'authenticated' OR v_uid IS NULL OR p_ctx->>'userId' IS DISTINCT FROM v_uid::text OR p_ctx->>'report' IS DISTINCT FROM p_report
    OR jsonb_typeof(p_ctx->'organizationId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_ctx->'buildings') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  v_buildings:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx->'buildings') x);
  v_from:=(p_params->>'fromDate')::date; v_to:=(p_params->>'toDate')::date;

  -- C1 xe (useVehicles.ts:39-130): toà ctx; tên/SĐT khách ở toà có customers.view của kết nối; xe không gắn toà
  -- chỉ khi toàn công ty.
  IF p_report='vehicles' THEN
    v_customers:=CASE WHEN jsonb_typeof(p_ctx#>'{scopes,customers.view}')='array'
      THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx#>'{scopes,customers.view}') x) ELSE '{}'::uuid[] END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.vehicle_type,'name',public.safe_text_v1(x.vehicle_name,100),
        'plate',public.safe_text_v1(x.license_plate,40),'color',public.safe_text_v1(x.color,60),
        'ownerName',public.safe_text_v1(x.owner_name,200),'ticketNumber',public.safe_text_v1(x.ticket_number,60),
        'parkingFee',COALESCE(x.parking_fee,0)::text,'buildingId',x.building_id,'buildingName',public.safe_text_v1(x.building_name,200),
        'roomId',x.room_id,'roomName',public.safe_text_v1(x.room_name,100),'customerId',x.customer_id,
        'customerName',public.safe_text_v1(x.customer_name,200),'customerPhone',public.safe_text_v1(x.customer_phone,40),
        'organizationId',x.organization_id)
        ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count)
      INTO v_rows,v_total
      FROM public.vehicles_list_core_v1(v_org,v_buildings,v_customers,p_ctx->'orgWide'='true'::jsonb,p_params->>'query',p_params->>'kind',
        (p_params->>'roomId')::uuid,(p_params->>'customerId')::uuid,2000,0,COALESCE(p_ctx->'allowCopiedCustomerText'='true'::jsonb,false)) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0)),'sourceCapped',COALESCE(v_total,0)>2000,
      'unavailable',NULL);
  END IF;

  -- C2–C5 kho vật tư (dữ liệu cấp công ty; cổng đã đòi CRM toàn công ty ∩ overlay Toàn tổ chức).
  IF p_report IN ('materials','material_categories','material_purchases','material_usages','material_adjustments') THEN
    IF p_ctx->'orgWide' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','organization_scope_required');
    END IF;
    IF p_report='materials' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'name',public.safe_text_v1(x.name,200),
          'categoryId',x.category_id,'categoryName',public.safe_text_v1(x.category_name,200),'unit',public.safe_text_v1(x.unit,40),
          'onHand',x.on_hand::text,'reorderLevel',x.reorder_level::text,'lowStock',x.low_stock,'avgUnitCost',x.avg_unit_cost::text,
          'organizationId',x.organization_id)
          ORDER BY x.name,x.id),'[]'::jsonb),max(x.total_count),max(x.low_stock_count)
        INTO v_rows,v_total,v_extra
        FROM public.materials_items_v1(v_org,p_params->>'query',(p_params->>'categoryId')::uuid,COALESCE((p_params->>'lowStock')::boolean,false),2000,0) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'lowStock',COALESCE(v_extra,0)::bigint),
        'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
    ELSIF p_report='material_categories' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'name',public.safe_text_v1(x.name,200),
          'description',public.safe_text_v1(x.description,500),'materialCount',x.material_count,'organizationId',x.organization_id) ORDER BY x.rn) FILTER (WHERE x.rn<=2000),'[]'::jsonb),
          count(*)
        INTO v_rows,v_total FROM (SELECT c.*,row_number() OVER (ORDER BY c.name,c.id) rn FROM public.materials_categories_v1(v_org) c) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',v_total),'sourceCapped',v_total>2000,'unavailable',NULL);
    ELSIF p_report='material_purchases' THEN
      -- Tên NCC chỉ khi kết nối giữ suppliers.view (RLS suppliers vẫn quyết từng NCC).
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'date',x.purchase_date,
          'supplierId',x.supplier_id,'supplierName',public.safe_text_v1(x.supplier_name,200),'total',x.total::text,
          'notes',public.safe_text_v1(x.notes,500),'itemCount',x.item_count,'organizationId',x.organization_id,
          'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l->'materialId','materialName',
              to_jsonb(public.safe_text_v1(l->>'materialName',200)),'unit',to_jsonb(public.safe_text_v1(l->>'unit',40)),
              'quantity',l->>'quantity','unitPrice',l->>'unitPrice','lineTotal',l->>'lineTotal') ORDER BY o),'[]'::jsonb)
            FROM jsonb_array_elements(x.items) WITH ORDINALITY e(l,o)))
          ORDER BY x.purchase_date DESC,x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count),max(x.total_amount)
        INTO v_rows,v_total,v_extra
        FROM public.materials_purchases_v1(v_org,v_from,v_to,(p_params->>'supplierId')::uuid,
          jsonb_typeof(p_ctx#>'{scopes,suppliers.view}')='array',2000,0) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'amount',COALESCE(v_extra,0)::text),
        'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
    ELSIF p_report='material_usages' THEN
      -- Mã/tên việc chỉ khi việc thuộc toà có tasks.view của kết nối (RLS jobs vẫn quyết).
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'date',x.usage_date,
          'jobId',x.job_id,'jobCode',public.safe_text_v1(x.job_code,60),'jobTitle',public.safe_text_v1(x.job_title,200),
          'creatorName',public.safe_text_v1(x.creator_name,200),'notes',public.safe_text_v1(x.notes,500),
          'itemCount',x.item_count,'totalQuantity',x.total_quantity::text,'totalCost',x.total_cost::text,'organizationId',x.organization_id,
          'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l->'materialId','materialName',
              to_jsonb(public.safe_text_v1(l->>'materialName',200)),'unit',to_jsonb(public.safe_text_v1(l->>'unit',40)),
              'quantity',l->>'quantity','unitCost',l->>'unitCost') ORDER BY o),'[]'::jsonb)
            FROM jsonb_array_elements(x.items) WITH ORDINALITY e(l,o)))
          ORDER BY x.usage_date DESC,x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count),max(x.total_cost_sum)
        INTO v_rows,v_total,v_extra
        FROM public.materials_usages_v1(v_org,v_from,v_to,CASE WHEN jsonb_typeof(p_ctx#>'{scopes,tasks.view}')='array'
          THEN ARRAY(SELECT y::uuid FROM jsonb_array_elements_text(p_ctx#>'{scopes,tasks.view}') y) ELSE '{}'::uuid[] END,2000,0) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'cost',COALESCE(v_extra,0)::text),
        'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'date',x.adjustment_date,
        'type',x.type,'reason',public.safe_text_v1(x.reason,500),'itemCount',x.item_count,'organizationId',x.organization_id,
        'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l->'materialId','materialName',
            to_jsonb(public.safe_text_v1(l->>'materialName',200)),'unit',to_jsonb(public.safe_text_v1(l->>'unit',40)),
            'quantity',l->>'quantity') ORDER BY o),'[]'::jsonb)
          FROM jsonb_array_elements(x.items) WITH ORDINALITY e(l,o)))
        ORDER BY x.adjustment_date DESC,x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count)
      INTO v_rows,v_total
      FROM public.materials_adjustments_v1(v_org,v_from,v_to,p_params->>'kind',2000,0) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0)),
      'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
  END IF;

  -- C6 kho tài sản: toà ctx; kho không gắn toà chỉ khi toàn công ty.
  IF p_report='warehouses' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'name',public.safe_text_v1(x.name,200),'location',public.safe_text_v1(x.location,300),
        'buildingId',x.building_id,'buildingName',public.safe_text_v1(x.building_name,200),'organizationId',x.organization_id) ORDER BY x.rn) FILTER (WHERE x.rn<=2000),
        '[]'::jsonb),max(x.total_count)
      INTO v_rows,v_total
      FROM (SELECT w.*,row_number() OVER (ORDER BY w.name,w.id) rn
        FROM public.warehouses_list_v1(v_org,v_buildings,p_ctx->'orgWide'='true'::jsonb,p_params->>'query') w) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0)),'sourceCapped',COALESCE(v_total,0)>2000,
      'unavailable',NULL);
  END IF;

  -- C9 thông báo của CHÍNH người hỏi (self), công ty của kết nối, trần 200 như trang web.
  IF p_report='notifications' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'type',x.type,'subject',public.safe_text_v1(x.subject,300),
        'content',public.safe_text_v1(x.content,1000),'unread',x.status='PENDING','createdAt',public.utc_instant_v1(x.created_at))
        ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count),max(x.unread_count)
      INTO v_rows,v_total,v_extra
      FROM public.notifications_inbox_v1(v_org,COALESCE((p_params->>'unreadOnly')::boolean,false),p_params->>'kind',200) x;
    IF v_total IS NULL THEN
      -- Bộ lọc không khớp dòng nào: vẫn báo số chưa đọc của cả hộp (badge web).
      SELECT count(*) INTO v_extra FROM public.notifications_inbox_v1(v_org,true,NULL,2000) x;
    END IF;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'unread',COALESCE(v_extra,0)::bigint),
      'sourceCapped',COALESCE(v_total,0)>200,'unavailable',NULL);
  END IF;

  -- C7/C8 lương: CHỈ tháng ĐÃ CHỐT. Trần tháng nhân viên tự xem (MySalaryPage.tsx:39-41,88; useManagerSalary.ts:639-665;
  -- managerSalary.ts:440-505): tháng hiện tại lùi tối đa 13 tháng, bỏ tháng admin tắt trong salary_staff_months();
  -- không tháng nào mở ⇒ tháng hiện tại.
  IF p_report IN ('my_salary','salary_month') THEN
    v_month:=((p_params->>'month')||'-01')::date;
    v_overrides:=public.salary_staff_months();
    IF jsonb_typeof(v_overrides) IS DISTINCT FROM 'object' THEN v_overrides:='{}'::jsonb; END IF;
    v_ceiling:=date_trunc('month',(p_ctx->>'today')::date)::date;
    FOR i IN 0..13 LOOP
      v_value:=v_overrides->to_char(v_ceiling,'YYYY-MM');
      -- isStaffMonthVisible: có khoá ⇒ !!giá trị (truthy của JS); không khoá ⇒ luôn thấy.
      EXIT WHEN v_value IS NULL OR (CASE jsonb_typeof(v_value) WHEN 'boolean' THEN v_value='true'::jsonb WHEN 'null' THEN false
        WHEN 'number' THEN (v_value#>>'{}')::numeric<>0 WHEN 'string' THEN (v_value#>>'{}')<>'' ELSE true END);
      v_ceiling:=(v_ceiling-interval '1 month')::date;
      IF i=13 THEN v_ceiling:=date_trunc('month',(p_ctx->>'today')::date)::date; END IF;
    END LOOP;
    IF p_report='my_salary' THEN
      -- MySalaryPage áp trần cho mọi người (kể cả admin); chỉ auth.uid().
      IF v_month>v_ceiling THEN
        RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
      END IF;
      SELECT * INTO v_row FROM public.salary_locked_month_v1(v_org,v_month,ARRAY[v_uid]) x WHERE x.staff_id=v_uid;
      IF v_row.staff_id IS NULL OR v_row.status IS DISTINCT FROM 'LOCKED' THEN
        -- Không là quản lý hưởng lương tháng đó, hoặc tháng chưa chốt: web tính ở trình duyệt ⇒ không đoán.
        RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
      END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.line_id,'type',l.line_type,'date',l.occurred_date,
          'label',public.safe_text_v1(l.label,300),'detail',public.safe_text_v1(l.detail,300),'amount',l.amount::text) ORDER BY o)
          FILTER (WHERE o<=2000),'[]'::jsonb),count(*)
        INTO v_rows,v_total FROM public.salary_locked_lines_v1(v_org,v_month,v_uid,COALESCE(p_params->>'kind','adjustments'))
          WITH ORDINALITY l(line_id,line_type,occurred_date,label,detail,amount,is_repair,is_contract,o);
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('month',p_params->>'month','status',v_row.status,
        'lockedAt',public.utc_instant_v1(v_row.locked_at),'roleTitle',public.safe_text_v1(v_row.role_title,100),
        'baseSalary',v_row.base_salary::text,'workBonus',v_row.work_bonus::text,'contractBonus',v_row.contract_bonus::text,
        'adjustmentsTotal',v_row.adjustments_total::text,'bonus',v_row.bonus_total::text,'investment',v_row.investment_profit::text,
        'commission',v_row.commission_total::text,'grossTotal',v_row.gross_total::text,'advances',v_row.advances_total::text,
        'roomRent',v_row.room_rent::text,'takeHome',v_row.take_home::text,'paid',v_row.paid::text,'remaining',v_row.remaining::text,'lineCount',v_total),
        'sourceCapped',v_total>2000,'unavailable',NULL);
    END IF;
    -- salary_month: dữ liệu cấp công ty (cổng đòi toàn công ty); người không là admin trang lương: chỉ mình, theo trần.
    IF p_ctx->'orgWide' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','organization_scope_required');
    END IF;
    v_admin:=public.salary_is_admin_v1(v_org);
    IF NOT v_admin AND v_month>v_ceiling THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
    END IF;
    v_staff:=CASE WHEN p_params->>'staffId' IS NULL THEN NULL ELSE ARRAY[(p_params->>'staffId')::uuid] END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('staffId',x.staff_id,'name',public.safe_text_v1(x.staff_name,200),
        'roleTitle',public.safe_text_v1(x.role_title,100),'status',x.status,'lockedAt',public.utc_instant_v1(x.locked_at),
        'baseSalary',x.base_salary::text,'bonus',x.bonus_total::text,'investment',x.investment_profit::text,'commission',x.commission_total::text,
        'grossTotal',x.gross_total::text,'advances',x.advances_total::text,'roomRent',x.room_rent::text,'takeHome',x.take_home::text,
        'paid',x.paid::text,'remaining',x.remaining::text,'organizationId',x.organization_id) ORDER BY x.rn) FILTER (WHERE x.rn<=2000),'[]'::jsonb),
      count(*) FILTER (WHERE x.status='LOCKED'),
      jsonb_build_object('month',p_params->>'month','managers',count(*),'locked',count(*) FILTER (WHERE x.status='LOCKED'),
        'notLocked',count(*) FILTER (WHERE x.status<>'LOCKED'),'grossTotal',COALESCE(sum(x.gross_total),0)::text,
        'takeHomeTotal',COALESCE(sum(x.take_home),0)::text,'paidTotal',COALESCE(sum(x.paid),0)::text,
        'remainingTotal',COALESCE(sum(x.remaining),0)::text)
      INTO v_rows,v_locked,v_summary
      FROM (SELECT s.*,row_number() OVER (ORDER BY s.staff_name,s.staff_id) rn FROM public.salary_locked_month_v1(v_org,v_month,v_staff) s) x;
    IF v_locked=0 THEN
      -- Không người nào đã chốt: mọi số của tháng là số tính ở trình duyệt ⇒ không đoán.
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
    END IF;
    RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',(v_summary->>'managers')::bigint>2000,'unavailable',NULL);
  END IF;

  -- C10–C14 Network Center: RPC của màn web gọi THẲNG (tự kiểm network_center.view theo toà), giữ đúng toà ctx.
  -- Mọi hàng nêu buildingId (báo cáo theo toà). Khách hotspot: RPC web JOIN customers KHÔNG kiểm customers.view; ở đây
-- tên/ID khách chỉ khi khách đọc được dưới
  -- RLS customers của người hỏi VÀ toà có customers.view của kết nối; ID hợp đồng chỉ khi đọc được dưới RLS contracts
  -- và toà đó. Người thực hiện lệnh/nhật ký: chỉ "chính tôi hay không"; không trả JSON result/parameters/target.
  IF p_report='network_fleet' THEN
    v_payload:=public.network_center_list_fleet_v1();
    SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',(item->>'buildingId')::uuid,
        'buildingName',public.safe_text_v1(item->>'buildingName',200),
        'routerIdentity',public.safe_text_v1(item->>'routerIdentity',200),'routerModel',public.safe_text_v1(item->>'routerModel',100),
        'routerosVersion',public.safe_text_v1(item->>'routerosVersion',60),'lifecycleStatus',public.safe_text_v1(item->>'lifecycleStatus',60),
        'healthStatus',public.safe_text_v1(item->>'healthStatus',60),'reachable',COALESCE((item->>'reachable')::boolean,false),
        'lastSeenAt',public.utc_instant_v1((item->>'lastSeenAt')::timestamptz),'cpuPercent',public.json_number_v1(item->'cpuPercent'),
        'memoryUsedBytes',public.json_number_v1(item->'memoryUsedBytes'),'memoryTotalBytes',public.json_number_v1(item->'memoryTotalBytes'),
        'pppoeState',public.safe_text_v1(item->>'pppoeState',60),'connectionCount',public.json_number_v1(item->'connectionCount'),
        'arubaCount',public.json_number_v1(item->'arubaCount'),'openIncidents',public.json_number_v1(item->'openIncidents'),
        'activeClients',public.json_number_v1(item->'activeClients'),'lastBackupAt',public.utc_instant_v1((item->>'lastBackupAt')::timestamptz),
        'uptimePercent',public.json_number_v1(item->'uptimePercent'),'maintenanceActive',COALESCE((item->>'maintenanceActive')::boolean,false),
        'rolloutState',public.safe_text_v1(item->>'rolloutState',60),'organizationId',bo.organization_id) ORDER BY o),'[]'::jsonb)
      INTO v_rows
      FROM jsonb_array_elements(COALESCE(v_payload->'items','[]'::jsonb)) WITH ORDINALITY e(item,o)
      LEFT JOIN public.buildings bo ON bo.id=(item->>'buildingId')::uuid
      WHERE (item->>'buildingId')::uuid=ANY(v_buildings);
    RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(t.r ORDER BY t.n),'[]'::jsonb) FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r,n) WHERE t.n<=2000),'summary',jsonb_build_object('buildings',jsonb_array_length(v_rows),
      'reachable',(SELECT count(*) FROM jsonb_array_elements(v_rows) r WHERE r->'reachable'='true'::jsonb),
      'openIncidents',(SELECT COALESCE(sum((r->>'openIncidents')::numeric),0) FROM jsonb_array_elements(v_rows) r),
      'activeClients',(SELECT COALESCE(sum((r->>'activeClients')::numeric),0) FROM jsonb_array_elements(v_rows) r)),
      'sourceCapped',jsonb_array_length(v_rows)>2000,'unavailable',NULL);
  END IF;
  IF p_report NOT IN ('network_building','network_ports','network_backups','network_clients','network_aruba','network_h196a',
      'network_commands','network_audit','network_config_diff') THEN
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  -- Báo cáo một toà: cổng đã đòi buildingId ∈ phạm vi; kiểm lại ở đây.
  v_building:=(p_params->>'buildingId')::uuid;
  IF v_building IS NULL OR NOT(v_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  -- Công ty của toà từ CỘT buildings.organization_id dưới RLS của người hỏi (RPC Network Center không trả công ty);
  -- toà không đọc được ⇒ NULL ⇒ bước kết thúc từ chối mọi hàng (42501), không chép ctx.
  SELECT bo.organization_id INTO v_building_org FROM public.buildings bo WHERE bo.id=v_building;
  IF p_report IN ('network_building','network_ports','network_backups') THEN
    v_payload:=public.network_center_get_building_v1(v_building);
    IF p_report='network_building' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'title',public.safe_text_v1(item->>'title',300),
          'detail',public.safe_text_v1(item->>'detail',1000),'severity',public.safe_text_v1(item->>'severity',60),
          'status',public.safe_text_v1(item->>'status',60),'openedAt',public.utc_instant_v1((item->>'openedAt')::timestamptz),
          'acknowledgedAt',public.utc_instant_v1((item->>'acknowledgedAt')::timestamptz)) ORDER BY o),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_payload->'incidents','[]'::jsonb)) WITH ORDINALITY e(item,o);
      RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(t.r ORDER BY t.n),'[]'::jsonb) FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r,n) WHERE t.n<=2000),'summary',jsonb_build_object(
        'buildingName',public.safe_text_v1(v_payload->>'buildingName',200),'roomsCount',public.json_number_v1(v_payload->'roomsCount'),
        'rolloutState',public.safe_text_v1(v_payload->>'rolloutState',60),
        'router',CASE WHEN jsonb_typeof(v_payload->'router')='object' THEN jsonb_build_object(
          'identity',public.safe_text_v1(v_payload#>>'{router,identity}',200),'model',public.safe_text_v1(v_payload#>>'{router,model}',100),
          'firmware',public.safe_text_v1(v_payload#>>'{router,firmware}',60),
          'lifecycleStatus',public.safe_text_v1(v_payload#>>'{router,lifecycleStatus}',60),
          'reachable',COALESCE((v_payload#>>'{router,reachable}')::boolean,false),
          'healthStatus',public.safe_text_v1(v_payload#>>'{router,healthStatus}',60),
          'lastSeenAt',public.utc_instant_v1((v_payload#>>'{router,lastSeenAt}')::timestamptz),
          'cpuPercent',public.json_number_v1(v_payload#>'{router,cpuPercent}'),
          'memoryUsedBytes',public.json_number_v1(v_payload#>'{router,memoryUsedBytes}'),
          'memoryTotalBytes',public.json_number_v1(v_payload#>'{router,memoryTotalBytes}'),
          'temperatureC',public.json_number_v1(v_payload#>'{router,temperatureC}'),
          'pppoeState',public.safe_text_v1(v_payload#>>'{router,pppoeState}',60),
          'connectionCount',public.json_number_v1(v_payload#>'{router,connectionCount}')) END,
        'maintenance',CASE WHEN jsonb_typeof(v_payload->'maintenance')='object' THEN jsonb_build_object(
          'reason',public.safe_text_v1(v_payload#>>'{maintenance,reason}',300),
          'status',public.safe_text_v1(v_payload#>>'{maintenance,status}',60),
          'startsAt',public.utc_instant_v1((v_payload#>>'{maintenance,startsAt}')::timestamptz),
          'endsAt',public.utc_instant_v1((v_payload#>>'{maintenance,endsAt}')::timestamptz)) END,
        'changesPaused',CASE WHEN jsonb_typeof(v_payload#>'{settings,changesPaused}')='boolean' THEN v_payload#>'{settings,changesPaused}' END,
        'openIncidents',jsonb_array_length(v_rows),
        'ports',jsonb_array_length(COALESCE(v_payload->'interfaces','[]'::jsonb)),
        'backups',jsonb_array_length(COALESCE(v_payload->'revisions','[]'::jsonb))),
        'sourceCapped',jsonb_array_length(v_rows)>2000,'unavailable',NULL);
    ELSIF p_report='network_ports' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'name',public.safe_text_v1(item->>'name',200),
          'role',public.safe_text_v1(item->>'role',60),'enabled',COALESCE((item->>'enabled')::boolean,false),
          'protected',COALESCE((item->>'protected')::boolean,false),'linkState',public.safe_text_v1(item->>'linkState',60),
          'rxBps',public.json_number_v1(item->'rxBps'),'txBps',public.json_number_v1(item->'txBps'),
          'utilizationPercent',public.json_number_v1(item->'utilizationPercent'),'errors',public.json_number_v1(item->'errors'),
          'discards',public.json_number_v1(item->'discards')) ORDER BY o),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_payload->'interfaces','[]'::jsonb)) WITH ORDINALITY e(item,o);
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'at',public.utc_instant_v1((item->>'capturedAt')::timestamptz),
          'label',public.safe_text_v1(item->>'label',100),'source',public.safe_text_v1(item->>'source',60)) ORDER BY o),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_payload->'revisions','[]'::jsonb)) WITH ORDINALITY e(item,o);
    END IF;
    RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(t.r ORDER BY t.n),'[]'::jsonb) FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r,n) WHERE t.n<=2000),'summary',jsonb_build_object('total',jsonb_array_length(v_rows)),
      'sourceCapped',jsonb_array_length(v_rows)>2000,'unavailable',NULL);
  ELSIF p_report='network_clients' THEN
    -- Trang web chỉ xem 100 thiết bị mới nhất (ClientsTab.tsx:28); ở đây đọc tiếp theo con trỏ tới 2000.
    FOR i IN 1..20 LOOP
      v_page:=public.network_center_list_clients_v1(v_building,v_at,v_id,100);
      v_items:=v_items||COALESCE(v_page->'items','[]'::jsonb);
      EXIT WHEN jsonb_typeof(v_page->'nextCursor') IS DISTINCT FROM 'object';
      IF i=20 THEN v_capped:=true; EXIT; END IF;
      v_at:=(v_page#>>'{nextCursor,seenAt}')::timestamptz; v_id:=(v_page#>>'{nextCursor,id}')::uuid;
    END LOOP;
    v_customers:=CASE WHEN jsonb_typeof(p_ctx#>'{scopes,customers.view}')='array'
      THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx#>'{scopes,customers.view}') x) ELSE '{}'::uuid[] END;
    v_query:=lower(NULLIF(btrim(p_params->>'query'),''));
    SELECT COALESCE(jsonb_agg(shown.r_json ORDER BY shown.o),'[]'::jsonb) INTO v_rows FROM (
      SELECT o,jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'hostname',public.safe_text_v1(item->>'hostname',200),
        'address',public.safe_text_v1(item->>'address',64),'macAddress',public.safe_text_v1(item->>'macAddress',40),
        'randomizedMac',COALESCE((item->>'randomizedMac')::boolean,false),'sessionType',public.safe_text_v1(item->>'sessionType',60),
        'connectionType',public.safe_text_v1(item->>'connectionType',60),'roomHint',public.safe_text_v1(item->>'roomHint',100),
        'roomId',room.id,'customerId',CASE WHEN gate.visible THEN cu.id END,
        'customerName',CASE WHEN gate.visible THEN public.safe_text_v1(cu.full_name,200) END,
        'contractId',CASE WHEN v_building=ANY(v_customers) THEN ct.id END,
        'rxBps',public.json_number_v1(item->'rxBps'),'txBps',public.json_number_v1(item->'txBps'),
        'lastSeenAt',public.utc_instant_v1((item->>'lastSeenAt')::timestamptz)) r_json,
        concat_ws(' ',item->>'hostname',item->>'address',item->>'macAddress',item->>'roomHint',CASE WHEN gate.visible THEN cu.full_name END) haystack
      FROM jsonb_array_elements(v_items) WITH ORDINALITY e(item,o)
      LEFT JOIN public.rooms room ON room.id=(item->>'roomId')::uuid AND room.organization_id=v_org AND room.building_id=v_building
      LEFT JOIN public.customers cu ON cu.id=(item->>'customerId')::uuid AND cu.organization_id=v_org AND cu.deleted_at IS NULL
      LEFT JOIN public.contracts ct ON ct.id=(item->>'contractId')::uuid AND ct.organization_id=v_org
      CROSS JOIN LATERAL (SELECT v_building=ANY(v_customers) AND cu.id IS NOT NULL AS visible) gate
    ) shown WHERE v_query IS NULL OR strpos(lower(shown.haystack),v_query)>0;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',jsonb_array_length(v_rows),
      'customerNamesShown',v_building=ANY(v_customers)),'sourceCapped',v_capped,'unavailable',NULL);
  ELSIF p_report IN ('network_aruba','network_h196a') THEN
    FOR i IN 1..8 LOOP
      v_page:=CASE p_report WHEN 'network_aruba' THEN public.network_center_list_aruba_v1(v_building,v_sort,v_id,250)
        ELSE public.network_center_list_h196a_v1(v_building,v_sort,v_id,250) END;
      v_items:=v_items||COALESCE(v_page->'items','[]'::jsonb);
      EXIT WHEN jsonb_typeof(v_page->'nextCursor') IS DISTINCT FROM 'object';
      IF i=8 THEN v_capped:=true; EXIT; END IF;
      v_sort:=(v_page#>>'{nextCursor,sortOrder}')::integer; v_id:=(v_page#>>'{nextCursor,id}')::uuid;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'name',public.safe_text_v1(item->>'name',200),
        'model',public.safe_text_v1(item->>'model',100),'lifecycleStatus',public.safe_text_v1(item->>'lifecycleStatus',60),
        'healthStatus',public.safe_text_v1(item->>'healthStatus',60),
        'reachable',CASE WHEN jsonb_typeof(item->'reachable')='boolean' THEN item->'reachable' END,
        'address',public.safe_text_v1(item->>'address',64),'lastSeenAt',public.utc_instant_v1((item->>'lastSeenAt')::timestamptz))
        ORDER BY o),'[]'::jsonb)
      INTO v_rows FROM jsonb_array_elements(v_items) WITH ORDINALITY e(item,o);
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',jsonb_array_length(v_rows)),'sourceCapped',v_capped,'unavailable',NULL);
  ELSIF p_report IN ('network_commands','network_audit') THEN
    FOR i IN 1..20 LOOP
      v_page:=CASE p_report WHEN 'network_commands' THEN public.network_center_list_commands_v1(v_building,v_at,v_id,100)
        ELSE public.network_center_list_audit_v1(v_building,v_at,v_id,100) END;
      v_items:=v_items||COALESCE(v_page->'items','[]'::jsonb);
      EXIT WHEN jsonb_typeof(v_page->'nextCursor') IS DISTINCT FROM 'object';
      IF i=20 THEN v_capped:=true; EXIT; END IF;
      v_at:=COALESCE(v_page#>>'{nextCursor,createdAt}',v_page#>>'{nextCursor,occurredAt}')::timestamptz; v_id:=(v_page#>>'{nextCursor,id}')::uuid;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,
        'at',public.utc_instant_v1(COALESCE(item->>'createdAt',item->>'at')::timestamptz),
        'action',public.safe_text_v1(COALESCE(item->>'actionType',item->>'action'),100),
        'status',public.safe_text_v1(COALESCE(item->>'status',item->>'outcome'),60),
        'reason',public.safe_text_v1(item->>'reason',300),'actorType',public.safe_text_v1(item->>'actorType',60),
        'byMe',COALESCE(COALESCE(item->>'requestedBy',item->>'actorId')=v_uid::text,false),
        'finishedAt',public.utc_instant_v1((item->>'finishedAt')::timestamptz)) ORDER BY o),'[]'::jsonb)
      INTO v_rows FROM jsonb_array_elements(v_items) WITH ORDINALITY e(item,o);
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',jsonb_array_length(v_rows)),'sourceCapped',v_capped,'unavailable',NULL);
  END IF;
  -- network_config_diff: hai bản sao lưu đã che bí mật; chỉ dòng thêm/bớt.
  BEGIN
    v_payload:=public.network_center_compare_snapshots_v1(v_building,(p_params->>'fromId')::uuid,(p_params->>'toId')::uuid);
  EXCEPTION WHEN no_data_found THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
  END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('line',o,'buildingId',v_building,'organizationId',v_building_org,'kind',line->>'kind','text',public.safe_text_v1(line->>'text',500)) ORDER BY o),'[]'::jsonb)
    INTO v_rows FROM (SELECT line,o FROM jsonb_array_elements(COALESCE(v_payload->'lines','[]'::jsonb)) WITH ORDINALITY e(line,o)
      WHERE line->>'kind' IN ('added','removed') ORDER BY o LIMIT 2000) changed;
  RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('changeCount',public.json_number_v1(v_payload->'changeCount')),
    'sourceCapped',(SELECT count(*) FROM jsonb_array_elements(COALESCE(v_payload->'lines','[]'::jsonb)) l WHERE l->>'kind' IN ('added','removed'))>2000,
    'unavailable',NULL);
END $fn$;
ALTER FUNCTION public.vehicles_list_core_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.vehicles_list_core_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.vehicles_list_core_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
