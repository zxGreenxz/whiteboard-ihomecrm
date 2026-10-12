-- P2A: fixed private store calls. No runtime SQL/RPC-name forwarding and no API-role grants.
-- Ciphertext is supplied by the trusted broker; encryption keys never enter PostgreSQL.
-- A refresh is DISPATCHED before provider I/O, then STAGED before publication.
-- Unknown publication is reconciled with the SAME publish claim/receipt, never
-- another provider refresh. This protocol does not promise distributed exactly-once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION app_private.hermes_request_v1(p jsonb,p_keys text[])
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'object' OR pg_column_size(p)>131072 THEN RAISE EXCEPTION 'hermes_request_invalid' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(p_keys) OR NOT (p ?& p_keys) THEN
    RAISE EXCEPTION 'hermes_request_invalid' USING ERRCODE='22023';
  END IF;
END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_uuid_v1(p jsonb)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'string' OR (p#>>'{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'hermes_identifier_invalid' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::uuid;
END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_integer_v1(p jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE v bigint;
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'number' OR (p#>>'{}') !~ '^[0-9]{1,16}$' THEN RAISE EXCEPTION 'hermes_integer_invalid' USING ERRCODE='22023'; END IF;
  v:=(p#>>'{}')::bigint;
  IF v<1 OR v>9007199254740991 THEN RAISE EXCEPTION 'hermes_integer_invalid' USING ERRCODE='22023'; END IF;
  RETURN v;
END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_envelope_v1(p jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['v','algorithm','keyVersion','nonce','ciphertext','tag']);
  IF p->'v' IS DISTINCT FROM '1'::jsonb OR p->>'algorithm' IS DISTINCT FROM 'A256GCM'
    OR jsonb_typeof(p->'keyVersion')<>'string' OR (p->>'keyVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR jsonb_typeof(p->'nonce')<>'string' OR (p->>'nonce') !~ '^[A-Za-z0-9_-]{16}$'
    OR jsonb_typeof(p->'tag')<>'string' OR (p->>'tag') !~ '^[A-Za-z0-9_-]{22}$'
    OR jsonb_typeof(p->'ciphertext')<>'string' OR (p->>'ciphertext') !~ '^[A-Za-z0-9_-]{1,87382}$' THEN
    RAISE EXCEPTION 'hermes_envelope_invalid' USING ERRCODE='22023'; END IF;
END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_binding_matches_v1(s app_private.hermes_sessions,p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['assistantId','userId','organizationId','sessionId']);
  RETURN s.assistant_id=app_private.hermes_uuid_v1(p->'assistantId') AND s.user_id=app_private.hermes_uuid_v1(p->'userId')
    AND s.organization_id=app_private.hermes_uuid_v1(p->'organizationId') AND s.provider_session_id=app_private.hermes_uuid_v1(p->'sessionId');
END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_session_json_v1(s app_private.hermes_sessions)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
SELECT jsonb_build_object('credentialRef',s.id,'revision',s.revision,'envelope',s.envelope,
  'expiresAt',floor(extract(epoch FROM s.expires_at)*1000)::bigint,
  'binding',jsonb_build_object('assistantId',s.assistant_id,'userId',s.user_id,'organizationId',s.organization_id,'sessionId',s.provider_session_id))
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_session_gate_v1(s app_private.hermes_sessions)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
BEGIN
  PERFORM app_private.hermes_member_v1(s.user_id,s.organization_id);
  RETURN EXISTS(SELECT 1 FROM app_private.hermes_assistants a JOIN app_private.hermes_org_policies p ON p.organization_id=a.organization_id
    WHERE a.id=s.assistant_id AND a.state='ACTIVE' AND p.enabled)
    AND EXISTS(SELECT 1 FROM app_private.hermes_connections c JOIN app_private.hermes_connection_tokens t ON t.connection_id=c.id
      WHERE c.credential_ref=s.id AND c.state='ACTIVE' AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp());
END
$fn$;

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
  SELECT * INTO policy FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
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
  SELECT * INTO policy FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  RETURN jsonb_build_object('status','active','connection',app_private.hermes_connection_json_v1(c)||jsonb_build_object(
      'tokenDigest',t.token_digest,'credentialRef',s.id,'expiresAt',floor(extract(epoch FROM t.expires_at)*1000)::bigint),
    'session',app_private.hermes_session_json_v1(s),'membership',member_context,
    'policy',jsonb_build_object('version',policy.version,'read',policy.read_capabilities,'action',policy.action_capabilities,'scopeIds',policy.scope_ids));
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_restrict_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE c app_private.hermes_connections; v_id uuid; v_epoch bigint; r text[]; a text[]; scopes uuid[];
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','expectedEpoch','read','action','scopeIds']);
  v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
  IF jsonb_typeof(p->'read')<>'array' OR jsonb_typeof(p->'action')<>'array' OR jsonb_typeof(p->'scopeIds')<>'array' THEN RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(value),'{}') INTO r FROM jsonb_array_elements_text(p->'read');
  SELECT coalesce(array_agg(value),'{}') INTO a FROM jsonb_array_elements_text(p->'action');
  SELECT coalesce(array_agg(app_private.hermes_uuid_v1(value)),'{}') INTO scopes FROM jsonb_array_elements(p->'scopeIds');
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id AND state='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
  IF NOT FOUND OR c.state<>'ACTIVE' OR c.epoch<>v_epoch THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  PERFORM app_private.hermes_validate_limits_v1(c.organization_id,r,a,scopes);
  IF NOT(r<@c.read_capabilities) OR NOT(a<@c.action_capabilities) OR NOT(scopes<@c.scope_ids) THEN
    RAISE EXCEPTION 'hermes_narrow_only' USING ERRCODE='42501'; END IF;
  UPDATE app_private.hermes_connections SET read_capabilities=r,action_capabilities=a,scope_ids=scopes,epoch=epoch+1 WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('ok',true,'connection',app_private.hermes_connection_json_v1(c));
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_revoke_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE c app_private.hermes_connections; v_id uuid; v_epoch bigint;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','expectedEpoch']);
  v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'status','missing'); END IF;
  IF c.state='REVOKED' THEN RETURN jsonb_build_object('ok',true,'status','already_revoked'); END IF;
  IF c.credential_ref IS NULL THEN
    -- Pending intents have no session to lock. The CAS also resolves a race with
    -- activation: if activation wins, its epoch change forces the caller to read
    -- again; this branch never upgrades a connection lock into a session lock.
    UPDATE app_private.hermes_connections SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp()
      WHERE id=c.id AND state='PENDING' AND credential_ref IS NULL AND epoch=v_epoch;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('ok',true,'status','revoked');
  END IF;
  -- Publish and connection revoke serialize on the credential row. A provider
  -- call dispatched before revocation may finish; joined reads still refuse the
  -- revoked connection. Another valid connection does not lose its session.
  PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
  IF c.state='REVOKED' THEN RETURN jsonb_build_object('ok',true,'status','already_revoked'); END IF;
  IF c.epoch<>v_epoch THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  UPDATE app_private.hermes_connections SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp() WHERE id=c.id;
  UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp() WHERE connection_id=c.id AND revoked_at IS NULL;
  -- This intentionally does not delete/revoke shared session material.
  RETURN jsonb_build_object('ok',true,'status','revoked');
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_acquire_refresh_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE s app_private.hermes_sessions; v_id uuid; v_owner uuid; v_ms bigint;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef','binding','ownerId','leaseMs']);
  v_id:=app_private.hermes_uuid_v1(p->'credentialRef'); v_owner:=app_private.hermes_uuid_v1(p->'ownerId'); v_ms:=app_private.hermes_integer_v1(p->'leaseMs');
  IF v_ms<1000 OR v_ms>120000 THEN RAISE EXCEPTION 'hermes_lease_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=v_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','missing'); END IF;
  IF NOT app_private.hermes_binding_matches_v1(s,p->'binding') THEN RAISE EXCEPTION 'hermes_binding_mismatch' USING ERRCODE='42501'; END IF;
  IF s.state IN ('REVOKED','RECONNECT_REQUIRED') THEN RETURN jsonb_build_object('status',lower(s.state)); END IF;
  IF NOT app_private.hermes_session_gate_v1(s) THEN RETURN jsonb_build_object('status','revoked'); END IF;
  IF s.state IN ('RESERVED','DISPATCHED','STAGED') AND s.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('status','busy','reconcile',s.state='STAGED'); END IF;
  IF s.state IN ('DISPATCHED','STAGED') THEN
    UPDATE app_private.hermes_sessions SET state='RECONNECT_REQUIRED',quarantine_reason='lease_expired',envelope=NULL,
      staged_envelope=NULL,staged_expires_at=NULL,revision=revision+1 WHERE id=s.id;
    RETURN jsonb_build_object('status','reconnect_required');
  END IF;
  UPDATE app_private.hermes_sessions SET state='RESERVED',fence=fence+1,lease_owner=v_owner,
    lease_until=clock_timestamp()+v_ms*interval '1 millisecond',published_fence=NULL WHERE id=s.id RETURNING * INTO s;
  RETURN jsonb_build_object('status','acquired','credential',app_private.hermes_session_json_v1(s),
    'lease',jsonb_build_object('fence',s.fence,'expiresAt',floor(extract(epoch FROM s.lease_until)*1000)::bigint));
END
$fn$;

-- Internal claim lock. All comparisons use the DB clock; no caller-provided now.
CREATE OR REPLACE FUNCTION app_private.hermes_claim_v1(p jsonb)
RETURNS app_private.hermes_sessions LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE s app_private.hermes_sessions; v_id uuid; v_owner uuid; v_revision bigint; v_fence bigint;
BEGIN
  v_id:=app_private.hermes_uuid_v1(p->'credentialRef'); v_owner:=app_private.hermes_uuid_v1(p->'ownerId');
  v_revision:=app_private.hermes_integer_v1(p->'revision'); v_fence:=app_private.hermes_integer_v1(p->'fence');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_claim_changed' USING ERRCODE='40001'; END IF;
  IF NOT app_private.hermes_binding_matches_v1(s,p->'binding') OR s.lease_owner IS DISTINCT FROM v_owner
    OR s.fence<>v_fence OR s.revision NOT IN (v_revision,v_revision+1) THEN
    RAISE EXCEPTION 'hermes_claim_changed' USING ERRCODE='40001'; END IF;
  RETURN s;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_dispatch_refresh_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE s app_private.hermes_sessions;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef','binding','ownerId','revision','fence']);
  s:=app_private.hermes_claim_v1(p);
  IF s.state<>'RESERVED' OR s.revision<>app_private.hermes_integer_v1(p->'revision') OR s.lease_until<=clock_timestamp()
    OR NOT app_private.hermes_session_gate_v1(s) THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE app_private.hermes_sessions SET state='DISPATCHED' WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'status','dispatched');
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_stage_refresh_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE s app_private.hermes_sessions; v_exp timestamptz;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef','binding','ownerId','revision','fence','envelope','expiresAt']);
  PERFORM app_private.hermes_envelope_v1(p->'envelope');
  v_exp:=to_timestamp(app_private.hermes_integer_v1(p->'expiresAt')/1000.0);
  s:=app_private.hermes_claim_v1(p);
  IF s.revision<>app_private.hermes_integer_v1(p->'revision') OR s.lease_until<=clock_timestamp()
    OR v_exp<=clock_timestamp() OR v_exp>clock_timestamp()+interval '24 hours'
    OR NOT app_private.hermes_session_gate_v1(s) THEN RETURN jsonb_build_object('ok',false); END IF;
  IF s.state='STAGED' THEN RETURN jsonb_build_object('ok',s.staged_envelope=p->'envelope' AND s.staged_expires_at=v_exp,'status','staged'); END IF;
  IF s.state<>'DISPATCHED' THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE app_private.hermes_sessions SET state='STAGED',envelope=NULL,staged_envelope=p->'envelope',staged_expires_at=v_exp WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'status','staged');
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_publish_refresh_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE s app_private.hermes_sessions; v_revision bigint; v_fence bigint;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef','binding','ownerId','revision','fence']);
  s:=app_private.hermes_claim_v1(p); v_revision:=app_private.hermes_integer_v1(p->'revision'); v_fence:=app_private.hermes_integer_v1(p->'fence');
  IF NOT app_private.hermes_session_gate_v1(s) THEN RETURN jsonb_build_object('ok',false); END IF;
  -- Reconcile an unknown publish acknowledgement without any provider request.
  IF s.state='ACTIVE' AND s.published_fence=v_fence AND s.revision=v_revision+1 AND s.expires_at>clock_timestamp() THEN
    RETURN jsonb_build_object('ok',true,'status','already_published','revision',s.revision,'fence',s.fence);
  END IF;
  IF s.state<>'STAGED' OR s.revision<>v_revision OR s.lease_until<=clock_timestamp()
    OR s.staged_expires_at<=clock_timestamp() OR s.staged_envelope IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE app_private.hermes_sessions SET state='ACTIVE',envelope=staged_envelope,expires_at=staged_expires_at,
    staged_envelope=NULL,staged_expires_at=NULL,revision=revision+1,published_fence=fence WHERE id=s.id RETURNING * INTO s;
  RETURN jsonb_build_object('ok',true,'status','published','revision',s.revision,'fence',s.fence);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_reconnect_session_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE s app_private.hermes_sessions;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef','binding','ownerId','revision','fence']);
  s:=app_private.hermes_claim_v1(p);
  IF s.state='REVOKED' THEN RETURN jsonb_build_object('ok',false); END IF;
  IF s.state='RECONNECT_REQUIRED' THEN RETURN jsonb_build_object('ok',true,'status','already_quarantined'); END IF;
  UPDATE app_private.hermes_sessions SET state='RECONNECT_REQUIRED',quarantine_reason='refresh_uncertain',
    envelope=NULL,staged_envelope=NULL,staged_expires_at=NULL,revision=revision+1 WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'status','reconnect_required');
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_revoke_session_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE v_id uuid; s app_private.hermes_sessions;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef']); v_id:=app_private.hermes_uuid_v1(p->'credentialRef');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=v_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'status','missing'); END IF;
  IF s.state='REVOKED' THEN RETURN jsonb_build_object('ok',true,'status','already_revoked'); END IF;
  UPDATE app_private.hermes_sessions SET state='REVOKED',quarantine_reason='session_revoked',envelope=NULL,
    staged_envelope=NULL,staged_expires_at=NULL,revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'status','revoked');
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_release_refresh_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE s app_private.hermes_sessions;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['credentialRef','binding','ownerId','revision','fence']);
  s:=app_private.hermes_claim_v1(p);
  IF s.state<>'RESERVED' OR s.revision<>app_private.hermes_integer_v1(p->'revision') THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE app_private.hermes_sessions SET state='ACTIVE',lease_owner=NULL,lease_until=NULL WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'status','released');
