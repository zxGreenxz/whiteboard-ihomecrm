-- Existing rows remain legacy allowlists: missing historical keys do not prove
-- human intent. New inheritance stores explicit exclusions independently of CRM.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
ALTER TABLE app_private.hermes_connections
 ADD COLUMN IF NOT EXISTS permission_mode text NOT NULL DEFAULT 'legacy_allowlist',
 ADD COLUMN IF NOT EXISTS excluded_read text[] NOT NULL DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS excluded_action text[] NOT NULL DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS scope_mode text NOT NULL DEFAULT 'restricted';
DO $fn$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.hermes_connections'::regclass AND conname='hermes_connection_permission_mode_v2') THEN
  ALTER TABLE app_private.hermes_connections ADD CONSTRAINT hermes_connection_permission_mode_v2 CHECK (
   permission_mode IN ('legacy_allowlist','inherit_crm') AND scope_mode IN ('restricted','unrestricted')
   AND (permission_mode='inherit_crm' OR (scope_mode='restricted' AND excluded_read='{}' AND excluded_action='{}'))
   AND cardinality(excluded_read)<=256 AND cardinality(excluded_action)<=256
   AND array_position(excluded_read,NULL) IS NULL AND array_position(excluded_action,NULL) IS NULL);
 END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_connection_json_v1(p_row app_private.hermes_connections)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT jsonb_build_object('id',p_row.id,'assistantId',p_row.assistant_id,'organizationId',p_row.organization_id,
  'userId',p_row.user_id,'state',lower(p_row.state),'epoch',p_row.epoch,
  'restrictions',jsonb_build_object('read',p_row.read_capabilities,'action',p_row.action_capabilities),'scopeIds',p_row.scope_ids,
  'permissionMode',p_row.permission_mode,'exclusions',jsonb_build_object('read',p_row.excluded_read,'action',p_row.excluded_action),'scopeMode',p_row.scope_mode)
$fn$;
-- Compatibility projection used by existing RPC/output fences. CRM grants and
-- company policy remain live intersections. Registry off/on preserves intent;
-- projection updates never rotate credentials, change identity or bump epoch.
CREATE OR REPLACE FUNCTION app_private.hermes_project_connection_limits_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 IF NEW.permission_mode='inherit_crm' THEN
  SELECT COALESCE(array_agg(capability ORDER BY capability),'{}'::text[]) INTO NEW.read_capabilities
   FROM app_private.hermes_capabilities WHERE mode='read' AND enabled AND NOT(capability=ANY(NEW.excluded_read));
  SELECT COALESCE(array_agg(capability ORDER BY capability),'{}'::text[]) INTO NEW.action_capabilities
   FROM app_private.hermes_capabilities WHERE mode='action' AND enabled AND NOT(capability=ANY(NEW.excluded_action));
  IF NEW.scope_mode='unrestricted' THEN
   SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO NEW.scope_ids FROM public.authorization_scopes
    WHERE organization_id=NEW.organization_id AND scope_type IN ('ORGANIZATION','AREA','BUILDING') AND cashbook_id IS NULL;
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS hermes_connection_limits_projection_v2 ON app_private.hermes_connections;
CREATE TRIGGER hermes_connection_limits_projection_v2 BEFORE INSERT OR UPDATE ON app_private.hermes_connections
 FOR EACH ROW EXECUTE FUNCTION app_private.hermes_project_connection_limits_v2();
CREATE OR REPLACE FUNCTION app_private.hermes_refresh_scope_projection_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 PERFORM 1 FROM app_private.hermes_connections c WHERE c.permission_mode='inherit_crm' AND c.scope_mode='unrestricted' AND c.state<>'REVOKED'
  AND c.organization_id IN (SELECT organization_id FROM hermes_changed_scopes) ORDER BY c.organization_id,c.id FOR UPDATE;
 UPDATE app_private.hermes_connections c SET scope_ids=c.scope_ids WHERE c.permission_mode='inherit_crm' AND c.scope_mode='unrestricted' AND c.state<>'REVOKED'
  AND c.organization_id IN (SELECT organization_id FROM hermes_changed_scopes);
 RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_refresh_scope_update_projection_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 PERFORM 1 FROM app_private.hermes_connections c WHERE c.permission_mode='inherit_crm' AND c.scope_mode='unrestricted' AND c.state<>'REVOKED'
  AND c.organization_id IN (SELECT organization_id FROM hermes_old_scopes UNION SELECT organization_id FROM hermes_changed_scopes)
  ORDER BY c.organization_id,c.id FOR UPDATE;
 UPDATE app_private.hermes_connections c SET scope_ids=c.scope_ids WHERE c.permission_mode='inherit_crm' AND c.scope_mode='unrestricted' AND c.state<>'REVOKED'
  AND c.organization_id IN (SELECT organization_id FROM hermes_old_scopes UNION SELECT organization_id FROM hermes_changed_scopes);
 RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_refresh_registry_projection_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 PERFORM 1 FROM app_private.hermes_connections WHERE permission_mode='inherit_crm' AND state<>'REVOKED' ORDER BY organization_id,id FOR UPDATE;
 UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities WHERE permission_mode='inherit_crm' AND state<>'REVOKED';
 RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS hermes_registry_projection_v2 ON app_private.hermes_capabilities;
