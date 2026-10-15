-- Cache draft. Allocated by scripts/tao-ten-migration.mjs; not applied.
-- Canonical jobs INSERT and profile selection execute as authenticated, under RLS.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
 VALUES('tasks.create','action',false) ON CONFLICT(capability) DO NOTHING;
CREATE TABLE IF NOT EXISTS app_private.hermes_task_create_receipts(
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 user_id uuid NOT NULL REFERENCES auth.users(id),request_id uuid NOT NULL,
 connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
 job_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),input jsonb NOT NULL,result jsonb,
 transaction_id bigint NOT NULL DEFAULT txid_current(),started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,user_id,request_id)
);
ALTER TABLE app_private.hermes_task_create_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_task_create_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_task_create_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- Private ledger/authority only: this definer never INSERTs/UPDATEs jobs.
CREATE OR REPLACE FUNCTION app_private.hermes_task_guard_v1(p_binding jsonb,p_operation text,p_input jsonb,p_finish boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections;s app_private.hermes_sessions;policy app_private.hermes_org_policies;
 member jsonb;context jsonb;receipt app_private.hermes_task_create_receipts;v_job public.jobs;
 v_request uuid;v_input jsonb;v_building uuid;v_room uuid;v_type uuid;v_assignee uuid;v_deadline timestamptz;
 v_result jsonb;k text;scope record;decision record;
BEGIN
 PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
 IF p_operation='create' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','title','description','buildingId','roomId','jobTypeId','priority','assigneeId','deadline']);
 ELSIF p_operation='status' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId']);
 ELSE RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 IF p_finish IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
 FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
  IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
  THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 v_request:=app_private.hermes_uuid_v1(p_input->'requestId');
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
 SELECT * INTO receipt FROM app_private.hermes_task_create_receipts r
  WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request FOR UPDATE;
 IF FOUND AND receipt.connection_id IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409';END IF;
 IF p_operation='status' AND receipt.request_id IS NULL THEN
  RETURN jsonb_build_object('input',p_input,'result',jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','not_found','job',NULL));
 END IF;
 IF p_operation='create' AND receipt.request_id IS NOT NULL AND receipt.input IS DISTINCT FROM p_input
  THEN RAISE EXCEPTION 'hermes_task_intent_changed' USING ERRCODE='PT409';END IF;
 v_input:=CASE WHEN p_operation='status' THEN receipt.input ELSE p_input END;
 v_building:=app_private.hermes_uuid_v1(v_input->'buildingId');v_type:=app_private.hermes_uuid_v1(v_input->'jobTypeId');
 IF v_input->'roomId'<>'null'::jsonb THEN v_room:=app_private.hermes_uuid_v1(v_input->'roomId');END IF;
 IF v_input->'assigneeId'<>'null'::jsonb THEN v_assignee:=app_private.hermes_uuid_v1(v_input->'assigneeId');END IF;
 IF jsonb_typeof(v_input->'title') IS DISTINCT FROM 'string' OR length(v_input->>'title') NOT BETWEEN 1 AND 200
  OR btrim(v_input->>'title') IS DISTINCT FROM v_input->>'title' OR v_input->>'title' ~ E'[\r\n\t]'
  OR (v_input->'description'<>'null'::jsonb AND (jsonb_typeof(v_input->'description') IS DISTINCT FROM 'string' OR length(v_input->>'description')>4000))
  OR jsonb_typeof(v_input->'priority') IS DISTINCT FROM 'string' OR v_input->>'priority' NOT IN ('NORMAL','LOW','URGENT')
  THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 IF v_input->'deadline'<>'null'::jsonb THEN
  IF jsonb_typeof(v_input->'deadline') IS DISTINCT FROM 'string' OR v_input->>'deadline' !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
   THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
  BEGIN v_deadline:=(v_input->>'deadline')::timestamptz;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END;
  IF to_char(v_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM v_input->>'deadline'
   THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';END IF;
 END IF;
 PERFORM 1 FROM public.buildings WHERE id=v_building AND organization_id=c.organization_id AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 IF v_room IS NOT NULL THEN
  PERFORM 1 FROM public.rooms WHERE id=v_room AND building_id=v_building AND organization_id=c.organization_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 END IF;
 PERFORM 1 FROM public.job_types WHERE id=v_type AND organization_id=c.organization_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 IF v_assignee IS NOT NULL THEN
  -- Membership is organization-scoped; profiles.organization_id is a legacy home org.
  PERFORM 1 FROM public.organization_memberships m WHERE m.user_id=v_assignee AND m.organization_id=c.organization_id
   AND m.status='ACTIVE' AND m.revoked_at IS NULL AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp())
   AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
  PERFORM 1 FROM public.profiles WHERE id=v_assignee FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 END IF;
 SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,'tasks.create',v_building,NULL);
 SELECT * INTO scope FROM app_private.authorized_scope_v3('tasks.create',c.organization_id);
 IF NOT COALESCE(decision.allowed,false) OR decision.authorization_version::text IS DISTINCT FROM member->>'authorizationVersion'
  OR (decision.nearest_deadline IS NOT NULL AND decision.nearest_deadline<=clock_timestamp())
  OR NOT(COALESCE(scope.org_wide,false) OR v_building=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
  THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
  AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND (overlay.scope_type='ORGANIZATION'
   OR overlay.scope_type='BUILDING' AND overlay.building_id=v_building
   OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
     WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=v_building)) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 IF p_operation='status' THEN
  v_result:=COALESCE(receipt.result,jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','unknown','job',NULL));
 ELSIF receipt.result IS NOT NULL THEN v_result:=receipt.result;
 ELSIF p_finish THEN
  IF receipt.request_id IS NULL OR receipt.transaction_id IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409';END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id=receipt.job_id FOR SHARE;
  IF NOT FOUND OR v_job.user_id IS DISTINCT FROM c.user_id OR v_job.organization_id IS DISTINCT FROM c.organization_id
   OR v_job.title IS DISTINCT FROM v_input->>'title' OR v_job.description IS DISTINCT FROM v_input->>'description'
   OR v_job.building_id IS DISTINCT FROM v_building OR v_job.room_id IS DISTINCT FROM v_room OR v_job.job_type_id IS DISTINCT FROM v_type
   OR v_job.priority IS DISTINCT FROM v_input->>'priority' OR v_job.assignee_id IS DISTINCT FROM v_assignee OR v_job.assignee_name IS NOT NULL
   OR v_job.deadline IS DISTINCT FROM v_deadline OR v_job.status IS DISTINCT FROM 'IN_PROGRESS' OR v_job.started_at IS DISTINCT FROM receipt.started_at
   OR v_job.visible_to_customer IS DISTINCT FROM false OR v_job.attachments IS NOT NULL OR v_job.completion_time IS NOT NULL
   OR v_job.completion_attachments IS NOT NULL OR v_job.completion_description IS NOT NULL OR v_job.code IS NULL
   THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409';END IF;
  v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','applied','job',jsonb_build_object(
   'id',v_job.id,'code',v_job.code,'title',v_job.title,'buildingId',v_job.building_id,'roomId',v_job.room_id,'jobTypeId',v_job.job_type_id,
   'priority',v_job.priority,'assigneeId',v_job.assignee_id,'deadline',to_char(v_job.deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'status',v_job.status,'createdBy',v_job.user_id));
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_TASK_CREATED','job',v_job.id,NULL,
   jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_request,'jobId',v_job.id,'assigneeId',v_assignee),'Hermes bounded task create');
  UPDATE app_private.hermes_task_create_receipts r SET result=v_result WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request;
 ELSE
  IF receipt.request_id IS NOT NULL THEN RAISE EXCEPTION 'hermes_task_outcome_unknown' USING ERRCODE='PT409';END IF;
  INSERT INTO app_private.hermes_task_create_receipts(organization_id,user_id,request_id,connection_id,input)
   VALUES(c.organization_id,c.user_id,v_request,c.id,p_input) RETURNING * INTO receipt;
 END IF;
 RETURN jsonb_build_object('input',p_input,'result',v_result,'jobId',receipt.job_id,'actorId',c.user_id,'organizationId',c.organization_id,'startedAt',receipt.started_at);
