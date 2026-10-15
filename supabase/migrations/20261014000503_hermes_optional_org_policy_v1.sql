-- Optional Hermes organization policy is a ceiling, never a second grant.
-- Missing row = neutral version 0. Persisted rows (including disabled/empty)
-- remain exact; no policy, user permission or capability is seeded by this change.
-- Version 0 cannot collide with the first explicit policy (version 1).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- The read helper shares the caller's snapshot, including STABLE room reads.
-- Mutating callers retain their existing explicit policy row locks. Restricting
-- the neutral projection to a connection avoids loading unrelated org scopes.
CREATE OR REPLACE FUNCTION app_private.hermes_effective_org_policy_v1(p_org uuid,
  p_read text[] DEFAULT NULL,p_action text[] DEFAULT NULL,p_scope_ids uuid[] DEFAULT NULL)
RETURNS app_private.hermes_org_policies LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_policy app_private.hermes_org_policies;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'hermes_policy_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_policy FROM app_private.hermes_org_policies WHERE organization_id=p_org;
  IF FOUND THEN RETURN v_policy; END IF;
  v_policy.organization_id:=p_org; v_policy.enabled:=true; v_policy.version:=0;
  SELECT COALESCE(array_agg(capability ORDER BY capability),'{}'::text[]) INTO v_policy.read_capabilities
    FROM app_private.hermes_capabilities WHERE mode='read' AND enabled
      AND (p_read IS NULL OR capability=ANY(p_read));
  SELECT COALESCE(array_agg(capability ORDER BY capability),'{}'::text[]) INTO v_policy.action_capabilities
    FROM app_private.hermes_capabilities WHERE mode='action' AND enabled
      AND (p_action IS NULL OR capability=ANY(p_action));
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_policy.scope_ids
    FROM public.authorization_scopes WHERE organization_id=p_org AND (p_scope_ids IS NULL OR id=ANY(p_scope_ids));
  RETURN v_policy;
END $fn$;

-- Forward replacement of public.hermes_prepare_connection_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_prepare_connection_v1(p_org uuid,p_read text[],p_action text[],p_scope_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_policy app_private.hermes_org_policies;
  v_assistant app_private.hermes_assistants; v_connection app_private.hermes_connections;
  v_secret text:=encode(extensions.gen_random_bytes(32),'hex');
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  PERFORM app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_validate_limits_v1(p_org,p_read,p_action,p_scope_ids);
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  SELECT * INTO v_policy FROM app_private.hermes_effective_org_policy_v1(p_org,p_read,p_action,p_scope_ids);
  IF NOT FOUND OR NOT v_policy.enabled OR NOT (p_read<@v_policy.read_capabilities)
    OR NOT (p_action<@v_policy.action_capabilities) OR NOT (p_scope_ids<@v_policy.scope_ids) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501';
  END IF;
  INSERT INTO app_private.hermes_assistants(organization_id,user_id) VALUES(p_org,v_actor)
    ON CONFLICT(organization_id,user_id) DO NOTHING;
  SELECT * INTO v_assistant FROM app_private.hermes_assistants WHERE organization_id=p_org AND user_id=v_actor FOR SHARE;
  IF v_assistant.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  INSERT INTO app_private.hermes_connections(assistant_id,organization_id,user_id,read_capabilities,action_capabilities,scope_ids,intent_digest,intent_expires_at)
  VALUES(v_assistant.id,p_org,v_actor,p_read,p_action,p_scope_ids,encode(extensions.digest(v_secret,'sha256'),'hex'),clock_timestamp()+interval '5 minutes')
  RETURNING * INTO v_connection;
  PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_CONNECTION_PREPARED','hermes_connection',v_connection.id,
    NULL,app_private.hermes_connection_json_v1(v_connection),'Explicit human connection intent');
  RETURN app_private.hermes_connection_json_v1(v_connection)||jsonb_build_object('intentSecret',v_secret,
    'intentExpiresAt',floor(extract(epoch FROM v_connection.intent_expires_at)*1000)::bigint);
END
$fn$;

-- Forward replacement of app_private.hermes_session_gate_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_session_gate_v1(s app_private.hermes_sessions)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
BEGIN
  PERFORM app_private.hermes_member_v1(s.user_id,s.organization_id);
  RETURN EXISTS(SELECT 1 FROM app_private.hermes_assistants a CROSS JOIN LATERAL app_private.hermes_effective_org_policy_v1(a.organization_id,'{}'::text[],'{}'::text[],'{}'::uuid[]) p
    WHERE a.id=s.assistant_id AND a.state='ACTIVE' AND p.enabled)
    AND EXISTS(SELECT 1 FROM app_private.hermes_connections c JOIN app_private.hermes_connection_tokens t ON t.connection_id=c.id
      WHERE c.credential_ref=s.id AND c.state='ACTIVE' AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp());
END
$fn$;

-- Forward replacement of app_private.hermes_store_activate_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_store_activate_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE c app_private.hermes_connections; a app_private.hermes_assistants; policy app_private.hermes_org_policies;
  v_id uuid; v_operation uuid; v_credential uuid; v_user uuid; v_provider uuid; v_epoch bigint;
  v_token_exp timestamptz; v_session_exp timestamptz; v_hash text;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','expectedEpoch','operationId','intentSecret','userId','providerSessionId','credentialRef','tokenDigest','tokenExpiresAt','sessionEnvelope','sessionExpiresAt']);
  v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_operation:=app_private.hermes_uuid_v1(p->'operationId');
  v_credential:=app_private.hermes_uuid_v1(p->'credentialRef'); v_user:=app_private.hermes_uuid_v1(p->'userId');
  v_provider:=app_private.hermes_uuid_v1(p->'providerSessionId'); v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
  v_token_exp:=to_timestamp(app_private.hermes_integer_v1(p->'tokenExpiresAt')/1000.0);
  v_session_exp:=to_timestamp(app_private.hermes_integer_v1(p->'sessionExpiresAt')/1000.0);
  PERFORM app_private.hermes_envelope_v1(p->'sessionEnvelope');
  IF jsonb_typeof(p->'intentSecret')<>'string' OR (p->>'intentSecret') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p->'tokenDigest')<>'string' OR (p->>'tokenDigest') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'hermes_activation_invalid' USING ERRCODE='22023'; END IF;
  v_hash:=encode(extensions.digest(p::text,'sha256'),'hex');
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
  IF NOT FOUND OR c.user_id<>v_user OR c.intent_digest<>encode(extensions.digest(p->>'intentSecret','sha256'),'hex') THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id FOR SHARE;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF a.state<>'ACTIVE' OR policy.organization_id IS NULL OR NOT policy.enabled
    OR NOT(c.read_capabilities<@policy.read_capabilities) OR NOT(c.action_capabilities<@policy.action_capabilities)
    OR NOT(c.scope_ids<@policy.scope_ids) THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF c.activation_operation_id=v_operation THEN
    IF c.activation_hash<>v_hash OR c.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_activation_conflict' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('ok',true,'status','already_activated','connection',app_private.hermes_connection_json_v1(c),'credentialRef',c.credential_ref);
  END IF;
  IF c.state<>'PENDING' OR c.epoch<>v_epoch OR c.intent_expires_at<=clock_timestamp()
    OR v_token_exp<=clock_timestamp() OR v_token_exp>clock_timestamp()+interval '15 minutes'
    OR v_session_exp<=clock_timestamp() OR v_session_exp>clock_timestamp()+interval '24 hours' OR v_token_exp>v_session_exp THEN
    RAISE EXCEPTION 'hermes_activation_expired_or_changed' USING ERRCODE='40001'; END IF;
  INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
    VALUES(v_credential,c.assistant_id,c.organization_id,c.user_id,v_provider,'ACTIVE',p->'sessionEnvelope',v_session_exp);
  INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(p->>'tokenDigest',c.id,v_token_exp);
  UPDATE app_private.hermes_connections SET credential_ref=v_credential,state='ACTIVE',epoch=epoch+1,
    activation_operation_id=v_operation,activation_hash=v_hash WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('ok',true,'status','activated','connection',app_private.hermes_connection_json_v1(c),'credentialRef',v_credential);
