-- Bounded CRM create: actual caller JWT, canonical tables/RLS/triggers.
-- Unassigned records require an ORGANIZATION Hermes overlay. CRM permission
-- remains the canonical any-scope entity permission; no CRM org-wide prerequisite.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
 ('customers.create','action',false),('leads.create','action',false) ON CONFLICT(capability) DO NOTHING;
CREATE TABLE IF NOT EXISTS app_private.hermes_customer_create_receipts(
 organization_id uuid NOT NULL REFERENCES public.organizations(id),user_id uuid NOT NULL REFERENCES auth.users(id),
 request_id uuid NOT NULL,connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
 kind text NOT NULL CHECK(kind IN ('customer','lead')),input jsonb NOT NULL,record_id uuid NOT NULL DEFAULT gen_random_uuid(),
 result jsonb,transaction_id bigint NOT NULL DEFAULT txid_current(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,user_id,request_id)
);
ALTER TABLE app_private.hermes_customer_create_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_customer_create_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_customer_create_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- This definer owns only authority, the private ledger and audit. Canonical
-- customer/lead INSERT is deliberately in the invoker below.
CREATE OR REPLACE FUNCTION app_private.hermes_customer_guard_v1(p_binding jsonb,p_kind text,p_operation text,p_input jsonb,p_finish boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections;s app_private.hermes_sessions;policy app_private.hermes_org_policies;
 member jsonb;context jsonb;receipt app_private.hermes_customer_create_receipts;v_row jsonb;
 v_request uuid;v_input jsonb;v_result jsonb;permission text;k text;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('customer','lead') THEN RAISE EXCEPTION 'hermes_customer_invalid' USING ERRCODE='22023';END IF;
 permission:=CASE p_kind WHEN 'customer' THEN 'customers.create' ELSE 'leads.create' END;
 PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
 IF p_operation='create' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','name','phone','email','notes']||CASE p_kind WHEN 'lead' THEN ARRAY['source'] ELSE '{}'::text[] END);
 ELSIF p_operation='status' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId']);
 ELSE RAISE EXCEPTION 'hermes_customer_invalid' USING ERRCODE='22023';END IF;
 IF p_finish IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
 FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
  IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_customer_invalid' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
  THEN RAISE EXCEPTION 'hermes_customer_invalid' USING ERRCODE='22023';END IF;
 v_request:=app_private.hermes_uuid_v1(p_input->'requestId');
 c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
 IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
  OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
 policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
 IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
  OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
  OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId' OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
  THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409';END IF;
 context:=public.get_authorization_context_v1(c.organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409';END IF;
 PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=permission AND mode='action' AND enabled FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR context->'permissions'->permission IS DISTINCT FROM 'true'::jsonb
  OR NOT(permission=ANY(c.action_capabilities)) OR NOT(permission=ANY(policy.action_capabilities))
  OR NOT public.can_access_org_entity(CASE p_kind WHEN 'customer' THEN 'customers' ELSE 'leads' END,'create')
  THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 -- These global records have no building to intersect with a building overlay.
 -- This is an overlay restriction, not an additional CRM permission requirement.
 PERFORM 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
  AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND overlay.scope_type='ORGANIZATION'
  AND overlay.building_id IS NULL AND overlay.area_id IS NULL AND overlay.cashbook_id IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 SELECT * INTO receipt FROM app_private.hermes_customer_create_receipts r
  WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request FOR UPDATE;
 IF FOUND AND (receipt.connection_id IS DISTINCT FROM c.id OR receipt.kind IS DISTINCT FROM p_kind)
  THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409';END IF;
 IF p_operation='status' AND receipt.request_id IS NULL THEN
  RETURN jsonb_build_object('input',p_input,'kind',p_kind,'result',jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'kind',p_kind,'outcome','not_found','record',NULL));
 END IF;
 IF p_operation='create' AND receipt.request_id IS NOT NULL AND receipt.input IS DISTINCT FROM p_input
  THEN RAISE EXCEPTION 'hermes_customer_intent_changed' USING ERRCODE='PT409';END IF;
 v_input:=CASE WHEN p_operation='status' THEN receipt.input ELSE p_input END;
 IF jsonb_typeof(v_input->'name') IS DISTINCT FROM 'string' OR length(v_input->>'name') NOT BETWEEN 1 AND 200
  OR btrim(v_input->>'name') IS DISTINCT FROM v_input->>'name' OR v_input->>'name' ~ E'[\r\n\t]'
  OR jsonb_typeof(v_input->'phone') IS DISTINCT FROM 'string' OR v_input->>'phone' !~ '^[0-9]{10,11}$'
  OR (v_input->'email'<>'null'::jsonb AND (jsonb_typeof(v_input->'email') IS DISTINCT FROM 'string' OR length(v_input->>'email')>254 OR v_input->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
  OR (v_input->'notes'<>'null'::jsonb AND (jsonb_typeof(v_input->'notes') IS DISTINCT FROM 'string' OR length(v_input->>'notes')>4000))
  OR (p_kind='lead' AND (jsonb_typeof(v_input->'source') IS DISTINCT FROM 'string' OR v_input->>'source' NOT IN ('FACEBOOK','ZALO','PHONE','REFERRAL','WALK_IN','WEBSITE','OTHER')))
  THEN RAISE EXCEPTION 'hermes_customer_invalid' USING ERRCODE='22023';END IF;
 PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 IF p_operation='status' THEN
  v_result:=COALESCE(receipt.result,jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'kind',p_kind,'outcome','unknown','record',NULL));
 ELSIF receipt.result IS NOT NULL THEN v_result:=receipt.result;
 ELSIF p_finish THEN
  IF receipt.request_id IS NULL OR receipt.transaction_id IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409';END IF;
  IF p_kind='customer' THEN
   SELECT to_jsonb(customer) INTO v_row FROM public.customers customer WHERE id=receipt.record_id FOR SHARE;
   IF v_row->>'full_name' IS DISTINCT FROM v_input->>'name' OR v_row->>'customer_type' IS DISTINCT FROM 'INDIVIDUAL'
    OR v_row->>'status_v2' IS DISTINCT FROM 'WALK_IN' OR v_row->'is_foreign' IS DISTINCT FROM 'false'::jsonb
    OR v_row->>'status' IS DISTINCT FROM 'PROSPECT'
    THEN RAISE EXCEPTION 'hermes_customer_receipt_invalid' USING ERRCODE='PT409';END IF;
  ELSE
   SELECT to_jsonb(lead) INTO v_row FROM public.leads lead WHERE id=receipt.record_id FOR SHARE;
   IF v_row->>'customer_name' IS DISTINCT FROM v_input->>'name' OR v_row->>'source' IS DISTINCT FROM v_input->>'source' OR v_row->>'status' IS DISTINCT FROM 'B1_LEAD'
    OR v_row->>'building_id' IS NOT NULL OR v_row->>'room_id' IS NOT NULL OR v_row->>'assigned_staff_id' IS NOT NULL OR v_row->>'appointment_date' IS NOT NULL
    OR v_row->>'deposit_id' IS NOT NULL OR v_row->>'contract_id' IS NOT NULL OR v_row->'openclaw_assignment_revision' IS DISTINCT FROM '1'::jsonb
    THEN RAISE EXCEPTION 'hermes_customer_receipt_invalid' USING ERRCODE='PT409';END IF;
  END IF;
  IF v_row IS NULL OR v_row->>'user_id' IS DISTINCT FROM c.user_id::text OR v_row->>'organization_id' IS DISTINCT FROM c.organization_id::text
   OR v_row->>'phone' IS DISTINCT FROM v_input->>'phone' OR v_row->>'email' IS DISTINCT FROM v_input->>'email'
   OR v_row->>'notes' IS DISTINCT FROM v_input->>'notes' OR v_row->>'deleted_at' IS NOT NULL
   THEN RAISE EXCEPTION 'hermes_customer_receipt_invalid' USING ERRCODE='PT409';END IF;
  v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'kind',p_kind,'outcome','applied','record',jsonb_build_object(
   'id',receipt.record_id,'name',v_input->>'name','phone',v_row->>'phone','email',v_row->>'email','notes',v_row->>'notes',
   'status',CASE p_kind WHEN 'customer' THEN v_row->>'status_v2' ELSE v_row->>'status' END,
   'customerType',CASE p_kind WHEN 'customer' THEN v_row->>'customer_type' END,'source',CASE p_kind WHEN 'lead' THEN v_row->>'source' END,'createdBy',c.user_id));
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_CUSTOMER_CREATED',p_kind,receipt.record_id,NULL,
   jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_request,'kind',p_kind,'recordId',receipt.record_id),'Hermes bounded CRM create');
  UPDATE app_private.hermes_customer_create_receipts r SET result=v_result WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request;
 ELSE
  IF receipt.request_id IS NOT NULL THEN RAISE EXCEPTION 'hermes_customer_outcome_unknown' USING ERRCODE='PT409';END IF;
  INSERT INTO app_private.hermes_customer_create_receipts(organization_id,user_id,request_id,connection_id,kind,input)
   VALUES(c.organization_id,c.user_id,v_request,c.id,p_kind,p_input) RETURNING * INTO receipt;
 END IF;
 RETURN jsonb_build_object('input',p_input,'kind',p_kind,'result',v_result,'recordId',receipt.record_id,'actorId',c.user_id,'organizationId',c.organization_id);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_customer_insert_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_input jsonb:=p_plan->'input';v_id uuid;v_kind text:=p_plan->>'kind';
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 IF p_plan->'result'<>'null'::jsonb THEN
  IF p_plan#>>'{result,outcome}'='applied' AND (
   (v_kind='customer' AND NOT EXISTS(SELECT 1 FROM public.customers WHERE id=(p_plan#>>'{result,record,id}')::uuid AND organization_id=(p_plan#>>'{result,organizationId}')::uuid AND deleted_at IS NULL)) OR
   (v_kind='lead' AND NOT EXISTS(SELECT 1 FROM public.leads WHERE id=(p_plan#>>'{result,record,id}')::uuid AND organization_id=(p_plan#>>'{result,organizationId}')::uuid AND deleted_at IS NULL)))
   THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
  RETURN p_plan;
 END IF;
 IF p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 IF v_kind='customer' THEN
  INSERT INTO public.customers(id,user_id,organization_id,customer_type,full_name,phone,email,notes,status,status_v2,is_foreign)
  VALUES((p_plan->>'recordId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,'INDIVIDUAL',v_input->>'name',v_input->>'phone',v_input->>'email',v_input->>'notes','PROSPECT','WALK_IN',false) RETURNING id INTO v_id;
 ELSIF v_kind='lead' THEN
  INSERT INTO public.leads(id,user_id,organization_id,customer_name,phone,email,notes,source,status)
  VALUES((p_plan->>'recordId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_input->>'name',v_input->>'phone',v_input->>'email',v_input->>'notes',(v_input->>'source')::public.lead_source,'B1_LEAD') RETURNING id INTO v_id;
 ELSE RAISE EXCEPTION 'hermes_customer_invalid' USING ERRCODE='22023';END IF;
 IF v_id IS DISTINCT FROM (p_plan->>'recordId')::uuid THEN RAISE EXCEPTION 'hermes_customer_receipt_invalid' USING ERRCODE='PT409';END IF;
 RETURN p_plan;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_customer_finish_v1(p_binding jsonb,p_kind text,p_operation text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_customer_guard_v1(p_binding,p_kind,p_operation,p_plan->'input',true)->'result';END $fn$;

-- OIDs bind at definition time; do not expose app_private USAGE to the caller.
CREATE OR REPLACE FUNCTION public.hermes_customer_create_action_v1(p_binding jsonb,p_kind text,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 SELECT app_private.hermes_customer_finish_v1(p_binding,p_kind,p_operation,
  app_private.hermes_customer_insert_v1(app_private.hermes_customer_guard_v1(p_binding,p_kind,p_operation,p_input,false)));
END;

CREATE OR REPLACE FUNCTION public.hermes_customer_create_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb;context jsonb;policy app_private.hermes_org_policies;enabled boolean;allowed boolean;key text;permissions jsonb:='{}';
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409';END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['customers.create','leads.create'],NULL);
 FOREACH key IN ARRAY ARRAY['customers.create','leads.create'] LOOP
  enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
  allowed:=COALESCE(enabled AND context->'permissions'->key='true'::jsonb AND public.can_access_org_entity(split_part(key,'.',1),'create'),false);
  permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false)));
 END LOOP;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions);
END $fn$;

DO $acl$ DECLARE signature text;BEGIN
 FOREACH signature IN ARRAY ARRAY['app_private.hermes_customer_guard_v1(jsonb,text,text,jsonb,boolean)','app_private.hermes_customer_insert_v1(jsonb)',
  'app_private.hermes_customer_finish_v1(jsonb,text,text,jsonb)','public.hermes_customer_create_action_v1(jsonb,text,text,jsonb)','public.hermes_customer_create_capabilities_v1(uuid)'] LOOP
  EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO authenticated';
 END LOOP;
END $acl$;
COMMIT;
NOTIFY pgrst,'reload schema';
