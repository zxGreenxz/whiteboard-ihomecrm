-- P2A: private identity/policy foundation. No business tool, user grant or Zalo owner is added.
-- The NOLOGIN executor is a capability role, not a deployed login. Provision a
-- dedicated backend login separately; never grant this role to API roles.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_store_executor') THEN
    CREATE ROLE hermes_store_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_store_executor'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)) THEN
    RAISE EXCEPTION 'hermes_executor_role_drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member='hermes_store_executor'::regrole)
    OR pg_has_role('anon','hermes_store_executor','MEMBER')
    OR pg_has_role('authenticated','hermes_store_executor','MEMBER')
    OR pg_has_role('service_role','hermes_store_executor','MEMBER') THEN
    RAISE EXCEPTION 'hermes_executor_membership_drift';
  END IF;
END
$role$;
GRANT USAGE ON SCHEMA app_private TO hermes_store_executor;
REVOKE CREATE ON SCHEMA app_private, public FROM hermes_store_executor;
DO $schema_acl$
BEGIN
  -- A direct REVOKE cannot cancel CREATE inherited from PUBLIC. Refuse that
  -- deployment instead of silently broadening the credential-store principal.
  IF has_schema_privilege('hermes_store_executor','app_private','CREATE')
    OR has_schema_privilege('hermes_store_executor','public','CREATE') THEN
    RAISE EXCEPTION 'hermes_executor_schema_drift';
  END IF;
END
$schema_acl$;

