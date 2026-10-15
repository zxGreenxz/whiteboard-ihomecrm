-- CACHE CANDIDATE ONLY. Timestamp allocated by scripts/tao-ten-migration.mjs.
-- Existing catalog action room_pass.set_active, current CRM actor, saved Action
-- overlay, canonical setter, stable intent/CAS/receipt. No Copilot nonce/PIN.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
  VALUES('sale_phong.manage_pass_listings','action',false) ON CONFLICT(capability) DO NOTHING;
CREATE TABLE IF NOT EXISTS app_private.hermes_room_pass_receipts(
 connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),request_id uuid NOT NULL,
 organization_id uuid NOT NULL REFERENCES public.organizations(id),user_id uuid NOT NULL REFERENCES auth.users(id),
 input jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(connection_id,request_id)
);
ALTER TABLE app_private.hermes_room_pass_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_room_pass_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_room_pass_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

CREATE OR REPLACE FUNCTION app_private.hermes_room_pass_revision_v1(p_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $fn$
 SELECT encode(extensions.digest(convert_to(l.updated_at::text||':'||l.xmin::text||':'||l.ctid::text,'UTF8'),'sha256'),'hex')
 FROM public.room_pass_listings l WHERE l.id=p_id
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_pass_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; buildings uuid[];
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 member:=app_private.hermes_member_v1(auth.uid(),p_organization_id); context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
   OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['sale_phong.manage_pass_listings'],NULL);
 enabled:=policy.enabled AND 'sale_phong.manage_pass_listings'=ANY(policy.action_capabilities)
   AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability='sale_phong.manage_pass_listings' AND cap.mode='action' AND cap.enabled);
 allowed:=COALESCE(enabled AND context#>'{permissions,sale_phong.manage_pass_listings}'='true'::jsonb,false);
 SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
   CROSS JOIN app_private.authorized_scope_v3('sale_phong.manage_pass_listings',p_organization_id) scope
   WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.building_ids));
 IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,
   'allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_pass_action_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
 member jsonb; context jsonb; receipt app_private.hermes_room_pass_receipts; listing public.room_pass_listings;
 v_listing_id uuid; v_request_id uuid; v_building_id uuid; v_room_id uuid; revision text; v_result jsonb; k text; scope record; decision record;