END
$fn$;

-- Forward replacement of app_private.hermes_store_read_connection_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_store_read_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  policy app_private.hermes_org_policies; member_context jsonb;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest']);
  IF jsonb_typeof(p->'tokenDigest')<>'string' OR (p->>'tokenDigest') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'hermes_token_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest' AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id AND state='ACTIVE';
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref AND state='ACTIVE'
    AND quarantine_reason IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND OR NOT app_private.hermes_session_gate_v1(s) THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  -- Existing credentials always lock session before connection. Re-read after
  -- waiting so revocation cannot leave an ACTIVE metadata snapshot in the result.
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id AND state='ACTIVE' AND credential_ref=s.id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  member_context:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids) WHERE enabled;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  RETURN jsonb_build_object('status','active','connection',app_private.hermes_connection_json_v1(c)||jsonb_build_object(
      'tokenDigest',t.token_digest,'credentialRef',s.id,'expiresAt',floor(extract(epoch FROM t.expires_at)*1000)::bigint),
    'session',app_private.hermes_session_json_v1(s),'membership',member_context,
    'policy',jsonb_build_object('version',policy.version,'read',policy.read_capabilities,'action',policy.action_capabilities,'scopeIds',policy.scope_ids));
END
$fn$;

-- Forward replacement of app_private.hermes_store_renew_connection_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_store_renew_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE s app_private.hermes_sessions; c app_private.hermes_connections; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies;
  v_id uuid; v_credential uuid; v_epoch bigint; v_revision bigint; v_ttl_ms bigint;
  v_expected timestamptz; v_target timestamptz; v_now timestamptz;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest','connectionId','expectedEpoch','credentialRef','expectedRevision','expectedExpiresAt','requestedTtlMs']);
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' OR (p->>'tokenDigest') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'hermes_token_invalid' USING ERRCODE='22023'; END IF;
  v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_credential:=app_private.hermes_uuid_v1(p->'credentialRef');
  v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch'); v_revision:=app_private.hermes_integer_v1(p->'expectedRevision');
  v_expected:=to_timestamp(app_private.hermes_integer_v1(p->'expectedExpiresAt')/1000.0);
  v_ttl_ms:=app_private.hermes_integer_v1(p->'requestedTtlMs');
  IF v_ttl_ms>900000 THEN RAISE EXCEPTION 'hermes_lease_invalid' USING ERRCODE='22023'; END IF;

  -- Match refresh/revoke lock order; validate every snapshot after its lock wait.
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=v_credential FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest' AND connection_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  PERFORM app_private.hermes_validate_limits_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  v_now:=clock_timestamp();
  IF s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=v_now OR s.revision<>v_revision
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR c.epoch<>v_epoch OR c.credential_ref IS DISTINCT FROM s.id
    OR c.assistant_id<>s.assistant_id OR c.organization_id<>s.organization_id OR c.user_id<>s.user_id
    OR t.revoked_at IS NOT NULL OR t.expires_at<=v_now OR t.expires_at<>v_expected THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  IF a.state<>'ACTIVE' OR NOT policy.enabled OR NOT(c.read_capabilities<@policy.read_capabilities)
    OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  -- Floor to a canonical millisecond BEFORE storing/acknowledging, never round
  -- past the session or hard-age cap. expectedExpiresAt remains a CAS value only.
  v_target:=date_trunc('milliseconds',LEAST(v_now+v_ttl_ms*interval '1 millisecond',s.expires_at,t.created_at+interval '30 days'));
  IF t.created_at>v_now OR v_target<=v_now OR v_target<=t.expires_at THEN
    RAISE EXCEPTION 'hermes_renewal_expired_or_changed' USING ERRCODE='40001'; END IF;
  UPDATE app_private.hermes_connection_tokens SET expires_at=v_target WHERE token_digest=t.token_digest;
  RETURN jsonb_build_object('ok',true,'status','renewed','expiresAt',floor(extract(epoch FROM v_target)*1000)::bigint);
END
$fn$;

