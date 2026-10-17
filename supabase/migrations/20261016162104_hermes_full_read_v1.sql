-- Hermes đọc đầy đủ cho NGƯỜI HỎI (đợt 1, chủ chốt 16/10/2026).
-- Trả lời RIÊNG cho user: thấy đúng dữ liệu web cho chính user đó xem (SĐT, CCCD
-- dạng chữ, ngày sinh, địa chỉ...), quyền vẫn "như user" = quyền CRM hiện tại ∩
-- overlay Read/scope đã lưu của kết nối ∩ chính sách công ty ∩ registry.
-- Bản tin NHÓM (group preview/send, lịch, tự động hoá) KHÔNG đi qua file này và
-- giữ nguyên lọc công khai.
--
--  1. public.hermes_room_pass_upsert_v2: bọc v1 (v1 giữ MỌI quyết định quyền,
--     biên nhận, ghi). v2 chỉ thay SĐT che bằng SĐT đầy đủ của khách đại diện
--     (lookup) và của liên hệ tin pass (upsert/status) cho người hỏi.
--  2. public.hermes_domain_read_v3 (họ miền v3, không có hàm capabilities riêng:
--     khoá quyền đều ĐÃ CÓ trong registry/options — customers.view,
--     contracts.view, invoices.view, deposits.view, reports_finance.analysis,
--     reports_real_estate.occupancy, rooms.view, chat_zalo.view...). Cùng khuôn
--     binding/overlay/scope toà của hermes_domain_read_v2.
--       customers        danh sách khách, SĐT đầy đủ (thay crm_read_customers v1)
--       customer_detail  hồ sơ khách như /customers/:id (không ảnh CCCD)
--       contract_detail  hợp đồng như /contracts/:id (không file hợp đồng)
--       report           bọc hàm đọc copilot_* đã phát hành, theo bảng cố định
-- Migration không ghi dữ liệu nghiệp vụ, không thêm khoá quyền, không đổi
-- registry; không đổi chữ ký/kiểu trả về của hàm đã phát hành.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Chữ dài (ghi chú, địa chỉ): giữ xuống dòng \n, bỏ mọi ký tự điều khiển khác,
-- cắt theo số ký tự (code point). Không đọc bảng nào.
CREATE OR REPLACE FUNCTION app_private.hermes_full_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
   translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
   '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END
$fn$;

