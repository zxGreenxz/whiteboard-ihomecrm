-- Đợt 1 nền chung thao tác ghi Hermes — M1 (21/10/2026; docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 9).
-- Hạ tầng dùng chung cho mọi thao tác ghi mới (crm_action_*); mỗi trang cắm RPC xem trước/ghi của mình vào sau.
--  (1) app_private.hermes_action_policies: danh mục thao tác phía SQL — khoá Action Hermes, quyền CRM giao vào, lớp
--      (money/irreversible/reversible), chính sách xác nhận (always/never; sàn của lớp money/irreversible nằm trong
--      connector, chính sách chỉ siết được) và private_only. Thiếu dòng ⇒ thao tác không tồn tại (42501).
--  (2) app_private.hermes_action_receipts: MỘT sổ biên nhận cho mọi thao tác, khoá (org, người dùng, requestId); giữ
--      SQLSTATE + 200 ký tự đầu của lỗi để phân loại crm_refused về sau (không bao giờ trả ra ngoài).
--  (3) app_private.hermes_action_reason_v1(sqlstate, message): danh sách ĐÓNG mã lý do (action-reasons.mjs).
--  (4) app_private.hermes_action_guard_v1(binding, action): kiểm binding/phiên/thành viên/chính sách công ty (đúng
--      khuôn hermes_expense_action_v1) + registry bật + khoá trong kết nối và trần công ty + quyền CRM thật; trả ngữ
--      cảnh và tập toà = phạm vi CRM ∩ overlay kết nối. action NULL = chỉ kiểm binding (tra trạng thái).
--  (5) receipt_begin/finish: luôn chạy lại guard (không nhận ngữ cảnh do người gọi đưa ⇒ không giả được), mở/chốt biên
--      nhận + audit HERMES_ACTION_* trong cùng transaction với thao tác.
--  (6) public.hermes_action_status_v1, public.hermes_action_capabilities_v1 (khuôn hermes_expense_capabilities_v1).
--  (7) Thao tác THỬ (D6) probe.note / probe.confirm — chỉ ghi biên nhận + audit, không đụng bảng nghiệp vụ; khoá
--      assistant.action_probe seed TẮT, chỉ bật trên TEST. Là khuôn cho RPC của từng trang, hai tầng vì authenticated KHÔNG
--      có USAGE trên app_private (production + TEST, đọc 21/10 23:35): vỏ public.hermes_action_probe_v1 INVOKER thân
--      SQL-standard gắn OID guard + hàm giải tên (dưới RLS người gọi) + bước ghi app_private.hermes_action_probe_step_v1
--      (DEFINER: basis tính lại trong transaction ghi, lỗi "hàm ghi" ⇒ lý do đóng). Không cấp USAGE app_private cho ai.
-- Không đổi hàm cũ nào. Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_sessions') IS NULL OR to_regclass('app_private.hermes_org_policies') IS NULL
    OR to_regprocedure('app_private.hermes_private_command_connection_v1(text)') IS NULL
    OR to_regprocedure('app_private.hermes_session_gate_v1(app_private.hermes_sessions)') IS NULL
    OR to_regprocedure('app_private.hermes_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])') IS NULL
    OR to_regprocedure('app_private.hermes_request_v1(jsonb,text[])') IS NULL
    OR to_regprocedure('app_private.authorized_scope_v3(text,uuid)') IS NULL
    OR to_regprocedure('public.get_authorization_context_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL THEN
    RAISE EXCEPTION 'hermes_action_foundation_dependency_invalid'; END IF;
END $requires$;

CREATE TABLE IF NOT EXISTS app_private.hermes_action_policies(
  action text PRIMARY KEY CHECK (action ~ '^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,31}$'),
  capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_.]{0,127}$'),
  crm_permission text NOT NULL CHECK (crm_permission ~ '^[a-z][a-z0-9_.]{0,127}$'),
  action_class text NOT NULL CHECK (action_class IN ('money','irreversible','reversible')),
  confirm text NOT NULL DEFAULT 'always' CHECK (confirm IN ('always','never')),
  private_only boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Sàn D2 cũng giữ ở đây: thao tác tiền/không lùi được không thể khai "never".
  CONSTRAINT hermes_action_policy_floor CHECK (action_class='reversible' OR confirm='always'));
