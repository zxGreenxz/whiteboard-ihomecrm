-- Hermes ghi phiếu CHI nhanh theo luồng "Báo chi nhanh". Phiếu đi đúng writer
-- canonical public.create_income_expense_v1 với JWT/actor thật: quyền tạo theo
-- toà, hạng mục hạn chế, quyền dùng sổ quỹ (chủ sổ/CUSTODIAN/OPERATOR), khoá sổ,
-- canary/cờ writer, khoá chống trùng income_expense.create_draft.v1 và bộ máy chi
-- (ngưỡng, hạng mục bắt buộc duyệt, cam kết chi) quyết trạng thái sinh.
-- Hermes không gọi hàm duyệt/vào sổ. Writer cho phiếu ra đời ĐÃ DUYỆT khi người
-- lập có income_expenses.approve trên toà: phần duyệt đó dùng quyền duyệt của
-- user nên phải nằm trong overlay Thao tác Hermes 'income_expenses.approve'; thiếu
-- thì từ chối trước khi ghi và hậu kiểm lại sau writer (rollback toàn bộ).
-- Chỉ phiếu CHI, không tiền mặt khách/cọc/hợp đồng/đính kèm/số tài khoản; hạng mục
-- hệ thống, hạn chế, cọc, nội bộ, đã lưu trữ hoặc ẩn khỏi Báo chi nhanh bị loại.
-- Biên nhận requestId bền trong cùng transaction với phiếu: mất ACK chỉ đối soát
-- status, không tạo lại. Năng lực mới đăng ký TẮT.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
  ('income_expenses.create','action',false),('income_expenses.approve','action',false)
ON CONFLICT(capability) DO NOTHING;
CREATE TABLE IF NOT EXISTS app_private.hermes_expense_create_receipts(
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  input jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,user_id,request_id)
);
ALTER TABLE app_private.hermes_expense_create_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_expense_create_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_expense_create_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- Usable expense categories for this channel (mirrors Báo chi nhanh selection,
-- narrowed: no restricted, deposit or internal-transfer category).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_category_ok_v1(p_org uuid,p_type uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.income_expense_types t WHERE t.id=p_type AND t.organization_id=p_org
   AND lower(t.type)='expense' AND t.archived_at IS NULL AND NOT COALESCE(t.system_only,false)
   AND NOT COALESCE(t.manual_hidden,false) AND NOT COALESCE(t.quick_entry_hidden,false)
   AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false))
$fn$;