CREATE TRIGGER hermes_registry_projection_v2 AFTER INSERT OR UPDATE OR DELETE ON app_private.hermes_capabilities
 FOR EACH STATEMENT EXECUTE FUNCTION app_private.hermes_refresh_registry_projection_v2();
DROP TRIGGER IF EXISTS hermes_scope_insert_projection_v2 ON public.authorization_scopes;
CREATE TRIGGER hermes_scope_insert_projection_v2 AFTER INSERT ON public.authorization_scopes
 REFERENCING NEW TABLE AS hermes_changed_scopes FOR EACH STATEMENT EXECUTE FUNCTION app_private.hermes_refresh_scope_projection_v2();
DROP TRIGGER IF EXISTS hermes_scope_update_projection_v2 ON public.authorization_scopes;
CREATE TRIGGER hermes_scope_update_projection_v2 AFTER UPDATE ON public.authorization_scopes
 REFERENCING OLD TABLE AS hermes_old_scopes NEW TABLE AS hermes_changed_scopes FOR EACH STATEMENT EXECUTE FUNCTION app_private.hermes_refresh_scope_update_projection_v2();
DROP TRIGGER IF EXISTS hermes_scope_delete_projection_v2 ON public.authorization_scopes;
CREATE TRIGGER hermes_scope_delete_projection_v2 AFTER DELETE ON public.authorization_scopes
 REFERENCING OLD TABLE AS hermes_changed_scopes FOR EACH STATEMENT EXECUTE FUNCTION app_private.hermes_refresh_scope_projection_v2();
CREATE OR REPLACE FUNCTION app_private.hermes_validate_exclusions_v2(p_read text[],p_action text[])
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
BEGIN
 IF p_read IS NULL OR p_action IS NULL OR cardinality(p_read)>256 OR cardinality(p_action)>256
  OR array_position(p_read,NULL) IS NOT NULL OR array_position(p_action,NULL) IS NOT NULL
  OR cardinality(p_read)<>(SELECT count(DISTINCT k) FROM unnest(p_read) k)
  OR cardinality(p_action)<>(SELECT count(DISTINCT k) FROM unnest(p_action) k)
  OR EXISTS(SELECT 1 FROM unnest(p_read) k WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities c WHERE c.capability=k AND c.mode='read'))
  OR EXISTS(SELECT 1 FROM unnest(p_action) k WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities c WHERE c.capability=k AND c.mode='action'))
 THEN RAISE EXCEPTION 'hermes_exclusions_invalid' USING ERRCODE='22023'; END IF;
END $fn$;
-- Canonical hash-chain audit, attributed to the immutable connection owner
-- already verified by the browser control plane; transaction-local claims are
-- restored before return. No session, token or envelope enters the audit.
CREATE OR REPLACE FUNCTION app_private.hermes_audit_connection_change_v2(c app_private.hermes_connections,p_event text,p_old jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE previous_sub text:=current_setting('request.jwt.claim.sub',true); previous_claims text:=current_setting('request.jwt.claims',true);
BEGIN
 PERFORM set_config('request.jwt.claim.sub',c.user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',c.user_id)::text,true);
 PERFORM app_private.append_authz_audit_v1(c.organization_id,p_event,'hermes_connection',c.id,p_old,
  app_private.hermes_connection_json_v1(c),'Explicit owner Hermes settings change');
 PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_sub,''),true);
 PERFORM set_config('request.jwt.claims',COALESCE(previous_claims,''),true);