-- Forward replacement of public.hermes_room_scope_map_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_room_scope_map_v1(p_organization_id uuid,p_scope_ids uuid[],
  p_connection_id uuid,p_token_digest text,p_expected_epoch bigint,p_expected_policy_version bigint,
  p_expected_membership_id uuid,p_expected_authorization_version bigint,p_expected_session_revision bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_buildings uuid[]; v_scopes jsonb; v_edges jsonb; v_auth jsonb; v_allowed uuid[];
  v_actor uuid:=auth.uid(); v_now timestamptz:=clock_timestamp(); v_count integer;
  v_c app_private.hermes_connections; v_s app_private.hermes_sessions;
  v_p app_private.hermes_org_policies; v_t app_private.hermes_connection_tokens;
  v_member public.organization_memberships;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_organization_id IS NULL
    OR p_connection_id IS NULL OR p_expected_membership_id IS NULL OR p_token_digest IS NULL
    OR p_token_digest !~ '^[0-9a-f]{64}$' OR p_expected_epoch IS NULL OR p_expected_epoch<1
    OR p_expected_policy_version IS NULL OR p_expected_policy_version<0
    OR p_expected_authorization_version IS NULL OR p_expected_authorization_version<1
    OR p_expected_session_revision IS NULL OR p_expected_session_revision<1 THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  IF p_scope_ids IS NULL OR cardinality(p_scope_ids)<1 OR cardinality(p_scope_ids)>256
    OR array_ndims(p_scope_ids)<>1 OR array_position(p_scope_ids,NULL) IS NOT NULL
    OR cardinality(p_scope_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_scope_ids) id) THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_c FROM app_private.hermes_connections
    WHERE id=p_connection_id AND organization_id=p_organization_id AND user_id=v_actor AND state='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_s FROM app_private.hermes_sessions
    WHERE id=v_c.credential_ref AND assistant_id=v_c.assistant_id AND organization_id=p_organization_id
      AND user_id=v_actor AND provider_session_id::text=auth.jwt()->>'session_id'
      AND state='ACTIVE' AND quarantine_reason IS NULL AND expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_t FROM app_private.hermes_connection_tokens
    WHERE token_digest=p_token_digest AND connection_id=v_c.id AND revoked_at IS NULL AND expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_effective_org_policy_v1(p_organization_id,v_c.read_capabilities,v_c.action_capabilities,v_c.scope_ids) WHERE enabled;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a
    WHERE a.id=v_c.assistant_id AND a.organization_id=p_organization_id AND a.user_id=v_actor AND a.state='ACTIVE')
    OR NOT ('rooms.view'=ANY(v_c.read_capabilities)) OR NOT ('rooms.view'=ANY(v_p.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap
      WHERE cap.capability='rooms.view' AND cap.mode='read' AND cap.enabled) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF v_c.epoch<>p_expected_epoch OR v_p.version<>p_expected_policy_version OR v_s.revision<>p_expected_session_revision THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_allowed FROM (
    SELECT unnest(v_c.scope_ids) AS id INTERSECT SELECT unnest(v_p.scope_ids) AS id
  ) allowed;
  IF NOT(p_scope_ids<@v_allowed) OR NOT(v_allowed<@p_scope_ids) THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;

  -- Identity/lifetime parity with hermes_member_v1, without calling that VOLATILE
  -- helper inside a coherent read. Permissions remain the shared CRM resolver's.
  SELECT count(*) INTO v_count FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=v_actor AND m.organization_id=p_organization_id AND o.status='ACTIVE'
      AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now);
  IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_member FROM public.organization_memberships
    WHERE id=p_expected_membership_id AND user_id=v_actor AND organization_id=p_organization_id
      AND status='ACTIVE' AND revoked_at IS NULL
      AND COALESCE(valid_from,'-infinity'::timestamptz)<=v_now AND (valid_to IS NULL OR valid_to>v_now);
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=v_actor) THEN
    SELECT count(DISTINCT m.organization_id) INTO v_count FROM public.organization_memberships m
      JOIN public.organizations o ON o.id=m.organization_id
      WHERE m.user_id=v_actor AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now);
    IF v_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous' USING ERRCODE='42501'; END IF;
  END IF;
  -- require_perm_v1 supplies no target building and would reject legitimate
  -- BUILDING/AREA-scoped readers. Use the same boolean + concrete scope resolver
  -- as the canonical CRM read adapter, then intersect every mapped building.
  v_auth:=public.get_authorization_context_v1(p_organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR v_auth->'permissions'->'rooms.view' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF v_auth->>'membershipId' IS DISTINCT FROM p_expected_membership_id::text
    OR v_auth->>'authorizationVersion' IS DISTINCT FROM p_expected_authorization_version::text THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  v_buildings:=public.copilot_org_scope_buildings_v1('rooms.view',p_organization_id);
  IF v_buildings IS NULL OR cardinality(v_buildings)<1 OR cardinality(v_buildings)>256 THEN
    RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
  -- Reject an incomplete/foreign/deleted mapping rather than silently dropping
  -- requested nodes. CASHBOOK is metadata only and grants zero room buildings.
  IF EXISTS (
    SELECT 1 FROM unnest(p_scope_ids) requested(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.authorization_scopes s
      WHERE s.id=requested.id AND s.organization_id=p_organization_id AND (
        s.scope_type='ORGANIZATION'
        OR (s.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.areas a
          WHERE a.id=s.area_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL))
        OR (s.scope_type='BUILDING' AND EXISTS(SELECT 1 FROM public.buildings b
          WHERE b.id=s.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL))
        OR (s.scope_type='CASHBOOK' AND EXISTS(SELECT 1 FROM public.accounts a
          WHERE a.id=s.cashbook_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL))
      )
    )
  ) THEN RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;

  SELECT jsonb_agg(jsonb_build_object('id',s.id,'scopeType',s.scope_type,
    'buildingId',s.building_id,'areaId',s.area_id,'cashbookId',s.cashbook_id) ORDER BY s.id)
    INTO v_scopes FROM public.authorization_scopes s
    WHERE s.organization_id=p_organization_id AND s.id=ANY(p_scope_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',ab.organization_id,
    'areaId',ab.area_id,'buildingId',ab.building_id) ORDER BY ab.area_id,ab.building_id),'[]'::jsonb)
    INTO v_edges
    FROM public.area_buildings ab
    JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
    JOIN public.buildings b ON b.id=ab.building_id AND b.organization_id=ab.organization_id AND b.deleted_at IS NULL
    WHERE ab.organization_id=p_organization_id AND ab.building_id=ANY(v_buildings)
      AND EXISTS(SELECT 1 FROM public.authorization_scopes s WHERE s.organization_id=p_organization_id
        AND s.id=ANY(p_scope_ids) AND s.scope_type='AREA' AND s.area_id=ab.area_id);
  IF jsonb_array_length(v_scopes)<>cardinality(p_scope_ids) OR jsonb_array_length(v_edges)>=4096 THEN
    RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
  IF v_s.expires_at<=clock_timestamp() OR v_t.expires_at<=clock_timestamp()
    OR (v_member.valid_to IS NOT NULL AND v_member.valid_to<=clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',p_organization_id,'complete',true,
    'scopes',v_scopes,'areaBuildings',v_edges,'permissionBuildingIds',to_jsonb(v_buildings),
    'binding',jsonb_build_object('connectionId',v_c.id,'epoch',v_c.epoch,'policyVersion',v_p.version,
      'membershipId',v_member.id,'authorizationVersion',p_expected_authorization_version,'sessionRevision',v_s.revision));
END
$fn$;

