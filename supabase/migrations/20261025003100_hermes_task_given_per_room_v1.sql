-- Hermes trang Công việc, lượt 14 — hai lỗi máy chủ theo nghiệm thu lượt cuối C3f trên TEST (connector 1a915197, SOUL v4.25, 25/10):
--  (1) "Việc tôi đã giao cho người khác mà chưa xong": crm_read_tasks đếm đúng summary.givenByMe nhưng byBuilding / byAssignee / overdue
--      tính trên CẢ tập lọc (gồm việc không do người hỏi giao) ⇒ bot không nêu được người nhận của việc mình giao. Bộ đọc miền v1 nhận
--      khoá givenByMe (chỉ miền tasks): dòng và MỌI phần summary tính trên đúng tập việc người hỏi giao cho người khác.
--  (2) "Mỗi phòng một việc" cho cả toà: task.create_batch nhận perRoom=true + buildingName ⇒ mỗi phòng của toà một mục (xem trước như
--      lô); > 20 phòng ⇒ needs_input batch_too_large kèm số phòng thật (rooms) để bot đề nghị chia lô.
-- Thay ba thân: public.hermes_domain_read_v1 (thân 20261022153345, md5 d79bb632be427768e64b6f3e7f543e73, production = TEST — chỉ nhánh tasks + khoá
-- input; mọi nhánh khác giữ từng byte); lõi + chuẩn bị lô của vỏ hermes_task_action_v1 (thân 20261024145100, md5 fdbb5d453243c8b920debc632f234b1e /
-- 1ea792d430d0c5f929d08a87984cf5a3, đang chạy trên TEST; production áp 091500 → 145100 trước file này theo thứ tự C3). Không ghi dữ liệu, không khoá mới.
-- THỨ TỰ: file này TRƯỚC connector lượt 14 (connector gửi givenByMe / perRoom; SQL cũ từ chối khoá givenByMe). Connector cũ + SQL mới:
-- input năm khoá vẫn qua, perRoom không tới được SQL (connector cũ từ chối tham số lạ). Không DROP. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_request_v1(jsonb,text[])') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regclass('public.rooms') IS NULL
    -- Thân đang chạy phải đúng thân 20261022153345 / 20261024145100 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='public.hermes_domain_read_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('d79bb632be427768e64b6f3e7f543e73','fb2f65b229970c25e60835b7ba9ed1fa')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('fdbb5d453243c8b920debc632f234b1e','adea03b28b36d0f221b0b8244055959d')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure) NOT IN ('1ea792d430d0c5f929d08a87984cf5a3','0d7a8ab43a59cce8cc627b9e9823eb01') THEN
    RAISE EXCEPTION 'hermes_task_given_per_room_dependency_invalid'; END IF;
END $requires$;

-- 1. Bộ đọc miền v1 (DEFINER): thân 20261022153345 + (1).
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; capabilities jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; org_wide boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; rows jsonb; next_cursor uuid; v_summary jsonb; v_tz text;
  v_given boolean:=false;