END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_prepare_connection_v2(p_org uuid,p_excluded_read text[],p_excluded_action text[],p_scope_mode text,p_scope_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE actor uuid:=auth.uid(); assistant app_private.hermes_assistants; c app_private.hermes_connections;
 secret text:=encode(extensions.gen_random_bytes(32),'hex'); policy app_private.hermes_org_policies;
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM app_private.hermes_member_v1(actor,p_org);
 IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
 PERFORM app_private.hermes_validate_exclusions_v2(p_excluded_read,p_excluded_action);
 IF p_scope_mode IS NULL OR p_scope_mode NOT IN ('restricted','unrestricted') OR p_scope_ids IS NULL
  OR (p_scope_mode='unrestricted' AND cardinality(p_scope_ids)<>0) THEN RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
 PERFORM app_private.hermes_validate_limits_v1(p_org,'{}','{}',p_scope_ids);
 policy:=app_private.hermes_effective_org_policy_v1(p_org,NULL,NULL,NULL);
 IF NOT policy.enabled THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.hermes_assistants(organization_id,user_id) VALUES(p_org,actor) ON CONFLICT(organization_id,user_id) DO NOTHING;
 SELECT * INTO assistant FROM app_private.hermes_assistants WHERE organization_id=p_org AND user_id=actor FOR SHARE;
 IF assistant.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.hermes_connections(assistant_id,organization_id,user_id,permission_mode,excluded_read,excluded_action,scope_mode,scope_ids,intent_digest,intent_expires_at)
 VALUES(assistant.id,p_org,actor,'inherit_crm',p_excluded_read,p_excluded_action,p_scope_mode,p_scope_ids,
  encode(extensions.digest(secret,'sha256'),'hex'),clock_timestamp()+interval '5 minutes') RETURNING * INTO c;
 PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_CONNECTION_PREPARED','hermes_connection',c.id,NULL,
  app_private.hermes_connection_json_v1(c),'Explicit CRM inheritance connection intent');
 RETURN app_private.hermes_connection_json_v1(c)||jsonb_build_object('intentSecret',secret,
  'intentExpiresAt',floor(extract(epoch FROM c.intent_expires_at)*1000)::bigint);
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_store_connection_settings_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; old_state jsonb; r text[]; a text[]; scopes uuid[]; v_id uuid; v_epoch bigint;
BEGIN
 PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','expectedEpoch','permissionMode','exclusions','scopeMode','scopeIds']);
 v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
 IF p->>'permissionMode' IS DISTINCT FROM 'inherit_crm' OR p->>'scopeMode' IS NULL OR p->>'scopeMode' NOT IN ('restricted','unrestricted')
  OR jsonb_typeof(p->'exclusions') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'scopeIds') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
 PERFORM app_private.hermes_request_v1(p->'exclusions',ARRAY['read','action']);
 IF jsonb_typeof(p#>'{exclusions,read}') IS DISTINCT FROM 'array' OR jsonb_typeof(p#>'{exclusions,action}') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(array_agg(value),'{}') INTO r FROM jsonb_array_elements_text(p#>'{exclusions,read}');
 SELECT COALESCE(array_agg(value),'{}') INTO a FROM jsonb_array_elements_text(p#>'{exclusions,action}');
 SELECT COALESCE(array_agg(app_private.hermes_uuid_v1(value)),'{}') INTO scopes FROM jsonb_array_elements(p->'scopeIds');
 PERFORM app_private.hermes_validate_exclusions_v2(r,a);
 IF p->>'scopeMode'='unrestricted' AND cardinality(scopes)<>0 THEN RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id AND state='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(c.organization_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,0));
 PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE;
 SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
 IF c.state<>'ACTIVE' OR c.epoch<>v_epoch THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
 PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
 PERFORM app_private.hermes_validate_limits_v1(c.organization_id,'{}','{}',scopes);
 old_state:=app_private.hermes_connection_json_v1(c);
 UPDATE app_private.hermes_connections SET permission_mode='inherit_crm',excluded_read=r,excluded_action=a,
  scope_mode=p->>'scopeMode',scope_ids=scopes,epoch=epoch+1 WHERE id=c.id RETURNING * INTO c;
 PERFORM app_private.hermes_audit_connection_change_v2(c,'HERMES_CONNECTION_SETTINGS_CHANGED',old_state);
 RETURN jsonb_build_object('ok',true,'connection',app_private.hermes_connection_json_v1(c));
END $fn$;

-- Forward replacements preserve the original transaction/CAS/writer protocol.
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
    OR (c.permission_mode='legacy_allowlist' AND (NOT(c.read_capabilities<@policy.read_capabilities) OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids))) THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
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
  IF a.state<>'ACTIVE' OR NOT policy.enabled OR (c.permission_mode='legacy_allowlist' AND (NOT(c.read_capabilities<@policy.read_capabilities) OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids))) THEN
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

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_diagnose_v1(p_schedule uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; c app_private.hermes_connections;
  t app_private.hermes_connection_tokens; ss app_private.hermes_sessions; x app_private.hermes_zalo_bindings;
  policy app_private.hermes_org_policies; decision record; v_context jsonb; v_key text; v_mode text; v_list jsonb;
  v_scopes uuid[]; v_state text; v_message text; v_owner jsonb;
BEGIN
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule;
  IF s.id IS NULL OR s.state<>'ACTIVE' THEN RETURN jsonb_build_object('reason','schedule_inactive','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  IF g.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('reason','grant_expired','kind','expiry','detail',
    jsonb_build_object('grantId',g.id,'expiresAt',to_char(g.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))); END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=g.settings->>'template' AND enabled)
    THEN RETURN jsonb_build_object('reason','template_disabled','kind','authority','detail',jsonb_build_object('template',g.settings->>'template')); END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=g.connection_id;
  IF c.id IS NULL OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR c.user_id<>s.user_id OR c.organization_id<>s.organization_id
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants WHERE id=c.assistant_id AND state='ACTIVE')
    THEN RETURN jsonb_build_object('reason','connection_revoked','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE connection_id=c.id AND revoked_at IS NULL
    AND expires_at>clock_timestamp() AND created_at+interval '30 days'>clock_timestamp() ORDER BY created_at DESC,token_digest LIMIT 1;
  IF t.token_digest IS NULL THEN RETURN jsonb_build_object('reason','connection_token_expired','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO ss FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF ss.id IS NULL OR ss.state<>'ACTIVE' OR ss.quarantine_reason IS NOT NULL OR ss.expires_at<=clock_timestamp()
    THEN RETURN jsonb_build_object('reason','session_expired','kind','authority','detail','{}'::jsonb); END IF;
  BEGIN PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
    RETURN jsonb_build_object('reason',CASE WHEN v_message='hermes_ordinary_org_ambiguous' THEN 'membership_ambiguous' ELSE 'membership_inactive' END,
      'kind','authority','detail','{}'::jsonb);
  END;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF NOT COALESCE(policy.enabled,false) THEN RETURN jsonb_build_object('reason','company_policy_disabled','kind','authority','detail','{}'::jsonb); END IF;
  FOR v_key,v_mode IN SELECT k,m FROM (VALUES('chat_zalo.manage_automation','action',1),('chat_zalo.send','action',2),
      ('chat_zalo.view','read',3),('rooms.view','read',4)) required(k,m,o) ORDER BY o LOOP
    IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=v_key AND mode=v_mode AND enabled)
      THEN RETURN jsonb_build_object('reason','capability_disabled','kind','authority','detail',jsonb_build_object('capability',v_key)); END IF;
    IF v_key<>'rooms.view' THEN
      SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,v_key);
      IF decision.allowed IS DISTINCT FROM true
        THEN RETURN jsonb_build_object('reason','user_permission_revoked','kind','authority','detail',jsonb_build_object('permission',v_key)); END IF;
    END IF;
    IF NOT(v_key=ANY(CASE WHEN v_mode='action' THEN c.action_capabilities ELSE c.read_capabilities END))
      THEN RETURN jsonb_build_object('reason','hermes_overlay_revoked','kind','authority','detail',jsonb_build_object('capability',v_key)); END IF;
    IF NOT(v_key=ANY(CASE WHEN v_mode='action' THEN policy.action_capabilities ELSE policy.read_capabilities END))
      THEN RETURN jsonb_build_object('reason','company_policy_revoked','kind','authority','detail',jsonb_build_object('capability',v_key)); END IF;
  END LOOP;
  -- The connection is usable only while its whole overlay stays inside the
  -- company ceiling (shared connection validator); report what was removed.
  IF c.permission_mode='legacy_allowlist' AND (NOT(c.read_capabilities<@policy.read_capabilities) OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids)) THEN
    RETURN jsonb_build_object('reason','company_policy_revoked','kind','authority','detail',jsonb_build_object(
      'capabilities',COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM ((SELECT unnest(c.read_capabilities) EXCEPT SELECT unnest(policy.read_capabilities))
        UNION (SELECT unnest(c.action_capabilities) EXCEPT SELECT unnest(policy.action_capabilities))) removed(k)),'[]'::jsonb),
      'scopeIds',COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM (SELECT unnest(c.scope_ids) EXCEPT SELECT unnest(policy.scope_ids)) removed(k)),'[]'::jsonb)));
  END IF;
  IF g.settings->>'timeZone' IS DISTINCT FROM app_private.org_timezone_v1(c.organization_id)
    THEN RETURN jsonb_build_object('reason','timezone_changed','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=g.binding_id;
  IF x.id IS NULL OR x.state<>'ACTIVE' OR x.revoked_at IS NOT NULL OR x.epoch<>g.binding_epoch OR x.account_id<>g.account_id OR x.connection_id<>g.connection_id
    THEN RETURN jsonb_build_object('reason','zalo_binding_changed','kind','authority','detail','{}'::jsonb); END IF;
  BEGIN
    v_context:=app_private.hermes_external_group_context_v1(app_private.hermes_schedule_binding_v1(g,gen_random_uuid()));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    RETURN jsonb_build_object('reason',CASE WHEN v_message='hermes_group_directory_too_large' THEN 'zalo_directory_too_large'
      WHEN v_state='PT409' THEN 'context_changed' ELSE 'zalo_sender_unavailable' END,'kind','authority','detail',jsonb_build_object('sqlstate',v_state));
  END;
  IF v_context#>>'{recipientRead,sender,accountId}' IS DISTINCT FROM g.account_id::text
    THEN RETURN jsonb_build_object('reason','zalo_binding_changed','kind','authority','detail','{}'::jsonb); END IF;
  IF NOT(v_context#>'{authority,effective,read}' ? 'rooms.view') THEN
    RETURN jsonb_build_object('reason','scope_narrowed','kind','authority','detail',jsonb_build_object('buildingIds',g.settings->'buildingIds'));
  END IF;
  SELECT array_agg(v::uuid) INTO v_scopes FROM jsonb_array_elements_text(v_context#>'{authority,scopeIds}') v;
  SELECT COALESCE(jsonb_agg(b ORDER BY b),'[]'::jsonb) INTO v_list FROM jsonb_array_elements_text(g.settings->'buildingIds') b
    WHERE NOT app_private.hermes_schedule_building_allowed_v1(c.user_id,c.organization_id,b::uuid,v_scopes);
  IF jsonb_array_length(v_list)>0 THEN RETURN jsonb_build_object('reason','scope_narrowed','kind','authority','detail',jsonb_build_object('buildingIds',v_list)); END IF;
  v_owner:=app_private.hermes_schedule_owner_state_v1(s.id,s.organization_id,g.settings);
  IF v_owner IS NOT NULL THEN RETURN v_owner; END IF;
  SELECT COALESCE(jsonb_agg(v ORDER BY v),'[]'::jsonb) INTO v_list FROM jsonb_array_elements_text(g.settings->'conversationIds') v
    WHERE NOT(v_context#>'{recipientRead,allowedConversationIds}' ? v);
  IF jsonb_array_length(v_list)>0 THEN RETURN jsonb_build_object('reason','target_denied','kind','authority','detail',
    jsonb_build_object('conversationIds',v_list,'partial',jsonb_array_length(v_list)<jsonb_array_length(g.settings->'conversationIds'))); END IF;
  RETURN jsonb_build_object('reason',NULL);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_restrict_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE old_state jsonb; c app_private.hermes_connections; v_id uuid; v_epoch bigint; r text[]; a text[]; scopes uuid[];
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','expectedEpoch','read','action','scopeIds']);
  v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
  IF jsonb_typeof(p->'read')<>'array' OR jsonb_typeof(p->'action')<>'array' OR jsonb_typeof(p->'scopeIds')<>'array' THEN RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(value),'{}') INTO r FROM jsonb_array_elements_text(p->'read');
  SELECT coalesce(array_agg(value),'{}') INTO a FROM jsonb_array_elements_text(p->'action');
  SELECT coalesce(array_agg(app_private.hermes_uuid_v1(value)),'{}') INTO scopes FROM jsonb_array_elements(p->'scopeIds');
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id AND state='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(c.organization_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,0));
  PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
  IF NOT FOUND OR c.state<>'ACTIVE' OR c.epoch<>v_epoch THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  IF c.permission_mode<>'legacy_allowlist' THEN RAISE EXCEPTION 'hermes_settings_required' USING ERRCODE='42501'; END IF;
  old_state:=app_private.hermes_connection_json_v1(c);
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  PERFORM app_private.hermes_validate_limits_v1(c.organization_id,r,a,scopes);
  IF NOT(r<@c.read_capabilities) OR NOT(a<@c.action_capabilities) OR NOT(scopes<@c.scope_ids) THEN
    RAISE EXCEPTION 'hermes_narrow_only' USING ERRCODE='42501'; END IF;
  UPDATE app_private.hermes_connections SET read_capabilities=r,action_capabilities=a,scope_ids=scopes,epoch=epoch+1 WHERE id=c.id RETURNING * INTO c;
  PERFORM app_private.hermes_audit_connection_change_v2(c,'HERMES_CONNECTION_RESTRICTED',old_state);
  RETURN jsonb_build_object('ok',true,'connection',app_private.hermes_connection_json_v1(c));
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_revoke_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
DECLARE old_state jsonb; c app_private.hermes_connections; v_id uuid; v_epoch bigint;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','expectedEpoch']);
  v_id:=app_private.hermes_uuid_v1(p->'connectionId'); v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'status','missing'); END IF;
  IF c.state='REVOKED' THEN RETURN jsonb_build_object('ok',true,'status','already_revoked'); END IF;
  PERFORM app_private.lock_org_for_decision_v1(c.organization_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,0));
  old_state:=app_private.hermes_connection_json_v1(c);
  IF c.credential_ref IS NULL THEN
    -- Pending intents have no session to lock. The CAS also resolves a race with
    -- activation: if activation wins, its epoch change forces the caller to read
    -- again; this branch never upgrades a connection lock into a session lock.
    UPDATE app_private.hermes_connections SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp()
      WHERE id=c.id AND state='PENDING' AND credential_ref IS NULL AND epoch=v_epoch RETURNING * INTO c;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
    PERFORM app_private.hermes_audit_connection_change_v2(c,'HERMES_CONNECTION_REVOKED',old_state);
    RETURN jsonb_build_object('ok',true,'status','revoked');
  END IF;
  -- Publish and connection revoke serialize on the credential row. A provider
  -- call dispatched before revocation may finish; joined reads still refuse the
  -- revoked connection. Another valid connection does not lose its session.
  PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE;
  IF c.state='REVOKED' THEN RETURN jsonb_build_object('ok',true,'status','already_revoked'); END IF;
  IF c.epoch<>v_epoch THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  old_state:=app_private.hermes_connection_json_v1(c);
  UPDATE app_private.hermes_connections SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp() WHERE connection_id=c.id AND revoked_at IS NULL;
  PERFORM app_private.hermes_audit_connection_change_v2(c,'HERMES_CONNECTION_REVOKED',old_state);
  -- This intentionally does not delete/revoke shared session material.
  RETURN jsonb_build_object('ok',true,'status','revoked');
END
$fn$;
DO $acl$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND p.proname=ANY(ARRAY[
   'hermes_connection_json_v1','hermes_project_connection_limits_v2','hermes_refresh_scope_projection_v2','hermes_refresh_scope_update_projection_v2',
   'hermes_refresh_registry_projection_v2','hermes_validate_exclusions_v2','hermes_audit_connection_change_v2',
   'hermes_store_connection_settings_v1','hermes_store_activate_v1','hermes_store_renew_connection_v1',
   'hermes_store_restrict_connection_v1','hermes_store_revoke_connection_v1','hermes_schedule_diagnose_v1']) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',fn);
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_connection_settings_v1(jsonb),app_private.hermes_store_activate_v1(jsonb),
 app_private.hermes_store_renew_connection_v1(jsonb),app_private.hermes_store_restrict_connection_v1(jsonb),
 app_private.hermes_store_revoke_connection_v1(jsonb) TO hermes_store_executor;
ALTER FUNCTION public.hermes_prepare_connection_v2(uuid,text[],text[],text,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_prepare_connection_v2(uuid,text[],text[],text,uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_prepare_connection_v2(uuid,text[],text[],text,uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