-- 1. Tin pass / tra phòng: SĐT đầy đủ cho người hỏi. v1 (đã rà, đã phát hành)
-- quyết định binding, overlay, quyền CRM theo toà, biên nhận và ghi; v2 không tự
-- cấp quyền gì: chỉ đọc lại SĐT của đúng khách đại diện / tin mà v1 vừa trả.
CREATE OR REPLACE FUNCTION public.hermes_room_pass_upsert_v2(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_result jsonb; v_rooms jsonb; v_contact jsonb; v_listing uuid; v_room uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('lookup','upsert','status')
    THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  v_result:=public.hermes_room_pass_upsert_v1(p_binding,p_operation,p_input);
  IF p_operation='lookup' THEN
    -- Cùng cách chọn khách đại diện như v1 (hợp đồng đang hiệu lực của phòng).
    SELECT COALESCE(jsonb_agg(room.value||jsonb_build_object('representative',(
        SELECT jsonb_build_object('name',app_private.hermes_domain_text_v1(cu.full_name),'phone',app_private.hermes_domain_text_v1(cu.phone))
        FROM public.contracts ct JOIN public.contract_customers cc ON cc.contract_id=ct.id
        JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
        WHERE ct.room_id=(room.value->>'roomId')::uuid AND ct.deleted_at IS NULL AND ct.status IN ('ACTIVE','EXTENDED')
        ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 1)) ORDER BY room.ordinality),'[]'::jsonb)
      INTO v_rooms FROM jsonb_array_elements(v_result->'rooms') WITH ORDINALITY AS room(value,ordinality);
    RETURN jsonb_set(v_result,'{rooms}',v_rooms,false);
  END IF;
  -- upsert / status của biên nhận upsert: liên hệ HIỆN TẠI của đúng tin trong
  -- biên nhận (cùng giao dịch với lượt ghi nên upsert khớp đúng bản vừa lưu).
  IF jsonb_typeof(v_result->'contact')='object' THEN
    v_listing:=app_private.hermes_uuid_v1(v_result#>'{listing,listingId}');
    v_room:=app_private.hermes_uuid_v1(v_result#>'{listing,roomId}');
    SELECT jsonb_build_object('name',app_private.hermes_domain_text_v1(l.contact_name),'phone',app_private.hermes_domain_text_v1(l.contact_phone))
      INTO v_contact FROM public.room_pass_listings l WHERE l.id=v_listing AND l.room_id=v_room;
    v_result:=jsonb_set(v_result,'{contact}',COALESCE(v_contact,jsonb_build_object('name',v_result#>'{contact,name}','phone',NULL)),false);
  END IF;
  RETURN v_result;
END $fn$;

-- 2. Họ miền v3. Quyết định quyền giống hệt hermes_domain_read_v2: binding kết
-- nối/phiên/thành viên/chính sách, quyền CRM hiện tại của ĐÚNG khoá
-- (get_authorization_context_v1 + authorized_scope_v3) ∩ overlay Read + scope
-- toà đã lưu của kết nối ∩ chính sách công ty ∩ registry. Toàn tổ chức chỉ khi
-- CRM org_wide VÀ kết nối đã chọn scope Toàn tổ chức.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v3(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean; org_wide boolean:=false; overlay_org boolean:=false;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_target uuid; v_report jsonb; v_from date; v_to date;
  rows jsonb; next_cursor uuid; v_item jsonb; v_result jsonb;
BEGIN
  IF p_domain='customers' THEN permission:='customers.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
  ELSIF p_domain='customer_detail' THEN permission:='customers.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['customerId']);
  ELSIF p_domain='contract_detail' THEN permission:='contracts.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['contractId']);
  ELSIF app_private.hermes_report_catalog_v1(p_domain,NULL) IS NOT NULL THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['report','query','status','month','fromDate','toDate','days','buildingId','limit','offset']);
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
  IF p_domain='customers' THEN
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
        OR NOT (v_report->'statuses' ? (p_input->>'status')))
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

  IF p_domain='customers' THEN
    -- Như hermes_domain_read_v1 nhưng SĐT đầy đủ; kết nối Toàn tổ chức thấy cả
    -- khách chưa có hợp đồng (như danh sách /customers), chỉ chủ sở hữu nhìn thấy được.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT customer.id,jsonb_build_object('id',customer.id,'name',app_private.hermes_domain_text_v1(COALESCE(customer.full_name,'')),
        'phone',app_private.hermes_domain_text_v1(customer.phone),'contractId',latest.id,'buildingId',latest.building_id,'roomId',latest.room_id,
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
      'notes',app_private.hermes_full_text_v1(cu.notes,2000),
      'contracts',(SELECT COALESCE(jsonb_agg(link.item ORDER BY link.active,link.start_date DESC NULLS LAST,link.id),'[]'::jsonb) FROM (
        SELECT contract.id,contract.start_date,CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END active,
          jsonb_build_object('id',contract.id,'number',app_private.hermes_full_text_v1(contract.contract_number,100),'status',contract.status::text,
            'buildingId',room.building_id,'buildingName',app_private.hermes_full_text_v1(building.name,200),'roomId',room.id,
            'roomName',app_private.hermes_full_text_v1(room.name,100),'startDate',contract.start_date,
            'endDate',COALESCE(contract.actual_end_date,contract.end_date),'rentPrice',COALESCE(contract.rent_price,0)::text,
            'isRepresentative',COALESCE(cc.is_representative,false)) item
        FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
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
      'tenants',(SELECT COALESCE(jsonb_agg(person.item ORDER BY person.representative DESC,person.name,person.id),'[]'::jsonb) FROM (
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
        ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 10) person),
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
    -- Hàm copilot tự kiểm quyền CRM (khoá trùng); Hermes chỉ cần overlay không thu hẹp
    -- cho báo cáo không lọc được theo toà, nên truyền overlay_org (không đòi CRM org_wide).
    v_result:=app_private.hermes_report_read_v1(p_domain,p_input,c.organization_id,buildings,overlay_org);
  END IF;
  IF octet_length(v_result::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;
-- 3. Bảng khai báo cố định cho báo cáo bọc hàm đọc copilot_* ĐÃ PHÁT HÀNH, chỉ
-- những hàm mà khoá CRM nó tự kiểm (copilot_org_scope_buildings_v1/
-- authorized_scope_v3) đúng bằng một khoá Hermes ĐÃ CÓ và không bị cờ trang
-- copilot_feature_flags chặn. Khoá permission ở đây phải TRÙNG khoá hàm copilot
-- tự kiểm, để quyền CRM của hàm ∩ overlay Hermes cùng một khoá.
--   scope=rows          hàng có building_id ⇒ lọc theo tập toà đã giao
--   scope=buildings     hàm nhận danh sách toà ⇒ truyền tập toà đã giao
--   scope=organization  hàng không có toà ⇒ CHỈ kết nối Toàn tổ chức
-- Danh sách này phải khớp REPORT_TOOLS trong infra/hermes-broker/full-read-contract.mjs.
CREATE OR REPLACE FUNCTION app_private.hermes_report_catalog_v1(p_domain text,p_report text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT CASE WHEN p_report IS NULL THEN (CASE WHEN p_domain IN ('occupancy_report','invoice_report','monthly_pnl','pending_approvals',
   'zalo_conversations','contract_search') THEN '{}'::jsonb END) ELSE (CASE p_domain||':'||p_report
   WHEN 'occupancy_report:snapshot' THEN '{"permission":"reports_real_estate.occupancy","source":"crm.copilot_occupancy_v1","scope":"rows","fromDate":true,"buildingFilter":true}'
   WHEN 'occupancy_report:upcoming' THEN '{"permission":"reports_real_estate.occupancy","source":"crm.copilot_occupancy_upcoming_v1","scope":"rows","fromDate":true,"days":true,"buildingFilter":true}'
   WHEN 'invoice_report:search' THEN '{"permission":"invoices.view","source":"crm.copilot_invoice_search_v1","scope":"rows","month":true,"statuses":["paid","partial","unpaid"],"buildingFilter":true}'
   WHEN 'invoice_report:stats' THEN '{"permission":"invoices.view","source":"crm.get_invoice_statistics_v2","scope":"buildings","month":true,"buildingFilter":true}'
   WHEN 'monthly_pnl:by_month' THEN '{"permission":"reports_finance.analysis","source":"crm.copilot_financial_pnl_v1","scope":"rows","fromDate":true,"toDate":true,"requiresDates":true,"buildingFilter":true}'
   WHEN 'pending_approvals:inbox' THEN '{"permission":"income_expenses.view","source":"crm.copilot_pending_requests_v1","scope":"organization"}'
   WHEN 'zalo_conversations:list' THEN '{"permission":"chat_zalo.view","source":"crm.copilot_zalo_conversations_v1","scope":"organization"}'
   WHEN 'contract_search:search' THEN '{"permission":"contracts.view","source":"crm.copilot_contract_search_v1","scope":"organization","statuses":["DRAFT","ACTIVE","EXTENDED","TRANSFERRED","TERMINATED","EXPIRED"]}'
 END)::jsonb END
$fn$;

-- Gọi đúng hàm copilot_* (quyền CRM của chính user qua auth.uid()), chiếu các
-- trường cố định, lọc theo tập toà đã giao, rồi phân trang offset/limit với
-- trần byte. Cờ trang copilot_feature_flags (copilot_feature_disabled) và báo
-- cáo cần Toàn tổ chức trả lý do rõ ràng trong 'unavailable', không lỗi mơ hồ.
CREATE OR REPLACE FUNCTION app_private.hermes_report_read_v1(p_domain text,p_input jsonb,p_org uuid,p_buildings uuid[],p_overlay_org boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_report text:=p_input->>'report'; v_spec jsonb; v_query text:=NULLIF(btrim(COALESCE(p_input->>'query','')),'');
  v_status text:=p_input->>'status'; v_month text:=p_input->>'month'; v_from date; v_to date; v_days integer; v_today date;
  v_limit integer; v_offset integer; v_raw jsonb; v_rows jsonb:='[]'::jsonb; v_summary jsonb; v_capped boolean:=false;
  v_page jsonb:='[]'::jsonb; v_bytes integer:=0; v_total integer; v_next integer; v_item jsonb; i integer;
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
  v_today:=public.org_today_v1(p_org);
  BEGIN
    IF p_domain='occupancy_report' AND v_report='snapshot' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',o.building_id,'buildingName',app_private.hermes_full_text_v1(o.building_name,200),
          'total',COALESCE(o.total,0),'occupied',COALESCE(o.occupied,0),'reserved',COALESCE(o.reserved,0),'maintenance',COALESCE(o.maintenance,0),
          'unavailable',COALESCE(o.unavailable,0),'available',COALESCE(o.available,0),'occupancyPct',round(o.occupancy_pct,2)::text,
          'committedPct',round(o.committed_pct,2)::text,'missedRevenue',round(o.missed_revenue,2)::text) ORDER BY o.building_name,o.building_id),'[]'::jsonb)
        INTO v_rows FROM public.copilot_occupancy_v1(p_org,COALESCE(v_from,v_today),30) o
        WHERE o.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(o.building_name,'')))>0);
    ELSIF p_domain='occupancy_report' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('contractId',u.contract_id,'contractNumber',app_private.hermes_full_text_v1(u.contract_number,100),
          'buildingId',u.building_id,'buildingName',app_private.hermes_full_text_v1(u.building_name,200),'roomId',u.room_id,
          'roomName',app_private.hermes_full_text_v1(u.room_name,100),'effectiveEndDate',u.effective_end_date,'daysRemaining',u.days_remaining,
          'rentPrice',u.rent_price::text,'extensionApplied',u.extension_applied) ORDER BY u.effective_end_date,u.building_name,u.room_name,u.contract_id)
          FILTER (WHERE u.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN
            lower(concat_ws(' ',u.building_name,u.room_name,u.contract_number)))>0)),'[]'::jsonb),count(*)>=2000
        INTO v_rows,v_capped FROM public.copilot_occupancy_upcoming_v1(p_org,COALESCE(v_from,v_today),COALESCE(v_days,30)) u;
    ELSIF p_domain='invoice_report' AND v_report='search' THEN
      v_raw:=public.copilot_invoice_search_v1(p_org,v_month,v_status,v_query);
      v_capped:=jsonb_array_length(COALESCE(v_raw,'[]'::jsonb))>=2000;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(e->>'id')::uuid,'number',app_private.hermes_full_text_v1(e->>'invoice_number',100),
          'billingMonth',app_private.hermes_full_text_v1(e->>'billing_month',20),'totalAmount',COALESCE(e->>'total_amount','0'),
          'status',e->>'status','buildingId',(e->>'building_id')::uuid,'buildingName',app_private.hermes_full_text_v1(e->>'building_name',200),
          'roomId',(e->>'room_id')::uuid,'roomName',app_private.hermes_full_text_v1(e->>'room_name',100)) ORDER BY ord),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_raw,'[]'::jsonb)) WITH ORDINALITY AS r(e,ord)
        WHERE (e->>'building_id')::uuid=ANY(p_buildings);
    ELSIF p_domain='invoice_report' THEN
      -- Cùng thân copilot_invoice_stats_v1 (get_invoice_statistics_v2), nhưng truyền
      -- tập toà đã giao thay vì toàn bộ phạm vi CRM: kết nối giới hạn toà vẫn dùng được.
      v_raw:=public.get_invoice_statistics_v2(NULL,NULL,NULL,NULL,NULL,v_month,NULL,p_buildings)::jsonb;
      v_summary:=jsonb_build_object('totalCount',COALESCE((v_raw->>'total_count')::bigint,0));
      FOR v_item IN SELECT jsonb_build_array(k,f) FROM (VALUES('totalAmount','total_amount'),('totalPaid','total_paid'),('totalRemaining','total_remaining'),
          ('totalRefunded','total_refunded'),('rentAmount','rent_amount'),('electricAmount','electric_amount'),('waterAmount','water_amount'),
          ('serviceAmount','pdv_amount'),('totalCollected','total_collected'),('cashAmount','payment_tm'),('transferAmount','payment_tk'),
          ('paymentTt','payment_tt'),('paymentCt','payment_ct'),('changeAmount','change_amount'),('depositCollected','deposit_collected')) m(k,f) LOOP
        v_summary:=v_summary||jsonb_build_object(v_item->>0,COALESCE(v_raw->>(v_item->>1),'0'));
      END LOOP;
    ELSIF p_domain='monthly_pnl' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month',pnl.month,'buildingId',pnl.building_id,
          'buildingName',app_private.hermes_full_text_v1(pnl.building_name,200),'revenue',COALESCE(pnl.revenue,0)::text,
          'expense',COALESCE(pnl.expense,0)::text,'net',COALESCE(pnl.net,0)::text) ORDER BY pnl.month,pnl.building_name,pnl.building_id)
          FILTER (WHERE pnl.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(pnl.building_name,'')))>0)),'[]'::jsonb),
          count(*)>=2000
        INTO v_rows,v_capped FROM public.copilot_financial_pnl_v1(p_org,v_from,v_to,false) pnl;
    ELSIF p_domain='pending_approvals' THEN
      v_raw:=public.copilot_pending_requests_v1(p_org,50);
      v_capped:=jsonb_array_length(COALESCE(v_raw->'hop_cho','[]'::jsonb))>=50;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',(e->>'yeu_cau_id')::uuid,'submissionNo',(e->>'lan_gui')::integer,
          'submittedAt',to_char((e->>'gui_luc')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'amount',e->>'so_tien',
          'voucherId',(e->>'phieu_id')::uuid,'voucherCode',app_private.hermes_full_text_v1(e->>'ma_phieu',100),
          'voucherName',app_private.hermes_full_text_v1(e->>'ten_phieu',200),'voucherType',e->>'loai',
          'makerName',app_private.hermes_full_text_v1(e->>'nguoi_lap',200),'stepNo',(e->>'buoc')::integer) ORDER BY ord),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_raw->'hop_cho','[]'::jsonb)) WITH ORDINALITY AS r(e,ord)
        WHERE v_query IS NULL OR position(lower(v_query) IN lower(concat_ws(' ',e->>'ma_phieu',e->>'ten_phieu',e->>'nguoi_lap')))>0;
    ELSIF p_domain='zalo_conversations' THEN
      v_raw:=public.copilot_zalo_conversations_v1(p_org,v_query,50);
      v_capped:=jsonb_array_length(COALESCE(v_raw->'hoi_thoai','[]'::jsonb))>=50;
      v_summary:=jsonb_build_object('conversations',COALESCE((v_raw#>>'{tong_hop,so_hoi_thoai}')::bigint,0),
        'unreadConversations',COALESCE((v_raw#>>'{tong_hop,so_chua_doc}')::bigint,0),
        'unreadMessages',COALESCE((v_raw#>>'{tong_hop,tong_tin_chua_doc}')::bigint,0),'pinned',COALESCE((v_raw#>>'{tong_hop,so_ghim}')::bigint,0));
      SELECT COALESCE(jsonb_agg(jsonb_build_object('conversationId',(e->>'hoi_thoai_id')::uuid,
          'peerName',app_private.hermes_full_text_v1(e->>'nguoi_nhan',200),'phone',app_private.hermes_full_text_v1(e->>'dien_thoai',40),
          'threadType',app_private.hermes_full_text_v1(e->>'loai',40),'kind',app_private.hermes_full_text_v1(e->>'nhom',40),
          'unread',COALESCE((e->>'chua_doc')::integer,0),'markedUnread',COALESCE((e->>'danh_dau_chua_doc')::boolean,false),
          'pinned',COALESCE((e->>'ghim')::boolean,false),'roomName',app_private.hermes_full_text_v1(e->>'phong',100),
          'buildingName',app_private.hermes_full_text_v1(e->>'toa_nha',200),'label',app_private.hermes_full_text_v1(e->>'nhan',200),
          'lastMessageAt',CASE WHEN e->>'tin_cuoi_luc' IS NULL THEN NULL
            ELSE to_char((e->>'tin_cuoi_luc')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'lastMessageDir',app_private.hermes_full_text_v1(e->>'tin_cuoi_chieu',20),
          'lastMessage',app_private.hermes_full_text_v1(e->>'tin_cuoi',160)) ORDER BY ord),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_raw->'hoi_thoai','[]'::jsonb)) WITH ORDINALITY AS r(e,ord);
    ELSE
      v_raw:=public.copilot_contract_search_v1(p_org,v_query,v_status,50);
      v_capped:=jsonb_array_length(COALESCE(v_raw->'hop_dong','[]'::jsonb))>=50;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('contractId',(e->>'hop_dong_id')::uuid,
          'number',app_private.hermes_full_text_v1(e->>'so_hop_dong',100),'customerName',app_private.hermes_full_text_v1(e->>'khach_hang',200),
          'roomName',app_private.hermes_full_text_v1(e->>'phong',100),'buildingName',app_private.hermes_full_text_v1(e->>'toa_nha',200),
          'startDate',(e->>'ngay_bat_dau')::date,'endDate',(e->>'ngay_ket_thuc')::date,'status',e->>'trang_thai',
          'rentPrice',e->>'tien_thue','totalDeposit',e->>'tien_coc','depositPaid',e->>'coc_da_thu') ORDER BY ord),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_raw->'hop_dong','[]'::jsonb)) WITH ORDINALITY AS r(e,ord);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Cờ trang copilot_feature_flags tắt/hết hạn: báo rõ, không thành lỗi quyền mơ hồ.
    IF SQLERRM='copilot_feature_disabled' THEN
      RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','copilot_feature_disabled',
        'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
    END IF;
    RAISE;
  END;
  -- Phân trang trong ảnh chụp vừa đọc; dừng sớm khi chạm trần byte (≈40 KB) để
  -- kết quả luôn lọt trần 60 KB SQL / 64 KB broker; nextOffset báo phần còn lại.
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

ALTER FUNCTION app_private.hermes_full_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_report_catalog_v1(text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_report_read_v1(text,jsonb,uuid,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION public.hermes_room_pass_upsert_v2(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_full_text_v1(text,integer),app_private.hermes_report_catalog_v1(text,text),
  app_private.hermes_report_read_v1(text,jsonb,uuid,uuid[],boolean),public.hermes_room_pass_upsert_v2(jsonb,text,jsonb),
  public.hermes_domain_read_v3(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_pass_upsert_v2(jsonb,text,jsonb),public.hermes_domain_read_v3(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
