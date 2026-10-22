-- R2d REVERT, wave-2 half — prepared 21/10/2026; NOT a migration (docs/plans/hermes-crm/revert/).
-- Returns public.hermes_domain_read_v3 — the one function 20261021063453_hermes_w2_customers_without_contract_v1.sql
-- replaced — to its exact 20261021044814 (R2c part 2, wave-2 half) body: the customers summary without withoutContract.
-- SAFE ORDER: the running connector must accept a customers summary without withoutContract — the R2d connector does (its
-- one-release window); the release after it refuses it.
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs
-- hermes_w2_customers_without_contract_revert_v1` gives — the hermes_w2_ prefix is required (wave-2 fence, last definition
-- of hermes_domain_read_v3 in the foundation band); add it to the w2MigrationPaths expectation (wave2-foundation.test.mjs)
-- and the last-definition file of full-read-report.test.mjs.
-- Before hermes_w2_customer_status_summary_revert_v1.sql (R2c part 2) when both are needed: that artifact refuses to run
-- while this file's body is live.
-- $requires$ refuses to run over other v3 bodies; idempotent (CREATE OR REPLACE).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v3(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR position('app_private.hermes_w2_gate_v1(p_binding,p_domain,p_input)' IN p.prosrc)=0
    OR (length(p.prosrc)-length(replace(p.prosrc,'''summary'',v_summary','')))/length('''summary'',v_summary')<>2
    OR position('customer.status_v2::text status,count(*) n' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_w2_without_contract_revert_unexpected_v3'; END IF;
END $requires$;

-- The 20261021044814 body, verbatim.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v3(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean; org_wide boolean:=false; overlay_org boolean:=false;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_target uuid; v_report jsonb; v_from date; v_to date;
  rows jsonb; next_cursor uuid; v_item jsonb; v_result jsonb; v_customer_scope uuid[]; v_contract_scope uuid[]; v_owners uuid[]; v_summary jsonb;
BEGIN
  -- Đợt 2 (20261018000000): hai miền meta sang cổng riêng; mọi dòng dưới giữ nguyên 20261017033630.
  IF p_domain IN ('report','report_list') THEN RETURN app_private.hermes_w2_gate_v1(p_binding,p_domain,p_input); END IF;
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
  -- (P2-2) RLS customers_select_rbac của web (20260726130000:33-35, production 17/10): mọi hồ sơ
  -- khách chỉ hiện khi chủ hồ sơ (customers.user_id) là thành viên ACTIVE của công ty người hỏi.
  v_owners:=COALESCE(public.current_visible_owner_ids(),'{}'::uuid[]);

  IF p_domain='customers' THEN
    -- Như hermes_domain_read_v1 nhưng SĐT đầy đủ; kết nối Toàn tổ chức thấy cả
    -- khách chưa có hợp đồng (như danh sách /customers), chỉ chủ sở hữu nhìn thấy được.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT customer.id,jsonb_build_object('id',customer.id,'name',app_private.hermes_domain_text_v1(COALESCE(customer.full_name,'')),
        'phone',app_private.hermes_domain_text_v1(customer.phone),
        -- (P3-6) Phòng/toà gần nhất đi cùng hợp đồng: chỉ khi có contracts.view ở toà đó.
        'contractId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.id END,
        'buildingId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.building_id END,
        'buildingName',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN app_private.hermes_domain_text_v1(COALESCE(latest.building_name,'')) ELSE '' END,
        'roomId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.room_id END,
        'roomName',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN app_private.hermes_domain_text_v1(latest.room_name) END) item
      FROM public.customers customer LEFT JOIN LATERAL (
        SELECT contract.id,room.id room_id,room.building_id,room.name room_name,building.name building_name FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
        WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(contract.actual_end_date,contract.end_date) DESC NULLS LAST,contract.id LIMIT 1) latest ON true
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL AND (cursor_id IS NULL OR customer.id>cursor_id)
        AND customer.user_id=ANY(v_owners) AND (latest.id IS NOT NULL OR org_wide)
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0
          OR position(regexp_replace(query,'[^0-9]','','g') IN regexp_replace(COALESCE(customer.phone,''),'[^0-9]','','g'))>0
            AND regexp_replace(query,'[^0-9]','','g')<>'')
      ORDER BY customer.id LIMIT row_limit+1) found;
    IF jsonb_array_length(rows)>row_limit THEN
      SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
      next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
    END IF;
    -- R2a: count of the whole filtered set (same WHERE without the cursor, no LIMIT); the contract
    -- the row joins (latest.id IS NOT NULL) is this EXISTS. No status or money column here.
    -- R2c: byStatus counts the contract status of the same set (customers.status_v2 = the tabs of /customers:
    -- RENTING đang thuê, MOVED_OUT đã chuyển đi, WALK_IN vãng lai/chưa có hợp đồng), only values present.
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,
        'byStatus',COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb),'sum','{}'::jsonb) INTO v_summary FROM (
      SELECT customer.status_v2::text status,count(*) n FROM public.customers customer
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL
        AND customer.user_id=ANY(v_owners) AND (org_wide OR EXISTS(SELECT 1 FROM public.contract_customers cc
          JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
          JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
          WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id))
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0
          OR position(regexp_replace(query,'[^0-9]','','g') IN regexp_replace(COALESCE(customer.phone,''),'[^0-9]','','g'))>0
            AND regexp_replace(query,'[^0-9]','','g')<>'')
      GROUP BY 1) s;
    v_result:=jsonb_build_object('items',rows,'nextCursor',next_cursor,'summary',v_summary);
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
    -- R2a: totals of the same snapshot rows (building name query, no cursor, no LIMIT).
    SELECT jsonb_build_object('count',count(*),'total',COALESCE(sum(COALESCE(snapshot.total,0)),0),
        'occupied',COALESCE(sum(COALESCE(snapshot.occupied,0)),0),'available',COALESCE(sum(COALESCE(snapshot.available,0)),0)) INTO v_summary
      FROM public.occupancy_snapshot_v2(public.org_today_v1(c.organization_id),buildings) snapshot
      WHERE snapshot.building_id=ANY(buildings)
        AND (query='' OR position(query IN lower(COALESCE(snapshot.building_name,'')))>0);
    v_result:=jsonb_build_object('items',rows,'nextCursor',next_cursor,'summary',v_summary);
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
      WHERE cu.id=v_target AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
        AND (EXISTS(SELECT 1 FROM public.contract_customers cc
            JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
            JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
            WHERE cc.customer_id=cu.id AND cc.organization_id=c.organization_id)
          OR org_wide);
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
          AND cu.user_id=ANY(v_owners)
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
  -- (P3-7) Đo SAU khi broker bọc kết quả thành chuỗi JSON (ngoặc kép, xuống dòng được escape):
  -- 60 000 byte ở đây còn lọt trần 65 536 của broker. PT413 ⇒ HTTP 413 ⇒ result_too_large.
  IF octet_length(to_jsonb(v_result::text)::text)>60000 THEN
    RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='PT413',HINT='Giảm limit hoặc thu hẹp bộ lọc rồi gọi lại.';
  END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;

ALTER FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record; sig text:='public.hermes_domain_read_v3(jsonb,text,jsonb)';
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
  IF NOT FOUND OR NOT p.prosecdef OR position('withoutContract' IN p.prosrc)>0
    OR position('SELECT customer.status_v2::text status,count(*) n FROM public.customers customer' IN p.prosrc)=0
    OR NOT has_function_privilege('authenticated',sig,'EXECUTE') OR has_function_privilege('anon',sig,'EXECUTE')
    THEN RAISE EXCEPTION 'hermes_w2_without_contract_revert_v3_unexpected'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
