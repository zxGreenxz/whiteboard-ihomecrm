-- OFFLINE CANDIDATE ONLY. Fixed read-only RPCs; no capability registration,
-- policy grant, queue/plan/nonce, provider send, or lifecycle writes.
-- The actual user JWT and private command claim come from the trusted backend.
-- No caller-supplied actor/org/account/thread/body is accepted.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Fixed CRM read/action bridge for the existing durable Auth adapter. No endpoint
-- accepts a permission key, actor or desired grant. Current CRM resolver and
-- persisted Hermes limits decide independent capabilities; disabled is explicit.
CREATE OR REPLACE FUNCTION public.hermes_group_action_context_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_auth jsonb; v_policy app_private.hermes_org_policies; v_allowed boolean:=false; v_read boolean:=false;
BEGIN
  IF auth.uid() IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  v_auth:=public.get_authorization_context_v1(p_organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb OR v_auth->>'membershipId' IS NULL
    OR v_auth->>'authorizationVersion' IS NULL
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_policy FROM app_private.hermes_org_policies WHERE organization_id=p_organization_id;
  IF v_policy.organization_id IS NULL THEN RAISE EXCEPTION 'hermes_group_policy_absent' USING ERRCODE='42501'; END IF;
  IF v_policy.enabled AND 'chat_zalo.view'=ANY(v_policy.read_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled) THEN
    v_read:=EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'chat_zalo.view') WHERE allowed);
  END IF;
  IF v_policy.enabled AND 'chat_zalo.send'=ANY(v_policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled)
    THEN
    v_allowed:=EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'chat_zalo.send') WHERE allowed);
  END IF;
  RETURN jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),
    'membershipId',v_auth->>'membershipId','authorizationVersion',(v_auth->>'authorizationVersion')::bigint,
    'policyVersion',v_policy.version,'allowed',COALESCE(v_allowed,false),
    'companyEnabled',v_policy.enabled AND 'chat_zalo.send'=ANY(v_policy.action_capabilities),
    'readAllowed',COALESCE(v_read,false),'readCompanyEnabled',v_policy.enabled AND 'chat_zalo.view'=ANY(v_policy.read_capabilities));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_group_preview_context_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions;
  t app_private.hermes_connection_tokens; policy app_private.hermes_org_policies;
  q app_private.hermes_zalo_private_commands; x app_private.hermes_zalo_bindings;
  a public.zalo_accounts; bot app_private.hermes_zalo_bots;
  ingress app_private.hermes_zalo_ingress_sessions; lease public.zalo_worker_lease;
  v_actor uuid:=auth.uid(); v_now timestamptz:=clock_timestamp(); v_exp timestamptz;
  v_scope_ids uuid[]; v_buildings uuid[]; v_map jsonb; v_groups jsonb; v_gate jsonb;
  v_owner jsonb; v_binding jsonb; v_sender jsonb; v_context text; v_authority jsonb;
  v_assistant_epoch bigint; v_key text; v_member jsonb; v_permissions jsonb; v_read jsonb:='["chat_zalo.view"]';
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated'
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p))<>10
    OR NOT(p ?& ARRAY['connectionId','tokenDigest','commandId','claimId','expectedEpoch','expectedPolicyVersion',
      'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision','requestId'])
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['connectionId','commandId','claimId','expectedMembershipId','requestId'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'string' OR p->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['expectedEpoch','expectedPolicyVersion','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'number' OR p->>v_key !~ '^[1-9][0-9]{0,15}$'
      OR (p->>v_key)::numeric>=9007199254740991
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' OR p->>'tokenDigest' !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;

  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest';
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id AND id=(p->>'connectionId')::uuid AND user_id=v_actor;
  IF c.id IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(c.organization_id);
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id AND id=(p->>'connectionId')::uuid AND user_id=v_actor FOR SHARE;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest' FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT context_epoch INTO v_assistant_epoch FROM app_private.hermes_assistants
    WHERE id=c.assistant_id AND user_id=v_actor AND organization_id=c.organization_id AND state='ACTIVE';
  IF c.id IS NULL OR s.id IS NULL OR policy.organization_id IS NULL OR v_assistant_epoch IS NULL
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR NOT policy.enabled
    OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=v_now
    OR s.user_id<>v_actor OR s.organization_id<>c.organization_id OR s.assistant_id<>c.assistant_id
    OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR t.revoked_at IS NOT NULL OR t.expires_at<=v_now OR t.created_at>v_now OR t.created_at+interval '30 days'<=v_now
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_member:=app_private.hermes_member_v1(v_actor,c.organization_id);
  v_permissions:=public.hermes_group_action_context_v1(c.organization_id);
  IF c.epoch::text IS DISTINCT FROM p->>'expectedEpoch' OR policy.version::text IS DISTINCT FROM p->>'expectedPolicyVersion'
    OR s.revision::text IS DISTINCT FROM p->>'expectedSessionRevision'
    OR v_member->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId'
    OR v_member->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    OR v_permissions->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId'
    OR v_permissions->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
  IF NOT('chat_zalo.view'=ANY(c.read_capabilities)) OR v_permissions->'readAllowed' IS DISTINCT FROM 'true'::jsonb
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- Directory/status have no room facts and require no room scope. Preview
  -- resolves current concrete room scope in its own final data operation.
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_scope_ids FROM (
    SELECT unnest(c.scope_ids) AS id INTERSECT SELECT unnest(policy.scope_ids) AS id
  ) selected;
  v_buildings:='{}'::uuid[];
  IF 'rooms.view'=ANY(c.read_capabilities) AND 'rooms.view'=ANY(policy.read_capabilities)
    AND cardinality(v_scope_ids)>0 AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled)
    AND (public.get_authorization_context_v1(c.organization_id)->'permissions'->'rooms.view')='true'::jsonb THEN
    v_read:=v_read||'"rooms.view"'::jsonb;
  END IF;
  -- Directory exposes no room facts: room-scope validation belongs only to the
  -- preview/send data operation. A stale room mapping cannot block group read.
  v_map:=jsonb_build_object('scopeIds',to_jsonb(v_scope_ids),'read',v_read);
  v_gate:=jsonb_build_object('send',v_permissions->'allowed'='true'::jsonb AND 'chat_zalo.send'=ANY(c.action_capabilities),
    'view',true,'authorizationVersion',v_member->'authorizationVersion');

  SELECT * INTO q FROM app_private.hermes_zalo_private_commands
    WHERE id=(p->>'commandId')::uuid AND claim_id=(p->>'claimId')::uuid AND state='DISPATCHED';
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=q.binding_id;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=q.account_id;
  SELECT * INTO bot FROM app_private.hermes_zalo_bots WHERE account_id=a.id;
  SELECT * INTO ingress FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id;
  SELECT * INTO lease FROM public.zalo_worker_lease WHERE id='singleton';
  IF q.id IS NULL OR x.id IS NULL OR a.id IS NULL OR bot.account_id IS NULL OR ingress.account_id IS NULL OR lease.id IS NULL
    OR q.connection_id<>c.id OR q.connection_epoch<>c.epoch OR q.user_id<>v_actor OR q.organization_id<>c.organization_id OR q.assistant_id<>c.assistant_id
    OR q.expires_at<=v_now OR q.ingress_generation<>ingress.generation
    OR x.state<>'ACTIVE' OR x.revoked_at IS NOT NULL OR x.epoch<>q.binding_epoch OR x.connection_epoch<>c.epoch
    OR x.user_id<>v_actor OR x.organization_id<>c.organization_id OR x.assistant_id<>c.assistant_id OR x.connection_id<>c.id
    OR x.account_id<>a.id OR x.sender_uid<>q.sender_uid OR x.sender_uid=ingress.own_uid
    OR a.kind<>'personal' OR a.status<>'connected' OR a.organization_id<>c.organization_id
    OR NOT bot.enabled OR bot.organization_id<>c.organization_id OR bot.version<>x.bot_version
    OR ingress.organization_id<>c.organization_id OR ingress.account_owner_id<>a.user_id OR ingress.own_uid IS DISTINCT FROM a.zalo_uid
    OR ingress.login_requested_at IS DISTINCT FROM a.login_requested_at OR ingress.instance_id<>lease.instance_id
    OR lease.heartbeat_at<=v_now-interval '30 seconds' OR lease.heartbeat_at>v_now
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  IF (SELECT count(*) FROM public.zalo_conversations WHERE account_id=a.id AND organization_id=c.organization_id AND thread_type='group')>256
    THEN RAISE EXCEPTION 'hermes_group_directory_too_large' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('conversationId',z.id,'organizationId',z.organization_id,'accountId',z.account_id,
    'threadId',z.thread_id,'threadType',z.thread_type,'name',z.peer_name) ORDER BY z.id),'[]'::jsonb)
    INTO v_groups FROM public.zalo_conversations z WHERE z.account_id=a.id AND z.organization_id=c.organization_id AND z.thread_type='group';
  v_owner:=jsonb_build_object('userId',v_actor,'organizationId',c.organization_id,'assistantId',c.assistant_id,'connectionId',c.id);
  v_binding:=jsonb_build_object('epoch',c.epoch,'policyVersion',policy.version,'membershipId',v_member->'membershipId',
    'authorizationVersion',v_member->'authorizationVersion','sessionRevision',s.revision);
  v_sender:=jsonb_build_object('accountId',a.id,'name',a.name,'ownUid',ingress.own_uid,
    'loginRequestedAt',CASE WHEN a.login_requested_at IS NULL THEN NULL ELSE to_char(a.login_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'botVersion',bot.version,'ingressGeneration',ingress.generation);
  v_context:=encode(sha256(convert_to(jsonb_build_object('owner',v_owner,'binding',v_binding,'scopeMap',v_map,'sender',v_sender,
    'groups',v_groups,'commandId',q.id,'claimId',q.claim_id,'bindingId',x.id,'bindingEpoch',x.epoch,
    'assistantEpoch',v_assistant_epoch,'actionAuthority',v_gate,'tokenExpiresAt',t.expires_at,'sessionExpiresAt',s.expires_at,'commandExpiresAt',q.expires_at)::text,'UTF8')),'hex');
  v_exp:=LEAST(q.expires_at,t.expires_at,t.created_at+interval '30 days',s.expires_at,lease.heartbeat_at+interval '30 seconds',
    (SELECT valid_to FROM public.organization_memberships WHERE id=(p->>'expectedMembershipId')::uuid));
  IF v_exp<=clock_timestamp() THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_authority:=jsonb_build_object('owner',v_owner,'binding',v_binding,'contextVersion',v_context,
    'expiresAt',floor(extract(epoch FROM v_exp)*1000)::bigint,
    'effective',jsonb_build_object('read',v_read,'action',CASE WHEN v_gate->'send'='true'::jsonb THEN '["chat_zalo.send"]'::jsonb ELSE '[]'::jsonb END),
    'scopeIds',to_jsonb(v_scope_ids),'allowedBuildingIds',to_jsonb(v_buildings));
  RETURN jsonb_build_object('authority',v_authority,'recipientRead',jsonb_build_object('organizationId',c.organization_id,
    'contextVersion',v_context,'readAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sender',v_sender,
    'allowedConversationIds',(SELECT COALESCE(jsonb_agg(g->'conversationId'),'[]'::jsonb) FROM jsonb_array_elements(v_groups) g),'conversations',v_groups));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_group_directory_v1(p jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT app_private.hermes_group_preview_context_v1(p)
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_group_preview_decision_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_base jsonb; v_ctx jsonb; v_auth jsonb; v_recipients jsonb; v_rooms uuid[]; v_groups uuid[];
  v_key text; v_room_payload jsonb; v_room_subset jsonb; v_group_subset jsonb; v_count integer; v_now bigint;
  v_map jsonb; v_scope_ids uuid[]; v_buildings uuid[];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>15
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
  v_ctx:=app_private.hermes_group_preview_context_v1(v_base); v_auth:=v_ctx->'authority'; v_recipients:=v_ctx->'recipientRead';
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

ALTER FUNCTION app_private.hermes_group_preview_context_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_group_action_context_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_group_directory_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_group_preview_decision_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_preview_context_v1(jsonb),public.hermes_group_directory_v1(jsonb),public.hermes_group_preview_decision_v1(jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_group_action_context_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_directory_v1(jsonb),public.hermes_group_preview_decision_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_group_action_context_v1(uuid) TO authenticated;
COMMIT;
