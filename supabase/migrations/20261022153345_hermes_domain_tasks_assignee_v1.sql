-- Hermes Đợt 2b — trang Công việc, Mốc 3b (ma trận nghiệm thu pha A vòng 1, 22/10/2026; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md
-- mục 20): crm_read_tasks không có người nhận ⇒ "Nathan đang làm gì" bó tay (CV-R04), "toà 44TL có việc gì" không nói ai làm
-- (CV-R03), và mô hình tự cộng các trang nên cộng sai (CV-R06 59 thay vì 54; CV-R01 62 việc không tóm theo toà).
-- Chỉ thay NHÁNH tasks của public.hermes_domain_read_v1; mọi nhánh khác giữ từng byte như 20261021063452 (thân đang chạy TEST
-- và production, md5 ghim ở dưới — thân khác ⇒ dừng, không đè bản vá nào). Cùng chữ ký ⇒ OID giữ nguyên. Không thêm khoá
-- input, không thêm hàm:
--  (1) Dòng thêm assigneeName = tên người nhận như web /tasks (profiles.full_name, rồi jobs.assignee_name gõ tay; null = chưa giao).
--  (2) query khớp tiêu đề/mã như cũ HOẶC tên người nhận, bỏ dấu (public.hermes_name_fold_v1 của 20261021132433) ⇒ lọc theo người
--      không tốn khoá input mới trong tools/list.
--  (3) summary thêm byBuilding [{buildingId, buildingName, count, overdue}], byAssignee [{assigneeName, count, overdue}] (≤50 nhóm,
--      nhiều việc trước) và givenByMe {count, overdue} (việc người hỏi tạo, người nhận khác người hỏi — kể cả chưa giao), tính trên
--      CẢ tập lọc (cùng phạm vi toà của khoá tasks.view, trạng thái, toà, query; không cursor/LIMIT).
-- THỨ TỰ PHÁT HÀNH: connector bản Mốc 3b (nhận dòng/summary có hoặc không có các khoá mới — cửa sổ tolerant) lên TRƯỚC; connector
-- cũ từ chối khoá lạ (backend_unavailable). Rollback (không phải migration): chạy lại câu lệnh hàm của 20261021063452 — khối
-- $requires$ ở đây nhận cả hai thân.
-- Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_name_fold_v1(text)');
  IF NOT FOUND OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres' OR to_regprocedure('app_private.hermes_domain_text_v1(text)') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid='public.jobs'::regclass AND NOT a.attisdropped
      AND a.attname IN ('assignee_id','assignee_name','user_id'))<>3
    OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid='public.profiles'::regclass AND NOT a.attisdropped AND a.attname IN ('id','full_name'))<>2
    THEN RAISE EXCEPTION 'hermes_domain_tasks_assignee_dependency_invalid'; END IF;
  -- Thân đang chạy phải đúng thân 20261021063452 (hoặc đúng thân của file này khi chạy lại).
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v1(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR md5(p.prosrc) NOT IN ('b0d16d1af0b2ce453b2ea53fdf919098','d79bb632be427768e64b6f3e7f543e73')
    THEN RAISE EXCEPTION 'hermes_domain_tasks_assignee_requires_063452_body'; END IF;
END $requires$;

-- Thân 20261021063452, chỉ đổi nhánh tasks (assigneeName, query theo tên người nhận, byBuilding/byAssignee/givenByMe).
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; capabilities jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; org_wide boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; rows jsonb; next_cursor uuid; v_summary jsonb; v_tz text;
BEGIN
  permission:=app_private.hermes_domain_permission_v1(p_domain);
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
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
        AND (query='' OR position(query IN lower(COALESCE(job.title,'')||' '||COALESCE(job.code,'')))>0
          OR position(public.hermes_name_fold_v1(query) IN public.hermes_name_fold_v1(COALESCE(NULLIF(person.full_name,''),job.assignee_name)))>0)
      ORDER BY job.id LIMIT row_limit+1) found;
    -- Tóm tắt của CẢ tập lọc (cùng WHERE, không cursor/LIMIT) để mô hình không tự cộng các trang. overdue: việc mở đã quá hạn lúc
    -- câu lệnh chạy (now()). byBuilding / byAssignee: tối đa 50 nhóm, nhiều việc trước (hoà: id toà / tên theo byte, null cuối).
    -- givenByMe: việc người hỏi tạo mà người nhận KHÁC người hỏi (kể cả chưa giao).
    WITH found AS MATERIALIZED (
      SELECT job.status::text status,job.building_id,app_private.hermes_domain_text_v1(COALESCE(building.name,'')) building_name,
        NULLIF(app_private.hermes_domain_text_v1(COALESCE(NULLIF(person.full_name,''),job.assignee_name)),'') assignee_name,COALESCE(job.status='IN_PROGRESS' AND job.deadline<now(),false) late,
        COALESCE(job.user_id=c.user_id AND job.assignee_id IS DISTINCT FROM job.user_id,false) given
      FROM public.jobs job LEFT JOIN public.buildings building ON building.id=job.building_id AND building.organization_id=c.organization_id
        LEFT JOIN public.profiles person ON person.id=job.assignee_id
      WHERE job.organization_id=c.organization_id AND (job.building_id=ANY(buildings) OR (job.building_id IS NULL AND org_wide))
        AND (v_status IS NULL OR job.status=v_status)
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

ALTER FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) TO authenticated;

DO $check$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v1(jsonb,text,jsonb)');
  IF NOT FOUND OR pg_get_userbyid(p.proowner)<>'postgres' OR p.provolatile<>'v' OR NOT p.prosecdef
    OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path=pg_catalog, public, app_private'
    OR md5(p.prosrc)<>'d79bb632be427768e64b6f3e7f543e73'
    OR NOT has_function_privilege('authenticated','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE') OR has_function_privilege('service_role','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_domain_tasks_assignee_contract_violated'; END IF;
END $check$;
COMMIT;