ALTER TABLE app_private.hermes_action_policies OWNER TO postgres;
ALTER TABLE app_private.hermes_action_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_action_policies FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

CREATE TABLE IF NOT EXISTS app_private.hermes_action_receipts(
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  action text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'started' CHECK (state IN ('started','applied','rejected')),
  result jsonb,
  sqlstate text CHECK (sqlstate IS NULL OR sqlstate ~ '^[0-9A-Z]{5}$'),
  message_head text CHECK (message_head IS NULL OR char_length(message_head)<=200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY(organization_id,user_id,request_id));
ALTER TABLE app_private.hermes_action_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_action_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_action_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- Khoá thử (D6) TẮT; hai thao tác thử dùng phạm vi toà của buildings.view.
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('assistant.action_probe','action',false) ON CONFLICT(capability) DO NOTHING;
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('probe.note','assistant.action_probe','buildings.view','reversible','never',true),
  ('probe.confirm','assistant.action_probe','buildings.view','money','always',true)
  ON CONFLICT(action) DO NOTHING;

-- 3. Mã lý do (danh sách đóng; chuỗi lạ ⇒ crm_refused). Câu tiếng Việt của hàm ghi web đã biết đi trước SQLSTATE.
CREATE OR REPLACE FUNCTION app_private.hermes_action_reason_v1(p_sqlstate text,p_message text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT CASE
    WHEN COALESCE(p_message,'') ~ '\[(PROFIT_LOCKED|CASHBOOK_CLOSED|HANDOVER_LOCKED|PERIOD_CLOSED)\]'
      OR COALESCE(p_message,'') ~* '(sổ quỹ đã khoá|locked cashbook period)' THEN 'period_locked'
    WHEN COALESCE(p_message,'') LIKE '%[STRICT_MODE]%' THEN 'strict_mode'
    WHEN COALESCE(p_message,'') ~* '(không có quyền sử dụng sổ quỹ|no CUSTODIAN possession)' THEN 'cashbook_not_held'
    WHEN COALESCE(p_message,'') ~* '(chỉ sửa được phiếu chờ duyệt|phiếu đã ghi sổ|phiếu đã huỷ)' THEN 'not_pending'
    WHEN COALESCE(p_message,'') ~* 'tổng tiền phiếu vượt giới hạn' THEN 'amount_out_of_range'
    WHEN COALESCE(p_message,'') ~* 'quota_exceeded' THEN 'quota_exceeded'
    WHEN p_sqlstate='22023' AND COALESCE(p_message,'') ~* '(lý do|reason)' THEN 'reason_required'
    WHEN p_sqlstate IN ('PT409','40001') THEN 'state_changed'
    WHEN p_sqlstate='42501' THEN 'not_allowed'
    WHEN p_sqlstate='23505' THEN 'duplicate_request'
    ELSE 'crm_refused' END
$fn$;

-- 4. Guard chung (DEFINER: chỉ kiểm binding/quyền, không đọc dữ liệu nghiệp vụ). Thân kiểm binding theo đúng
-- hermes_expense_action_v1 (20261015120100); hàm cũ giữ nguyên.
CREATE OR REPLACE FUNCTION app_private.hermes_action_guard_v1(p_binding jsonb,p_action text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
  a app_private.hermes_action_policies; member jsonb; context jsonb; k text; v_buildings uuid[]:='{}';
BEGIN
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  IF p_action IS NOT NULL THEN
    SELECT * INTO a FROM app_private.hermes_action_policies WHERE action=p_action;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId'); PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_action IS NOT NULL THEN
    PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=a.capability AND mode='action' AND enabled FOR SHARE;
    IF NOT FOUND OR NOT policy.enabled OR context->'permissions'->a.crm_permission IS DISTINCT FROM 'true'::jsonb
      OR NOT(a.capability=ANY(c.action_capabilities)) OR NOT(a.capability=ANY(policy.action_capabilities))
      THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
    -- Phạm vi CRM của quyền giao vào, ∩ overlay đã lưu của kết nối (như hermes_expense_action_v1).
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
      CROSS JOIN app_private.authorized_scope_v3(a.crm_permission,c.organization_id) scope
      WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
        AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
        AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
          AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND overlay.cashbook_id IS NULL AND (overlay.scope_type='ORGANIZATION'
          OR overlay.scope_type='BUILDING' AND overlay.building_id=b.id
          OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas ar ON ar.id=ab.area_id
            AND ar.organization_id=ab.organization_id AND ar.deleted_at IS NULL
            WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id)));
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'connectionId',c.id,'membershipId',member->>'membershipId',
    'action',p_action,'capability',a.capability,'actionClass',a.action_class,'confirm',a.confirm,'privateOnly',a.private_only,
    'buildingIds',to_jsonb(v_buildings));
