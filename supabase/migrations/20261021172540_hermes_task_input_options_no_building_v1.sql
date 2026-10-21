-- Hermes crm_task_input_options: kind=jobTypes/assignees tra được KHÔNG cần buildingId (chủ dự án duyệt 22/10/2026,
-- câu 29, "sửa nhanh" để bot giao việc được ngay trong lúc chờ bản đúng).
-- Lỗi đo trên TEST 21/10 (bot thật): schema quảng bá ghi buildingId bỏ trống được, bot gọi kind=assignees/jobTypes không
-- kèm buildingId ⇒ connector từ chối (invalid_request) ⇒ ba lỗi liền nhau thì Hermes tạm khoá cả MCP server ~59 giây
-- ⇒ bot báo "CRM đang lỗi"; 21/27 lần tạo việc hỏng. Người nhận (thành viên công ty) và loại việc (danh mục công ty)
-- vốn không lọc theo toà: buildingId ở hai loại này chỉ dùng để kiểm quyền.
-- Đổi (CREATE OR REPLACE, giữ chữ ký, kiểu trả về, owner, ACL; public.hermes_task_input_options_v1 không đổi và vẫn
-- gắn đúng OID hai hàm dưới):
--   1. app_private.hermes_task_input_guard_v1 (DEFINER): kind IN (jobTypes, assignees) nhận buildingId null; khi đó
--      đòi người dùng có tasks.create ở ÍT NHẤT MỘT toà trong phạm vi kết nối — đúng tập toà v_buildings mà nhánh có
--      toà đã dùng (authorize_tenant_action_v3 từng toà ∩ authorized_scope_v3 ∩ overlay của kết nối và chính sách công
--      ty), rỗng ⇒ 42501 như toà ngoài tập. Không nới quyền: mọi kiểm trước đó (binding, phiên, epoch, chính sách,
--      registry, quyền CRM tasks.create) giữ nguyên từng dòng. kind=rooms vẫn bắt buildingId (null ⇒ 22023).
--   2. app_private.hermes_task_input_rows_v1 (INVOKER, dưới RLS người hỏi): nhánh jobTypes/assignees với buildingId
--      null đòi ít nhất một toà của tập đó còn thấy được dưới RLS (như nhánh có toà đòi đúng toà đó); có buildingId thì
--      y như cũ. Kết quả vẫn trả buildingId như đầu vào (null).
-- Có buildingId: mọi loại giữ nguyên hành vi cũ. THỨ TỰ PHÁT HÀNH: connector chịu cả hai bản SQL (bản cũ từ chối
-- buildingId null bằng 22023 ⇒ connector trả câu hướng dẫn tĩnh) lên TRƯỚC, rồi file này (TEST → đo bot thật →
-- production). Lùi: áp lại đúng hai định nghĩa của 20261014094913 (connector mới vẫn chạy với bản cũ).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  -- Thân guard của 20261014094913 (8decd7a0…, production/TEST 22/10) hoặc của chính file này (chạy lượt hai).
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_task_input_guard_v1(jsonb,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR md5(replace(p.prosrc,chr(13),'')) NOT IN ('8decd7a07cca54d27d97cf2108936331','b71ec696270eff44ac492ed2ae78b1a9')
    THEN RAISE EXCEPTION 'hermes_task_input_no_building_requires_v5_guard'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_task_input_rows_v1(jsonb)');
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosqlbody IS NULL
    OR position('hermes_task_assignee_member_v1' IN pg_get_function_sqlbody(p.oid))=0
    THEN RAISE EXCEPTION 'hermes_task_input_no_building_requires_v5_rows'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_task_input_options_v1(jsonb,jsonb)');
  IF NOT FOUND OR p.prosecdef OR p.prosqlbody IS NULL
    OR (SELECT count(DISTINCT d.refobjid) FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
      AND d.refclassid='pg_proc'::regclass AND d.refobjid IN (to_regprocedure('app_private.hermes_task_input_guard_v1(jsonb,jsonb)'),
        to_regprocedure('app_private.hermes_task_input_rows_v1(jsonb)')))<>2
    THEN RAISE EXCEPTION 'hermes_task_input_no_building_requires_v1_entry'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_input_guard_v1(p_binding jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections;s app_private.hermes_sessions;policy app_private.hermes_org_policies;
 member jsonb;context jsonb;k text;v_building uuid;v_cursor uuid;v_limit bigint;v_buildings uuid[];
BEGIN
 PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
 PERFORM app_private.hermes_request_v1(p_input,ARRAY['kind','buildingId','query','limit','cursor']);
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR p_input->>'kind' NOT IN ('buildings','rooms','jobTypes','assignees')
  OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR length(p_input->>'query')>100 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 IF p_input->>'kind'='buildings' THEN
  IF p_input->'buildingId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 ELSIF p_input->>'kind' IN ('jobTypes','assignees') AND p_input->'buildingId'='null'::jsonb THEN v_building:=NULL;
 ELSE v_building:=app_private.hermes_uuid_v1(p_input->'buildingId');END IF;
 IF p_input->'cursor'<>'null'::jsonb THEN v_cursor:=app_private.hermes_uuid_v1(p_input->'cursor');END IF;
 v_limit:=app_private.hermes_integer_v1(p_input->'limit');IF v_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
 FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
  IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
  THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
 IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
  OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
 policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
 IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
  OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
  OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId' OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
  THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409';END IF;
 context:=public.get_authorization_context_v1(c.organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409';END IF;
 PERFORM 1 FROM app_private.hermes_capabilities WHERE capability='tasks.create' AND mode='action' AND enabled FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR context#>'{permissions,tasks.create}' IS DISTINCT FROM 'true'::jsonb
  OR NOT('tasks.create'=ANY(c.action_capabilities)) OR NOT('tasks.create'=ANY(policy.action_capabilities))
  THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;

 SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
 CROSS JOIN app_private.authorized_scope_v3('tasks.create',c.organization_id) scope
 CROSS JOIN LATERAL app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,'tasks.create',b.id,NULL) decision
 WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL AND COALESCE(decision.allowed,false)
  AND decision.authorization_version::text=member->>'authorizationVersion' AND (decision.nearest_deadline IS NULL OR decision.nearest_deadline>clock_timestamp())
  AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
  AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
   AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND (overlay.scope_type='ORGANIZATION'
    OR overlay.scope_type='BUILDING' AND overlay.building_id=b.id
    OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
      WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id)));
 IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 IF v_building IS NOT NULL AND NOT(v_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 IF v_building IS NULL AND p_input->>'kind' IN ('jobTypes','assignees') AND cardinality(v_buildings)=0 THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 RETURN jsonb_build_object('organizationId',c.organization_id,'buildingIds',to_jsonb(v_buildings),'input',p_input);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_input_rows_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 WITH args AS (SELECT p_plan->'input' AS input,(p_plan->>'organizationId')::uuid AS org,
   ARRAY(SELECT jsonb_array_elements_text(p_plan->'buildingIds')::uuid) AS buildings),
 candidates AS (
  SELECT b.id,b.name AS label FROM public.buildings b,args x WHERE x.input->>'kind'='buildings' AND b.id=ANY(x.buildings) AND b.organization_id=x.org AND b.deleted_at IS NULL
  UNION ALL
  SELECT r.id,r.name FROM public.rooms r,args x WHERE x.input->>'kind'='rooms' AND r.building_id=(x.input->>'buildingId')::uuid AND r.organization_id=x.org AND r.deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=r.building_id AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))
  UNION ALL
  SELECT j.id,j.name FROM public.job_types j,args x WHERE x.input->>'kind'='jobTypes' AND j.organization_id=x.org
   AND EXISTS(SELECT 1 FROM public.buildings b WHERE (x.input->>'buildingId' IS NULL OR b.id=(x.input->>'buildingId')::uuid) AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))
  UNION ALL
  SELECT p.id,p.full_name FROM public.profiles p,args x WHERE x.input->>'kind'='assignees' AND app_private.hermes_task_assignee_member_v1(p.id,x.org)
   AND EXISTS(SELECT 1 FROM public.buildings b WHERE (x.input->>'buildingId' IS NULL OR b.id=(x.input->>'buildingId')::uuid) AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))
 ), selected AS MATERIALIZED (
  SELECT id,COALESCE(label,'(Chưa đặt tên)') AS label FROM candidates,args x
  WHERE (x.input->>'cursor' IS NULL OR id>(x.input->>'cursor')::uuid)
   AND strpos(lower(COALESCE(label,'(Chưa đặt tên)')),lower(x.input->>'query'))>0
  ORDER BY id LIMIT ((p_plan#>>'{input,limit}')::int+1)
 ), visible AS (SELECT * FROM selected ORDER BY id LIMIT (p_plan#>>'{input,limit}')::int)
 SELECT jsonb_build_object('organizationId',p_plan->'organizationId','kind',p_plan#>'{input,kind}','buildingId',p_plan#>'{input,buildingId}',
  'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY id) FROM visible),'[]'::jsonb),
  'nextCursor',CASE WHEN (SELECT count(*) FROM selected)>(p_plan#>>'{input,limit}')::int THEN (SELECT max(id::text) FROM visible) ELSE NULL END);
END;

ALTER FUNCTION app_private.hermes_task_input_guard_v1(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_input_guard_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_input_guard_v1(jsonb,jsonb) TO authenticated;
ALTER FUNCTION app_private.hermes_task_input_rows_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_input_rows_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_input_rows_v1(jsonb) TO authenticated;

DO $assert$
DECLARE p record; sig text; body text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.hermes_task_input_guard_v1(jsonb,jsonb)','app_private.hermes_task_input_rows_v1(jsonb)',
    'public.hermes_task_input_options_v1(jsonb,jsonb)'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT FOUND OR pg_get_userbyid(p.proowner)<>'postgres' OR p.provolatile<>'v'
      OR p.prosecdef IS DISTINCT FROM (sig LIKE 'app_private.hermes_task_input_guard_v1%')
      OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
      OR has_function_privilege('anon',sig,'EXECUTE') OR has_function_privilege('service_role',sig,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',sig,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes_task_input_no_building_contract_violated: %',sig; END IF;
  END LOOP;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_task_input_guard_v1(jsonb,jsonb)');
  IF replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path=pg_catalog, public, app_private'
    OR md5(replace(p.prosrc,chr(13),''))<>'b71ec696270eff44ac492ed2ae78b1a9'
    THEN RAISE EXCEPTION 'hermes_task_input_no_building_guard_changed'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_task_input_rows_v1(jsonb)');
  IF p.prosqlbody IS NULL OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path=pg_catalog, public'
    THEN RAISE EXCEPTION 'hermes_task_input_no_building_rows_path_changed'; END IF;
  body:=pg_get_function_sqlbody(p.oid);
  IF (length(body)-length(replace(body,'''buildingId''::text) IS NULL)','')))/length('''buildingId''::text) IS NULL)')<>2
    OR position('hermes_task_assignee_member_v1' IN body)=0
    THEN RAISE EXCEPTION 'hermes_task_input_no_building_rows_projection_missing'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