BEGIN
 PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
 IF p_operation='observe' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['listingId']);
 ELSIF p_operation='set_active' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','listingId','active','expectedRevision']);
 ELSIF p_operation='status' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId']);
 ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
 FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
   IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
   THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 IF p_operation<>'status' THEN v_listing_id:=app_private.hermes_uuid_v1(p_input->'listingId'); END IF;
 IF p_operation<>'observe' THEN v_request_id:=app_private.hermes_uuid_v1(p_input->'requestId'); END IF;
 IF p_operation='set_active' AND (jsonb_typeof(p_input->'active') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_input->'expectedRevision') IS DISTINCT FROM 'string' OR p_input->>'expectedRevision' !~ '^[a-f0-9]{64}$')
   THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
 IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
   OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
 policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
 IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
   OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
   OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId' OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 context:=public.get_authorization_context_v1(c.organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
   OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 IF context#>'{permissions,sale_phong.manage_pass_listings}' IS DISTINCT FROM 'true'::jsonb
   OR NOT('sale_phong.manage_pass_listings'=ANY(c.action_capabilities)) OR NOT('sale_phong.manage_pass_listings'=ANY(policy.action_capabilities))
   OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings' AND mode='action' AND enabled)
   THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 IF p_operation='status' THEN
   SELECT * INTO receipt FROM app_private.hermes_room_pass_receipts r WHERE r.connection_id=c.id AND r.request_id=v_request_id
     AND r.organization_id=c.organization_id AND r.user_id=c.user_id;
   IF NOT FOUND THEN RETURN jsonb_build_object('requestId',v_request_id,'outcome','not_found','listing',NULL); END IF;
   v_listing_id:=(receipt.input->>'listingId')::uuid;
 END IF;
 SELECT l.building_id,l.room_id INTO v_building_id,v_room_id FROM public.room_pass_listings l WHERE l.id=v_listing_id AND l.organization_id=c.organization_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.buildings b WHERE b.id=v_building_id AND b.organization_id=c.organization_id AND b.deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.rooms r WHERE r.id=v_room_id AND r.building_id=v_building_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO listing FROM public.room_pass_listings l WHERE l.id=v_listing_id AND l.organization_id=c.organization_id AND l.building_id=v_building_id AND l.room_id=v_room_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,'sale_phong.manage_pass_listings',v_building_id,NULL);
 SELECT * INTO scope FROM app_private.authorized_scope_v3('sale_phong.manage_pass_listings',c.organization_id);
 IF NOT COALESCE(decision.allowed,false) OR decision.authorization_version::text IS DISTINCT FROM member->>'authorizationVersion'
   OR (decision.nearest_deadline IS NOT NULL AND decision.nearest_deadline<=clock_timestamp())
   OR NOT(COALESCE(scope.org_wide,false) OR v_building_id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
   OR NOT COALESCE(public.can_manage_pass_listing(v_building_id,listing.user_id),false)
   OR NOT EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
     AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND (overlay.scope_type='ORGANIZATION'
       OR overlay.scope_type='BUILDING' AND overlay.building_id=v_building_id
       OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
         WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=v_building_id)))
   THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 IF p_operation='status' THEN RETURN receipt.result; END IF;
 revision:=app_private.hermes_room_pass_revision_v1(listing.id);
 IF p_operation='observe' THEN RETURN jsonb_build_object('organizationId',c.organization_id,'listing',jsonb_build_object(
   'listingId',listing.id,'buildingId',listing.building_id,'roomId',listing.room_id,'active',listing.active,'revision',revision)); END IF;
 INSERT INTO app_private.hermes_room_pass_receipts(connection_id,request_id,organization_id,user_id,input)
   VALUES(c.id,v_request_id,c.organization_id,c.user_id,p_input) ON CONFLICT DO NOTHING;
 SELECT * INTO receipt FROM app_private.hermes_room_pass_receipts r WHERE r.connection_id=c.id AND r.request_id=v_request_id FOR UPDATE;
 IF receipt.input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'hermes_action_intent_changed' USING ERRCODE='PT409'; END IF;
 IF receipt.result IS NOT NULL THEN RETURN receipt.result; END IF;
 IF revision IS DISTINCT FROM p_input->>'expectedRevision' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 PERFORM public.set_room_pass_listing_active(listing.id,(p_input->>'active')::boolean);
 SELECT * INTO listing FROM public.room_pass_listings l WHERE l.id=v_listing_id;
 IF listing.organization_id IS DISTINCT FROM c.organization_id OR listing.building_id IS DISTINCT FROM v_building_id OR listing.room_id IS DISTINCT FROM v_room_id
   OR listing.active IS DISTINCT FROM (p_input->>'active')::boolean THEN RAISE EXCEPTION 'hermes_action_receipt_invalid' USING ERRCODE='PT409'; END IF;
 v_result:=jsonb_build_object('requestId',v_request_id,'outcome','applied','listing',jsonb_build_object('listingId',listing.id,'buildingId',listing.building_id,
   'roomId',listing.room_id,'active',listing.active,'revision',app_private.hermes_room_pass_revision_v1(listing.id)));
 UPDATE app_private.hermes_room_pass_receipts r SET result=v_result WHERE r.connection_id=c.id AND r.request_id=v_request_id;
 PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_ROOM_PASS_SET_ACTIVE','room_pass_listing',listing.id,
   jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_request_id,'active',listing.active));
 RETURN v_result;
END $fn$;
ALTER FUNCTION app_private.hermes_room_pass_revision_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_room_pass_action_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_room_pass_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_room_pass_revision_v1(uuid),public.hermes_room_pass_action_v1(jsonb,text,jsonb),public.hermes_room_pass_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_pass_action_v1(jsonb,text,jsonb),public.hermes_room_pass_capabilities_v1(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