-- Forward replacement of public.hermes_connection_context_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v1(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_c app_private.hermes_connections; v_p app_private.hermes_org_policies;
  v_member jsonb; v_auth jsonb; v_read jsonb; v_buildings uuid[];
BEGIN
  SELECT * INTO v_c FROM app_private.hermes_connections WHERE id=p_connection_id AND user_id=auth.uid();
  IF NOT FOUND OR v_c.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_member:=app_private.hermes_member_v1(auth.uid(),v_c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_effective_org_policy_v1(v_c.organization_id,v_c.read_capabilities,v_c.action_capabilities,v_c.scope_ids);
  IF NOT FOUND OR NOT v_p.enabled OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=v_c.assistant_id AND a.state='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_sessions s WHERE s.id=v_c.credential_ref AND s.state='ACTIVE' AND s.quarantine_reason IS NULL AND s.expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=v_c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501';
  END IF;
  v_auth:=public.get_authorization_context_v1(v_c.organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM v_c.organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_buildings:=public.copilot_org_scope_buildings_v1('rooms.view',v_c.organization_id);
  SELECT COALESCE(jsonb_agg(cap.capability ORDER BY cap.capability),'[]'::jsonb) INTO v_read
    FROM app_private.hermes_capabilities cap WHERE cap.mode='read' AND cap.enabled
      AND cap.capability=ANY(v_c.read_capabilities) AND cap.capability=ANY(v_p.read_capabilities)
      AND (cap.capability='assistant.context.read' OR
        (cap.capability='rooms.view' AND v_auth->'permissions'->'rooms.view'='true'::jsonb
          AND cardinality(v_buildings)>0));
  RETURN app_private.hermes_connection_json_v1(v_c)||v_member||jsonb_build_object('policyVersion',v_p.version,
    'companyCeilings',jsonb_build_object('read',v_p.read_capabilities,'action',v_p.action_capabilities),
    'effective',jsonb_build_object('read',v_read,'action','[]'::jsonb));
END
$fn$;

-- Forward replacement of public.hermes_connection_options_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_member jsonb; v_auth jsonb;
  v_policy app_private.hermes_org_policies; v_buildings uuid[]; v_scopes jsonb:='[]'::jsonb;
  v_read jsonb:='[]'::jsonb; v_enabled boolean:=false;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_org IS NULL THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  v_member:=app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_auth:=public.get_authorization_context_v1(p_org);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_org::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR v_auth->>'membershipId' IS DISTINCT FROM v_member->>'membershipId'
    OR v_auth->>'authorizationVersion' IS DISTINCT FROM v_member->>'authorizationVersion' THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  SELECT * INTO v_policy FROM app_private.hermes_effective_org_policy_v1(p_org,NULL,NULL,NULL);
  v_enabled:=FOUND AND v_policy.enabled;
  IF v_enabled THEN
    IF 'assistant.context.read'=ANY(v_policy.read_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities
      WHERE capability='assistant.context.read' AND mode='read' AND enabled) THEN
      v_read:=v_read||'"assistant.context.read"'::jsonb;
    END IF;
    IF 'rooms.view'=ANY(v_policy.read_capabilities) AND v_auth->'permissions'->'rooms.view'='true'::jsonb
      AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled) THEN
      v_buildings:=public.copilot_org_scope_buildings_v1('rooms.view',p_org);
      IF v_buildings IS NULL OR cardinality(v_buildings)>256 THEN
        RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',s.id,'scopeType',s.scope_type,
        'label',app_private.scope_label_v1(s.id),'buildingId',s.building_id,'areaId',s.area_id,'cashbookId',NULL) ORDER BY s.id),'[]'::jsonb)
        INTO v_scopes FROM public.authorization_scopes s
        WHERE s.organization_id=p_org AND s.id=ANY(v_policy.scope_ids) AND s.scope_type IN ('ORGANIZATION','AREA','BUILDING')
          AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=ANY(v_buildings) AND b.organization_id=p_org AND b.deleted_at IS NULL
            AND (s.scope_type='ORGANIZATION' OR (s.scope_type='BUILDING' AND s.building_id=b.id)
              OR (s.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.areas a JOIN public.area_buildings ab
                ON ab.area_id=a.id AND ab.organization_id=a.organization_id
                WHERE a.id=s.area_id AND a.organization_id=p_org AND a.deleted_at IS NULL AND ab.building_id=b.id))));
      IF jsonb_array_length(v_scopes)>256 THEN RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(v_scopes)>0 THEN v_read:=v_read||'"rooms.view"'::jsonb; END IF;
    END IF;
  END IF;
  -- A bounded observation, not a lease: enrollment and every runtime call
  -- independently recheck live user/company/policy/scope authority.
  RETURN v_member||jsonb_build_object('userId',v_actor,'organizationId',p_org,
    'policyVersion',COALESCE(v_policy.version,0),'enabled',v_enabled,'read',v_read,'action','[]'::jsonb,'scopes',v_scopes);
END
$fn$;

-- Forward replacement of public.hermes_org_policy_options_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_member jsonb; v_policy app_private.hermes_org_policies;
  v_read jsonb; v_scopes jsonb; v_stored_scopes jsonb;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_org IS NULL THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  v_member:=app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.require_perm_v1(p_org,'users.edit','quản lý quyền trợ lý Hermes');
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  SELECT * INTO v_policy FROM app_private.hermes_effective_org_policy_v1(p_org,NULL,NULL,NULL);
  SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]'::jsonb) INTO v_read
    FROM app_private.hermes_capabilities WHERE mode='read' AND enabled
      AND capability IN ('assistant.context.read','rooms.view');

  -- Scope labels are projected only after validating each referenced object's
  -- organization; an inconsistent relation never leaks a different org's name.
  WITH valid_scopes AS (
    SELECT s.id,s.scope_type,s.building_id,s.area_id,
      CASE s.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức'
        WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
        WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END AS label
    FROM public.authorization_scopes s
    LEFT JOIN public.buildings b ON b.id=s.building_id AND b.organization_id=p_org AND b.deleted_at IS NULL
    LEFT JOIN public.areas a ON a.id=s.area_id AND a.organization_id=p_org AND a.deleted_at IS NULL
    WHERE s.organization_id=p_org AND
      ((s.scope_type='ORGANIZATION' AND s.building_id IS NULL AND s.area_id IS NULL AND s.cashbook_id IS NULL)
       OR (s.scope_type='BUILDING' AND b.id IS NOT NULL AND s.area_id IS NULL AND s.cashbook_id IS NULL)
       OR (s.scope_type='AREA' AND a.id IS NOT NULL AND s.building_id IS NULL AND s.cashbook_id IS NULL))
    ORDER BY s.id LIMIT 257
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',id,'scopeType',scope_type,'label',label,
      'buildingId',building_id,'areaId',area_id,'cashbookId',NULL) ORDER BY id),'[]'::jsonb)
    INTO v_scopes FROM valid_scopes;
  IF jsonb_array_length(v_scopes)>256 THEN RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;

  -- Preserve every stored ID without making it available for a new grant.
  -- Unavailable, deleted or foreign references receive no object label.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',stored.id,
      'label',COALESCE(choice.item->>'label','Phạm vi chưa có trong danh sách hiện tại'),
      'available',choice.item IS NOT NULL) ORDER BY stored.id),'[]'::jsonb)
    INTO v_stored_scopes FROM unnest(COALESCE(v_policy.scope_ids,'{}'::uuid[])) stored(id)
    LEFT JOIN LATERAL (SELECT item FROM jsonb_array_elements(v_scopes) item
      WHERE item->>'scopeId'=stored.id::text) choice ON true;
  RETURN v_member||jsonb_build_object('userId',v_actor,'organizationId',p_org,
    'policy',jsonb_build_object('organizationId',p_org,'version',COALESCE(v_policy.version,0),
      'enabled',COALESCE(v_policy.enabled,false),'read',COALESCE(v_policy.read_capabilities,'{}'::text[]),
      'action',COALESCE(v_policy.action_capabilities,'{}'::text[]),'scopeIds',COALESCE(v_policy.scope_ids,'{}'::uuid[])),
    'choices',jsonb_build_object('read',v_read,'action','[]'::jsonb,'scopes',v_scopes),
    'storedScopes',v_stored_scopes);
END
$fn$;

-- Forward replacement of app_private.hermes_zalo_context_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_context_v1(p_connection uuid,p_user uuid,p_org uuid,p_epoch bigint)
RETURNS app_private.hermes_connections LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions;
BEGIN
  PERFORM app_private.hermes_member_v1(p_user,p_org);
  IF p_user IS DISTINCT FROM auth.uid() OR app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=p_connection AND user_id=p_user AND organization_id=p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=p_connection FOR SHARE;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  PERFORM 1 FROM app_private.hermes_effective_org_policy_v1(p_org,c.read_capabilities,c.action_capabilities,c.scope_ids) WHERE enabled;
  IF NOT FOUND OR c.state<>'ACTIVE' OR c.epoch IS DISTINCT FROM p_epoch OR s.state<>'ACTIVE' OR s.expires_at<=clock_timestamp()
    OR s.id IS NULL OR s.id IS DISTINCT FROM c.credential_ref
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=c.assistant_id AND a.state='ACTIVE' AND a.user_id=p_user AND a.organization_id=p_org)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  RETURN c;
END $$;

