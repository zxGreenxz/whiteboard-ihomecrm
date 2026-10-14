-- Fixed CRM read domains. No Copilot page/chat flag, arbitrary table/RPC name,
-- role mirror, surrogate actor, money write, or additional approval workflow.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
  ('customers.view','read',false),('leads.view','read',false),('contracts.view','read',false),
  ('invoices.view','read',false),('assets.view','read',false),('services.view','read',false),
  ('tasks.view','read',false),('reports_real_estate.occupancy','read',false)
ON CONFLICT(capability) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.hermes_domain_permission_v1(p_domain text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT CASE p_domain WHEN 'customers' THEN 'customers.view' WHEN 'leads' THEN 'leads.view'
   WHEN 'contracts' THEN 'contracts.view' WHEN 'invoices' THEN 'invoices.view'
   WHEN 'assets' THEN 'assets.view' WHEN 'services' THEN 'services.view' WHEN 'tasks' THEN 'tasks.view'
   WHEN 'occupancy' THEN 'reports_real_estate.occupancy' END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_domain_text_v1(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT left(regexp_replace(translate(p_text,chr(8232)||chr(8233),'  '),'[[:cntrl:]]','','g'),200)
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text;
  result jsonb:='{}'; enabled boolean; allowed boolean; buildings uuid[];
  keys text[]:=ARRAY['customers.view','leads.view','contracts.view','invoices.view','assets.view','services.view','tasks.view','reports_real_estate.occupancy'];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,keys,'{}'::text[],NULL);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    allowed:=enabled AND context->'permissions'->key='true'::jsonb;
    buildings:='{}';
    IF COALESCE(allowed,false) THEN
      SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
      FROM app_private.authorized_scope_v3(key,p_organization_id) scope
      JOIN public.buildings b ON b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids));
      IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
    END IF;
    result:=result||jsonb_build_object(key,jsonb_build_object('allowed',COALESCE(allowed,false),'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

-- The connection lock excludes revoke/rebind while each read runs. The final
-- response repeats lifetime checks, so a slow query cannot outlive the credential.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; capabilities jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; org_wide boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; rows jsonb; next_cursor uuid;
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
  ELSIF p_domain='leads' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT lead.id,jsonb_build_object('id',lead.id,'name',app_private.hermes_domain_text_v1(COALESCE(lead.customer_name,'')),
        'status',lead.status,'buildingId',lead.building_id,'roomId',room.id,'nextFollowUp',lead.next_follow_up_date) item
      FROM public.leads lead LEFT JOIN public.rooms room ON room.id=lead.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=lead.building_id AND room.building_id=ANY(buildings)
      WHERE lead.organization_id=c.organization_id AND lead.deleted_at IS NULL
        AND (lead.building_id=ANY(buildings) OR (lead.building_id IS NULL AND org_wide))
        AND (cursor_id IS NULL OR lead.id>cursor_id) AND (v_status IS NULL OR lead.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(lead.customer_name,'')))>0)
      ORDER BY lead.id LIMIT row_limit+1) found;
  ELSIF p_domain='contracts' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT contract.id,jsonb_build_object('id',contract.id,'number',app_private.hermes_domain_text_v1(contract.contract_number),
        'status',contract.status,'buildingId',room.building_id,'roomId',room.id,'startDate',contract.start_date,
        'endDate',COALESCE(contract.actual_end_date,contract.end_date)) item
      FROM public.contracts contract JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      WHERE contract.organization_id=c.organization_id AND contract.deleted_at IS NULL AND room.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR contract.id>cursor_id) AND (v_status IS NULL OR contract.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(contract.contract_number,'')))>0)
      ORDER BY contract.id LIMIT row_limit+1) found;
  ELSIF p_domain='invoices' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT invoice.id,jsonb_build_object('id',invoice.id,'number',app_private.hermes_domain_text_v1(invoice.invoice_number),
        'status',invoice.status,'buildingId',room.building_id,'roomId',room.id,'billingMonth',invoice.billing_month,'totalAmount',COALESCE(invoice.total_amount,0)::text) item
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id AND room.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR invoice.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')))>0)
      ORDER BY invoice.id LIMIT row_limit+1) found;
  ELSIF p_domain='assets' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT asset.id,jsonb_build_object('id',asset.id,'name',app_private.hermes_domain_text_v1(COALESCE(asset.name,'')),
        'code',app_private.hermes_domain_text_v1(asset.code),'condition',asset.condition,'buildingId',asset.building_id,'roomId',room.id,'quantity',COALESCE(asset.quantity,0)::text) item
      FROM public.assets asset LEFT JOIN public.rooms room ON room.id=asset.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=asset.building_id AND room.building_id=ANY(buildings)
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (cursor_id IS NULL OR asset.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      ORDER BY asset.id LIMIT row_limit+1) found;
  ELSIF p_domain='services' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT service.id,jsonb_build_object('id',service.id,'name',app_private.hermes_domain_text_v1(COALESCE(service.name,'')),
        'code',app_private.hermes_domain_text_v1(service.code),'unit',app_private.hermes_domain_text_v1(service.unit),'unitPrice',COALESCE(service.unit_price,0)::text,
        'buildingIds',COALESCE((SELECT jsonb_agg(DISTINCT bs.building_id ORDER BY bs.building_id) FROM public.building_services bs
          WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings)),'[]')) item
      FROM public.services service WHERE service.organization_id=c.organization_id AND service.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings))
          OR (org_wide AND service.user_id=ANY(public.current_visible_owner_ids()) AND NOT EXISTS(SELECT 1 FROM public.building_services bs
            WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active)))
        AND (cursor_id IS NULL OR service.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(service.name,'')||' '||COALESCE(service.code,'')))>0)
      ORDER BY service.id LIMIT row_limit+1) found;
  ELSIF p_domain='tasks' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT job.id,jsonb_build_object('id',job.id,'title',app_private.hermes_domain_text_v1(COALESCE(job.title,'')),
        'code',app_private.hermes_domain_text_v1(job.code),'status',job.status,'buildingId',job.building_id,'roomId',room.id,'deadline',job.deadline) item
      FROM public.jobs job LEFT JOIN public.rooms room ON room.id=job.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=job.building_id AND room.building_id=ANY(buildings)
      WHERE job.organization_id=c.organization_id AND (job.building_id=ANY(buildings) OR (job.building_id IS NULL AND org_wide))
        AND (cursor_id IS NULL OR job.id>cursor_id) AND (v_status IS NULL OR job.status=v_status)
        AND (query='' OR position(query IN lower(COALESCE(job.title,'')||' '||COALESCE(job.code,'')))>0)
      ORDER BY job.id LIMIT row_limit+1) found;
  ELSE
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT building.id,jsonb_build_object('id',building.id,'buildingId',building.id,'name',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'total',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL),
        'occupied',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='OCCUPIED'),
        'available',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='AVAILABLE')) item
      FROM public.buildings building WHERE building.organization_id=c.organization_id AND building.deleted_at IS NULL AND building.id=ANY(buildings)
        AND (cursor_id IS NULL OR building.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(building.name,'')))>0)
      ORDER BY building.id LIMIT row_limit+1) found;
  END IF;
  IF jsonb_array_length(rows)>row_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
    next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
  END IF;
  IF octet_length(rows::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,'items',rows,'nextCursor',next_cursor);