CREATE TABLE IF NOT EXISTS app_private.hermes_capabilities (
  capability text PRIMARY KEY CHECK (capability ~ '^[a-z][a-z0-9_.]{0,127}$'),
  mode text NOT NULL CHECK (mode IN ('read','action')),
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE(capability,mode)
);
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
VALUES ('assistant.context.read','read',true) ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_private.hermes_assistants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','DISABLED')),
  context_epoch bigint NOT NULL DEFAULT 1 CHECK (context_epoch>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,user_id), UNIQUE(id,organization_id,user_id)
);
CREATE TABLE IF NOT EXISTS app_private.hermes_org_policies (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  read_capabilities text[] NOT NULL DEFAULT '{}',
  action_capabilities text[] NOT NULL DEFAULT '{}',
  scope_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.hermes_sessions (
  id uuid PRIMARY KEY,
  assistant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider_session_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('ACTIVE','RESERVED','DISPATCHED','STAGED','RECONNECT_REQUIRED','REVOKED')),
  envelope jsonb,
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence>=0),
  lease_owner uuid,
  lease_until timestamptz,
  staged_envelope jsonb,
  staged_expires_at timestamptz,
  published_fence bigint,
  quarantine_reason text CHECK (quarantine_reason IN ('refresh_uncertain','session_revoked','lease_expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(assistant_id,organization_id,user_id) REFERENCES app_private.hermes_assistants(id,organization_id,user_id),
  UNIQUE(id,assistant_id,organization_id,user_id),
  CHECK ((state IN ('RECONNECT_REQUIRED','REVOKED')) = (quarantine_reason IS NOT NULL)),
  CHECK (state NOT IN ('RECONNECT_REQUIRED','REVOKED') OR (envelope IS NULL AND staged_envelope IS NULL AND staged_expires_at IS NULL)),
  CHECK (state NOT IN ('ACTIVE','RESERVED','DISPATCHED') OR envelope IS NOT NULL),
  CHECK ((state='STAGED') = (staged_envelope IS NOT NULL AND staged_expires_at IS NOT NULL)),
  CHECK ((staged_envelope IS NULL) = (staged_expires_at IS NULL)),
  CHECK (state<>'STAGED' OR envelope IS NULL),
  CHECK (state NOT IN ('RESERVED','DISPATCHED','STAGED') OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (published_fence IS NULL OR (published_fence>0 AND published_fence<=fence))
);
CREATE TABLE IF NOT EXISTS app_private.hermes_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','ACTIVE','REVOKED')),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch>0),
  read_capabilities text[] NOT NULL DEFAULT '{}',
  action_capabilities text[] NOT NULL DEFAULT '{}',
  scope_ids uuid[] NOT NULL DEFAULT '{}',
  channel_binding jsonb NOT NULL DEFAULT '{}', -- reserved; no model-supplied binding accepted in P2A
  credential_ref uuid,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  intent_expires_at timestamptz NOT NULL,
  activation_operation_id uuid UNIQUE,
  activation_hash text CHECK (activation_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  FOREIGN KEY(assistant_id,organization_id,user_id) REFERENCES app_private.hermes_assistants(id,organization_id,user_id),
  FOREIGN KEY(credential_ref,assistant_id,organization_id,user_id)
    REFERENCES app_private.hermes_sessions(id,assistant_id,organization_id,user_id),
  CHECK (state<>'ACTIVE' OR (credential_ref IS NOT NULL AND activation_operation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS app_private.hermes_connection_tokens (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_connection_one_current_token
  ON app_private.hermes_connection_tokens(connection_id) WHERE revoked_at IS NULL;

ALTER TABLE app_private.hermes_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_org_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_connection_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_capabilities,app_private.hermes_assistants,
  app_private.hermes_org_policies,app_private.hermes_sessions,app_private.hermes_connections,
  app_private.hermes_connection_tokens FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Migration owner stays administrative. The runtime executor owns no relation
-- or SECURITY DEFINER function and cannot replace code or bypass table RLS.
ALTER TABLE app_private.hermes_capabilities OWNER TO postgres;
ALTER TABLE app_private.hermes_assistants OWNER TO postgres;
ALTER TABLE app_private.hermes_org_policies OWNER TO postgres;
ALTER TABLE app_private.hermes_sessions OWNER TO postgres;
ALTER TABLE app_private.hermes_connections OWNER TO postgres;
ALTER TABLE app_private.hermes_connection_tokens OWNER TO postgres;

-- Helpers have no caller grants. A private executor cannot impersonate auth.uid()
-- to manage policy because only authenticated public RPCs below receive that ACL.
CREATE OR REPLACE FUNCTION app_private.hermes_member_v1(p_user uuid,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_count integer; v_org_count integer; v_super boolean; v_member uuid; v_version bigint;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_user IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(m.id::text)::uuid INTO v_count,v_member
  FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
  WHERE m.user_id=p_user AND m.organization_id=p_org AND o.status='ACTIVE'
    AND m.status='ACTIVE' AND m.revoked_at IS NULL
    AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now
    AND (m.valid_to IS NULL OR m.valid_to>v_now);
  IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=p_user) INTO v_super;
  IF NOT v_super THEN
    SELECT count(DISTINCT m.organization_id) INTO v_org_count
    FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now
      AND (m.valid_to IS NULL OR m.valid_to>v_now);
    IF v_org_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT authorization_version INTO v_version FROM public.organizations WHERE id=p_org;
  RETURN jsonb_build_object('membershipId',v_member,'authorizationVersion',v_version,'isSuperadmin',v_super);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_validate_limits_v1(p_org uuid,p_read text[],p_action text[],p_scopes uuid[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
BEGIN
  IF p_read IS NULL OR p_action IS NULL OR p_scopes IS NULL
    OR cardinality(p_read)>256 OR cardinality(p_action)>256 OR cardinality(p_scopes)>256
    OR array_position(p_read,NULL) IS NOT NULL OR array_position(p_action,NULL) IS NOT NULL OR array_position(p_scopes,NULL) IS NOT NULL
    OR EXISTS(SELECT 1 FROM unnest(p_read) k WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities c WHERE c.capability=k AND c.mode='read' AND c.enabled))
    OR EXISTS(SELECT 1 FROM unnest(p_action) k WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities c WHERE c.capability=k AND c.mode='action' AND c.enabled))
    OR EXISTS(SELECT 1 FROM unnest(p_scopes) requested(scope_id) WHERE NOT EXISTS(SELECT 1 FROM public.authorization_scopes s WHERE s.id=requested.scope_id AND s.organization_id=p_org)) THEN
    RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_connection_json_v1(p_row app_private.hermes_connections)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
SELECT jsonb_build_object('id',p_row.id,'assistantId',p_row.assistant_id,'organizationId',p_row.organization_id,
  'userId',p_row.user_id,'state',lower(p_row.state),'epoch',p_row.epoch,
  'restrictions',jsonb_build_object('read',p_row.read_capabilities,'action',p_row.action_capabilities),
  'scopeIds',p_row.scope_ids)
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_set_org_policy_v1(p_org uuid,p_expected_version bigint,
  p_enabled boolean,p_read text[],p_action text[],p_scope_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_old app_private.hermes_org_policies; v_new app_private.hermes_org_policies;
BEGIN
  PERFORM app_private.hermes_member_v1(auth.uid(),p_org);
  PERFORM app_private.require_perm_v1(p_org,'users.edit','quản lý quyền trợ lý Hermes');
  PERFORM app_private.hermes_validate_limits_v1(p_org,p_read,p_action,p_scope_ids);
  IF p_expected_version IS NULL OR p_expected_version<0 OR p_enabled IS NULL THEN RAISE EXCEPTION 'hermes_policy_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_old FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR UPDATE;
  IF (v_old.organization_id IS NULL AND p_expected_version<>0)
    OR (v_old.organization_id IS NOT NULL AND v_old.version<>p_expected_version) THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,read_capabilities,action_capabilities,scope_ids,updated_by)
  VALUES(p_org,p_enabled,1,p_read,p_action,p_scope_ids,auth.uid())
  ON CONFLICT(organization_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=hermes_org_policies.version+1,
    read_capabilities=EXCLUDED.read_capabilities,action_capabilities=EXCLUDED.action_capabilities,
    scope_ids=EXCLUDED.scope_ids,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
  WHERE hermes_org_policies.version=p_expected_version
  RETURNING * INTO v_new;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_POLICY_CHANGED','hermes_org_policy',p_org,
    to_jsonb(v_old),to_jsonb(v_new),'Explicit human assistant ceiling');
  RETURN jsonb_build_object('organizationId',p_org,'version',v_new.version,'enabled',v_new.enabled,
    'read',v_new.read_capabilities,'action',v_new.action_capabilities,'scopeIds',v_new.scope_ids);
END
$fn$;

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
  SELECT * INTO v_policy FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
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

CREATE OR REPLACE FUNCTION public.hermes_my_connections_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_rows jsonb;
BEGIN
  PERFORM app_private.hermes_member_v1(auth.uid(),p_org);
  SELECT coalesce(jsonb_agg(app_private.hermes_connection_json_v1(c) ORDER BY c.created_at,c.id),'[]'::jsonb)
    INTO v_rows FROM app_private.hermes_connections c WHERE c.organization_id=p_org AND c.user_id=auth.uid();
  RETURN v_rows;
END
$fn$;

-- No ciphertext, digest or intent secret is included in the public context.
-- P2A exports self context only; adding business capabilities requires a reviewed
-- CRM permission/scope mapping in a later migration, never an arbitrary key here.
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v1(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_c app_private.hermes_connections; v_p app_private.hermes_org_policies; v_member jsonb;
BEGIN
  SELECT * INTO v_c FROM app_private.hermes_connections WHERE id=p_connection_id AND user_id=auth.uid();
  IF NOT FOUND OR v_c.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_member:=app_private.hermes_member_v1(auth.uid(),v_c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_org_policies WHERE organization_id=v_c.organization_id;
  IF NOT FOUND OR NOT v_p.enabled OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=v_c.assistant_id AND a.state='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_sessions s WHERE s.id=v_c.credential_ref AND s.state='ACTIVE' AND s.quarantine_reason IS NULL AND s.expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=v_c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501';
  END IF;
  RETURN app_private.hermes_connection_json_v1(v_c)||v_member||jsonb_build_object('policyVersion',v_p.version,
    'companyCeilings',jsonb_build_object('read',v_p.read_capabilities,'action',v_p.action_capabilities),
    'effective',jsonb_build_object('read',CASE WHEN 'assistant.context.read'=ANY(v_c.read_capabilities)
      AND 'assistant.context.read'=ANY(v_p.read_capabilities)
      AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability='assistant.context.read' AND cap.mode='read' AND cap.enabled)
      THEN jsonb_build_array('assistant.context.read') ELSE '[]'::jsonb END,'action','[]'::jsonb));
END
$fn$;

ALTER FUNCTION app_private.hermes_member_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_validate_limits_v1(uuid,text[],text[],uuid[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_connection_json_v1(app_private.hermes_connections) OWNER TO postgres;
ALTER FUNCTION public.hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[]) OWNER TO postgres;
ALTER FUNCTION public.hermes_prepare_connection_v1(uuid,text[],text[],uuid[]) OWNER TO postgres;
ALTER FUNCTION public.hermes_my_connections_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_connection_context_v1(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION app_private.hermes_member_v1(uuid,uuid),app_private.hermes_validate_limits_v1(uuid,text[],text[],uuid[]),
  app_private.hermes_connection_json_v1(app_private.hermes_connections) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[]),
  public.hermes_prepare_connection_v1(uuid,text[],text[],uuid[]),public.hermes_my_connections_v1(uuid),
  public.hermes_connection_context_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[]),
  public.hermes_prepare_connection_v1(uuid,text[],text[],uuid[]),public.hermes_my_connections_v1(uuid),
  public.hermes_connection_context_v1(uuid) TO authenticated;
COMMIT;