-- Forward replacement of public.hermes_zalo_private_command_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_zalo_private_command_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE x app_private.hermes_zalo_bindings; c app_private.hermes_connections; s app_private.hermes_sessions;
  a public.zalo_accounts; i app_private.hermes_zalo_ingress_sessions; q app_private.hermes_zalo_private_commands;
  v_account uuid; v_org uuid; v_instance uuid; v_generation uuid; v_binding uuid; v_connection uuid;
  v_sent bigint; v_now timestamptz; v_deadline timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_request_v1(p,ARRAY['operation','accountId','organizationId','instanceId','generation','senderUid','providerMessageId','sentAt','text']);
  IF p->>'operation' IS DISTINCT FROM 'acceptPrivateCommand'
    OR jsonb_typeof(p->'senderUid') IS DISTINCT FROM 'string' OR p->>'senderUid' !~ '^[1-9][0-9]{0,39}$'
    OR jsonb_typeof(p->'providerMessageId') IS DISTINCT FROM 'string' OR p->>'providerMessageId' !~ '^[A-Za-z0-9_-]{1,128}$'
    OR jsonb_typeof(p->'text') IS DISTINCT FROM 'string' OR octet_length(p->>'text') NOT BETWEEN 1 AND 8192
    OR p->>'text' ~* '/hermes-link|hz_[a-f0-9]{64}'
  THEN RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
  v_account:=app_private.hermes_uuid_v1(p->'accountId'); v_org:=app_private.hermes_uuid_v1(p->'organizationId');
  v_instance:=app_private.hermes_uuid_v1(p->'instanceId'); v_generation:=app_private.hermes_uuid_v1(p->'generation');
  v_sent:=app_private.hermes_integer_v1(p->'sentAt');
  -- Resolve identity from a confirmed binding, never from provider text or IDs
  -- claimed by the request. Read again under locks before committing anything.
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE account_id=v_account AND organization_id=v_org
    AND sender_uid=p->>'senderUid' AND state='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  v_binding:=x.id; v_connection:=x.connection_id;
  PERFORM app_private.hermes_member_v1(x.user_id,v_org);
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  -- Same order as binding confirmation / credential refresh: org, session,
  -- connection, policy, worker lease, account, bot, ingress, binding.
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_connection;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_connection FOR SHARE;
  IF c.id IS NULL OR s.id IS NULL OR c.state<>'ACTIVE' OR c.epoch<>x.connection_epoch
    OR c.credential_ref IS DISTINCT FROM s.id OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL
    OR s.user_id IS DISTINCT FROM x.user_id OR s.organization_id IS DISTINCT FROM v_org OR s.assistant_id IS DISTINCT FROM x.assistant_id
    OR c.user_id IS DISTINCT FROM x.user_id OR c.organization_id IS DISTINCT FROM v_org OR c.assistant_id IS DISTINCT FROM x.assistant_id
  THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=v_org FOR SHARE;
  PERFORM 1 FROM app_private.hermes_effective_org_policy_v1(v_org,c.read_capabilities,c.action_capabilities,c.scope_ids) WHERE enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=v_instance
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=v_account AND organization_id=v_org AND kind='personal' AND status='connected' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app_private.hermes_zalo_bots WHERE account_id=a.id AND organization_id=v_org AND enabled AND version=x.bot_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT * INTO i FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id AND organization_id=v_org
    AND instance_id=v_instance AND generation=v_generation FOR SHARE;
  IF NOT FOUND OR i.account_owner_id IS DISTINCT FROM a.user_id OR i.own_uid IS DISTINCT FROM a.zalo_uid
    OR i.login_requested_at IS DISTINCT FROM a.login_requested_at OR p->>'senderUid'=i.own_uid
  THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=v_binding AND connection_id=c.id
    AND account_id=a.id AND organization_id=v_org AND sender_uid=p->>'senderUid' AND state='ACTIVE' FOR SHARE;
  IF NOT FOUND OR x.connection_epoch<>c.epoch THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.hermes_member_v1(x.user_id,v_org);
  IF NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  v_now:=clock_timestamp();
  IF s.expires_at<=v_now OR v_sent<floor(extract(epoch FROM (v_now-interval '5 minutes'))*1000)
    OR v_sent>floor(extract(epoch FROM (v_now+interval '30 seconds'))*1000)
    OR v_sent<floor(extract(epoch FROM i.registered_at)*1000)
    OR v_sent<floor(extract(epoch FROM x.activated_at)*1000)
  THEN RAISE EXCEPTION 'hermes_zalo_stale' USING ERRCODE='PT409'; END IF;
  -- Same ID with different content/actor cannot become a second command. A
  -- reconnect does not erase dedup; generation is provenance, not the key.
  SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE account_id=a.id AND provider_message_id=p->>'providerMessageId';
  IF FOUND THEN
    IF q.binding_id<>x.id OR q.binding_epoch<>x.epoch OR q.connection_epoch<>c.epoch OR q.sender_uid<>x.sender_uid
      OR q.sent_at_ms<>v_sent OR q.body IS DISTINCT FROM p->>'text' OR q.state<>'QUEUED' OR q.expires_at<=v_now
    THEN RAISE EXCEPTION 'hermes_zalo_conflict' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('status','duplicate','commandId',q.id,'accountId',a.id,'organizationId',v_org,'providerMessageId',q.provider_message_id);
  END IF;
  -- Bounded per-account intake. Expiry never authorizes execution; consumers
  -- must recheck authority and claim the existing row before any side effect.
  IF (SELECT count(*) FROM app_private.hermes_zalo_private_commands WHERE account_id=a.id AND state='QUEUED')>=64
  THEN RAISE EXCEPTION 'hermes_zalo_queue_full' USING ERRCODE='PT429'; END IF;
  SELECT max(t.expires_at) INTO v_deadline
    FROM app_private.hermes_connection_tokens t WHERE t.connection_id=c.id AND t.revoked_at IS NULL AND t.expires_at>v_now;
  IF v_deadline IS NULL OR v_deadline<=v_now THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  v_deadline:=LEAST(v_now+interval '15 minutes',s.expires_at,v_deadline);
  INSERT INTO app_private.hermes_zalo_private_commands(binding_id,binding_epoch,account_id,organization_id,user_id,assistant_id,connection_id,
    connection_epoch,ingress_generation,sender_uid,provider_message_id,sent_at_ms,body,accepted_at,expires_at)
  VALUES(x.id,x.epoch,a.id,v_org,x.user_id,x.assistant_id,c.id,c.epoch,i.generation,x.sender_uid,p->>'providerMessageId',v_sent,p->>'text',v_now,v_deadline)
  RETURNING * INTO q;
  RETURN jsonb_build_object('status','queued','commandId',q.id,'accountId',a.id,'organizationId',v_org,'providerMessageId',q.provider_message_id);
END $$;