END $fn$;

-- 5a. Mở biên nhận: cùng requestId + cùng đầu vào ⇒ phát lại; khác đầu vào ⇒ conflict; kết nối khác ⇒ PT409.
CREATE OR REPLACE FUNCTION app_private.hermes_action_receipt_begin_v1(p_binding jsonb,p_action text,p_request_id uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; r app_private.hermes_action_receipts;
BEGIN
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  IF p_request_id IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM app_private.hermes_action_receipts WHERE organization_id=(ctx->>'organizationId')::uuid AND user_id=auth.uid()
    AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF r.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
    IF r.action IS DISTINCT FROM p_action OR r.input IS DISTINCT FROM p_input THEN RETURN jsonb_build_object('state','conflict'); END IF;
    IF r.state='started' THEN RETURN jsonb_build_object('state','unknown'); END IF;
    RETURN jsonb_build_object('state','replay','result',r.result);
  END IF;
  INSERT INTO app_private.hermes_action_receipts(organization_id,user_id,request_id,connection_id,action,input)
    VALUES((ctx->>'organizationId')::uuid,auth.uid(),p_request_id,(ctx->>'connectionId')::uuid,p_action,p_input);
  RETURN jsonb_build_object('state','new');
END $fn$;

-- 5b. Chốt biên nhận + audit (chỉ dòng 'started' của chính người gọi, đúng thao tác).
CREATE OR REPLACE FUNCTION app_private.hermes_action_receipt_finish_v1(p_binding jsonb,p_action text,p_request_id uuid,p_outcome jsonb,
  p_sqlstate text DEFAULT NULL,p_message text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_state text;
BEGIN
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_state:=CASE p_outcome->>'kind' WHEN 'applied' THEN 'applied' WHEN 'rejected' THEN 'rejected' END;
  IF v_state IS NULL THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  UPDATE app_private.hermes_action_receipts SET state=v_state,result=p_outcome,finished_at=clock_timestamp(),
      sqlstate=CASE WHEN p_sqlstate ~ '^[0-9A-Z]{5}$' THEN p_sqlstate END,message_head=left(p_message,200)
    WHERE organization_id=(ctx->>'organizationId')::uuid AND user_id=auth.uid() AND request_id=p_request_id
      AND action=p_action AND state='started' AND connection_id=(ctx->>'connectionId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_receipt_invalid' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.append_authz_audit_v1((ctx->>'organizationId')::uuid,
    CASE v_state WHEN 'applied' THEN 'HERMES_ACTION_APPLIED' ELSE 'HERMES_ACTION_REJECTED' END,'hermes_action',p_request_id,NULL,
    jsonb_build_object('action',p_action,'connectionId',ctx->>'connectionId','reason',p_outcome->>'reason'),'Hermes shared write action');
  RETURN p_outcome;
END $fn$;

-- 6a. Tra trạng thái theo requestId (chỉ kiểm binding; biên nhận của chính người gọi, đúng kết nối).
CREATE OR REPLACE FUNCTION public.hermes_action_status_v1(p_binding jsonb,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; r app_private.hermes_action_receipts;
BEGIN
  ctx:=app_private.hermes_action_guard_v1(p_binding,NULL);
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM app_private.hermes_action_receipts WHERE organization_id=(ctx->>'organizationId')::uuid AND user_id=auth.uid()
    AND request_id=p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','status','outcome','not_found'); END IF;
  IF r.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
  IF r.state='started' THEN RETURN jsonb_build_object('kind','status','outcome','unknown','action',r.action); END IF;
  RETURN jsonb_build_object('kind','status','outcome',r.state,'action',r.action)
    || CASE WHEN r.state='applied' THEN jsonb_build_object('result',COALESCE(r.result->'result','{}'::jsonb))
       ELSE jsonb_build_object('reason',r.result->>'reason') END;
END $fn$;

-- 6b. Capabilities cho connector (khuôn hermes_expense_capabilities_v1) + chính sách từng thao tác.
CREATE OR REPLACE FUNCTION public.hermes_action_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; key text; v_perm text;
  buildings uuid[]; keys text[]; permissions jsonb:='{}'; actions jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT COALESCE(array_agg(DISTINCT p.capability ORDER BY p.capability),'{}'::text[]) INTO keys FROM app_private.hermes_action_policies p;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],keys,NULL);
  FOREACH key IN ARRAY keys LOOP
    -- Một khoá có thể phục vụ nhiều thao tác; quyền CRM giao vào lấy theo thao tác đầu (cùng khoá ⇒ cùng quyền CRM).
    SELECT p.crm_permission INTO v_perm FROM app_private.hermes_action_policies p WHERE p.capability=key ORDER BY p.action LIMIT 1;
    enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
    allowed:=COALESCE(enabled AND context->'permissions'->v_perm='true'::jsonb,false);
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
      CROSS JOIN app_private.authorized_scope_v3(v_perm,p_organization_id) scope
      WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
    IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
    permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  SELECT COALESCE(jsonb_object_agg(p.action,jsonb_build_object('capability',p.capability,'actionClass',p.action_class,'confirm',p.confirm,
    'privateOnly',p.private_only)),'{}'::jsonb) INTO actions FROM app_private.hermes_action_policies p;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions,'actions',actions);
END $fn$;

-- 7. Thao tác THỬ: khuôn cho RPC của từng trang, hai tầng (authenticated KHÔNG có USAGE trên app_private ở production lẫn
-- TEST, đọc 21/10 23:35 — nên RPC INVOKER không được gọi app_private bằng tên lúc chạy):
--  (a) app_private.hermes_action_probe_step_v1: DEFINER, chạy lại guard, nhận kết quả giải tên mà vỏ (b) đã tính dưới RLS
--      của người gọi, rồi xem trước / mở biên nhận / "ghi" / chốt. Client không gọi thẳng được (không USAGE app_private).
--  (b) public.hermes_action_probe_v1: INVOKER, thân SQL-standard (BEGIN ATOMIC) gắn OID của guard, hàm giải tên và (a) lúc
--      tạo (mẫu R2d 20261021063452). Thứ tự: guard (phạm vi toà của khoá) → giải tên ghi dưới RLS người gọi (D7: hàm SQL
--      dùng chung INVOKER) → bước (a).
-- phase: preview (chỉ đọc) | auto (theo chính sách: ghi thẳng hoặc trả bản xem trước) | apply (lượt 2: đúng bản đã giải +
-- expectedBasis; basis tính lại ở đây, lệch ⇒ state_changed, không mở biên nhận). probe.note với note '!raise XXXXX' giả
-- lập lỗi "hàm ghi" SQLSTATE XXXXX để thử đường ánh xạ lý do.
CREATE OR REPLACE FUNCTION app_private.hermes_action_probe_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_resolved jsonb; v_basis text; v_begin jsonb; v_outcome jsonb; v_note text;
BEGIN
  IF p_action NOT IN ('probe.note','probe.confirm') OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL
    OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' OR (p_phase='apply' AND (p_resolved IS NULL OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  IF p_phase='apply' THEN
    v_resolved:=p_resolved;
  ELSIF p_resolution IS NULL THEN
    -- Không có tên nào để giải (vỏ chỉ giải khi params có buildingName/roomName).
    IF p_params ? 'buildingName' OR p_params ? 'roomName' THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
    v_resolved:='{}'::jsonb;
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',p_resolution->'candidates','more',p_resolution->'more');
  ELSIF p_resolution->>'status'='resolved' THEN
    v_resolved:=jsonb_strip_nulls(jsonb_build_object('buildingId',p_resolution#>'{building,id}','buildingName',p_resolution#>'{building,name}',
      'roomId',p_resolution#>'{room,id}','roomName',p_resolution#>'{room,name}'));
  ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  END IF;
  -- Bản đã giải (lượt 1 hay đưa lại ở lượt 2) phải nằm trong phạm vi hiện tại của khoá; phòng phải thuộc đúng toà đó.
  IF v_resolved->>'buildingId' IS NOT NULL AND NOT ((v_resolved->>'buildingId')::uuid IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  IF v_resolved->>'roomId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid
      AND r.building_id=(v_resolved->>'buildingId')::uuid AND r.deleted_at IS NULL) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  -- basis = trạng thái đã cho người dùng xem (ở đây: tên toà hiện tại); đổi tên toà giữa hai lượt ⇒ lệch.
  v_basis:=md5(jsonb_build_array(p_action,v_resolved->'buildingId',v_resolved->'roomId',
    (SELECT b.name FROM public.buildings b WHERE b.id=(v_resolved->>'buildingId')::uuid))::text);
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF p_phase='preview' OR (p_phase='auto' AND (ctx->>'actionClass'<>'reversible' OR ctx->>'confirm'='always')) THEN
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required',
      'preview',jsonb_strip_nulls(jsonb_build_object('action',p_action,'building',v_resolved->'buildingName','room',v_resolved->'roomName',
        'amount',p_params->'amount','note',p_params->'note')),'warnings','[]'::jsonb);
  END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
  IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state'<>'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  -- "Hàm ghi" của thao tác thử: không ghi bảng nghiệp vụ nào; lỗi của nó đi qua đúng đường ánh xạ lý do.
  BEGIN
    v_note:=p_params->>'note';
    IF v_note LIKE '!raise %' THEN RAISE EXCEPTION 'probe writer refused: %',v_note USING ERRCODE=substr(v_note,8,5); END IF;
    v_outcome:=jsonb_build_object('kind','applied','link',NULL,'result',jsonb_strip_nulls(jsonb_build_object('probe',true,'action',p_action,
      'building',v_resolved->'buildingName','room',v_resolved->'roomName','amount',p_params->'amount','note',v_note)));
  EXCEPTION WHEN OTHERS THEN
    v_outcome:=jsonb_build_object('kind','rejected','reason',app_private.hermes_action_reason_v1(SQLSTATE,SQLERRM));
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome,SQLSTATE,SQLERRM);
  END;
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
END $fn$;

-- Đầu hàm theo đúng khuôn lane migrate:forward nhận cho thân SQL-standard ghi (như hermes_task_follow_action_v1);
-- mọi tên trong thân đã ghi đủ schema và gắn OID lúc tạo. Câu lệnh được ghim băm ở scripts/hermes-task-function-contract.mjs.
CREATE OR REPLACE FUNCTION public.hermes_action_probe_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object'
      AND (p_params ? 'buildingName' OR p_params ? 'roomName') THEN
      public.hermes_write_name_resolve_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        jsonb_strip_nulls(jsonb_build_object('building',p_params->>'buildingName','room',p_params->>'roomName'))) END AS resolution FROM g)
  SELECT app_private.hermes_action_probe_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) FROM r;
