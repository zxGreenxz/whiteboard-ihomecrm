-- Additive task-create choices. The v4 baseline remains unchanged.
-- The action registry is installed disabled by hermes_task_create_action_v1.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE OR REPLACE FUNCTION app_private.hermes_task_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; capability jsonb;
  policy app_private.hermes_org_policies; choices jsonb; combined jsonb; building_ids uuid[];
  action_key constant text:='tasks.create';
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context')
    OR jsonb_typeof(result) IS DISTINCT FROM 'object' OR auth.role() IS DISTINCT FROM 'authenticated'
    OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR member->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- v4 delegates to the existing users.edit guard. This adds a choice only,
    -- never enables the registry or policy and never copies a role.
    IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities registry WHERE registry.capability=action_key AND registry.mode='action' AND registry.enabled)
      AND NOT(result#>'{choices,action}' ? action_key) THEN
      result:=jsonb_set(result,'{choices,action}',(result#>'{choices,action}')||to_jsonb(action_key),false);
    END IF;
    RETURN result;
  END IF;
  capability:=public.hermes_task_create_capabilities_v1(org);
  IF capability->>'userId' IS DISTINCT FROM result->>'userId'
    OR capability->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR capability->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR capability->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR capability->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF capability->'allowed' IS DISTINCT FROM 'true'::jsonb OR
    (p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb) THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO building_ids
    FROM jsonb_array_elements_text(capability->'buildingIds');
  -- Existing CRM scope IDs, current building ACL and company ceiling all apply.
  -- Action-only connections need these choices even with an empty Read set.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,
    'label',CASE scope.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức'
      WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
      WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END,
    'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
    FROM public.authorization_scopes scope
    LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
    LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
    WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL
      AND (p_kind<>'context' OR result->'scopeIds' ? scope.id::text) AND (
      (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(building_ids)>0) OR
      (scope.scope_type='BUILDING' AND b.id=ANY(building_ids) AND scope.area_id IS NULL) OR
      (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(
        SELECT 1 FROM public.area_buildings ab WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(building_ids))));
  IF jsonb_array_length(choices)=0 THEN RETURN result; END IF;
  IF p_kind='context' THEN
    IF result#>'{restrictions,action}' ? action_key AND result#>'{companyCeilings,action}' ? action_key
      AND NOT(result#>'{effective,action}' ? action_key) THEN
      result:=jsonb_set(result,'{effective,action}',(result#>'{effective,action}')||to_jsonb(action_key),false);
    END IF;
    RETURN result;
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
    SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices)
    ORDER BY value->>'scopeId') selected;
  IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_task_scope_too_large' USING ERRCODE='22023'; END IF;
  result:=jsonb_set(result,'{scopes}',combined,false);
  IF NOT(result->'action' ? action_key) THEN result:=jsonb_set(result,'{action}',(result->'action')||to_jsonb(action_key),false); END IF;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v5(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_task_extend_options_v1(public.hermes_org_policy_options_v4(p_org),'org_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v5(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_task_extend_options_v1(public.hermes_connection_options_v4(p_org),'connection_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v5(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_task_extend_options_v1(public.hermes_connection_context_v4(p_connection_id),'context'); END $fn$;
DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_task_extend_options_v1(jsonb,text)',
    'public.hermes_org_policy_options_v5(uuid)','public.hermes_connection_options_v5(uuid)','public.hermes_connection_context_v5(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v5(uuid),public.hermes_connection_options_v5(uuid),public.hermes_connection_context_v5(uuid) TO authenticated;
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
 PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 RETURN jsonb_build_object('organizationId',c.organization_id,'buildingIds',to_jsonb(v_buildings),'input',p_input);
END $fn$;

-- Fixed action-input metadata, never a task-data Read grant. Canonical selector
-- tables execute as the caller under RLS, including task_types.view if required
-- by existing job_types policy. No additional grants on CRM tables are made.
CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
 SELECT auth.role()='authenticated' AND auth.uid() IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.organization_memberships m WHERE m.user_id=p_user AND m.organization_id=p_org
   AND m.status='ACTIVE' AND m.revoked_at IS NULL AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp())
   AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
$fn$;

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
   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(x.input->>'buildingId')::uuid AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))
  UNION ALL
  SELECT p.id,p.full_name FROM public.profiles p,args x WHERE x.input->>'kind'='assignees' AND app_private.hermes_task_assignee_member_v1(p.id,x.org)
   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(x.input->>'buildingId')::uuid AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))
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

CREATE OR REPLACE FUNCTION public.hermes_task_input_options_v1(p_binding jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 SELECT app_private.hermes_task_input_rows_v1(app_private.hermes_task_input_guard_v1(p_binding,p_input));
END;

ALTER FUNCTION app_private.hermes_task_input_guard_v1(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_input_guard_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_input_guard_v1(jsonb,jsonb) TO authenticated;
ALTER FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
ALTER FUNCTION app_private.hermes_task_input_rows_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_input_rows_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_input_rows_v1(jsonb) TO authenticated;
ALTER FUNCTION public.hermes_task_input_options_v1(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_task_input_options_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_task_input_options_v1(jsonb,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