END
$fn$;

ALTER FUNCTION app_private.hermes_request_v1(jsonb,text[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_uuid_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_integer_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_envelope_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_binding_matches_v1(app_private.hermes_sessions,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_session_json_v1(app_private.hermes_sessions) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_session_gate_v1(app_private.hermes_sessions) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_claim_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_activate_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_read_connection_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_restrict_connection_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_revoke_connection_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_acquire_refresh_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_dispatch_refresh_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_stage_refresh_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_publish_refresh_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_reconnect_session_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_revoke_session_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_release_refresh_v1(jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION app_private.hermes_request_v1(jsonb,text[]),app_private.hermes_uuid_v1(jsonb),
  app_private.hermes_integer_v1(jsonb),app_private.hermes_envelope_v1(jsonb),
  app_private.hermes_binding_matches_v1(app_private.hermes_sessions,jsonb),
  app_private.hermes_session_json_v1(app_private.hermes_sessions),app_private.hermes_session_gate_v1(app_private.hermes_sessions),
  app_private.hermes_claim_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_store_activate_v1(jsonb),app_private.hermes_store_read_connection_v1(jsonb),
  app_private.hermes_store_restrict_connection_v1(jsonb),app_private.hermes_store_revoke_connection_v1(jsonb),
  app_private.hermes_store_acquire_refresh_v1(jsonb),app_private.hermes_store_dispatch_refresh_v1(jsonb),
  app_private.hermes_store_stage_refresh_v1(jsonb),app_private.hermes_store_publish_refresh_v1(jsonb),
  app_private.hermes_store_reconnect_session_v1(jsonb),app_private.hermes_store_revoke_session_v1(jsonb),
  app_private.hermes_store_release_refresh_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_activate_v1(jsonb),app_private.hermes_store_read_connection_v1(jsonb),
  app_private.hermes_store_restrict_connection_v1(jsonb),app_private.hermes_store_revoke_connection_v1(jsonb),
  app_private.hermes_store_acquire_refresh_v1(jsonb),app_private.hermes_store_dispatch_refresh_v1(jsonb),
  app_private.hermes_store_stage_refresh_v1(jsonb),app_private.hermes_store_publish_refresh_v1(jsonb),
  app_private.hermes_store_reconnect_session_v1(jsonb),app_private.hermes_store_revoke_session_v1(jsonb),
  app_private.hermes_store_release_refresh_v1(jsonb) TO hermes_store_executor;
COMMIT;