BEGIN
  permission:=app_private.hermes_domain_permission_v1(p_domain);
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  -- Lượt 14 Công việc ("việc anh giao cho người khác mà chưa xong"): miền tasks nhận thêm khoá givenByMe (boolean) = chỉ việc người hỏi
  -- tạo mà người nhận KHÁC người hỏi (kể cả chưa giao, như summary.givenByMe). Connector chỉ gửi khoá khi bật ⇒ input năm khoá của
  -- connector cũ vẫn qua; miền khác gửi khoá này ⇒ 22023 như mọi khoá lạ.
  IF p_domain='tasks' AND jsonb_typeof(p_input)='object' AND p_input ? 'givenByMe' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status','givenByMe']);
    IF jsonb_typeof(p_input->'givenByMe') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_given:=(p_input->>'givenByMe')::boolean;
  ELSE
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
  END IF;
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  row_limit:=app_private.hermes_integer_v1(p_input->'limit');
  query:=p_input->>'query'; v_status:=p_input->>'status';
  IF row_limit NOT BETWEEN 1 AND 50 OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(query)>200
    OR query ~ '[[:cntrl:]]' OR position(chr(8232) IN query)>0 OR position(chr(8233) IN query)>0
    OR (p_input->'status'<>'null'::jsonb AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR NOT (
      (p_domain='leads' AND v_status IN ('B1_LEAD','B2_APPOINTMENT','B3_CONSULTATION','CONVERTED','FAILED')) OR
      (p_domain='contracts' AND v_status IN ('DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED')) OR
      (p_domain='tasks' AND v_status IN ('IN_PROGRESS','COMPLETED')))))
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  query:=lower(btrim(query));
  IF p_input->'cursor'<>'null'::jsonb THEN cursor_id:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  IF p_input->'buildingId'<>'null'::jsonb THEN requested_building:=app_private.hermes_uuid_v1(p_input->'buildingId'); END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR session.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  capabilities:=public.hermes_domain_capabilities_v1(c.organization_id);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR session.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    OR capabilities->>'policyVersion' IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF capabilities->'permissions'->permission->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  -- Map saved scope IDs within the current organization, then intersect the
  -- permission-specific CRM building set. A cashbook scope grants no buildings.
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND capabilities->'permissions'->permission->'buildingIds' ? b.id::text
    AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id AND (
      scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
      OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
        ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
        WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
  SELECT COALESCE(scope.org_wide,false) AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay
    WHERE overlay.id=ANY(scopes) AND overlay.organization_id=c.organization_id AND overlay.scope_type='ORGANIZATION')
    INTO org_wide FROM app_private.authorized_scope_v3(permission,c.organization_id) scope;
  org_wide:=COALESCE(org_wide,false);
  IF requested_building IS NOT NULL THEN
    IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested_building]; org_wide:=false;
  END IF;

  -- Each branch: the page (cursor, LIMIT row_limit+1) and then the summary of the whole
  -- filtered set (same WHERE without cursor_id, no LIMIT). byStatus lists only present values.
  IF p_domain='customers' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT customer.id,jsonb_build_object('id',customer.id,'name',app_private.hermes_domain_text_v1(COALESCE(customer.full_name,'')),
        'phoneMasked',CASE WHEN customer.phone IS NULL THEN NULL ELSE '***'||right(regexp_replace(customer.phone,'[^0-9]','','g'),4) END,
        'contractId',latest.id,'buildingId',latest.building_id,'roomId',latest.room_id) item
      FROM public.customers customer JOIN LATERAL (
        SELECT contract.id,room.id room_id,room.building_id FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
        WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(contract.actual_end_date,contract.end_date) DESC NULLS LAST,contract.id LIMIT 1) latest ON true
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL AND (cursor_id IS NULL OR customer.id>cursor_id)
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0 OR position(query IN COALESCE(customer.phone,''))>0)
      ORDER BY customer.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'byStatus','{}'::jsonb,'sum','{}'::jsonb) INTO v_summary
      FROM public.customers customer
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM public.contract_customers cc
          JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
          JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
          WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id)
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0 OR position(query IN COALESCE(customer.phone,''))>0);
  ELSIF p_domain='leads' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT lead.id,jsonb_build_object('id',lead.id,'name',app_private.hermes_domain_text_v1(COALESCE(lead.customer_name,'')),
        'status',lead.status,'buildingId',lead.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'nextFollowUp',lead.next_follow_up_date) item
      FROM public.leads lead LEFT JOIN public.rooms room ON room.id=lead.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=lead.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=lead.building_id AND building.organization_id=c.organization_id
      WHERE lead.organization_id=c.organization_id AND lead.deleted_at IS NULL
        AND (lead.building_id=ANY(buildings) OR (lead.building_id IS NULL AND org_wide))
        AND (cursor_id IS NULL OR lead.id>cursor_id) AND (v_status IS NULL OR lead.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(lead.customer_name,'')))>0)
      ORDER BY lead.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb),
        'sum','{}'::jsonb) INTO v_summary FROM (
      SELECT lead.status::text status,count(*) n FROM public.leads lead
      WHERE lead.organization_id=c.organization_id AND lead.deleted_at IS NULL
        AND (lead.building_id=ANY(buildings) OR (lead.building_id IS NULL AND org_wide))
        AND (v_status IS NULL OR lead.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(lead.customer_name,'')))>0)
      GROUP BY 1) s;
  ELSIF p_domain='contracts' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT contract.id,jsonb_build_object('id',contract.id,'number',app_private.hermes_domain_text_v1(contract.contract_number),
        'status',contract.status,'buildingId',room.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'startDate',contract.start_date,
        'endDate',COALESCE(contract.actual_end_date,contract.end_date)) item
      FROM public.contracts contract JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE contract.organization_id=c.organization_id AND contract.deleted_at IS NULL AND room.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR contract.id>cursor_id) AND (v_status IS NULL OR contract.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(contract.contract_number,'')))>0)
      ORDER BY contract.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb),
        'sum','{}'::jsonb) INTO v_summary FROM (
      SELECT contract.status::text status,count(*) n
      FROM public.contracts contract JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      WHERE contract.organization_id=c.organization_id AND contract.deleted_at IS NULL AND room.building_id=ANY(buildings)
        AND (v_status IS NULL OR contract.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(contract.contract_number,'')))>0)
      GROUP BY 1) s;
  ELSIF p_domain='invoices' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT invoice.id,jsonb_build_object('id',invoice.id,'number',app_private.hermes_domain_text_v1(invoice.invoice_number),
        'status',invoice.status,'buildingId',room.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'billingMonth',invoice.billing_month,'totalAmount',COALESCE(invoice.total_amount,0)::text) item
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id AND room.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR invoice.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')))>0)
      ORDER BY invoice.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'byStatus','{}'::jsonb,'sum','{}'::jsonb) INTO v_summary
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id AND room.building_id=ANY(buildings)
        AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')))>0);
  ELSIF p_domain='assets' THEN
    -- R2c: createdAt = the day the asset was added, in the company's business time zone (org_timezone_v1).
    v_tz:=app_private.org_timezone_v1(c.organization_id);
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT asset.id,jsonb_build_object('id',asset.id,'name',app_private.hermes_domain_text_v1(COALESCE(asset.name,'')),
        'code',app_private.hermes_domain_text_v1(asset.code),'condition',asset.condition,'buildingId',asset.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'quantity',COALESCE(asset.quantity,0)::text,
        'createdAt',(asset.created_at AT TIME ZONE v_tz)::date) item
      FROM public.assets asset LEFT JOIN public.rooms room ON room.id=asset.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=asset.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=asset.building_id AND building.organization_id=c.organization_id
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (cursor_id IS NULL OR asset.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      ORDER BY asset.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.condition,s.n) FILTER (WHERE s.condition IS NOT NULL),'{}'::jsonb),
        'sum',jsonb_build_object('quantity',COALESCE(sum(s.quantity),0)::text)) INTO v_summary FROM (
      SELECT asset.condition::text condition,count(*) n,sum(COALESCE(asset.quantity,0)) quantity FROM public.assets asset
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      GROUP BY 1) s;
    -- R2c: the most recently added asset of the same set (created_at desc, then id; no cursor, no LIMIT before it),
    -- named and dated like the rows; null when the set is empty.
    v_summary:=v_summary||jsonb_build_object('latest',(SELECT jsonb_build_object('id',asset.id,
        'name',app_private.hermes_domain_text_v1(COALESCE(asset.name,'')),'code',app_private.hermes_domain_text_v1(asset.code),
        'buildingId',asset.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomName',app_private.hermes_domain_text_v1(room.name),'createdAt',(asset.created_at AT TIME ZONE v_tz)::date)
      FROM public.assets asset LEFT JOIN public.rooms room ON room.id=asset.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=asset.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=asset.building_id AND building.organization_id=c.organization_id
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      ORDER BY asset.created_at DESC,asset.id LIMIT 1));
    -- R2d: latestCount = the assets of the same set whose created_at equals the latest one EXACTLY (the full timestamp,
    -- not the day): one import batch — production added every asset at one instant, so latest alone names an arbitrary
    -- member of it. 0 when the set is empty.
    v_summary:=v_summary||jsonb_build_object('latestCount',(SELECT count(*) FROM (
      SELECT asset.created_at,max(asset.created_at) OVER () newest FROM public.assets asset
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)) batch
      WHERE batch.created_at=batch.newest));
  ELSIF p_domain='services' THEN
    -- R2d: a service is company-wide (branch b, Toàn tổ chức) when it has no ACTIVE link to a LIVE building of the company —
    -- active links to soft-deleted buildings no longer hide it (the web /services lists it). Branch (a) and buildingIds keep
    -- the links to the connection's buildings.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT service.id,jsonb_build_object('id',service.id,'name',app_private.hermes_domain_text_v1(COALESCE(service.name,'')),
        'code',app_private.hermes_domain_text_v1(service.code),'unit',app_private.hermes_domain_text_v1(service.unit),'unitPrice',COALESCE(service.unit_price,0)::text,
        'buildingIds',COALESCE((SELECT jsonb_agg(DISTINCT bs.building_id ORDER BY bs.building_id) FROM public.building_services bs
          WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings)),'[]')) item
      FROM public.services service WHERE service.organization_id=c.organization_id AND service.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings))
          OR (org_wide AND service.user_id=ANY(public.current_visible_owner_ids()) AND NOT EXISTS(SELECT 1 FROM public.building_services bs
            JOIN public.buildings live ON live.id=bs.building_id AND live.organization_id=c.organization_id AND live.deleted_at IS NULL
            WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active)))
        AND (cursor_id IS NULL OR service.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(service.name,'')||' '||COALESCE(service.code,'')))>0)
      ORDER BY service.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'byStatus','{}'::jsonb,'sum','{}'::jsonb) INTO v_summary
      FROM public.services service WHERE service.organization_id=c.organization_id AND service.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings))
          OR (org_wide AND service.user_id=ANY(public.current_visible_owner_ids()) AND NOT EXISTS(SELECT 1 FROM public.building_services bs
            JOIN public.buildings live ON live.id=bs.building_id AND live.organization_id=c.organization_id AND live.deleted_at IS NULL
            WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active)))
        AND (query='' OR position(query IN lower(COALESCE(service.name,'')||' '||COALESCE(service.code,'')))>0);
  ELSIF p_domain='tasks' THEN
    -- Mốc 3b (22/10): dòng mang assigneeName (tên người nhận như web /tasks: hồ sơ, rồi tên gõ tay; null = chưa giao); query
    -- khớp tiêu đề/mã như cũ HOẶC tên người nhận (bỏ dấu, hermes_name_fold_v1).
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT job.id,jsonb_build_object('id',job.id,'title',app_private.hermes_domain_text_v1(COALESCE(job.title,'')),
        'code',app_private.hermes_domain_text_v1(job.code),'status',job.status,'buildingId',job.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'deadline',job.deadline,
        'assigneeName',NULLIF(app_private.hermes_domain_text_v1(COALESCE(NULLIF(person.full_name,''),job.assignee_name)),'')) item
      FROM public.jobs job LEFT JOIN public.rooms room ON room.id=job.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=job.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=job.building_id AND building.organization_id=c.organization_id
        LEFT JOIN public.profiles person ON person.id=job.assignee_id
      WHERE job.organization_id=c.organization_id AND (job.building_id=ANY(buildings) OR (job.building_id IS NULL AND org_wide))
        AND (cursor_id IS NULL OR job.id>cursor_id) AND (v_status IS NULL OR job.status=v_status)
        AND (NOT v_given OR (job.user_id=c.user_id AND job.assignee_id IS DISTINCT FROM job.user_id))
        AND (query='' OR position(query IN lower(COALESCE(job.title,'')||' '||COALESCE(job.code,'')))>0
          OR position(public.hermes_name_fold_v1(query) IN public.hermes_name_fold_v1(COALESCE(NULLIF(person.full_name,''),job.assignee_name)))>0)
      ORDER BY job.id LIMIT row_limit+1) found;
    -- Tóm tắt của CẢ tập lọc (cùng WHERE, không cursor/LIMIT) để mô hình không tự cộng các trang. overdue: việc mở đã quá hạn lúc
    -- câu lệnh chạy (now()). byBuilding / byAssignee: tối đa 50 nhóm, nhiều việc trước (hoà: id toà / tên theo byte, null cuối).
    -- givenByMe: việc người hỏi tạo mà người nhận KHÁC người hỏi (kể cả chưa giao). Lượt 14: lọc givenByMe ⇒ dòng VÀ mọi phần summary
    -- (count, byStatus, overdue, byBuilding, byAssignee, givenByMe) tính trên đúng tập đó (givenByMe.count = count).
    WITH found AS MATERIALIZED (
      SELECT job.status::text status,job.building_id,app_private.hermes_domain_text_v1(COALESCE(building.name,'')) building_name,
        NULLIF(app_private.hermes_domain_text_v1(COALESCE(NULLIF(person.full_name,''),job.assignee_name)),'') assignee_name,COALESCE(job.status='IN_PROGRESS' AND job.deadline<now(),false) late,
        COALESCE(job.user_id=c.user_id AND job.assignee_id IS DISTINCT FROM job.user_id,false) given
      FROM public.jobs job LEFT JOIN public.buildings building ON building.id=job.building_id AND building.organization_id=c.organization_id
        LEFT JOIN public.profiles person ON person.id=job.assignee_id
      WHERE job.organization_id=c.organization_id AND (job.building_id=ANY(buildings) OR (job.building_id IS NULL AND org_wide))
        AND (v_status IS NULL OR job.status=v_status)
        AND (NOT v_given OR (job.user_id=c.user_id AND job.assignee_id IS DISTINCT FROM job.user_id))
        AND (query='' OR position(query IN lower(COALESCE(job.title,'')||' '||COALESCE(job.code,'')))>0
          OR position(public.hermes_name_fold_v1(query) IN public.hermes_name_fold_v1(COALESCE(NULLIF(person.full_name,''),job.assignee_name)))>0))
    SELECT jsonb_build_object('count',(SELECT count(*) FROM found),
        'byStatus',(SELECT COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb) FROM (SELECT status,count(*) n FROM found GROUP BY 1) s),
        'sum','{}'::jsonb,'overdue',(SELECT count(*) FILTER (WHERE late) FROM found),
        'byBuilding',(SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',g.building_id,'buildingName',g.building_name,'count',g.n,'overdue',g.late)
            ORDER BY g.n DESC,g.building_id NULLS LAST),'[]'::jsonb) FROM (
          SELECT building_id,min(building_name) building_name,count(*) n,count(*) FILTER (WHERE late) late FROM found
          GROUP BY building_id ORDER BY count(*) DESC,building_id NULLS LAST LIMIT 50) g),
        'byAssignee',(SELECT COALESCE(jsonb_agg(jsonb_build_object('assigneeName',g.assignee_name,'count',g.n,'overdue',g.late)
            ORDER BY g.n DESC,g.assignee_name COLLATE "C" NULLS LAST),'[]'::jsonb) FROM (
          SELECT assignee_name,count(*) n,count(*) FILTER (WHERE late) late FROM found
          GROUP BY assignee_name ORDER BY count(*) DESC,assignee_name COLLATE "C" NULLS LAST LIMIT 50) g),
        'givenByMe',(SELECT jsonb_build_object('count',count(*) FILTER (WHERE given),'overdue',count(*) FILTER (WHERE given AND late)) FROM found))
      INTO v_summary;
  ELSE
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT building.id,jsonb_build_object('id',building.id,'buildingId',building.id,'name',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'total',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL),
        'occupied',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='OCCUPIED'),
        'available',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='AVAILABLE')) item
      FROM public.buildings building WHERE building.organization_id=c.organization_id AND building.deleted_at IS NULL AND building.id=ANY(buildings)
        AND (cursor_id IS NULL OR building.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(building.name,'')))>0)
      ORDER BY building.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'total',COALESCE(sum(t.total),0)::bigint,'occupied',COALESCE(sum(t.occupied),0)::bigint,
        'available',COALESCE(sum(t.available),0)::bigint) INTO v_summary FROM (
      SELECT (SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL) total,
        (SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='OCCUPIED') occupied,
        (SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='AVAILABLE') available
      FROM public.buildings building WHERE building.organization_id=c.organization_id AND building.deleted_at IS NULL AND building.id=ANY(buildings)
        AND (query='' OR position(query IN lower(COALESCE(building.name,'')))>0)) t;
  END IF;
  IF jsonb_array_length(rows)>row_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
    next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
  END IF;
  IF octet_length(rows::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,'items',rows,'nextCursor',next_cursor,'summary',v_summary);