-- Cashbooks the actor may spend from (same rule as the writer: owner, CUSTODIAN
-- or OPERATOR), current company only, never virtual or deleted.
CREATE OR REPLACE FUNCTION app_private.hermes_expense_cashbook_ok_v1(p_org uuid,p_user uuid,p_cashbook uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=p_cashbook AND a.organization_id=p_org AND a.deleted_at IS NULL
   AND NOT COALESCE(a.is_virtual,false) AND (a.user_id=p_user OR EXISTS(SELECT 1 FROM public.cashbook_possession_bindings b
     JOIN public.organization_memberships m ON m.id=b.membership_id
     WHERE b.cashbook_id=a.id AND b.organization_id=p_org AND m.user_id=p_user AND m.status='ACTIVE'
       AND b.valid_to IS NULL AND b.possession_kind IN ('CUSTODIAN','OPERATOR'))))
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_expense_action_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; receipt app_private.hermes_expense_create_receipts; v_row public.income_expenses;
  k text; v_request uuid; v_building uuid; v_room uuid; v_cashbook uuid; v_date date; v_cursor uuid; v_limit bigint;
  v_buildings uuid[]; v_items jsonb:='[]'; v_line jsonb; v_total numeric:=0; v_amount numeric; v_name text; v_vendor text;
  v_kind text; v_query text; v_rows jsonb; v_result jsonb; v_maker_can_approve boolean; v_approve_overlay boolean;
  action_key constant text:='income_expenses.create'; approve_key constant text:='income_expenses.approve';
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('options','create','status') THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  PERFORM app_private.hermes_request_v1(p_input,CASE p_operation
    WHEN 'options' THEN ARRAY['kind','buildingId','query','limit','cursor']
    WHEN 'status' THEN ARRAY['requestId']
    ELSE ARRAY['requestId','buildingId','roomId','cashbookId','voucherDate','name','vendor','lines'] END);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId'); PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    THEN RAISE EXCEPTION 'hermes_expense_context_changed' USING ERRCODE='PT409'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_expense_context_changed' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=action_key AND mode='action' AND enabled FOR SHARE;
  IF NOT FOUND OR NOT policy.enabled OR context->'permissions'->action_key IS DISTINCT FROM 'true'::jsonb
    OR NOT(action_key=ANY(c.action_capabilities)) OR NOT(action_key=ANY(policy.action_capabilities))
    THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  -- CRM create scope for this key, intersected with the saved Hermes overlay.
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
    CROSS JOIN app_private.authorized_scope_v3(action_key,c.organization_id) scope
    WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
      AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
      AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
        AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND overlay.cashbook_id IS NULL AND (overlay.scope_type='ORGANIZATION'
        OR overlay.scope_type='BUILDING' AND overlay.building_id=b.id
        OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a ON a.id=ab.area_id
          AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
          WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id)));
  IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;

  IF p_operation='options' THEN
    v_kind:=p_input->>'kind'; v_query:=p_input->>'query';
    IF jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR v_kind NOT IN ('buildings','rooms','categories','cashbooks')
      OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(v_query)>100 OR v_query ~ '[[:cntrl:]]'
      THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
    v_limit:=app_private.hermes_integer_v1(p_input->'limit');
    IF v_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
    IF p_input->'cursor'<>'null'::jsonb THEN v_cursor:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
    IF v_kind='rooms' THEN
      v_building:=app_private.hermes_uuid_v1(p_input->'buildingId');
      IF NOT(v_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
    ELSIF p_input->'buildingId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
    -- Choices only need the action grant; they are labels, never Read data.
    IF cardinality(v_buildings)=0 THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
    v_query:=lower(btrim(v_query));
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY id),'[]') INTO v_rows FROM (
      SELECT id,label FROM (
        SELECT b.id,app_private.hermes_domain_text_v1(COALESCE(b.name,'(chưa đặt tên)')) label FROM public.buildings b
          WHERE v_kind='buildings' AND b.id=ANY(v_buildings) AND b.organization_id=c.organization_id AND b.deleted_at IS NULL
        UNION ALL
        SELECT r.id,app_private.hermes_domain_text_v1(COALESCE(r.name,'(chưa đặt tên)')) FROM public.rooms r
          WHERE v_kind='rooms' AND r.building_id=v_building AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
        UNION ALL
        SELECT t.id,app_private.hermes_domain_text_v1(COALESCE(t.name,'(chưa đặt tên)')) FROM public.income_expense_types t
          WHERE v_kind='categories' AND t.organization_id=c.organization_id AND app_private.hermes_expense_category_ok_v1(c.organization_id,t.id)
        UNION ALL
        -- Long digit runs are masked: a cashbook label must not disclose an account number.
        SELECT a.id,app_private.hermes_domain_text_v1(regexp_replace(COALESCE(a.name,'(chưa đặt tên)'),'[0-9]{5,}','***','g')) FROM public.accounts a
          WHERE v_kind='cashbooks' AND a.organization_id=c.organization_id AND app_private.hermes_expense_cashbook_ok_v1(c.organization_id,c.user_id,a.id)
      ) candidates WHERE (v_cursor IS NULL OR id>v_cursor) AND strpos(lower(label),v_query)>0
      ORDER BY id LIMIT v_limit+1) found;
    v_result:=jsonb_build_object('organizationId',c.organization_id,'kind',v_kind,'buildingId',v_building,'items',v_rows,'nextCursor',NULL);
    IF jsonb_array_length(v_rows)>v_limit THEN
      SELECT jsonb_agg(value ORDER BY ordinality) INTO v_rows FROM jsonb_array_elements(v_rows) WITH ORDINALITY WHERE ordinality<=v_limit;
      v_result:=v_result||jsonb_build_object('items',v_rows,'nextCursor',v_rows->(v_limit::int-1)->'id');
    END IF;
    PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
    RETURN v_result;
  END IF;

  v_request:=app_private.hermes_uuid_v1(p_input->'requestId');
  SELECT * INTO receipt FROM app_private.hermes_expense_create_receipts r
    WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request FOR UPDATE;
  IF FOUND AND receipt.connection_id IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'hermes_expense_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_operation='status' THEN
    PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
    IF receipt.request_id IS NULL THEN
      RETURN jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','not_found','voucher',NULL);
    END IF;
    RETURN COALESCE(receipt.result,jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','unknown','voucher',NULL));
  END IF;
  IF receipt.request_id IS NOT NULL THEN
    IF receipt.input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'hermes_expense_intent_changed' USING ERRCODE='PT409'; END IF;
    IF receipt.result IS NULL THEN RAISE EXCEPTION 'hermes_expense_outcome_unknown' USING ERRCODE='PT409'; END IF;
    PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
    RETURN receipt.result;
  END IF;

  -- Fixed input contract. Money is an integer VND JSON number; no attachments,
  -- payee bank account, tenant, contract, notes or caller-selected approval.
  v_building:=app_private.hermes_uuid_v1(p_input->'buildingId');
  v_cashbook:=app_private.hermes_uuid_v1(p_input->'cashbookId');
  IF p_input->'roomId'<>'null'::jsonb THEN v_room:=app_private.hermes_uuid_v1(p_input->'roomId'); END IF;
  v_date:=app_private.hermes_domain_date_v2(p_input->'voucherDate');
  v_name:=p_input->>'name';
  IF v_date IS NULL OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR char_length(v_name) NOT BETWEEN 1 AND 200
    OR btrim(v_name) IS DISTINCT FROM v_name OR v_name ~ '[[:cntrl:]]'
    OR (p_input->'vendor'<>'null'::jsonb AND (jsonb_typeof(p_input->'vendor') IS DISTINCT FROM 'string'
      OR char_length(p_input->>'vendor') NOT BETWEEN 1 AND 100 OR (p_input->>'vendor') ~ '[[:cntrl:]]'))
    OR jsonb_typeof(p_input->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'lines') NOT BETWEEN 1 AND 20
    THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
  IF p_input->'vendor'<>'null'::jsonb THEN v_vendor:=p_input->>'vendor'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_input->'lines') LOOP
    PERFORM app_private.hermes_request_v1(v_line,ARRAY['categoryId','amount','description']);
    IF jsonb_typeof(v_line->'amount') IS DISTINCT FROM 'number' OR (v_line->>'amount') !~ '^[1-9][0-9]{0,12}$'
      OR (v_line->'description'<>'null'::jsonb AND (jsonb_typeof(v_line->'description') IS DISTINCT FROM 'string'
        OR char_length(v_line->>'description') NOT BETWEEN 1 AND 200 OR (v_line->>'description') ~ '[[:cntrl:]]'))
      OR NOT app_private.hermes_expense_category_ok_v1(c.organization_id,app_private.hermes_uuid_v1(v_line->'categoryId'))
      THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
    v_amount:=(v_line->>'amount')::numeric; v_total:=v_total+v_amount;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('income_expense_type_id',v_line->>'categoryId',
      'description',CASE WHEN v_line->'description'='null'::jsonb THEN NULL ELSE v_line->>'description' END,
      'quantity',1,'unit_price',v_amount,'start_date',v_date,'end_date',v_date));
  END LOOP;
  IF v_total>9999999999999 THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
  IF NOT(v_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  IF v_room IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=v_room AND r.building_id=v_building
    AND r.organization_id=c.organization_id AND r.deleted_at IS NULL) THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
  IF NOT app_private.hermes_expense_cashbook_ok_v1(c.organization_id,c.user_id,v_cashbook)
    THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  -- Birth approval through the maker's own approve permission is an approval
  -- effect: Hermes needs the same key in its Action overlay. Machine rules of the
  -- spend engine (threshold, commitment) are not the maker's approve authority.
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=approve_key AND mode='action' AND enabled FOR SHARE;
  v_approve_overlay:=FOUND AND approve_key=ANY(c.action_capabilities) AND approve_key=ANY(policy.action_capabilities);
  v_maker_can_approve:=COALESCE(app_private.can_v3(approve_key,v_building),false);
  IF v_maker_can_approve AND NOT v_approve_overlay THEN RAISE EXCEPTION 'hermes_expense_approval_overlay_required' USING ERRCODE='42501'; END IF;
  INSERT INTO app_private.hermes_expense_create_receipts(organization_id,user_id,request_id,connection_id,input)
    VALUES(c.organization_id,c.user_id,v_request,c.id,p_input);
  BEGIN
    v_row:=public.create_income_expense_v1('EXPENSE',v_name,v_building,v_room,NULL,NULL,v_vendor,NULL,NULL,v_cashbook,
      '[]'::jsonb,NULL,NULL,v_date,v_items,'hermes-expense:'||v_request::text);
  EXCEPTION
    WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501';
    WHEN unique_violation THEN RAISE EXCEPTION 'hermes_expense_intent_changed' USING ERRCODE='PT409';
    WHEN raise_exception OR feature_not_supported OR check_violation OR program_limit_exceeded OR data_exception
      THEN RAISE EXCEPTION 'hermes_expense_rejected' USING ERRCODE='22023';
  END;
  IF v_row.id IS NULL OR v_row.organization_id IS DISTINCT FROM c.organization_id OR v_row.user_id IS DISTINCT FROM c.user_id
    OR v_row.type IS DISTINCT FROM 'EXPENSE' OR v_row.building_id IS DISTINCT FROM v_building OR v_row.account_id IS DISTINCT FROM v_cashbook
    OR v_row.room_id IS DISTINCT FROM v_room OR v_row.voucher_date IS DISTINCT FROM v_date OR v_row.deleted_at IS NOT NULL
    OR v_row.total_amount IS DISTINCT FROM v_total OR v_row.approval_status NOT IN ('UNAPPROVED','APPROVED')
    THEN RAISE EXCEPTION 'hermes_expense_receipt_invalid' USING ERRCODE='PT409'; END IF;
  IF v_row.approval_status='APPROVED' AND NOT v_approve_overlay AND COALESCE(app_private.can_v3(approve_key,v_building),false)
    THEN RAISE EXCEPTION 'hermes_expense_approval_overlay_required' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','applied','voucher',jsonb_build_object(
    'id',v_row.id,'code',app_private.hermes_domain_text_v1(v_row.code),'buildingId',v_row.building_id,'roomId',v_row.room_id,
    'cashbookId',v_row.account_id,'voucherDate',v_row.voucher_date,'totalAmount',v_row.total_amount::text,
    'approvalStatus',v_row.approval_status,'lineCount',jsonb_array_length(v_items),'createdBy',c.user_id));
  UPDATE app_private.hermes_expense_create_receipts r SET result=v_result
    WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request;
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_EXPENSE_CREATED','income_expense',v_row.id,NULL,
    jsonb_build_object('actor',c.user_id,'connectionId',c.id,'requestId',v_request,'approvalStatus',v_row.approval_status,
      'approveOverlay',v_approve_overlay),'Hermes bounded expense create');
  RETURN v_result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_expense_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; key text;
  buildings uuid[]; permissions jsonb:='{}';
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_expense_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['income_expenses.create','income_expenses.approve'],NULL);
  FOREACH key IN ARRAY ARRAY['income_expenses.create','income_expenses.approve'] LOOP
    enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
    allowed:=COALESCE(enabled AND context->'permissions'->key='true'::jsonb,false);
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
      CROSS JOIN app_private.authorized_scope_v3(key,p_organization_id) scope
      WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
    IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
    permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions);
END $fn$;

ALTER FUNCTION app_private.hermes_expense_category_ok_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_expense_category_ok_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_expense_cashbook_ok_v1(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_expense_cashbook_ok_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_expense_action_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_expense_action_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_expense_action_v1(jsonb,text,jsonb) TO authenticated;
ALTER FUNCTION public.hermes_expense_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_expense_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_expense_capabilities_v1(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
