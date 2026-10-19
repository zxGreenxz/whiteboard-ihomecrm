-- TG3b: fixed private read plan, followed by the shared CRM reader under the
-- caller's RLS. No writer locks, capability-catalog waterfall or final reread.
-- The application opts in after this migration and the shared cores are ready.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_metadata_member_v1(uuid,uuid)',
    'app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)',
    'public.get_authorization_context_v1(uuid)'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(signature);
    IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
      THEN RAISE EXCEPTION 'hermes_fast_read_dependency_invalid: %',signature; END IF;
  END LOOP;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_rows_fast_v1(jsonb)');
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_fast_read_requires_shared_invoker_reader'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_domain_read_scope_fast_v1(p_binding jsonb,p_domain text,p_input jsonb,p_caller text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; enabled boolean;
  selected uuid[]; buildings uuid[]; customer_buildings uuid[]:='{}'; contract_buildings uuid[]:='{}';
  overlay_org boolean; org_wide boolean; requested uuid; cursor_id uuid; row_limit integer; query text; status text;
  result jsonb; scope_sets jsonb:='{}'; grant_state jsonb;
BEGIN
  IF p_caller IS DISTINCT FROM 'authenticated' OR auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  permission:=CASE p_domain WHEN 'customers' THEN 'customers.view' WHEN 'contracts' THEN 'contracts.view' WHEN 'invoices' THEN 'invoices.view' END;
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedSessionRevision']);
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  IF jsonb_typeof(p_binding->'tokenDigest') IS DISTINCT FROM 'string' OR (p_binding->>'tokenDigest') !~ '^[a-f0-9]{64}$'
    OR app_private.hermes_integer_v1(p_binding->'expectedEpoch')<1 OR app_private.hermes_integer_v1(p_binding->'expectedSessionRevision')<1
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  row_limit:=app_private.hermes_integer_v1(p_input->'limit'); query:=p_input->>'query'; status:=p_input->>'status';
  IF row_limit NOT BETWEEN 1 AND 50 OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(query)>200
    OR query ~ '[[:cntrl:]]' OR position(chr(8232) IN query)>0 OR position(chr(8233) IN query)>0
    OR (p_input->'status'<>'null'::jsonb AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR p_domain<>'contracts'
      OR status NOT IN ('DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED')))
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_input->'cursor'<>'null'::jsonb THEN cursor_id:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  IF p_input->'buildingId'<>'null'::jsonb THEN requested:=app_private.hermes_uuid_v1(p_input->'buildingId'); END IF;

  -- A single statement snapshot admits the read. Do not reuse a writer helper:
  -- that would lock the organization and revalidate after the business query.
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p_binding->>'tokenDigest';
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id;
  IF c.id IS NULL OR s.id IS NULL OR t.token_digest IS NULL OR a.id IS NULL
    OR c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.user_id IS DISTINCT FROM auth.uid()
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR a.state<>'ACTIVE'
    OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=now()
    OR s.user_id IS DISTINCT FROM c.user_id OR s.organization_id IS DISTINCT FROM c.organization_id OR s.assistant_id IS DISTINCT FROM c.assistant_id
    OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR t.revoked_at IS NOT NULL OR t.expires_at<=now() OR t.created_at>now() OR t.created_at+interval '30 days'<=now()
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch' OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  member:=app_private.hermes_metadata_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  IF context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO selected FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) intersection;
  overlay_org:=EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(selected) AND scope.organization_id=c.organization_id
    AND scope.scope_type='ORGANIZATION' AND scope.cashbook_id IS NULL);

  -- Only the requested permission and its two possible embeds are evaluated;
  -- each embed retains its own CRM grant and explicit Hermes exclusion.
  FOREACH k IN ARRAY ARRAY[permission,'customers.view','contracts.view'] LOOP
    IF scope_sets ? k THEN CONTINUE; END IF;
    enabled:=COALESCE(policy.enabled,false) AND k=ANY(policy.read_capabilities) AND k=ANY(c.read_capabilities)
      AND NOT(k=ANY(c.excluded_read)) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=k AND h.mode='read' AND h.enabled);
    grant_state:=app_private.hermes_metadata_domain_grant_v1(c.organization_id,k,enabled,context);
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
      WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL AND grant_state->'buildingIds' ? b.id::text
        AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(selected) AND scope.organization_id=c.organization_id
          AND scope.cashbook_id IS NULL AND (scope.scope_type='ORGANIZATION' OR scope.scope_type='BUILDING' AND scope.building_id=b.id
            OR scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas ar
              ON ar.id=ab.area_id AND ar.organization_id=ab.organization_id AND ar.deleted_at IS NULL
              WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id)));
    scope_sets:=scope_sets||jsonb_build_object(k,jsonb_build_object('buildingIds',buildings,'allowed',grant_state->'allowed',
      'orgWide',COALESCE(grant_state->'orgWide'='true'::jsonb,false) AND overlay_org));
  END LOOP;
  state:=scope_sets->permission;
  IF state->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(v::uuid),'{}'::uuid[]) INTO buildings FROM jsonb_array_elements_text(state->'buildingIds') v;
  SELECT COALESCE(array_agg(v::uuid),'{}'::uuid[]) INTO customer_buildings FROM jsonb_array_elements_text(scope_sets#>'{customers.view,buildingIds}') v;
  SELECT COALESCE(array_agg(v::uuid),'{}'::uuid[]) INTO contract_buildings FROM jsonb_array_elements_text(scope_sets#>'{contracts.view,buildingIds}') v;
  org_wide:=state->'orgWide'='true'::jsonb;
  IF requested IS NOT NULL THEN
    IF NOT(requested=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested]; org_wide:=false;
  END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'connectionId',c.id,'permission',permission,
    'buildingIds',buildings,'cashbookIds','[]'::jsonb,'customerBuildingIds',customer_buildings,'contractBuildingIds',contract_buildings,
    'orgWide',org_wide,'query',btrim(query),'limit',row_limit,'cursor',cursor_id,'buildingId',requested,'status',status,
    'domain',p_domain,'fetchedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_domain_read_fast_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH scope AS MATERIALIZED (SELECT app_private.hermes_domain_read_scope_fast_v1(p_binding,p_domain,p_input,current_user::text) AS plan)
  SELECT jsonb_build_object('authority',jsonb_build_object('organizationId',plan->'organizationId','userId',plan->'userId',
    'connectionId',plan->'connectionId','permission',plan->'permission','buildingIds',plan->'buildingIds','cashbookIds',plan->'cashbookIds'),
    'result',app_private.hermes_domain_read_rows_fast_v1(plan)) FROM scope;
END;

ALTER FUNCTION app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_fast_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text),public.hermes_domain_read_fast_v1(jsonb,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text),public.hermes_domain_read_fast_v1(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