END $fn$;

-- 2. Lõi giải tên (INVOKER, dưới RLS người hỏi; chỉ tham chiếu public.*): thân 20261024145100 + (2).
CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_scope uuid[]; v_building text; v_room text; v_type text; v_person text; v_content text; v_whole boolean:=false;
  v_self boolean:=false; v_res jsonb; v_job jsonb; v_who jsonb; v_guessed boolean:=false; v_date date; v_time time; v_deadline timestamptz;
  v_fold text; v_tfold text; v_title text; v_desc text; v_priority text; v_found jsonb; v_best integer; v_more boolean;
  v_pfold text; v_ambiguous boolean:=false; v_jfold text; v_cwords text[]; v_jwords text[]; v_twanted text;
  v_jq text; v_code text; v_hits jsonb; v_hit jsonb; v_closed boolean; v_changes jsonb;
  v_jtext text; v_jroom text; v_jroomkey text; v_jbids uuid[]:='{}'::uuid[]; v_key text; v_kid uuid;
  v_batch boolean:=false; v_common jsonb; v_who_name text; v_managed jsonb; v_items jsonb; v_item jsonb; v_out jsonb:='[]'::jsonb; v_one jsonb;
  v_i integer; v_rooms integer;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('task.create','task.create_batch','task.update','task.cancel','task.recurring_create','task.recurring_update',
    'task.recurring_pause','task.recurring_delete') OR p_ctx IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_action IN ('task.create','task.recurring_create') AND jsonb_typeof(p_params->'content') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  v_scope:=ARRAY(SELECT jsonb_array_elements_text(p_ctx->'buildingIds')::uuid);

  -- Mốc 5 (việc định kỳ). Tạo: đi CHUNG nhánh một mục của task.create bên dưới (toà / phòng / loại / người nhận / tiêu đề đúng luật,
  -- dưới RLS người hỏi), lúc trả về bỏ hạn và gắn lịch thô cho bước chuẩn bị (DEFINER) chuẩn hoá theo giờ công ty. Sửa / tạm dừng / xoá:
  -- tìm ĐÚNG MỘT quy tắc chưa xoá — mã DK-NNNN (khớp bằng, chấp nhận "dk3", "DK 0003") hoặc nội dung bỏ dấu chứa chuỗi — người hỏi
  -- thấy qua RLS và trong phạm vi toà của khoá; mơ hồ ⇒ hỏi lại kèm mã + nội dung + phòng + lịch (+ toà), KHÔNG BAO GIỜ tự chọn.
  IF p_action IN ('task.recurring_update','task.recurring_pause','task.recurring_delete') THEN
    v_jq:=NULLIF(btrim(regexp_replace(COALESCE(p_params->>'rule',''),'\s+',' ','g')),'');
    IF v_jq IS NULL THEN
      RETURN jsonb_build_object('status','unresolved','field','recurrence','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
    v_jfold:=public.hermes_name_fold_v1(v_jq);
    v_code:=upper(regexp_replace(v_jq,'[\s-]+','','g'));
    v_code:=CASE WHEN v_code ~ '^DK[0-9]{1,9}$' THEN 'DK-'||lpad(substr(v_code,3),4,'0') END;
    WITH m AS (SELECT r.id,r.code,r.title,r.building_id,r.room_id,r.assignee_id,r.version,r.paused_at,r.frequency,r.every,r.weekdays,r.month_day,
        CASE WHEN r.code=v_code THEN 1 WHEN char_length(v_jfold)>=3 AND position(v_jfold IN public.hermes_name_fold_v1(r.title))>0 THEN 2 END AS how
        FROM public.job_recurrence_rules r WHERE r.organization_id=v_org AND r.deleted_at IS NULL AND r.building_id=ANY(v_scope)),
      best AS (SELECT min(m.how) h FROM m WHERE m.how IS NOT NULL)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'code',m.code,'title',m.title,'buildingId',m.building_id,'roomId',m.room_id,
        'assigneeId',m.assignee_id,'version',m.version,'paused',m.paused_at IS NOT NULL,
        'schedule',public.job_recurrence_schedule_text_v1(m.frequency,m.every,m.weekdays,m.month_day)) ORDER BY m.code),'[]'::jsonb)
      INTO v_hits FROM m,best WHERE m.how=best.h;
    IF jsonb_array_length(v_hits)=0 THEN
      RETURN jsonb_build_object('status','unresolved','field','recurrence','wanted',left(v_jq,120),'why','not_visible','candidates','[]'::jsonb,'more',false);
    ELSIF jsonb_array_length(v_hits)>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','recurrence','wanted',left(v_jq,120),'why','ambiguous',
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name',left(format('%s · %s (%s, %s)',e->>'code',left(e->>'title',60),
              COALESCE((SELECT rm.name FROM public.rooms rm WHERE rm.id=(e->>'roomId')::uuid),'cả toà'),e->>'schedule'),120),
            'buildingName',(SELECT left(b.name,120) FROM public.buildings b WHERE b.id=(e->>'buildingId')::uuid))) ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_hits) WITH ORDINALITY y(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_hits)>8);
    END IF;
    v_hit:=v_hits->0;
    IF p_action='task.recurring_delete' THEN RETURN jsonb_build_object('status','resolved','rule',v_hit,'personMissing',false); END IF;
    IF p_action='task.recurring_pause' THEN
      -- resume=true ⇒ muốn chạy; trạng thái đã đúng như muốn ⇒ không đổi gì (hỏi lại, không ghi).
      IF COALESCE(p_params->'resume'='true'::jsonb,false)<>(v_hit->'paused'='true'::jsonb) THEN
        RETURN jsonb_build_object('status','invalid','reason','recurrence_unchanged'); END IF;
      RETURN jsonb_build_object('status','resolved','rule',v_hit,'resume',COALESCE(p_params->'resume'='true'::jsonb,false),'personMissing',false);
    END IF;
    -- task.recurring_update: ít nhất một thay đổi; người nhận mới theo đúng luật của task.update; lịch thô (bước chuẩn bị kiểm).
    v_changes:='{}'::jsonb;
    IF NULLIF(btrim(p_params->>'content'),'') IS NOT NULL THEN
      v_changes:=v_changes||jsonb_build_object('title',left(btrim(regexp_replace(p_params->>'content','\s+',' ','g')),200)); END IF;
    IF NULLIF(btrim(p_params->>'description'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('description',left(btrim(p_params->>'description'),4000)); END IF;
    IF NULLIF(p_params->>'priority','') IS NOT NULL THEN
      IF p_params->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('priority',p_params->>'priority');
    END IF;
    v_changes:=v_changes||jsonb_strip_nulls(jsonb_build_object('frequency',p_params->'frequency','every',p_params->'every','weekdays',p_params->'weekdays',
      'monthDay',p_params->'monthDay','startDate',p_params->'startDate','endDate',p_params->'endDate','dueDays',p_params->'dueDays'));
    v_person:=NULLIF(btrim(p_params->>'assigneeName'),'');
    IF v_person IS NOT NULL THEN
      v_pfold:=public.hermes_name_fold_v1(v_person);
      IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      -- Lượt 13: danh xưng trơn ("anh", "chị", "em", "a", "ảnh", "ổng", "bả", "anh ấy"…) không phải tên ⇒ hỏi giao cho ai; không thành
      -- chính người hỏi, không thành người quản lý.
      ELSIF btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$' THEN
        RETURN jsonb_build_object('status','unresolved','field','person','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false);
      ELSE
        IF v_pfold='minh' THEN v_ambiguous:=true; END IF;
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE RETURN v_who;
        END IF;
      END IF;
      v_changes:=v_changes||jsonb_build_object('assignee',v_who,'assigneeAmbiguous',v_ambiguous,
        'assigneeWanted',CASE WHEN v_ambiguous THEN left(v_person,40) END);
    END IF;
    IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    RETURN jsonb_build_object('status','resolved','rule',v_hit,'changes',jsonb_strip_nulls(v_changes),'personMissing',false);
  END IF;

  -- Mốc 3 (task.update / task.cancel): tìm ĐÚNG MỘT việc. Mã đầy đủ (mọi trạng thái); 3–4 số cuối của mã, "vừa giao"/"vừa tạo"
  -- (việc mới nhất người hỏi tạo trong 24 giờ) hoặc tiêu đề bỏ dấu chứa chuỗi — chỉ việc ĐANG MỞ. Chỉ trong việc người hỏi thấy
  -- qua RLS và trong phạm vi toà của khoá; nêu toà/phòng thì lọc thêm. Khớp nhiều ⇒ hỏi lại kèm mã + tiêu đề + phòng + người nhận
  -- (+ toà), KHÔNG BAO GIỜ tự chọn (sự cố huỷ nhầm việc cùng tên ở toà khác 21/10). Chỉ khớp việc đã xong ⇒ 'closed'.
  IF p_action IN ('task.update','task.cancel') THEN
    v_jq:=NULLIF(btrim(regexp_replace(COALESCE(p_params->>'job',''),'\s+',' ','g')),'');
    IF v_jq IS NULL THEN
      RETURN jsonb_build_object('status','unresolved','field','job','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
    v_building:=NULLIF(btrim(p_params->>'buildingName'),''); v_room:=NULLIF(btrim(p_params->>'roomName'),'');
    IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN v_room:=NULL; END IF;
    IF v_building IS NOT NULL OR v_room IS NOT NULL THEN
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;
    END IF;
    v_jfold:=public.hermes_name_fold_v1(v_jq);
    -- Lượt 12: người dùng chọn một dòng trong danh sách máy chủ đã đưa ("<mã> · <tiêu đề> (<phòng>, <người nhận>)") ⇒ lấy mã ở đầu nhãn.
    v_code:=upper(replace(COALESCE(substring(v_jq from '^([^ ·]+) · '),v_jq),' ',''));
    -- Nghiệm thu 23–24/10: người dùng hay kèm phòng / toà vào chuỗi tìm ("việc sửa vòi nước phòng 203", "… toà 111PVC"). Tách "phòng N"
    -- và tên / mã toà (trong phạm vi khoá) khỏi chuỗi khớp tiêu đề; chưa nêu riêng phòng / toà thì lọc theo phần tách ra (một toà duy
    -- nhất; phòng theo khoá phòng ở mọi toà). Bỏ "việc" đứng đầu, giới từ đứng cuối; so theo từ (bỏ dấu, dấu câu thành khoảng trắng).
    v_jroom:=substring(v_jfold from '(?:^| )(?:phong|ph|p)\.? ?([0-9]{1,4}[a-z]?)(?: |,|$)');
    v_jtext:=v_jfold;
    IF v_jroom IS NOT NULL THEN
      v_jtext:=regexp_replace(' '||v_jtext||' ',' (phong|ph|p)\.? ?'||v_jroom||'(?= |,)',' ');
      v_jroomkey:=public.hermes_room_key_v1(v_jroom);
    END IF;
    v_jtext:=btrim(regexp_replace(regexp_replace(v_jtext,'[^a-z0-9]+',' ','g'),' +',' ','g'));
    FOR v_key,v_kid IN SELECT x.k,x.id FROM (SELECT DISTINCT b.id,kk.k FROM public.buildings b
        CROSS JOIN LATERAL (SELECT btrim(regexp_replace(public.hermes_name_fold_v1(b.name),'[^a-z0-9]+',' ','g')) k
          UNION SELECT btrim(regexp_replace(public.hermes_name_fold_v1(a.alias),'[^a-z0-9]+',' ','g'))
            FROM unnest(string_to_array(COALESCE(b.code,''),',')) a(alias)) kk
        WHERE b.organization_id=v_org AND b.id=ANY(v_scope) AND b.deleted_at IS NULL AND char_length(kk.k)>=3
          AND position(' '||kk.k||' ' IN ' '||v_jtext||' ')>0) x ORDER BY char_length(x.k) DESC,x.k LOOP
      v_jtext:=btrim(replace(replace(' '||v_jtext||' ',' toa nha '||v_key||' ',' '),' toa '||v_key||' ',' '));
      v_jtext:=btrim(replace(' '||v_jtext||' ',' '||v_key||' ',' '));
      IF NOT v_kid=ANY(v_jbids) THEN v_jbids:=v_jbids||v_kid; END IF;
    END LOOP;
    v_jtext:=btrim(regexp_replace(v_jtext,'^((cai|cong) )?viec( |$)',''));
    v_jtext:=btrim(regexp_replace(v_jtext,'( (o|tai|cua|trong|toa|phong))+$',''));
    -- Phần tách ra là một cách khớp THÊM (tiêu đề chứa phần chữ còn lại + đúng phòng / toà tách được); luật cũ (cả chuỗi nằm trong
    -- tiêu đề) giữ nguyên — việc "cả toà" có ghi phòng trong tiêu đề vẫn tìm được.
    WITH c AS (SELECT j.id,j.code,j.title,j.status,j.building_id,j.room_id,j.assignee_id,j.deadline,j.created_at,j.user_id,
          (v_room IS NOT NULL OR v_jroomkey IS NULL OR v_jroomkey='' OR EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=j.room_id
            AND (public.hermes_room_key_v1(r.name)=v_jroomkey OR EXISTS(SELECT 1 FROM unnest(string_to_array(COALESCE(r.code,''),',')) a(alias)
              WHERE btrim(a.alias)<>'' AND public.hermes_room_key_v1(a.alias)=v_jroomkey))))
          AND (v_building IS NOT NULL OR cardinality(v_jbids)<>1 OR j.building_id=v_jbids[1]) AS at_place
        FROM public.jobs j WHERE j.organization_id=v_org AND j.building_id=ANY(v_scope)
          AND (v_res IS NULL OR j.building_id=(v_res#>>'{building,id}')::uuid)
          AND (v_res IS NULL OR jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' OR j.room_id IS NOT DISTINCT FROM (v_res#>>'{room,id}')::uuid)),
    m AS (SELECT c.*,CASE
        WHEN upper(COALESCE(c.code,''))=v_code THEN 1
        WHEN v_jq ~ '^[0-9]{3,4}$' AND right(COALESCE(c.code,''),4)=lpad(v_jq,4,'0') THEN 2
        WHEN v_jfold IN ('vua giao','vua tao','viec vua giao','viec vua tao','viec moi giao','viec moi tao') AND c.user_id=auth.uid()
          AND c.created_at>clock_timestamp()-interval '24 hours' THEN 3
        WHEN char_length(v_jfold)>=3 AND position(v_jfold IN public.hermes_name_fold_v1(COALESCE(c.title,'')))>0 THEN 4
        WHEN (v_jroomkey<>'' OR cardinality(v_jbids)>0) AND c.at_place AND char_length(v_jtext)>=3
          AND position(v_jtext IN btrim(regexp_replace(public.hermes_name_fold_v1(COALESCE(c.title,'')),'[^a-z0-9]+',' ','g')))>0 THEN 4
        WHEN v_jtext='' AND (v_jroomkey<>'' OR cardinality(v_jbids)=1) AND c.at_place THEN 4 END AS how FROM c),
    best AS (SELECT min(m.how) h FROM m WHERE m.how=1 OR (m.how IS NOT NULL AND m.status='IN_PROGRESS')),
    hit AS (SELECT m.* FROM m,best WHERE m.how=best.h AND (m.how=1 OR m.status='IN_PROGRESS')
        AND (m.how<>3 OR m.created_at=(SELECT max(x.created_at) FROM m x WHERE x.how=3 AND x.status='IN_PROGRESS')))
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hit.id,'code',hit.code,'title',hit.title,'status',hit.status,'buildingId',hit.building_id,
          'roomId',hit.room_id,'assigneeId',hit.assignee_id,'deadline',hit.deadline,'how',hit.how) ORDER BY hit.created_at DESC,hit.id) FROM hit),'[]'::jsonb),
      COALESCE((SELECT bool_or(m.status IS DISTINCT FROM 'IN_PROGRESS') FROM m WHERE m.how IS NOT NULL),false)
      INTO v_hits,v_closed;
    IF jsonb_array_length(v_hits)=0 THEN
      IF v_closed THEN RETURN jsonb_build_object('status','closed'); END IF;
      RETURN jsonb_build_object('status','unresolved','field','job','wanted',left(v_jq,120),'why','not_visible','candidates','[]'::jsonb,'more',false);
    ELSIF jsonb_array_length(v_hits)>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','job','wanted',left(v_jq,120),'why','ambiguous',
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name',left(format('%s · %s (%s, %s)',COALESCE(e->>'code','—'),left(e->>'title',60),
              COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=(e->>'roomId')::uuid),'cả toà'),
              COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id=(e->>'assigneeId')::uuid),'chưa giao')),120),
            'buildingName',(SELECT left(b.name,120) FROM public.buildings b WHERE b.id=(e->>'buildingId')::uuid))) ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_hits) WITH ORDINALITY y(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_hits)>8);
    END IF;
    v_hit:=v_hits->0;
    IF v_hit->>'status' IS DISTINCT FROM 'IN_PROGRESS' THEN RETURN jsonb_build_object('status','closed','jobId',v_hit->'id'); END IF;
    IF p_action='task.cancel' THEN RETURN jsonb_build_object('status','resolved','job',v_hit,'personMissing',false); END IF;
    -- task.update: ít nhất một thay đổi. Người nhận mới theo đúng luật của task.create (token tự xưng rõ ràng ⇒ chính mình; mình/anh/
    -- chị/em/tên chính mình ⇒ giải tên + cờ mơ hồ). Hạn: ngày/giờ thô — bước chuẩn bị (DEFINER) tính theo múi giờ công ty.
    v_changes:='{}'::jsonb;
    IF NULLIF(btrim(p_params->>'note'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('note',left(btrim(p_params->>'note'),1000)); END IF;
    IF NULLIF(btrim(p_params->>'content'),'') IS NOT NULL THEN
      v_changes:=v_changes||jsonb_build_object('title',left(btrim(regexp_replace(p_params->>'content','\s+',' ','g')),200)); END IF;
    IF NULLIF(btrim(p_params->>'description'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('description',left(btrim(p_params->>'description'),4000)); END IF;
    IF NULLIF(p_params->>'priority','') IS NOT NULL THEN
      IF p_params->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('priority',p_params->>'priority');
    END IF;
    IF jsonb_typeof(p_params->'deadline')='string' THEN
      IF p_params->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('deadlineDate',p_params->>'deadline');
    END IF;
    IF jsonb_typeof(p_params->'deadlineTime')='string' THEN
      IF p_params->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('deadlineTime',p_params->>'deadlineTime');
    END IF;
    v_person:=NULLIF(btrim(p_params->>'assigneeName'),'');
    IF v_person IS NOT NULL THEN
      v_pfold:=public.hermes_name_fold_v1(v_person);
      IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      -- Lượt 13: danh xưng trơn ("anh", "chị", "em", "a", "ảnh", "ổng", "bả", "anh ấy"…) không phải tên ⇒ hỏi giao cho ai; không thành
      -- chính người hỏi, không thành người quản lý.
      ELSIF btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$' THEN
        RETURN jsonb_build_object('status','unresolved','field','person','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false);
      ELSE
        IF v_pfold='minh' THEN v_ambiguous:=true; END IF;
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE RETURN v_who;
        END IF;
      END IF;
      v_changes:=v_changes||jsonb_build_object('assignee',v_who,'assigneeAmbiguous',v_ambiguous,
        'assigneeWanted',CASE WHEN v_ambiguous THEN left(v_person,40) END);
    END IF;
    IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    RETURN jsonb_build_object('status','resolved','job',v_hit,'changes',jsonb_strip_nulls(v_changes),'personMissing',false);
  END IF;
  -- Mốc 4 (task.create_batch): mỗi mục chạy ĐÚNG luật của task.create ở dưới (giải tên, đoán loại, người nhận, hạn, tiêu đề) dưới RLS
  -- người hỏi. Mục = giá trị chung (buildingName, jobType, content, description, assigneeName, deadline, deadlineTime, priority) đè bởi giá
  -- trị riêng của mục ("toà X, mỗi phòng một việc" chỉ nêu toà một lần); chuỗi trống = không nêu. buildingsManagedBy thay items: chỉ giải người ở đây và MỘT mẫu không toà (người nhận trống =
  -- chính người đó); bước chuẩn bị (DEFINER) trải mẫu ra mọi toà người đó quản lý trong phạm vi khoá. Mục đầu tiên chưa giải được
  -- ⇒ trả kết quả đó kèm số mục (item, đếm từ 1).
  v_batch:=p_action='task.create_batch';
  IF v_batch THEN
    v_common:=(SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) FROM jsonb_each(p_params) e
      WHERE e.key IN ('buildingName','jobType','content','description','assigneeName','deadline','deadlineTime','priority')
        AND jsonb_typeof(e.value)<>'null' AND NOT (jsonb_typeof(e.value)='string' AND btrim(e.value#>>'{}')=''));
    v_who_name:=NULLIF(btrim(COALESCE(p_params->>'buildingsManagedBy','')),'');
    -- Lượt 14 (nghiệm thu: "toà 102LVT, mỗi phòng một việc" ⇒ bot phải hỏi xin danh sách phòng): perRoom=true + buildingName (không items,
    -- không buildingsManagedBy) = mỗi phòng chưa xoá của toà mà người hỏi thấy (RLS) một mục, theo tên phòng. > 20 phòng ⇒ batch_too_large
    -- kèm số phòng thật (rooms) để bot đề nghị chia lô; toà không có phòng ⇒ hỏi lại phòng.
    IF p_params->'perRoom'='true'::jsonb THEN
      IF NOT (v_common ? 'buildingName') OR jsonb_typeof(p_params->'items')='array' OR v_who_name IS NOT NULL THEN
        RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('building',v_common->>'buildingName'));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;
      SELECT count(*)::integer,COALESCE(jsonb_agg(v_common||jsonb_build_object('roomName',r.name) ORDER BY r.name,r.id),'[]'::jsonb)
        INTO v_rooms,v_items FROM public.rooms r
        WHERE r.organization_id=v_org AND r.building_id=(v_res#>>'{building,id}')::uuid AND r.deleted_at IS NULL AND btrim(COALESCE(r.name,''))<>'';
      IF v_rooms=0 THEN
        RETURN jsonb_build_object('status','unresolved','field','room','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
      IF v_rooms>20 THEN RETURN jsonb_build_object('status','invalid','reason','batch_too_large','rooms',v_rooms); END IF;
    ELSIF (jsonb_typeof(p_params->'items') IS NOT DISTINCT FROM 'array') = (v_who_name IS NOT NULL) THEN
      RETURN jsonb_build_object('status','invalid','reason','invalid_params');
    ELSIF v_who_name IS NULL THEN
      IF jsonb_array_length(p_params->'items')=0 THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      IF jsonb_array_length(p_params->'items')>20 THEN RETURN jsonb_build_object('status','invalid','reason','batch_too_large'); END IF;
      SELECT jsonb_agg(v_common||COALESCE((SELECT jsonb_object_agg(f.key,f.value)
          FROM jsonb_each(CASE WHEN jsonb_typeof(x.e)='object' THEN x.e ELSE '{}'::jsonb END) f
          WHERE f.key IN ('buildingName','roomName','jobType','content','description','assigneeName','deadline','deadlineTime','priority')
            AND jsonb_typeof(f.value)<>'null' AND NOT (jsonb_typeof(f.value)='string' AND btrim(f.value#>>'{}')='')),'{}'::jsonb) ORDER BY x.ord)
        INTO v_items FROM jsonb_array_elements(p_params->'items') WITH ORDINALITY x(e,ord);
    ELSE
      -- buildingsManagedBy = mọi toà người đó quản lý: nêu thêm một toà là mâu thuẫn ⇒ invalid_params (không lặng lẽ bỏ).
      IF v_common ? 'buildingName' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_who_name));
      IF v_who->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_who; END IF;
      v_managed:=v_who->'person';
      v_items:=jsonb_build_array(v_common||jsonb_build_object('_template',true)
        ||CASE WHEN v_common ? 'assigneeName' THEN '{}'::jsonb ELSE jsonb_build_object('_assignee',v_managed) END);
    END IF;
  ELSE
    v_items:=jsonb_build_array(p_params);
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_items)-1 LOOP
    v_item:=v_items->v_i;
    v_whole:=false; v_self:=false; v_res:=NULL; v_job:=NULL; v_who:=NULL; v_guessed:=false; v_date:=NULL; v_time:=NULL;
    v_ambiguous:=false; v_twanted:=NULL; v_found:=NULL; v_one:=NULL;
    <<one>>
    BEGIN
      v_building:=NULLIF(btrim(v_item->>'buildingName'),''); v_room:=NULLIF(btrim(v_item->>'roomName'),'');
      v_type:=NULLIF(btrim(v_item->>'jobType'),''); v_person:=NULLIF(btrim(v_item->>'assigneeName'),'');
      v_content:=btrim(regexp_replace(v_item->>'content','\s+',' ','g'));
      IF COALESCE(v_content,'')='' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
      IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN
        v_room:=NULL; v_whole:=true; END IF;
      IF v_item ? '_template' THEN
        v_res:=jsonb_build_object('status','resolved'); v_room:=NULL; v_whole:=true;
      ELSE
      IF v_building IS NULL AND v_room IS NULL THEN
        v_one:=jsonb_build_object('status','unresolved','field','building','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); EXIT one; END IF;
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN v_one:=v_res; EXIT one; END IF;
      END IF;

      -- Loại việc (Mốc 2c, bot thật trên TEST 22/10): nêu tên khớp đúng một loại ⇒ dùng. Không khớp (mô hình hay tự đặt "Bảo trì",
      -- "Dọn vệ sinh", "kiểm tra điện"…) ⇒ coi như CHƯA nêu và tự suy theo nội dung + chính chuỗi đó, chấm điểm trên các loại đang bật
      -- mà người hỏi thấy được (RLS): 95 chuỗi loại bỏ khoảng trắng trùng tên loại ("ve sinh" ~ "vesinh") > 90 đầu nội dung (như ô gõ
      -- nhanh của web) > 80 chuỗi loại chứa tên loại > 70 đồng nghĩa trong chuỗi loại > 60 nội dung chứa tên loại > 50 đồng nghĩa trong
      -- nội dung; cùng mức thì tên dài hơn thắng. Đúng một loại điểm cao nhất ⇒ dùng + cờ đoán (luôn xem trước). Không suy được hoặc
      -- hoà ⇒ hỏi lại kèm tối đa 5 gợi ý xếp theo độ gần (điểm, rồi tiền tố chung dài nhất với một từ), không chọn bừa. Đồng nghĩa chỉ
      -- trỏ tới tên loại (bỏ dấu, bỏ khoảng trắng) có trong danh mục thật; công ty không có loại đó thì dòng tự bỏ qua. Lượt 12: thêm 92
      -- chuỗi loại mở đầu bằng tên loại; loại được NÊU rõ (tên hoặc cụm đồng nghĩa đứng đầu) không còn là đoán (xem dưới).
      IF v_type IS NOT NULL THEN
        v_job:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('jobType',v_type));
        IF v_job->>'status'='resolved' THEN v_job:=v_job->'jobType'; END IF;
      END IF;
      IF v_type IS NULL OR v_job ? 'status' THEN
        -- So theo từ: bỏ dấu (hàm dùng chung) rồi mọi ký tự không phải chữ/số thành một khoảng trắng ("nước," = "nuoc").
        v_fold:=btrim(regexp_replace(public.hermes_name_fold_v1(v_content),'[^a-z0-9]+',' ','g'));
        v_jfold:=CASE WHEN v_type IS NULL THEN '' ELSE btrim(regexp_replace(public.hermes_name_fold_v1(v_type),'[^a-z0-9]+',' ','g')) END;
        v_cwords:=string_to_array(v_fold,' ');
        v_jwords:=CASE WHEN v_jfold='' THEN '{}'::text[] ELSE string_to_array(v_jfold,' ') END;
        WITH syn(p,kc) AS (VALUES ('sua chua','sua'),('sua sang','sua'),('bao tri','sua'),('bao duong','sua'),('khac phuc','sua'),
            ('hu hong','sua'),('bi hu','sua'),('hong','sua'),('lap dat','sua'),('dieu chinh','sua'),
            ('kiem tra','check'),('ra soat','check'),('kiem dinh','check'),('xem xet','check'),
            ('nhan phong','checkin'),('ky hop dong','checkin'),('lam hop dong','checkin'),('dan khach','checkin'),
            ('don dep','vesinh'),('don phong','vesinh'),('don ve sinh','vesinh'),('don rac','vesinh'),('lau chui','vesinh'),('lau don','vesinh'),
            ('quet don','vesinh'),('quet rac','vesinh'),('chui rua','vesinh'),('ve sinh','vesinh'),
            ('don dep','ve'),('don phong','ve'),('don ve sinh','ve'),('lau chui','ve'),('quet don','ve'),('chui rua','ve'),
            ('thay the','thay'),('thay moi','thay'),('doi moi','thay'),
            ('mua sam','mua'),('dat mua','mua'),
            ('giat ui','giat'),('giat say','giat'),('giat giu','giat'),
            ('thong tac','thong'),('thong cong','thong'),('tac nghen','thong'),('bi tac','thong'),('nghet','thong'),
            ('trang tri','decor'),('bai tri','decor'),
            ('tang ca','ot'),('ngoai gio','ot'),('thu tien','ot')),
        t AS (SELECT j.id,j.name,btrim(regexp_replace(public.hermes_name_fold_v1(j.name),'[^a-z0-9]+',' ','g')) k
          FROM public.job_types j WHERE j.organization_id=v_org AND COALESCE(j.is_active,true) AND btrim(COALESCE(j.name,''))<>''
            AND NOT public.job_type_building_like_v1(v_org,j.name)),
        u AS (SELECT t.id,t.name,t.k,replace(t.k,' ','') kc FROM t),
        s AS (SELECT u.id,u.name,u.kc,CASE
            WHEN u.kc='' THEN 0
            WHEN v_jfold<>'' AND replace(v_jfold,' ','')=u.kc THEN 95
            WHEN v_jfold<>'' AND (left(v_jfold,char_length(u.k)+1)=u.k||' ' OR v_jwords[1]||COALESCE(v_jwords[2],'')=u.kc
              OR v_jwords[1]||COALESCE(v_jwords[2],'')||COALESCE(v_jwords[3],'')=u.kc) THEN 92
            WHEN v_fold=u.k OR left(v_fold,char_length(u.k)+1)=u.k||' ' OR v_cwords[1]||COALESCE(v_cwords[2],'')=u.kc
              OR v_cwords[1]||COALESCE(v_cwords[2],'')||COALESCE(v_cwords[3],'')=u.kc THEN 90
            WHEN v_jfold<>'' AND (position(' '||u.k||' ' IN ' '||v_jfold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_jwords)) i
              WHERE v_jwords[i]||COALESCE(v_jwords[i+1],'')=u.kc OR v_jwords[i]||COALESCE(v_jwords[i+1],'')||COALESCE(v_jwords[i+2],'')=u.kc)) THEN 80
            WHEN v_jfold<>'' AND EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_jfold||' ')>0) THEN 70
            WHEN position(' '||u.k||' ' IN ' '||v_fold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_cwords)) i
              WHERE v_cwords[i]||COALESCE(v_cwords[i+1],'')=u.kc OR v_cwords[i]||COALESCE(v_cwords[i+1],'')||COALESCE(v_cwords[i+2],'')=u.kc) THEN 60
            WHEN EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_fold||' ')>0) THEN 50
            ELSE 0 END AS base,
            EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND (v_fold=syn.p OR left(v_fold,char_length(syn.p)+1)=syn.p||' '
              OR v_jfold=syn.p OR left(v_jfold,char_length(syn.p)+1)=syn.p||' ')) AS lead FROM u),
        r AS (SELECT s.id,s.name,CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE 0 END AS score,
            CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE
              (SELECT COALESCE(max(n),0) FROM unnest(v_cwords||v_jwords) w(x),generate_series(2,least(char_length(w.x),char_length(s.kc))) n
                WHERE left(w.x,n)=left(s.kc,n)) END AS rank,
            EXISTS(SELECT 1 FROM public.jobs x WHERE x.organization_id=v_org AND x.job_type_id=s.id) AS used,s.lead,s.kc FROM s)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'score',r.score,'used',r.used,'lead',r.lead,'kc',r.kc) ORDER BY r.rank DESC,r.name,r.id),'[]'::jsonb)
          INTO v_found FROM r;
        v_best:=COALESCE((v_found->0->>'score')::int,0);
        IF v_best>=5000 AND (jsonb_array_length(v_found)=1 OR (v_found->1->>'score')::int<v_best) THEN
          -- Lượt 12 (nghiệm thu sau C1): KHÔNG phải đoán (không cờ, không xem trước vì loại, lô không cảnh báo) khi loại duy nhất điểm cao
          -- nhất được NÊU rõ: chuỗi loại trùng tên loại bỏ dấu / hoa thường / dấu câu / khoảng trắng (95: "ve sinh" = "vesinh"); hoặc chuỗi
          -- loại mở đầu bằng tên loại (92: "sửa vòi nước"), nội dung mở đầu bằng tên loại (90, như cú pháp "<loại> <mô tả>" của ô gõ nhanh
          -- web), nội dung / chuỗi loại mở đầu bằng cụm đồng nghĩa trỏ tới loại đó ("Kiểm tra điện" → check) — ba trường hợp sau chỉ khi
          -- chuỗi loại không trỏ sang loại KHÁC (không loại nào khác ở mức 80 / 70, trừ loại có tên nằm lọt trong tên loại đứng đầu:
          -- "vệ" trong "vệ sinh"). Từ giữa nội dung vẫn là đoán (luôn xem trước).
          v_job:=jsonb_build_object('id',v_found->0->'id','name',v_found->0->'name'); v_twanted:=v_type;
          v_guessed:=NOT (v_best>=9500 OR ((v_best>=9000 OR v_found->0->'lead'='true'::jsonb) AND NOT EXISTS(SELECT 1
            FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord) WHERE y.ord>1 AND (y.e->>'score')::int BETWEEN 7000 AND 8999
              AND strpos(v_found->0->>'kc',y.e->>'kc')=0)));
        ELSIF jsonb_array_length(v_found)=0 AND v_type IS NOT NULL THEN
          v_one:=v_job; EXIT one;  -- không thấy loại nào (vd thiếu task_types.view): giữ nguyên kết quả hàm giải tên, không gợi ý
        ELSE
          -- Nghiệm thu: gợi ý không nêu loại chưa từng dùng mà cũng không có điểm (danh mục production có "ml", "thông": 0 việc).
          v_one:=jsonb_build_object('status','unresolved','field','jobType','wanted','','why','unspecified',
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',f.e->'name') ORDER BY f.n),'[]'::jsonb) FROM (
                SELECT y.e,row_number() OVER (ORDER BY y.ord) n FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord)
                WHERE y.e->'used'='true'::jsonb OR (y.e->>'score')::int>0) f WHERE f.n<=5),
            'more',(SELECT count(*) FROM jsonb_array_elements(v_found) e WHERE e->'used'='true'::jsonb OR (e->>'score')::int>0)>5); EXIT one;
        END IF;
      END IF;

      -- Người nhận (review Mốc 2, chặn 1): chỉ từ KHÔNG thể là tên người mới hiểu là chính người hỏi (lượt 13: tự giao LUÔN xem trước). "mình", "anh",
      -- "chị", "em" có thể là tên (Minh, Anh…) ⇒ qua hàm giải tên (hồ sơ thấy được + thành viên ACTIVE); không thấy ai tên như vậy
      -- thì hiểu là chính người hỏi nhưng cờ mơ hồ ⇒ LUÔN xem trước. Tên giải ra đúng người hỏi cũng tính là mơ hồ. Trống ⇒ Q31.
      IF v_person IS NOT NULL THEN
        v_pfold:=public.hermes_name_fold_v1(v_person);
        IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN v_self:=true; v_person:=NULL;
        -- Lượt 13 (nghiệm thu: bot gửi "anh" / "tôi" khi người dùng không tự giao): danh xưng trơn ("anh", "chị", "em", "a", "ảnh", "ổng",
        -- "bả", "anh ấy"…) không phải tên ⇒ hỏi giao cho ai; không thành chính người hỏi, không thành người quản lý (Q31).
        ELSIF btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$' THEN
          v_one:=jsonb_build_object('status','unresolved','field','person','wanted','','why','unspecified',
            'candidates','[]'::jsonb,'more',false); EXIT one;
        ELSIF v_pfold='minh' THEN v_ambiguous:=true; END IF;
      END IF;
      IF v_person IS NOT NULL THEN
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE
          -- Lượt 12: tên mơ hồ (nhiều người) ở task.create ⇒ kèm id ứng viên (mỗi tên giải lại đúng một người dưới RLS người hỏi; tên
          -- trùng hẳn nhau thì bỏ) để bước chuẩn bị ghi lời mời chọn như Q31. Khoá 'offer' không ra khỏi bước chuẩn bị.
          IF NOT v_batch AND p_action='task.create' AND v_who->>'why'='ambiguous' THEN
            v_who:=v_who||jsonb_build_object('offer',jsonb_build_object('buildingId',v_res#>'{building,id}','ids',
              (SELECT COALESCE(jsonb_agg(x.id ORDER BY x.ord),'[]'::jsonb) FROM (SELECT c.ord,public.hermes_write_name_resolve_v1(v_org,v_scope,
                  jsonb_build_object('person',c.e->>'name'))#>'{person,id}' AS id FROM jsonb_array_elements(v_who->'candidates') WITH ORDINALITY c(e,ord)) x
                WHERE jsonb_typeof(x.id)='string')));
          END IF;
          v_one:=v_who; EXIT one;
        END IF;
      ELSIF v_self THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      ELSIF jsonb_typeof(v_item->'_assignee')='object' THEN
        v_who:=v_item->'_assignee';
      END IF;

      -- Hạn (Q30): trống ⇒ hết ngày mai giờ công ty; đã qua ⇒ hỏi lại.
      IF jsonb_typeof(v_item->'deadline')='string' THEN
        IF v_item->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
        v_date:=(v_item->>'deadline')::date;
      END IF;
      IF jsonb_typeof(v_item->'deadlineTime')='string' THEN
        IF v_item->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
        v_time:=(v_item->>'deadlineTime')::time;
      END IF;
      v_deadline:=public.job_deadline_v1(v_org,v_date,v_time);
      IF v_deadline IS NULL OR v_deadline<=clock_timestamp() THEN v_one:=jsonb_build_object('status','invalid','reason','date_out_of_range'); EXIT one; END IF;

      -- Tiêu đề như web: "<loại> <nội dung>", bỏ lặp nếu nội dung đã mở đầu bằng tên loại.
      v_fold:=public.hermes_name_fold_v1(v_content); v_tfold:=public.hermes_name_fold_v1(v_job->>'name');
      v_title:=CASE WHEN v_tfold='' OR v_fold=v_tfold OR left(v_fold,char_length(v_tfold)+1)=v_tfold||' ' THEN v_content
        ELSE btrim(v_job->>'name')||' '||v_content END;
      v_title:=left(btrim(regexp_replace(v_title,'\s+',' ','g')),200);
      v_desc:=COALESCE(NULLIF(btrim(v_item->>'description'),''),v_content);
      v_priority:=COALESCE(NULLIF(v_item->>'priority',''),'NORMAL');
      IF v_priority NOT IN ('NORMAL','LOW','URGENT') THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
      v_one:=jsonb_build_object('status','resolved','building',v_res->'building','room',v_res->'room',
        'wholeBuilding',v_whole AND v_room IS NULL AND jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object',
        'roomMissing',jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' AND NOT v_whole,
        'jobType',v_job,'jobTypeGuessed',v_guessed,'jobTypeWanted',left(v_twanted,60),'person',v_who,'personMissing',v_who IS NULL,
        'personAmbiguous',v_ambiguous,'personWanted',CASE WHEN v_ambiguous THEN left(btrim(v_item->>'assigneeName'),40) END,
        'deadline',v_deadline,'deadlineDefaulted',v_date IS NULL,'title',v_title,'description',v_desc,'priority',v_priority); EXIT one;
    END one;
    IF v_one->>'status' IS DISTINCT FROM 'resolved' THEN
      RETURN CASE WHEN v_batch THEN v_one||jsonb_build_object('item',v_i+1) ELSE v_one END;
    END IF;
    v_out:=v_out||jsonb_build_array(v_one);
  END LOOP;
  IF NOT v_batch AND p_action='task.recurring_create' THEN
    RETURN ((v_out->0)-'deadline'-'deadlineDefaulted')||jsonb_build_object('schedule',jsonb_strip_nulls(jsonb_build_object('frequency',p_params->'frequency',
      'every',p_params->'every','weekdays',p_params->'weekdays','monthDay',p_params->'monthDay','startDate',p_params->'startDate',
      'endDate',p_params->'endDate','dueDays',p_params->'dueDays')));
  END IF;
  IF NOT v_batch THEN RETURN v_out->0; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('status','resolved','batch',true,'items',v_out,'personMissing',false,'managedBy',v_managed));