-- Forward replacement of app_private.hermes_private_command_connection_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_private_command_connection_v1(p_digest text)
RETURNS app_private.hermes_connections LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies; v_now timestamptz;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p_digest;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(c.organization_id);
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id FOR SHARE;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p_digest FOR SHARE;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id FOR SHARE;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  v_now:=clock_timestamp();
  IF c.id IS NULL OR s.id IS NULL OR t.token_digest IS NULL OR a.id IS NULL OR policy.organization_id IS NULL
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR c.credential_ref IS DISTINCT FROM s.id
    OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=v_now
    OR s.user_id<>c.user_id OR s.organization_id<>c.organization_id OR s.assistant_id<>c.assistant_id
    OR t.connection_id<>c.id OR t.revoked_at IS NOT NULL OR t.expires_at<=v_now OR t.created_at>v_now OR t.created_at+interval '30 days'<=v_now
    OR a.state<>'ACTIVE' OR NOT policy.enabled OR NOT(c.read_capabilities<@policy.read_capabilities)
    OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids)
  THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  RETURN c;
END $$;

-- Forward replacement of public.hermes_zalo_private_reply_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_zalo_private_reply_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE q app_private.hermes_zalo_private_commands; v_operation text; v_status text; v_outcome text; v_provider text;
  v_account uuid; v_org uuid; v_instance uuid; v_generation uuid; v_owner uuid; v_delivery uuid; v_id uuid;
  v_login timestamptz; v_exp timestamptz; v_now timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  v_operation:=p->>'operation';
  IF v_operation='ack' THEN
    PERFORM app_private.hermes_request_v1(p,ARRAY['operation','accountId','organizationId','instanceId','generation','accountOwnerId','ownUid','loginRequestedAt','deliveryId','outcome','providerMessageId']);
  ELSE
    PERFORM app_private.hermes_request_v1(p,ARRAY['operation','accountId','organizationId','instanceId','generation','accountOwnerId','ownUid','loginRequestedAt','deliveryId']);
  END IF;
  IF v_operation IS NULL OR v_operation NOT IN ('claim','dispatch','ack')
    OR jsonb_typeof(p->'ownUid') IS DISTINCT FROM 'string' OR p->>'ownUid' !~ '^[1-9][0-9]{0,39}$'
    OR (jsonb_typeof(p->'loginRequestedAt') IS DISTINCT FROM 'null' AND (jsonb_typeof(p->'loginRequestedAt') IS DISTINCT FROM 'string'
      OR p->>'loginRequestedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'))
  THEN RAISE EXCEPTION 'hermes_reply_invalid' USING ERRCODE='22023'; END IF;
  v_account:=app_private.hermes_uuid_v1(p->'accountId'); v_org:=app_private.hermes_uuid_v1(p->'organizationId');
  v_instance:=app_private.hermes_uuid_v1(p->'instanceId'); v_generation:=app_private.hermes_uuid_v1(p->'generation');
  v_owner:=app_private.hermes_uuid_v1(p->'accountOwnerId'); v_delivery:=app_private.hermes_uuid_v1(p->'deliveryId');
  BEGIN v_login:=(p->>'loginRequestedAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'hermes_reply_invalid' USING ERRCODE='22023'; END;
  IF v_operation='ack' THEN
    v_outcome:=p->>'outcome'; v_provider:=p->>'providerMessageId';
    IF jsonb_typeof(p->'outcome') IS DISTINCT FROM 'string' OR v_outcome NOT IN ('sent','unknown','cancelled')
      OR (v_outcome='sent' AND (jsonb_typeof(p->'providerMessageId') IS DISTINCT FROM 'string' OR v_provider !~ '^[A-Za-z0-9_-]{1,128}$'))
      OR (v_outcome<>'sent' AND jsonb_typeof(p->'providerMessageId') IS DISTINCT FROM 'null')
    THEN RAISE EXCEPTION 'hermes_reply_invalid' USING ERRCODE='22023'; END IF;
    -- A late receipt is proof about one already-admitted delivery, not current
    -- read/send authority. It may reconcile after revoke/relogin/expiry, but
    -- cannot return text, change recipient, or reopen the delivery.
    SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE delivery_id=v_delivery FOR UPDATE;
  ELSE
    -- Unlocked rejection hint only. The selected reply is checked again under
    -- the ordered authority locks below; never acquire worker locks first.
    IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts a
      JOIN app_private.hermes_zalo_bots b ON b.account_id=a.id AND b.organization_id=v_org AND b.enabled
      JOIN app_private.hermes_zalo_ingress_sessions i ON i.account_id=a.id
      JOIN public.zalo_worker_lease l ON l.id='singleton' AND l.instance_id=i.instance_id
      WHERE a.id=v_account AND a.organization_id=v_org AND a.kind='personal' AND a.status='connected'
        AND a.user_id=v_owner AND a.zalo_uid=p->>'ownUid' AND a.login_requested_at IS NOT DISTINCT FROM v_login
        AND i.organization_id=v_org AND i.account_owner_id=v_owner AND i.own_uid=p->>'ownUid'
        AND i.login_requested_at IS NOT DISTINCT FROM v_login AND i.instance_id=v_instance AND i.generation=v_generation
        AND l.heartbeat_at>clock_timestamp()-interval '30 seconds')
    THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
    SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE delivery_id=v_delivery;
    IF q.id IS NULL AND v_operation='claim' THEN
      IF EXISTS(SELECT 1 FROM app_private.hermes_zalo_private_commands WHERE account_id=v_account AND state IN ('REPLY_CLAIMED','REPLY_DISPATCHED'))
      THEN RETURN jsonb_build_object('status','empty'); END IF;
      -- Skip obsolete bindings and users so one revoked user cannot head-block
      -- other users sharing the bot. These predicates are discovery hints only;
      -- the canonical member/connection/channel helpers still lock and recheck.
      SELECT pending.id INTO v_id FROM app_private.hermes_zalo_private_commands pending
        JOIN app_private.hermes_connections c ON c.id=pending.connection_id
        JOIN app_private.hermes_sessions s ON s.id=c.credential_ref
        JOIN app_private.hermes_connection_tokens t ON t.connection_id=c.id AND t.revoked_at IS NULL
        JOIN app_private.hermes_assistants assistant ON assistant.id=c.assistant_id
        CROSS JOIN LATERAL app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids) policy
        JOIN app_private.hermes_zalo_bindings binding ON binding.id=pending.binding_id
        JOIN app_private.hermes_zalo_bots bot ON bot.account_id=pending.account_id
        WHERE pending.account_id=v_account AND pending.organization_id=v_org AND pending.state='READY'
          AND pending.expires_at>clock_timestamp() AND pending.delivery_id IS NULL
          AND pending.authorization_version IS NOT NULL AND EXISTS(SELECT 1 FROM public.organizations
            WHERE id=v_org AND authorization_version=pending.authorization_version AND status='ACTIVE')
          AND pending.authorization_expires_at>clock_timestamp()
          AND c.organization_id=v_org AND c.user_id=pending.user_id AND c.assistant_id=pending.assistant_id
          AND c.state='ACTIVE' AND c.revoked_at IS NULL AND c.epoch=pending.connection_epoch
          AND s.state='ACTIVE' AND s.quarantine_reason IS NULL AND s.expires_at>clock_timestamp()
          AND s.user_id=c.user_id AND s.organization_id=c.organization_id AND s.assistant_id=c.assistant_id
          AND t.expires_at>clock_timestamp() AND t.created_at<=clock_timestamp() AND t.created_at+interval '30 days'>clock_timestamp()
          AND assistant.state='ACTIVE' AND policy.enabled AND c.read_capabilities<@policy.read_capabilities
          AND c.action_capabilities<@policy.action_capabilities AND c.scope_ids<@policy.scope_ids
          AND binding.state='ACTIVE' AND binding.epoch=pending.binding_epoch AND binding.connection_epoch=c.epoch
          AND binding.connection_id=c.id AND binding.account_id=v_account AND binding.organization_id=v_org
          AND binding.user_id=c.user_id AND binding.assistant_id=c.assistant_id
          AND binding.sender_uid=pending.sender_uid AND binding.sender_uid<>p->>'ownUid'
          AND bot.enabled AND bot.version=binding.bot_version AND bot.organization_id=v_org
          AND (SELECT count(*) FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
            WHERE m.user_id=c.user_id AND m.organization_id=v_org AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
              AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))=1
          AND (EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=c.user_id)
            OR (SELECT count(DISTINCT m.organization_id) FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
              WHERE m.user_id=c.user_id AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
                AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))=1)
        ORDER BY pending.accepted_at,pending.id LIMIT 1;
      IF v_id IS NULL THEN RETURN jsonb_build_object('status','empty'); END IF;
    ELSE v_id:=q.id; END IF;
    q:=app_private.hermes_private_reply_lock_v1(v_id,p);
    IF v_operation='claim' AND q.state='READY' AND q.delivery_id IS NULL THEN
      -- The organization decision lock serializes contenders before this check;
      -- the partial unique index also enforces account-wide single flight.
      IF EXISTS(SELECT 1 FROM app_private.hermes_zalo_private_commands WHERE account_id=v_account AND state IN ('REPLY_CLAIMED','REPLY_DISPATCHED'))
      THEN RETURN jsonb_build_object('status','empty'); END IF;
      UPDATE app_private.hermes_zalo_private_commands SET state='REPLY_CLAIMED',delivery_id=v_delivery,
        reply_instance_id=v_instance,reply_generation=v_generation,reply_account_owner_id=v_owner,reply_own_uid=p->>'ownUid',
        reply_login_requested_at=v_login,reply_claimed_at=clock_timestamp() WHERE id=q.id RETURNING * INTO q;
    END IF;
  END IF;
  IF q.id IS NULL OR q.delivery_id IS DISTINCT FROM v_delivery OR q.account_id IS DISTINCT FROM v_account
    OR q.organization_id IS DISTINCT FROM v_org OR q.reply_instance_id IS DISTINCT FROM v_instance
    OR q.reply_generation IS DISTINCT FROM v_generation OR q.reply_account_owner_id IS DISTINCT FROM v_owner
    OR q.reply_own_uid IS DISTINCT FROM p->>'ownUid' OR q.reply_login_requested_at IS DISTINCT FROM v_login
  THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  IF v_operation='claim' THEN
    IF q.state<>'REPLY_CLAIMED' THEN RAISE EXCEPTION 'hermes_reply_conflict' USING ERRCODE='PT409'; END IF;
    SELECT LEAST(q.expires_at,q.authorization_expires_at,t.expires_at,s.expires_at,t.created_at+interval '30 days') INTO v_exp
      FROM app_private.hermes_connections c JOIN app_private.hermes_sessions s ON s.id=c.credential_ref
      JOIN app_private.hermes_connection_tokens t ON t.connection_id=c.id AND t.revoked_at IS NULL WHERE c.id=q.connection_id;
    RETURN jsonb_build_object('status','claimed','deliveryId',q.delivery_id,'commandId',q.id,'accountId',q.account_id,
      'organizationId',q.organization_id,'generation',q.reply_generation,'recipientUid',q.sender_uid,'text',q.reply_body,
      'expiresAt',floor(extract(epoch FROM v_exp)*1000)::bigint);
  ELSIF v_operation='dispatch' THEN
    IF q.state='REPLY_DISPATCHED' THEN v_status:='already_dispatched';
    ELSIF q.state='REPLY_CLAIMED' THEN
      UPDATE app_private.hermes_zalo_private_commands SET state='REPLY_DISPATCHED',reply_dispatched_at=clock_timestamp() WHERE id=q.id;
      v_status:='dispatched';
    ELSE RAISE EXCEPTION 'hermes_reply_conflict' USING ERRCODE='PT409'; END IF;
  ELSE
    IF q.reply_outcome IS NOT NULL THEN
      IF q.reply_outcome IS DISTINCT FROM v_outcome OR q.reply_provider_message_id IS DISTINCT FROM v_provider
      THEN RAISE EXCEPTION 'hermes_reply_conflict' USING ERRCODE='PT409'; END IF;
    ELSE
      IF (v_outcome='cancelled' AND (q.state<>'REPLY_CLAIMED' OR q.reply_dispatched_at IS NOT NULL))
        OR (v_outcome IN ('sent','unknown') AND (q.reply_dispatched_at IS NULL OR q.state NOT IN ('REPLY_DISPATCHED','UNKNOWN_EFFECT')))
      THEN RAISE EXCEPTION 'hermes_reply_conflict' USING ERRCODE='PT409'; END IF;
      UPDATE app_private.hermes_zalo_private_commands SET
        state=CASE v_outcome WHEN 'sent' THEN 'SENT' WHEN 'unknown' THEN 'UNKNOWN_EFFECT' ELSE 'FAILED' END,
        body=NULL,reply_body=NULL,reply_outcome=v_outcome,reply_provider_message_id=v_provider,reply_ack_at=clock_timestamp() WHERE id=q.id;
    END IF;
    v_status:=v_outcome;
  END IF;
  RETURN jsonb_build_object('status',v_status,'deliveryId',q.delivery_id,'commandId',q.id,'accountId',q.account_id,
    'organizationId',q.organization_id,'generation',q.reply_generation);