END $fn$;

-- Called only from the reviewed v3 metadata wrappers, after their base policy
-- authorization. Scope choices may now serve a domain-only reader with no
-- rooms.view grant; they still convey no runtime read authority.
CREATE OR REPLACE FUNCTION app_private.hermes_domain_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; capabilities jsonb; key text;
  policy app_private.hermes_org_policies; extra jsonb; choices jsonb; building_ids uuid[]; org_wide boolean:=false;
  keys text[]:=ARRAY['customers.view','leads.view','contracts.view','invoices.view','assets.view','services.view','tasks.view','reports_real_estate.occupancy'];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context') OR jsonb_typeof(result) IS DISTINCT FROM 'object'
    OR auth.role() IS DISTINCT FROM 'authenticated' OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- The v3 wrapper has already enforced CRM users.edit through its v1 base.
    -- Do not add a role restriction: an ordinary authorized admin remains valid.
    SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]') INTO extra
      FROM app_private.hermes_capabilities WHERE capability=ANY(keys) AND mode='read' AND enabled;
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO extra FROM (
      SELECT DISTINCT value FROM jsonb_array_elements((result#>'{choices,read}')||extra)) selected;
    RETURN jsonb_set(result,'{choices,read}',extra,false);
  END IF;
  capabilities:=public.hermes_domain_capabilities_v1(org);
  IF capabilities->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR capabilities->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR capabilities->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  FOREACH key IN ARRAY keys LOOP
    IF capabilities->'permissions'->key->'allowed'='true'::jsonb THEN
      IF p_kind='connection_options' AND result->'enabled'='true'::jsonb THEN
        IF NOT(result->'read' ? key) THEN result:=jsonb_set(result,'{read}',(result->'read')||to_jsonb(key),false); END IF;
        IF EXISTS(SELECT 1 FROM app_private.authorized_scope_v3(key,org) scope WHERE scope.org_wide) THEN org_wide:=true; END IF;
      ELSIF p_kind='context' AND result#>'{restrictions,read}' ? key AND result#>'{companyCeilings,read}' ? key THEN
        IF NOT(result#>'{effective,read}' ? key) THEN result:=jsonb_set(result,'{effective,read}',(result#>'{effective,read}')||to_jsonb(key),false); END IF;
      END IF;
    END IF;
  END LOOP;
  IF p_kind='connection_options' AND result->'enabled'='true'::jsonb THEN
    policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
    SELECT COALESCE(array_agg(DISTINCT building.value::uuid),'{}'::uuid[]) INTO building_ids
      FROM jsonb_each(capabilities->'permissions') permission
      CROSS JOIN LATERAL jsonb_array_elements_text(permission.value->'buildingIds') building(value)
      WHERE permission.value->'allowed'='true'::jsonb;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,
      'label',CASE scope.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức' WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
        WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END,
      'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
      FROM public.authorization_scopes scope
      LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
      LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
      WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL AND (
        (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND (org_wide OR cardinality(building_ids)>0)) OR
        (scope.scope_type='BUILDING' AND b.id=ANY(building_ids) AND scope.area_id IS NULL) OR
        (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(SELECT 1 FROM public.area_buildings ab
          WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(building_ids))));
    SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO choices FROM (
      SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices) ORDER BY value->>'scopeId') selected;
    IF jsonb_array_length(choices)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
    result:=jsonb_set(result,'{scopes}',choices,false);
    IF jsonb_array_length(choices)=0 THEN
      SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO extra FROM jsonb_array_elements(result->'read') value
        WHERE NOT(value#>>'{}'=ANY(keys));
      result:=jsonb_set(result,'{read}',extra,false);
    END IF;
  END IF;
  RETURN result;
END $fn$;

DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_domain_permission_v1(text)','app_private.hermes_domain_text_v1(text)',
    'app_private.hermes_domain_extend_options_v1(jsonb,text)',
    'public.hermes_domain_capabilities_v1(uuid)','public.hermes_domain_read_v1(jsonb,text,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v1(uuid),public.hermes_domain_read_v1(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