END $fn$;

-- 3. Chuẩn bị lô (DEFINER): thân 20261024145100 + số phòng của (2).
CREATE OR REPLACE FUNCTION app_private.hermes_task_batch_prepare_v1(p_binding jsonb,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v_tz text; v_receipt app_private.hermes_action_receipts; v_items jsonb; v jsonb; v_tpl jsonb;
  v_scope uuid[]; v_managed uuid[]; v_person uuid; v_locks uuid[]; v_lock uuid; v_i integer; v_n integer;
  v_building uuid; v_room uuid; v_type uuid; v_assignee uuid; v_deadline timestamptz;
  v_building_name text; v_room_name text; v_type_name text; v_assignee_name text; v_dups jsonb; v_manages boolean; v_org_locked boolean:=false;
  v_bases text[]:='{}'; v_basis text; v_rows jsonb:='[]'::jsonb; v_jobs jsonb:='[]'::jsonb; v_lines text[]:='{}'; v_keys text[]:='{}'; v_key text;
  v_guessed text[]:='{}'; v_noroom text[]:='{}'; v_ambiguous text[]:='{}'; v_dup text[]:='{}'; v_twin text[]:='{}'; v_unmanaged text[]:='{}';
  v_assignees uuid[]:='{}'; v_quota text; v_begin jsonb; v_warnings jsonb:='[]'::jsonb; v_text text; v_who text; v_when text; v_self text[]:='{}';
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR jsonb_typeof(p_resolved->'items') IS DISTINCT FROM 'array'
      OR p_expected_basis IS NULL))
    OR (p_phase<>'apply' AND (p_resolution IS NULL OR jsonb_typeof(p_resolution)<>'object')) THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,'task.create_batch');
  v_org:=(ctx->>'organizationId')::uuid; v_actor:=auth.uid(); v_tz:=app_private.org_timezone_v1(v_org);
  v_scope:=ARRAY(SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid);
  -- requestId đã có biên nhận ⇒ phát lại (hoặc xung đột) TRƯỚC mọi quyết định khác, như task.create.
  IF p_phase<>'preview' THEN
    SELECT * INTO v_receipt FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=v_actor AND r.request_id=p_request_id;
    IF FOUND THEN
      IF v_receipt.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
      IF v_receipt.action IS DISTINCT FROM 'task.create_batch' OR v_receipt.input->'params' IS DISTINCT FROM p_params THEN
        RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_receipt.state='started' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      RETURN jsonb_build_object('kind','replay','outcome',v_receipt.result);
    END IF;
  END IF;
  IF p_phase='apply' THEN
    v_items:=p_resolved->'items';
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb),
      'item',p_resolution->'item'));
  ELSIF p_resolution->>'status'='invalid' AND p_resolution->>'reason' IN ('date_out_of_range','invalid_params','batch_too_large') THEN
    -- Lượt 14: perRoom quá 20 phòng ⇒ kèm số phòng thật của toà (rooms) cho câu "chia lô".
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','needs_input','reason',p_resolution->>'reason','item',p_resolution->'item',
      'rooms',CASE WHEN p_resolution->>'reason'='batch_too_large' AND jsonb_typeof(p_resolution->'rooms')='number' THEN p_resolution->'rooms' END));
  ELSIF p_resolution->>'status' IS DISTINCT FROM 'resolved' OR p_resolution->'batch' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_resolution->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_resolution->'items') NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  ELSE
    SELECT jsonb_agg(jsonb_build_object('buildingId',x.e#>'{building,id}','roomId',COALESCE(x.e#>'{room,id}','null'::jsonb),
        'roomMissing',x.e->'roomMissing','jobTypeId',x.e#>'{jobType,id}','jobTypeGuessed',x.e->'jobTypeGuessed',
        'assigneeId',COALESCE(x.e#>'{person,id}','null'::jsonb),'assigneeAmbiguous',COALESCE(x.e->'personAmbiguous','false'::jsonb),
        'deadline',x.e->'deadline','deadlineDefaulted',x.e->'deadlineDefaulted','title',x.e->'title','description',x.e->'description',
        'priority',x.e->'priority') ORDER BY x.o)
      INTO v_items FROM jsonb_array_elements(p_resolution->'items') WITH ORDINALITY x(e,o);
    -- Lô không đề xuất người quản lý như Q31 của một việc: mục chưa có người nhận ⇒ hỏi lại (kèm số mục).
    SELECT min(x.o) INTO v_n FROM jsonb_array_elements(v_items) WITH ORDINALITY x(e,o) WHERE jsonb_typeof(x.e->'assigneeId') IS DISTINCT FROM 'string';
    IF v_n IS NOT NULL THEN
      RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','person','wanted','','why','unspecified',
        'candidates','[]'::jsonb,'more',false,'item',v_n); END IF;
    IF jsonb_typeof(p_resolution->'managedBy')='object' THEN
      -- buildingsManagedBy: trải mẫu (mục duy nhất, không toà) ra mọi toà người đó quản lý trong phạm vi khoá, cả toà, theo tên toà.
      BEGIN v_person:=(p_resolution#>>'{managedBy,id}')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END;
      IF jsonb_array_length(v_items)<>1 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
      v_managed:=app_private.hermes_task_managed_buildings_v1(v_org,v_person,v_scope);
      IF cardinality(v_managed)=0 THEN
        RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','building','wanted','','why','unspecified',
          'candidates','[]'::jsonb,'more',false); END IF;
      IF cardinality(v_managed)>20 THEN RETURN jsonb_build_object('kind','needs_input','reason','batch_too_large'); END IF;
      v_tpl:=v_items->0;
      SELECT jsonb_agg(v_tpl||jsonb_build_object('buildingId',u.b,'roomId',NULL,'roomMissing',false) ORDER BY u.o)
        INTO v_items FROM unnest(v_managed) WITH ORDINALITY u(b,o);
    END IF;
  END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_n:=jsonb_array_length(v_items);
  -- Lượt có thể ghi: khoá (công ty, toà) TRƯỚC khi tính việc trùng, như task.create; theo thứ tự id toà để hai lô chồng toà không
  -- khoá chéo nhau. Khoá giữ tới hết giao dịch ghi.
  BEGIN
    v_locks:=ARRAY(SELECT DISTINCT (e->>'buildingId')::uuid FROM jsonb_array_elements(v_items) e ORDER BY 1);
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END;
  IF p_phase<>'preview' THEN
    FOREACH v_lock IN ARRAY v_locks LOOP
      IF v_lock IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_dup:'||v_org::text||':'||v_lock::text,0)); END IF;
    END LOOP;
  END IF;
  FOR v_i IN 0..v_n-1 LOOP
    v:=v_items->v_i;
    -- Bản đã giải (lượt 1 hay đưa lại ở lượt 2) phải còn đúng phạm vi hiện tại của khoá.
    BEGIN
      v_building:=(v->>'buildingId')::uuid; v_room:=(v->>'roomId')::uuid; v_type:=(v->>'jobTypeId')::uuid;
      v_assignee:=(v->>'assigneeId')::uuid; v_deadline:=(v->>'deadline')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
    END;
    IF v_building IS NULL OR v_type IS NULL OR v_assignee IS NULL OR v_deadline IS NULL
      OR jsonb_typeof(v->'title') IS DISTINCT FROM 'string' OR char_length(v->>'title') NOT BETWEEN 1 AND 200 OR v->>'title' ~ '[\x01-\x1f\x7f]'
      OR jsonb_typeof(v->'description') IS DISTINCT FROM 'string' OR char_length(v->>'description')>4000
      OR v->>'priority' IS NULL OR v->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    IF NOT (v_building=ANY(v_scope)) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id=v_building AND b.organization_id=v_org AND b.deleted_at IS NULL
      AND NOT COALESCE(b.is_virtual,false);
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_room_name:=NULL;
    IF v_room IS NOT NULL THEN
      SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id=v_room AND r.building_id=v_building AND r.deleted_at IS NULL;
      IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    END IF;
    SELECT j.name INTO v_type_name FROM public.job_types j WHERE j.id=v_type AND j.organization_id=v_org AND COALESCE(j.is_active,true);
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF NOT COALESCE(app_private.hermes_task_assignee_member_v1(v_assignee,v_org),false) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    IF v_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range','item',v_i+1); END IF;
    SELECT p.full_name INTO v_assignee_name FROM public.profiles p WHERE p.id=v_assignee;
    v_dups:=public.job_open_duplicates_v1(v_org,v_building,v_room,v_type);
    v_manages:=true;
    IF v_assignee<>v_actor THEN
      IF NOT v_org_locked THEN PERFORM app_private.lock_org_for_decision_v1(v_org); v_org_locked:=true; END IF;
      v_manages:=COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_assignee,v_org,'tasks.edit',v_building,NULL) a),false);
    END IF;
    v_bases:=v_bases||md5(jsonb_build_array('task.create_batch',v_building,v_room,v_type,v_assignee,v_deadline,v->>'title',v->>'description',
      v->>'priority',v_building_name,(SELECT jsonb_agg(e->'id' ORDER BY e->>'id') FROM jsonb_array_elements(v_dups) e),v_manages)::text);
    v_who:=CASE WHEN v_assignee=v_actor THEN 'CHÍNH anh/chị' ELSE COALESCE(v_assignee_name,'(không xem được tên)') END;
    IF v_assignee=v_actor THEN v_self:=v_self||format('#%s',v_i+1); END IF;
    IF v->'jobTypeGuessed'='true'::jsonb THEN v_guessed:=v_guessed||format('#%s %s',v_i+1,v_type_name); END IF;
    IF v->'roomMissing'='true'::jsonb THEN v_noroom:=v_noroom||format('#%s',v_i+1); END IF;
    IF v->'assigneeAmbiguous'='true'::jsonb THEN v_ambiguous:=v_ambiguous||format('#%s %s',v_i+1,v_who); END IF;
    IF jsonb_array_length(v_dups)>0 THEN v_dup:=v_dup||format('#%s %s',v_i+1,COALESCE(v_dups->0->>'code','—')); END IF;
    v_key:=v_building::text||'/'||COALESCE(v_room::text,'-')||'/'||v_type::text;
    IF v_key=ANY(v_keys) THEN v_twin:=v_twin||format('#%s',v_i+1); END IF;
    v_keys:=v_keys||v_key;
    IF NOT v_manages AND NOT (format('%s ở toà %s',v_who,v_building_name)=ANY(v_unmanaged)) THEN
      v_unmanaged:=v_unmanaged||format('%s ở toà %s',v_who,v_building_name); END IF;
    v_assignees:=v_assignees||v_assignee;
    v_when:=app_private.hermes_task_when_v1(v_org,v_deadline,v->'deadlineDefaulted'='true'::jsonb);
    v_rows:=v_rows||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('stt',v_i+1,'building',v_building_name,'room',v_room_name,
      'wholeBuilding',v_room IS NULL,'title',v->>'title','jobType',v_type_name,'assignee',v_who,'assigneeSelf',v_assignee=v_actor,
      'deadline',to_char(v_deadline AT TIME ZONE v_tz,'YYYY-MM-DD HH24:MI'),'deadlineText',v_when,'priority',v->>'priority',
      'duplicates',jsonb_array_length(v_dups))));
    v_lines:=v_lines||format('%s) toà %s%s — ''%s'' — giao %s — hạn %s',v_i+1,v_building_name,
      CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room_name ELSE ', cả toà' END,v->>'title',v_who,v_when);
    v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('jobId',gen_random_uuid(),'buildingId',v_building,'roomId',v_room,'jobTypeId',v_type,
      'assigneeId',v_assignee,'deadline',v_deadline,'title',v->>'title','description',v->>'description','priority',v->>'priority'));
  END LOOP;
  v_basis:=md5(jsonb_build_array('task.create_batch',v_n,to_jsonb(v_bases))::text);
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  -- Hạn mức (Q37) cho CẢ lô: vượt ⇒ từ chối ngay ở bản xem trước (không hỏi đồng ý một lô sẽ bị chặn); lượt ghi kiểm lại TRƯỚC khi
  -- mở biên nhận (khoá tư vấn theo người hỏi giữ tới hết giao dịch).
  v_quota:=app_private.hermes_task_quota_v1(v_org,v_actor,v_assignees);
  IF v_quota IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_quota); END IF;

  IF p_phase<>'apply' THEN
    IF (SELECT count(DISTINCT jsonb_build_array(e->'title',e->'assignee',e->'deadline',e->'priority')) FROM jsonb_array_elements(v_rows) e)=1 THEN
      v_text:=format('Giao %s việc ''%s'' cho %s, hạn %s%s: %s.',v_n,v_rows->0->>'title',v_rows->0->>'assignee',v_rows->0->>'deadlineText',
        CASE v_rows->0->>'priority' WHEN 'URGENT' THEN ', ưu tiên Gấp' WHEN 'LOW' THEN ', ưu tiên Thấp' ELSE '' END,
        (SELECT string_agg((e->>'building')||CASE WHEN e ? 'room' THEN ' phòng '||(e->>'room') ELSE ' (cả toà)' END,', ' ORDER BY (e->>'stt')::int)
          FROM jsonb_array_elements(v_rows) e));
    ELSE
      v_text:=format('Giao %s việc: %s.',v_n,array_to_string(v_lines,'; '));
    END IF;
    -- Lượt 13: mục giao cho chính người gửi lệnh được nêu riêng (lô luôn xem trước; chỉ ghi khi có xác nhận ở lượt sau).
    IF cardinality(v_self)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Giao cho CHÍNH anh/chị (người gửi lệnh) ở mục '||array_to_string(v_self,', ')
      ||': chỉ ghi khi anh/chị đồng ý; muốn giao người khác thì nêu tên người đó.',300)); END IF;
    IF cardinality(v_guessed)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Loại việc do bot chọn theo nội dung: '||array_to_string(v_guessed,', ')||' — hỏi lại nếu sai.',300)); END IF;
    IF cardinality(v_noroom)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Chưa nêu phòng ở mục '||array_to_string(v_noroom,', ')||': việc cho CẢ TOÀ.',300)); END IF;
    IF cardinality(v_ambiguous)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Người nhận hiểu theo cách gọi chưa rõ ở mục '||array_to_string(v_ambiguous,', ')
      ||' — nếu là người khác, nêu đủ tên.',300)); END IF;
    IF cardinality(v_dup)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Đã có việc cùng loại đang mở ở chỗ của mục '||array_to_string(v_dup,', ')
      ||' — vẫn tạo thêm?',300)); END IF;
    IF cardinality(v_twin)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Mục '||array_to_string(v_twin,', ')||' trùng chỗ và loại với một mục trước trong lô.',300)); END IF;
    IF cardinality(v_unmanaged)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Không có quyền công việc ở toà (vẫn thấy việc nhưng không sửa/hoàn thành được trên web): '
      ||array_to_string(v_unmanaged,'; ')||'.',300)); END IF;
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',jsonb_build_object('items',v_items),'confirm','required','warnings',v_warnings,
      'preview',jsonb_build_object('text',left(v_text,4000),'count',v_n,'items',v_rows));
  END IF;

  -- Lượt ghi: MỘT biên nhận cho cả lô.
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,'task.create_batch',p_request_id,
    jsonb_build_object('params',p_params,'resolved',jsonb_build_object('items',v_items)));
  IF v_begin->>'state'='replay' THEN RETURN jsonb_build_object('kind','replay','outcome',v_begin->'result'); END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('kind','write','action','task.create_batch','requestId',p_request_id,'organizationId',v_org,'actorId',v_actor,
    'connectionId',ctx->'connectionId','startedAt',clock_timestamp(),'jobs',v_jobs);
END $fn$;

ALTER FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Bộ đọc + lõi: vai authenticated gọi (như 20261022153345 / 20261022031548). Chuẩn bị lô chỉ hàm DEFINER gọi: không cấp.
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) TO authenticated;

DO $check$
BEGIN
  IF has_function_privilege('authenticated','app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE') OR has_function_privilege('anon','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE') OR has_function_privilege('hermes_store_executor','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    OR (SELECT replace(COALESCE(array_to_string(p.proconfig,','),''),'"','') FROM pg_proc p WHERE p.oid='public.hermes_domain_read_v1(jsonb,text,jsonb)'::regprocedure)<>'search_path=pg_catalog, public, app_private'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='public.hermes_domain_read_v1(jsonb,text,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM 'fb2f65b229970c25e60835b7ba9ed1fa'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM 'adea03b28b36d0f221b0b8244055959d'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '0d7a8ab43a59cce8cc627b9e9823eb01'
    OR has_function_privilege('anon','app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_task_given_per_room_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