END $$;

-- Forward replacement of public.hermes_group_action_context_v1; identity, CRM, registry and connection fences remain.
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
  SELECT * INTO v_policy FROM app_private.hermes_effective_org_policy_v1(p_organization_id,ARRAY['chat_zalo.view']::text[],ARRAY['chat_zalo.send']::text[],'{}'::uuid[]);
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

-- Forward replacement of app_private.hermes_group_preview_context_v1; identity, CRM, registry and connection fences remain.
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
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'number' OR (p->>v_key !~ '^[1-9][0-9]{0,15}$' AND NOT(v_key='expectedPolicyVersion' AND p->>v_key='0'))
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
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
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

-- Forward replacement of app_private.hermes_group_current_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION app_private.hermes_group_current_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; q app_private.hermes_zalo_private_commands;
  a public.zalo_accounts; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
  x app_private.hermes_zalo_bindings; bot app_private.hermes_zalo_bots; ingress app_private.hermes_zalo_ingress_sessions;
  v_member jsonb; v_auth record; v_id uuid; v_building uuid; v_fact jsonb; v_facts jsonb:='[]'; v_groups jsonb;
  v_rooms uuid[]; v_convs uuid[]; v_scopes uuid[]; v_now timestamptz;
BEGIN
  c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  -- Take the strongest lease lock once. Concurrent admissions must not both
  -- hold SHARE then deadlock while upgrading to UPDATE.
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton'
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  q:=app_private.hermes_private_command_lock_v1(c,(p->>'commandId')::uuid,p->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT * INTO a FROM public.zalo_accounts WHERE id=q.account_id;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=q.binding_id;
  SELECT * INTO bot FROM app_private.hermes_zalo_bots WHERE account_id=a.id;
  SELECT * INTO ingress FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id;
  v_member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  v_now:=clock_timestamp();
  IF c.id::text IS DISTINCT FROM p->>'connectionId' OR q.claim_id::text IS DISTINCT FROM p->>'claimId'
    OR c.epoch::text IS DISTINCT FROM p->>'expectedEpoch' OR policy.version::text IS DISTINCT FROM p->>'expectedPolicyVersion'
    OR s.revision::text IS DISTINCT FROM p->>'expectedSessionRevision'
    OR v_member->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId'
    OR v_member->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    OR q.ingress_generation IS DISTINCT FROM ingress.generation
    OR NOT('rooms.view'=ANY(c.read_capabilities)) OR NOT('rooms.view'=ANY(policy.read_capabilities))
    OR NOT('chat_zalo.view'=ANY(c.read_capabilities)) OR NOT('chat_zalo.view'=ANY(policy.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)
    OR NOT('chat_zalo.send'=ANY(c.action_capabilities)) OR NOT('chat_zalo.send'=ANY(policy.action_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled)
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
    -- The helper checks current membership, offboarding, emergency deny and
    -- the actual org-wide send/view rights; no duplicated role permission map.
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.send');
    IF v_auth.allowed IS DISTINCT FROM true OR v_auth.authorization_version::text IS DISTINCT FROM p->>'expectedAuthorizationVersion'
      THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.view');
    IF v_auth.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
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
  RETURN jsonb_build_object('owner',jsonb_build_object('userId',c.user_id,'organizationId',c.organization_id,'assistantId',c.assistant_id,'connectionId',c.id),
    'binding',jsonb_build_object('epoch',c.epoch,'policyVersion',policy.version,'membershipId',v_member->'membershipId',
      'authorizationVersion',v_member->'authorizationVersion','sessionRevision',s.revision,'bindingId',x.id,'bindingEpoch',x.epoch,
      'assistantEpoch',(SELECT context_epoch FROM app_private.hermes_assistants WHERE id=c.assistant_id)),
    'scopeIds',to_jsonb(v_scopes),'sender',jsonb_build_object('accountId',a.id,'accountOwnerId',a.user_id,'name',a.name,
      'ownUid',ingress.own_uid,'loginRequestedAt',a.login_requested_at,'botVersion',bot.version,'ingressGeneration',ingress.generation),
    'recipients',v_groups,'publicFacts',v_facts);
END $fn$;

-- Forward replacement of public.hermes_group_send_status_v1; identity, CRM, registry and connection fences remain.
CREATE OR REPLACE FUNCTION public.hermes_group_send_status_v1(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE h app_private.hermes_group_dispatches; c app_private.hermes_connections; policy app_private.hermes_org_policies;
  s app_private.hermes_sessions; v_auth record; v_rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=p_dispatch_id AND user_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_not_found' USING ERRCODE='P0002'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(h.organization_id);
  PERFORM app_private.hermes_member_v1(auth.uid(),h.organization_id);
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=(h.snapshot#>>'{owner,connectionId}')::uuid;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=(h.snapshot#>>'{owner,connectionId}')::uuid FOR SHARE;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=h.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(h.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id IS NULL OR c.user_id IS DISTINCT FROM auth.uid() OR c.organization_id IS DISTINCT FROM h.organization_id OR c.state<>'ACTIVE'
    OR c.revoked_at IS NOT NULL OR s.id IS DISTINCT FROM c.credential_ref OR s.state IS DISTINCT FROM 'ACTIVE'
    OR s.user_id IS DISTINCT FROM c.user_id OR s.organization_id IS DISTINCT FROM c.organization_id OR s.assistant_id IS DISTINCT FROM c.assistant_id
    OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR s.quarantine_reason IS NOT NULL OR s.expires_at<=clock_timestamp() OR policy.organization_id IS NULL OR NOT policy.enabled
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants WHERE id=c.assistant_id AND user_id=auth.uid() AND organization_id=h.organization_id AND state='ACTIVE')
    OR NOT('chat_zalo.view'=ANY(c.read_capabilities)) OR NOT('chat_zalo.view'=ANY(policy.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(auth.uid(),h.organization_id,'chat_zalo.view');
  IF v_auth.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- Expired dispatches remain readable with CURRENT group-read authority. Status never retries
  -- delivery; unknown has priority over the queue's coarse failed/sent field.
  SELECT jsonb_agg(jsonb_build_object('conversationId',j.conversation_id,'jobId',j.job_id,'name',z.peer_name,
    'status',CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown'
      WHEN q.status='sent' THEN 'sent' WHEN q.status='failed' THEN 'failed' WHEN q.status='processing' THEN 'processing' ELSE 'queued' END)
    ORDER BY j.conversation_id) INTO v_rows FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue q ON q.id=j.job_id
    JOIN public.zalo_conversations z ON z.id=j.conversation_id AND z.organization_id=h.organization_id
      AND z.account_id=(h.snapshot#>>'{sender,accountId}')::uuid AND z.thread_type='group'
    CROSS JOIN LATERAL jsonb_array_elements(h.snapshot->'recipients') r
    WHERE j.dispatch_id=h.id AND r->>'conversationId'=j.conversation_id::text;
  IF jsonb_array_length(v_rows) IS DISTINCT FROM jsonb_array_length(h.snapshot->'recipients')
    THEN RAISE EXCEPTION 'hermes_group_origin_changed' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('id',h.id,'expiresAt',to_char(h.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recipients',v_rows);
END $fn$;

ALTER FUNCTION app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_prepare_connection_v1(uuid,text[],text[],uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_prepare_connection_v1(uuid,text[],text[],uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_prepare_connection_v1(uuid,text[],text[],uuid[]) TO authenticated;

ALTER FUNCTION app_private.hermes_session_gate_v1(app_private.hermes_sessions) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_session_gate_v1(app_private.hermes_sessions) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_store_activate_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_activate_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_activate_v1(jsonb) TO hermes_store_executor;

ALTER FUNCTION app_private.hermes_store_read_connection_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_read_connection_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_read_connection_v1(jsonb) TO hermes_store_executor;

ALTER FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) TO hermes_store_executor;

ALTER FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) TO authenticated;

ALTER FUNCTION public.hermes_connection_context_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_context_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_context_v1(uuid) TO authenticated;

ALTER FUNCTION public.hermes_connection_options_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_options_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_options_v1(uuid) TO authenticated;

ALTER FUNCTION public.hermes_org_policy_options_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_org_policy_options_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v1(uuid) TO authenticated;

ALTER FUNCTION app_private.hermes_zalo_context_v1(uuid,uuid,uuid,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_context_v1(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_zalo_private_command_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_private_command_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_private_command_v1(jsonb) TO service_role;

ALTER FUNCTION app_private.hermes_private_command_connection_v1(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_private_command_connection_v1(text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_zalo_private_reply_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_private_reply_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_private_reply_v1(jsonb) TO service_role;

ALTER FUNCTION public.hermes_group_action_context_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_group_action_context_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_action_context_v1(uuid) TO authenticated;

ALTER FUNCTION app_private.hermes_group_preview_context_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_preview_context_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_current_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_current_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_group_send_status_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_group_send_status_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_send_status_v1(uuid) TO authenticated;

COMMIT;