END;

ALTER FUNCTION app_private.hermes_action_reason_v1(text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_action_guard_v1(jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_action_probe_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_action_status_v1(jsonb,uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_action_capabilities_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_action_reason_v1(text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_action_guard_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_action_probe_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_action_status_v1(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_action_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới vai authenticated nên cần EXECUTE trên đúng hai hàm app_private nó gắn OID (guard, bước ghi; tới qua
-- OID, không qua tên). Biên nhận và ánh xạ lý do chỉ được bước ghi DEFINER gọi: không cấp cho authenticated.
GRANT EXECUTE ON FUNCTION app_private.hermes_action_guard_v1(jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_action_probe_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_action_status_v1(jsonb,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_action_capabilities_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.action_probe' AND (mode<>'action'))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.action_probe')
    -- Vỏ public: INVOKER + thân SQL-standard (OID gắn lúc tạo), không phải plpgsql tra app_private lúc chạy.
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_action_probe_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR has_function_privilege('anon','public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_action_status_v1(jsonb,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)','EXECUTE')
    OR has_table_privilege('authenticated','app_private.hermes_action_receipts','SELECT')
    OR has_table_privilege('authenticated','app_private.hermes_action_policies','SELECT') THEN
    RAISE EXCEPTION 'hermes_action_foundation_catalog_invalid'; END IF;
END $check$;
COMMIT;