END $fn$;

-- Only the invoker touches canonical jobs. Existing RLS, triggers and code
-- allocation apply. RLS profiles is the same assignability query as the CRM UI.
CREATE OR REPLACE FUNCTION app_private.hermes_task_insert_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_input jsonb:=p_plan->'input';v_id uuid;v_assignee uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 IF p_plan->'result'<>'null'::jsonb THEN
  IF p_plan#>>'{result,outcome}'='applied' AND NOT EXISTS(SELECT 1 FROM public.jobs WHERE id=(p_plan#>>'{result,job,id}')::uuid)
   THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
  RETURN p_plan;
 END IF;
 IF p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=(v_input->>'buildingId')::uuid)
  OR NOT EXISTS(SELECT 1 FROM public.job_types WHERE id=(v_input->>'jobTypeId')::uuid)
  OR (v_input->>'roomId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=(v_input->>'roomId')::uuid))
  THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 v_assignee:=(v_input->>'assigneeId')::uuid;
 IF v_assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=v_assignee)
  THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501';END IF;
 INSERT INTO public.jobs(id,user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,deadline,status,started_at,visible_to_customer,attachments)
 VALUES((p_plan->>'jobId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_input->>'title',v_input->>'description',
  (v_input->>'buildingId')::uuid,(v_input->>'roomId')::uuid,(v_input->>'jobTypeId')::uuid,v_input->>'priority',v_assignee,NULL,
  (v_input->>'deadline')::timestamptz,'IN_PROGRESS',(p_plan->>'startedAt')::timestamptz,false,NULL) RETURNING id INTO v_id;
 IF v_id IS DISTINCT FROM (p_plan->>'jobId')::uuid THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409';END IF;
 RETURN p_plan;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_finish_v1(p_binding jsonb,p_operation text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 RETURN app_private.hermes_task_guard_v1(p_binding,p_operation,p_plan->'input',true)->'result';
END $fn$;

-- SQL-standard body binds private helper OIDs at definition time, so this
-- invoker does not need (or grant) USAGE on app_private. Never change to definer.
CREATE OR REPLACE FUNCTION public.hermes_task_create_action_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 SELECT app_private.hermes_task_finish_v1(p_binding,p_operation,
  app_private.hermes_task_insert_v1(app_private.hermes_task_guard_v1(p_binding,p_operation,p_input,false)));
END;

CREATE OR REPLACE FUNCTION public.hermes_task_create_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; buildings uuid[];
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 member:=app_private.hermes_member_v1(auth.uid(),p_organization_id); context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
   OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['tasks.create'],NULL);
 enabled:=policy.enabled AND 'tasks.create'=ANY(policy.action_capabilities)
   AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability='tasks.create' AND cap.mode='action' AND cap.enabled);
 allowed:=COALESCE(enabled AND context#>'{permissions,tasks.create}'='true'::jsonb,false);
 SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
   CROSS JOIN app_private.authorized_scope_v3('tasks.create',p_organization_id) scope
   WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.building_ids));
 IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,
   'allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings));
END $fn$;

ALTER FUNCTION app_private.hermes_task_guard_v1(jsonb,text,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_guard_v1(jsonb,text,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_guard_v1(jsonb,text,jsonb,boolean) TO authenticated;
ALTER FUNCTION app_private.hermes_task_insert_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_insert_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_insert_v1(jsonb) TO authenticated;
ALTER FUNCTION app_private.hermes_task_finish_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_finish_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_finish_v1(jsonb,text,jsonb) TO authenticated;
ALTER FUNCTION public.hermes_task_create_action_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_task_create_action_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_task_create_action_v1(jsonb,text,jsonb) TO authenticated;
ALTER FUNCTION public.hermes_task_create_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_task_create_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_task_create_capabilities_v1(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
