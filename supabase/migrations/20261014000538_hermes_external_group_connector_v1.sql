-- External MCP connection origin. No synthetic DM command, actor claim or JWT.
-- Reuses CRM authority, room facts, immutable group jobs and worker admission.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

ALTER TABLE app_private.hermes_group_dispatches ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'private_command';
ALTER TABLE app_private.hermes_group_dispatches ALTER COLUMN command_id DROP NOT NULL;
DO $migration$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.hermes_group_dispatches'::regclass AND conname='hermes_group_origin_check') THEN
    ALTER TABLE app_private.hermes_group_dispatches ADD CONSTRAINT hermes_group_origin_check CHECK(
      (origin='private_command' AND command_id IS NOT NULL) OR (origin='external_mcp' AND command_id IS NULL));
  END IF;
END $migration$;

-- Authenticated callers are bound to the persisted REAL user session. The
-- service-role worker reaches this private helper only through its fixed RPC;
-- it rechecks the persisted actor, without rewriting request JWT claims.
CREATE OR REPLACE FUNCTION app_private.hermes_external_group_context_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  policy app_private.hermes_org_policies; x app_private.hermes_zalo_bindings;
  a public.zalo_accounts; bot app_private.hermes_zalo_bots; ingress app_private.hermes_zalo_ingress_sessions;
  lease public.zalo_worker_lease; v_member jsonb; v_auth record; v_key text; v_scopes uuid[];
  v_read jsonb:='["chat_zalo.view"]'; v_action jsonb:='[]'; v_owner jsonb; v_binding jsonb;
  v_sender jsonb; v_groups jsonb; v_context text; v_now timestamptz; v_exp timestamptz;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>8
    OR NOT(p ?& ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId',
      'expectedAuthorizationVersion','expectedSessionRevision','requestId'])
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['connectionId','expectedMembershipId','requestId'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'string' OR p->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['expectedEpoch','expectedPolicyVersion','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'number' OR p->>v_key !~ '^(0|[1-9][0-9]{0,15})$'
      OR (p->>v_key)::numeric>=9007199254740991 OR (v_key<>'expectedPolicyVersion' AND (p->>v_key)::numeric=0)
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest';
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF auth.role() NOT IN ('authenticated','service_role') OR auth.role() IS NULL OR
    (auth.role()='authenticated' AND (auth.uid() IS DISTINCT FROM c.user_id OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'))
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF c.id::text IS DISTINCT FROM p->>'connectionId' OR c.epoch::text IS DISTINCT FROM p->>'expectedEpoch'
    OR policy.version::text IS DISTINCT FROM p->>'expectedPolicyVersion' OR s.revision::text IS DISTINCT FROM p->>'expectedSessionRevision'
    OR v_member->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId'
    OR v_member->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.view');
  IF v_auth.allowed IS DISTINCT FROM true OR v_auth.authorization_version::text IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    OR NOT('chat_zalo.view'=ANY(c.read_capabilities)) OR NOT('chat_zalo.view'=ANY(policy.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) AS id INTERSECT SELECT unnest(policy.scope_ids) AS id) selected;
  IF 'rooms.view'=ANY(c.read_capabilities) AND 'rooms.view'=ANY(policy.read_capabilities) AND cardinality(v_scopes)>0
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled)
    THEN v_read:=v_read||'"rooms.view"'::jsonb; END IF;
  SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.send');
  IF v_auth.allowed AND 'chat_zalo.send'=ANY(c.action_capabilities) AND 'chat_zalo.send'=ANY(policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled)
    THEN v_action:='["chat_zalo.send"]'; END IF;
  -- The org decision lock serializes binding changes. Ambiguity is denied,
  -- never resolved by taking the first sender or trusting an account argument.
  IF (SELECT count(*) FROM app_private.hermes_zalo_bindings WHERE connection_id=c.id AND state='ACTIVE' AND revoked_at IS NULL)<>1
    THEN RAISE EXCEPTION 'hermes_group_sender_unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE connection_id=c.id AND state='ACTIVE' AND revoked_at IS NULL;
  SELECT * INTO lease FROM public.zalo_worker_lease WHERE id='singleton' FOR UPDATE;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=x.account_id FOR SHARE;
  SELECT * INTO bot FROM app_private.hermes_zalo_bots WHERE account_id=a.id FOR SHARE;
  SELECT * INTO ingress FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id FOR SHARE;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=x.id FOR SHARE;
  v_now:=clock_timestamp();
  IF x.id IS NULL OR a.id IS NULL OR bot.account_id IS NULL OR ingress.account_id IS NULL OR lease.id IS NULL
    OR x.state<>'ACTIVE' OR x.revoked_at IS NOT NULL OR x.connection_id<>c.id OR x.connection_epoch<>c.epoch
    OR x.user_id<>c.user_id OR x.organization_id<>c.organization_id OR x.assistant_id<>c.assistant_id
    OR x.sender_uid=ingress.own_uid OR a.kind<>'personal' OR a.status<>'connected' OR a.organization_id<>c.organization_id
    OR NOT bot.enabled OR bot.organization_id<>c.organization_id OR bot.version<>x.bot_version
    OR ingress.organization_id<>c.organization_id OR ingress.account_owner_id<>a.user_id OR ingress.own_uid IS DISTINCT FROM a.zalo_uid
    OR ingress.login_requested_at IS DISTINCT FROM a.login_requested_at OR ingress.instance_id<>lease.instance_id
    OR lease.heartbeat_at<=v_now-interval '30 seconds' OR lease.heartbeat_at>v_now
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  IF (SELECT count(*) FROM public.zalo_conversations WHERE account_id=a.id AND organization_id=c.organization_id AND thread_type='group')>256
    THEN RAISE EXCEPTION 'hermes_group_directory_too_large' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('conversationId',z.id,'organizationId',z.organization_id,'accountId',z.account_id,
    'threadId',z.thread_id,'threadType',z.thread_type,'name',z.peer_name) ORDER BY z.id),'[]'::jsonb) INTO v_groups
    FROM public.zalo_conversations z WHERE z.account_id=a.id AND z.organization_id=c.organization_id AND z.thread_type='group';
  v_owner:=jsonb_build_object('userId',c.user_id,'organizationId',c.organization_id,'assistantId',c.assistant_id,'connectionId',c.id);
  v_binding:=jsonb_build_object('epoch',c.epoch,'policyVersion',policy.version,'membershipId',v_member->'membershipId',
    'authorizationVersion',v_member->'authorizationVersion','sessionRevision',s.revision);
  v_sender:=jsonb_build_object('accountId',a.id,'name',a.name,'ownUid',ingress.own_uid,
    'loginRequestedAt',CASE WHEN a.login_requested_at IS NULL THEN NULL ELSE to_char(a.login_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'botVersion',bot.version,'ingressGeneration',ingress.generation);
  v_context:=encode(sha256(convert_to(jsonb_build_object('origin','external_mcp','owner',v_owner,'binding',v_binding,
    'scopeIds',v_scopes,'sender',v_sender,'groups',v_groups,'bindingId',x.id,'bindingEpoch',x.epoch,
    'assistantEpoch',(SELECT context_epoch FROM app_private.hermes_assistants WHERE id=c.assistant_id),
    'read',v_read,'action',v_action,'tokenExpiresAt',t.expires_at,'sessionExpiresAt',s.expires_at)::text,'UTF8')),'hex');
  v_exp:=LEAST(v_now+interval '5 minutes',t.expires_at,t.created_at+interval '30 days',s.expires_at,lease.heartbeat_at+interval '30 seconds',
    (SELECT valid_to FROM public.organization_memberships WHERE id=(p->>'expectedMembershipId')::uuid));
  IF v_exp<=clock_timestamp() THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('authority',jsonb_build_object('owner',v_owner,'binding',v_binding,'contextVersion',v_context,
    'expiresAt',floor(extract(epoch FROM v_exp)*1000)::bigint,'effective',jsonb_build_object('read',v_read,'action',v_action),
    'scopeIds',to_jsonb(v_scopes),'allowedBuildingIds','[]'::jsonb),'recipientRead',jsonb_build_object('organizationId',c.organization_id,
    'contextVersion',v_context,'readAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sender',v_sender,
    'allowedConversationIds',(SELECT COALESCE(jsonb_agg(g->'conversationId'),'[]'::jsonb) FROM jsonb_array_elements(v_groups) g),'conversations',v_groups));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_external_group_directory_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  RETURN app_private.hermes_external_group_context_v1(p);
END $fn$;

-- Shared fixed room preview decision. Context is supplied only by private SQL
-- wrappers after verifying the real origin; it is never accepted by an RPC.
CREATE OR REPLACE FUNCTION app_private.hermes_group_preview_from_context_v1(p jsonb,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_base jsonb; v_ctx jsonb; v_auth jsonb; v_recipients jsonb; v_rooms uuid[]; v_groups uuid[];
  v_key text; v_room_payload jsonb; v_room_subset jsonb; v_group_subset jsonb; v_count integer; v_now bigint;
  v_map jsonb; v_scope_ids uuid[]; v_buildings uuid[];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p)) NOT IN (13,15)
    OR NOT(p ?& ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest'])
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['expectedContextVersion','intentDigest','roomReadDigest'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'string' OR p->>v_key !~ '^[a-f0-9]{64}$'
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['roomIds','conversationIds'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'array' OR jsonb_array_length(p->v_key)<1
      OR jsonb_array_length(p->v_key)>(CASE WHEN v_key='roomIds' THEN 20 ELSE 8 END)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->v_key) j WHERE jsonb_typeof(j)<>'string'
        OR j#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR (SELECT count(DISTINCT j) FROM jsonb_array_elements(p->v_key) j)<>jsonb_array_length(p->v_key)
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_rooms FROM jsonb_array_elements_text(p->'roomIds') j;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_groups FROM jsonb_array_elements_text(p->'conversationIds') j;
  v_base:=p-ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest'];
  v_ctx:=p_context; v_auth:=v_ctx->'authority'; v_recipients:=v_ctx->'recipientRead';
  IF NOT(v_auth#>'{effective,read}' ?& ARRAY['rooms.view','chat_zalo.view'])
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_scope_ids FROM jsonb_array_elements_text(v_auth->'scopeIds') j;
  v_map:=public.hermes_room_scope_map_v1((v_auth#>>'{owner,organizationId}')::uuid,v_scope_ids,(p->>'connectionId')::uuid,p->>'tokenDigest',
    (p->>'expectedEpoch')::bigint,(p->>'expectedPolicyVersion')::bigint,
    (p->>'expectedMembershipId')::uuid,(p->>'expectedAuthorizationVersion')::bigint,(p->>'expectedSessionRevision')::bigint);
  -- Scope IDs and concrete building IDs are separate namespaces. Cashbooks
  -- grant no rooms, AREA edges only add permission-intersected buildings.
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO v_buildings FROM (
    SELECT value::uuid AS id FROM jsonb_array_elements_text(v_map->'permissionBuildingIds') permitted(value)
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_map->'scopes') scope WHERE scope->>'scopeType'='ORGANIZATION')
    UNION SELECT (scope->>'buildingId')::uuid FROM jsonb_array_elements(v_map->'scopes') scope
      WHERE scope->>'scopeType'='BUILDING' AND v_map->'permissionBuildingIds' ? (scope->>'buildingId')
    UNION SELECT (edge->>'buildingId')::uuid FROM jsonb_array_elements(v_map->'areaBuildings') edge
  ) allowed;
  IF cardinality(v_buildings)<1 THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_auth:=jsonb_set(v_auth,'{allowedBuildingIds}',to_jsonb(v_buildings),false);
  IF v_auth->>'contextVersion' IS DISTINCT FROM p->>'expectedContextVersion'
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_recipients->'conversations') g WHERE (g->>'conversationId')::uuid=ANY(v_groups);
  IF v_count<>cardinality(v_groups) THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- The existing source performs current rooms.view scoping and canonical sale
  -- workflow. Strip all contact/internal/media data before crossing the RPC.
  -- The fixed adapter reprojects this same-snapshot payload and compares the
  -- complete first-page digest to the already read page before releasing output.
  v_room_payload:=public.copilot_available_rooms_v1((v_auth->'owner'->>'organizationId')::uuid);
  IF jsonb_typeof(v_room_payload->'rooms') IS DISTINCT FROM 'array' OR jsonb_typeof(v_room_payload->'buildings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_room_payload->'rooms')>=2000 OR jsonb_array_length(v_room_payload->'buildings')>=2000
    THEN RAISE EXCEPTION 'hermes_group_rooms_incomplete' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_room_payload->'rooms') room
    WHERE (room->>'id')::uuid=ANY(v_rooms) AND room->>'status_public' IN ('free','soon')
      AND v_auth->'allowedBuildingIds' ? (room->>'building_id');
  IF v_count<>cardinality(v_rooms) THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg((SELECT jsonb_object_agg(key,value) FROM jsonb_each(room)
    WHERE key=ANY(ARRAY['id','building_id','floor','name','code','area','rent_price','deposit_amount','status_public','avail_date','sale_state','sale_today','expected_ready_on']))),'[]'::jsonb)
    INTO v_room_subset FROM jsonb_array_elements(v_room_payload->'rooms') room;
  SELECT COALESCE(jsonb_agg((SELECT jsonb_object_agg(key,value) FROM jsonb_each(building)
    WHERE key=ANY(ARRAY['id','name','code']))),'[]'::jsonb)
    INTO v_group_subset FROM jsonb_array_elements(v_room_payload->'buildings') building;
  v_room_payload:=jsonb_build_object('rooms',v_room_subset,'buildings',v_group_subset);
  SELECT jsonb_agg(g ORDER BY g->>'conversationId') INTO v_group_subset FROM jsonb_array_elements(v_recipients->'conversations') g
    WHERE (g->>'conversationId')::uuid=ANY(v_groups);
  v_recipients:=v_recipients||jsonb_build_object('allowedConversationIds',to_jsonb(v_groups),'conversations',v_group_subset);
  v_now:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF (v_auth->>'expiresAt')::bigint<=v_now THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('decision',jsonb_build_object('kind','hermes.group-room-preview.v1','outcome','allow',
    'decisionId',p->>'requestId','tokenDigest',p->>'tokenDigest','intentDigest',p->>'intentDigest','roomReadDigest',p->>'roomReadDigest',
    'contextVersion',v_auth->>'contextVersion','checkedAt',v_now,'expiresAt',(v_auth->>'expiresAt')::bigint),
    'authority',v_auth,'recipientRead',v_recipients,'roomPayload',v_room_payload);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_group_preview_decision_v1(p jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT app_private.hermes_group_preview_from_context_v1(p,app_private.hermes_group_preview_context_v1(
    p-ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest']))
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_external_group_preview_decision_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  RETURN app_private.hermes_group_preview_from_context_v1(p,app_private.hermes_external_group_context_v1(
    p-ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest']));
END $fn$;

-- Current explicit actor + room facts used again immediately before provider I/O.
CREATE OR REPLACE FUNCTION app_private.hermes_external_group_current_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; policy app_private.hermes_org_policies; a public.zalo_accounts;
  v_ctx jsonb; v_auth record; v_id uuid; v_building uuid; v_fact jsonb; v_facts jsonb:='[]'; v_groups jsonb;
  v_rooms uuid[]; v_convs uuid[]; v_scopes uuid[];
BEGIN
  v_ctx:=app_private.hermes_external_group_context_v1(p-ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest']);
  IF NOT(v_ctx#>'{authority,effective,read}' ?& ARRAY['rooms.view','chat_zalo.view'])
    OR NOT(v_ctx#>'{authority,effective,action}' ? 'chat_zalo.send')
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=(p->>'connectionId')::uuid;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT * INTO a FROM public.zalo_accounts WHERE id=(v_ctx#>>'{recipientRead,sender,accountId}')::uuid;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_rooms FROM jsonb_array_elements_text(p->'roomIds') j;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_convs FROM jsonb_array_elements_text(p->'conversationIds') j;
  IF cardinality(v_rooms) NOT BETWEEN 1 AND 20 OR cardinality(v_convs) NOT BETWEEN 1 AND 8
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) AS id INTERSECT SELECT unnest(policy.scope_ids) AS id
  ) effective;
  PERFORM 1 FROM public.zalo_conversations WHERE id=ANY(v_convs) ORDER BY id FOR UPDATE;
  SELECT jsonb_agg(jsonb_build_object('conversationId',z.id,'threadId',z.thread_id,'name',z.peer_name) ORDER BY z.id)
    INTO v_groups FROM public.zalo_conversations z WHERE id=ANY(v_convs) AND account_id=a.id AND organization_id=c.organization_id
      AND thread_type='group' AND NULLIF(btrim(thread_id),'') IS NOT NULL AND NULLIF(btrim(peer_name),'') IS NOT NULL;
  IF jsonb_array_length(v_groups) IS DISTINCT FROM cardinality(v_convs)
    OR (SELECT count(DISTINCT g->>'threadId') FROM jsonb_array_elements(v_groups) g)<>cardinality(v_convs)
    THEN RAISE EXCEPTION 'hermes_group_target_changed' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.buildings WHERE id IN (SELECT building_id FROM public.rooms WHERE id=ANY(v_rooms)) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.rooms WHERE id=ANY(v_rooms) ORDER BY id FOR SHARE;
  FOREACH v_id IN ARRAY v_rooms LOOP
    v_fact:=app_private.hermes_group_room_fact_v1(c.organization_id,v_id); v_building:=(v_fact->>'buildingId')::uuid;
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'rooms.view',v_building);
    IF v_auth.allowed IS DISTINCT FROM true OR NOT EXISTS(
      SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(v_scopes) AND scope.organization_id=c.organization_id
        AND (scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=v_building)
          OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings edge JOIN public.areas ar ON ar.id=edge.area_id
            WHERE edge.area_id=scope.area_id AND edge.organization_id=c.organization_id AND edge.building_id=v_building
              AND ar.organization_id=c.organization_id AND ar.deleted_at IS NULL))))
      THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
    v_facts:=v_facts||jsonb_build_array(v_fact);
  END LOOP;
  RETURN jsonb_build_object('origin','external_mcp','owner',v_ctx#>'{authority,owner}',
    'binding',v_ctx#>'{authority,binding}','contextVersion',v_ctx#>>'{authority,contextVersion}',
    'scopeIds',to_jsonb(v_scopes),'sender',(v_ctx#>'{recipientRead,sender}')||jsonb_build_object('accountOwnerId',a.user_id),
    'recipients',v_groups,'publicFacts',v_facts);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_group_assert_dispatch_v1(p_dispatch_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE h app_private.hermes_group_dispatches; v_current jsonb;
BEGIN
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=p_dispatch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  IF h.origin='external_mcp' THEN v_current:=app_private.hermes_external_group_current_v1(h.request);
  ELSE v_current:=app_private.hermes_group_current_v1(h.request); END IF;
  IF h.expires_at<=clock_timestamp() OR h.snapshot IS DISTINCT FROM v_current
    OR h.payload_digest IS DISTINCT FROM sha256(convert_to(jsonb_build_object('request',h.request,'snapshot',h.snapshot,'body',h.body)::text,'UTF8'))
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_external_group_send_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_decision jsonb; v_snapshot jsonb; v_body text; v_dispatch jsonb; v_receipts jsonb:='[]'; v_queue jsonb;
  h app_private.hermes_group_dispatches; c app_private.hermes_connections;
  z public.zalo_conversations; v_exp timestamptz; v_request uuid; v_group jsonb; v_msg uuid; v_job uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- Thirteen fixed keys. No command claim, body, actor or account input.
  v_decision:=public.hermes_external_group_preview_decision_v1(p);
  v_snapshot:=app_private.hermes_external_group_current_v1(p);
  v_decision:=public.hermes_external_group_preview_decision_v1(p);
  IF v_snapshot#>>'{owner,userId}' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_request:=(p->>'requestId')::uuid;
  -- Current connection/org and worker locks serialize duplicate admission.
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE user_id=auth.uid() AND request_id=v_request;
  IF FOUND THEN
    IF h.origin IS DISTINCT FROM 'external_mcp' OR h.user_id IS DISTINCT FROM auth.uid()
      OR (h.request-ARRAY['expectedContextVersion','intentDigest','roomReadDigest']) IS DISTINCT FROM (p-ARRAY['expectedContextVersion','intentDigest','roomReadDigest'])
      OR h.snapshot IS DISTINCT FROM v_snapshot OR h.expires_at<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue job ON job.id=j.job_id
        WHERE j.dispatch_id=h.id AND job.status<>'queued') THEN
      RAISE EXCEPTION 'hermes_group_request_reused' USING ERRCODE='PT409';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('conversationId',j.conversation_id,'jobId',j.job_id,'status','queued') ORDER BY j.conversation_id)
      INTO v_receipts FROM app_private.hermes_group_jobs j WHERE dispatch_id=h.id;
    IF jsonb_array_length(v_receipts) IS DISTINCT FROM jsonb_array_length(h.snapshot->'recipients')
      THEN RAISE EXCEPTION 'hermes_group_origin_changed' USING ERRCODE='PT409'; END IF;
  ELSE
    SELECT 'PHÒNG ĐÃ CHỌN'||E'\n'||string_agg(ord::text||'. '||(f->>'buildingLabel')||' · '||(f->>'roomLabel')||' | '||
      regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'areaM2')::numeric),',00$',''),'(,[0-9])0$','\1')||' m² | '||
      regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'rentVnd')::numeric),',00$',''),'(,[0-9])0$','\1')||' đ/tháng | '||
      (f#>>'{availability,label}'),E'\n' ORDER BY ord) INTO v_body
      FROM jsonb_array_elements(v_snapshot->'publicFacts') WITH ORDINALITY AS facts(f,ord);
    SELECT * INTO c FROM app_private.hermes_connections WHERE id=(p->>'connectionId')::uuid;
    SELECT LEAST(clock_timestamp()+interval '5 minutes',s.expires_at,t.expires_at,t.created_at+interval '30 days',m.valid_to)
      INTO v_exp FROM app_private.hermes_sessions s CROSS JOIN app_private.hermes_connection_tokens t
        CROSS JOIN public.organization_memberships m WHERE s.id=c.credential_ref AND t.token_digest=p->>'tokenDigest' AND m.id=(p->>'expectedMembershipId')::uuid;
    IF v_exp IS NULL OR v_exp<=clock_timestamp() THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
    INSERT INTO app_private.hermes_group_dispatches(id,user_id,organization_id,command_id,origin,request_id,request,snapshot,body,payload_digest,expires_at)
      VALUES(v_request,auth.uid(),c.organization_id,NULL,'external_mcp',v_request,p,v_snapshot,v_body,
        sha256(convert_to(jsonb_build_object('request',p,'snapshot',v_snapshot,'body',v_body)::text,'UTF8')),v_exp)
      ON CONFLICT DO NOTHING RETURNING * INTO h;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_request_reused' USING ERRCODE='PT409'; END IF;
    FOR v_group IN SELECT value FROM jsonb_array_elements(v_snapshot->'recipients') ORDER BY value->>'conversationId' LOOP
      SELECT * INTO z FROM public.zalo_conversations WHERE id=(v_group->>'conversationId')::uuid;
      v_msg:=gen_random_uuid(); v_job:=gen_random_uuid();
      INSERT INTO public.zalo_messages(id,user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_by,sent_at,client_dedup_key)
        VALUES(v_msg,z.user_id,h.organization_id,z.id,z.account_id,'out','text',h.body,'pending',h.user_id,clock_timestamp(),'hermes-group:'||h.id||':'||z.id);
      v_queue:=jsonb_build_object('id',v_job,'user_id',z.user_id,'organization_id',h.organization_id,'account_id',z.account_id,
        'conversation_id',z.id,'message_id',v_msg,'channel','personal','payload',jsonb_build_object('type','text','body',h.body));
      -- Reserve private provenance before INSERT; the deferred FK verifies the
      -- queue row at commit. A generic enqueue cannot mint this reservation.
      INSERT INTO app_private.hermes_group_jobs(job_id,dispatch_id,conversation_id,queue_snapshot) VALUES(v_job,h.id,z.id,v_queue);
      INSERT INTO public.zalo_send_queue(id,user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,hermes_group_dispatch_id)
        VALUES(v_job,z.user_id,h.organization_id,z.id,z.account_id,v_msg,'personal',jsonb_build_object('type','text','body',h.body),'queued',h.id);
      UPDATE public.zalo_conversations SET last_message_text=h.body,last_message_at=clock_timestamp(),last_message_dir='out',updated_at=clock_timestamp() WHERE id=z.id;
      v_receipts:=v_receipts||jsonb_build_array(jsonb_build_object('conversationId',z.id,'jobId',v_job,'status','queued'));
    END LOOP;
  END IF;
  v_dispatch:=jsonb_build_object('id',h.id,'expiresAt',to_char(h.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recipients',v_receipts);
  RETURN v_decision||jsonb_build_object('dispatch',v_dispatch);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_external_group_send_status_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_ctx jsonb; h app_private.hermes_group_dispatches;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p->'dispatchId') IS DISTINCT FROM 'string' OR p->>'dispatchId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  v_ctx:=app_private.hermes_external_group_context_v1(p-'dispatchId');
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=(p->>'dispatchId')::uuid AND user_id=auth.uid();
  IF NOT FOUND OR h.origin IS DISTINCT FROM 'external_mcp' OR h.snapshot#>>'{owner,connectionId}' IS DISTINCT FROM p->>'connectionId'
    OR h.snapshot#>>'{owner,organizationId}' IS DISTINCT FROM v_ctx#>>'{authority,owner,organizationId}'
    OR h.snapshot#>>'{sender,accountId}' IS DISTINCT FROM v_ctx#>>'{recipientRead,sender,accountId}'
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  RETURN public.hermes_group_send_status_v1(h.id);
END $fn$;

ALTER FUNCTION app_private.hermes_external_group_context_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_external_group_context_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_external_group_directory_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_external_group_directory_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_external_group_directory_v1(jsonb) TO authenticated;

ALTER FUNCTION app_private.hermes_group_preview_from_context_v1(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_preview_from_context_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_group_preview_decision_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_group_preview_decision_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_preview_decision_v1(jsonb) TO authenticated;

ALTER FUNCTION public.hermes_external_group_preview_decision_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_external_group_preview_decision_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_external_group_preview_decision_v1(jsonb) TO authenticated;

ALTER FUNCTION app_private.hermes_external_group_current_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_external_group_current_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_assert_dispatch_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_assert_dispatch_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_external_group_send_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_external_group_send_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_external_group_send_v1(jsonb) TO authenticated;

ALTER FUNCTION public.hermes_external_group_send_status_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_external_group_send_status_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_external_group_send_status_v1(jsonb) TO authenticated;

COMMIT;
NOTIFY pgrst,'reload schema';
