-- CRM work notes only. No import, query or mount of native/personal memory.
-- Self ownership is a CRM boundary; supervision additionally uses users.view.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
  ('assistant.memory.read','read',false),('assistant.memory.write','action',false)
  ON CONFLICT(capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_private.hermes_work_memory_settings (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  enabled boolean NOT NULL DEFAULT false,
  sharing text NOT NULL DEFAULT 'owner' CHECK(sharing IN ('owner','superadmin')),
  retention_days integer NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 365),
  access_version bigint NOT NULL DEFAULT 1 CHECK(access_version BETWEEN 1 AND 9007199254740990),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,user_id)
);
CREATE TABLE IF NOT EXISTS app_private.hermes_work_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  assistant_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  key text NOT NULL CHECK(key ~ '^[a-z0-9_]{1,64}$'),
  content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 1000),
  source_channel text NOT NULL DEFAULT 'external_mcp' CHECK(source_channel='external_mcp'),
  source_label text NOT NULL CHECK(char_length(source_label) BETWEEN 1 AND 200),
  version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE(organization_id,user_id,key),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_private.hermes_work_memory_settings(organization_id,user_id),
  FOREIGN KEY(assistant_id,organization_id,user_id) REFERENCES app_private.hermes_assistants(id,organization_id,user_id),
  CHECK(content !~ '[\x00-\x1F\x7F-\x9F]' AND source_label !~ '[\x00-\x1F\x7F-\x9F]'),
  CHECK(position(chr(8232) IN content)=0 AND position(chr(8233) IN content)=0 AND position(chr(8232) IN source_label)=0 AND position(chr(8233) IN source_label)=0),
  CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS hermes_work_memories_expiry_idx ON app_private.hermes_work_memories(expires_at);
ALTER TABLE app_private.hermes_work_memory_settings OWNER TO postgres;
ALTER TABLE app_private.hermes_work_memories OWNER TO postgres;
ALTER TABLE app_private.hermes_work_memory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_work_memories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_work_memory_settings,app_private.hermes_work_memories
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- This extends the existing authority resolver; it neither grants CRM roles nor
-- imports Copilot chat admission, approvals, PINs or personal history.
CREATE OR REPLACE FUNCTION public.hermes_work_memory_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; r boolean; w boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,
    ARRAY['assistant.memory.read'],ARRAY['assistant.memory.write'],'{}'::uuid[]);
  r:=policy.enabled AND 'assistant.memory.read'=ANY(policy.read_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.memory.read' AND mode='read' AND enabled);
  w:=policy.enabled AND 'assistant.memory.write'=ANY(policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.memory.write' AND mode='action' AND enabled);
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),
    'policyVersion',policy.version,'readAllowed',COALESCE(r,false),'writeAllowed',COALESCE(w,false));
END $fn$;

-- Same connection/session/token locks and live CRM identity used by existing
-- private command/group paths; no Zalo account or synthetic DM claim required.
CREATE OR REPLACE FUNCTION app_private.hermes_work_memory_context_v1(p jsonb,p_write boolean)
RETURNS app_private.hermes_connections LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions;
  member jsonb; caps jsonb; k text;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p->k)<1 THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p->'expectedPolicyVersion') END)<0 THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(s)
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  caps:=public.hermes_work_memory_capabilities_v1(c.organization_id);
  IF c.id::text IS DISTINCT FROM p->>'connectionId' OR c.epoch::text IS DISTINCT FROM p->>'expectedEpoch'
    OR s.revision::text IS DISTINCT FROM p->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    OR caps->>'policyVersion' IS DISTINCT FROM p->>'expectedPolicyVersion'
    THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  IF caps->'readAllowed' IS DISTINCT FROM 'true'::jsonb OR NOT('assistant.memory.read'=ANY(c.read_capabilities))
    OR (p_write AND (caps->'writeAllowed' IS DISTINCT FROM 'true'::jsonb OR NOT('assistant.memory.write'=ANY(c.action_capabilities))))
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  RETURN c;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_work_memory_settings_json_v1(p app_private.hermes_work_memory_settings)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT jsonb_build_object('enabled',p.enabled,'sharing',p.sharing,'retentionDays',p.retention_days,'accessVersion',p.access_version)
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_work_memory_status_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; settings app_private.hermes_work_memory_settings;
BEGIN
  c:=app_private.hermes_work_memory_context_v1(p,false);
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=c.user_id;
  RETURN jsonb_build_object('organizationId',c.organization_id,'ownerUserId',c.user_id,'settings',
    CASE WHEN settings.user_id IS NULL THEN jsonb_build_object('enabled',false,'sharing','owner','retentionDays',30,'accessVersion',0)
      ELSE app_private.hermes_work_memory_settings_json_v1(settings) END,
    'personalMemory','outside_crm','remoteCopies','not_revocable');
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_work_memory_configure_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; settings app_private.hermes_work_memory_settings; expected bigint; days integer;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['enabled','sharing','retentionDays','expectedAccessVersion']);
  IF jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' OR p_input->>'sharing' NOT IN ('owner','superadmin')
    OR jsonb_typeof(p_input->'sharing') IS DISTINCT FROM 'string'
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  expected:=(CASE WHEN p_input->'expectedAccessVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'expectedAccessVersion') END);
  days:=app_private.hermes_integer_v1(p_input->'retentionDays');
  IF expected<0 OR days NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_work_memory_context_v1(p,true);
  INSERT INTO app_private.hermes_work_memory_settings(organization_id,user_id) VALUES(c.organization_id,c.user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=c.user_id FOR UPDATE;
  -- First creation has version 1 internally; expected 0 is valid only while no
  -- configuration has ever been saved (the insert above is in this transaction).
  IF (expected=0 AND settings.access_version<>1) OR (expected<>0 AND expected<>settings.access_version)
    THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.hermes_work_memory_settings SET enabled=(p_input->>'enabled')::boolean,
    sharing=p_input->>'sharing',retention_days=days,access_version=access_version+1,updated_at=clock_timestamp()
    WHERE organization_id=c.organization_id AND user_id=c.user_id RETURNING * INTO settings;
  -- Lowering retention never extends an existing note's deadline.
  UPDATE app_private.hermes_work_memories SET expires_at=LEAST(expires_at,updated_at+make_interval(days=>days))
    WHERE organization_id=c.organization_id AND user_id=c.user_id;
  DELETE FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=c.user_id AND expires_at<=clock_timestamp();
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_MEMORY_CONFIGURED','hermes_assistant',c.assistant_id,
    jsonb_build_object('actor',c.user_id,'connectionId',c.id,'accessVersion',settings.access_version,'enabled',settings.enabled,'sharing',settings.sharing,'retentionDays',days));
  RETURN public.hermes_work_memory_status_v1(p);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_work_memory_list_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; settings app_private.hermes_work_memory_settings; owner_id uuid;
  items jsonb; v_limit integer; v_offset integer; v_since timestamptz; v_now timestamptz; v_auth record; member jsonb;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['ownerUserId','limit','offset','updatedSince']);
  v_limit:=app_private.hermes_integer_v1(p_input->'limit'); v_offset:=(CASE WHEN p_input->'offset'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'offset') END);
  IF v_limit NOT BETWEEN 1 AND 10 OR v_offset NOT BETWEEN 0 AND 200
    OR jsonb_typeof(p_input->'updatedSince') NOT IN ('null','string')
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  BEGIN v_since:=(p_input->>'updatedSince')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END;
  c:=app_private.hermes_work_memory_context_v1(p,false);
  owner_id:=CASE WHEN p_input->'ownerUserId'='null'::jsonb THEN c.user_id ELSE app_private.hermes_uuid_v1(p_input->'ownerUserId') END;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF owner_id<>c.user_id THEN
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'users.view');
    IF member->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb OR v_auth.allowed IS DISTINCT FROM true
      OR v_auth.authorization_version::text IS DISTINCT FROM member->>'authorizationVersion'
      THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  END IF;
  PERFORM app_private.hermes_member_v1(owner_id,c.organization_id);
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=owner_id FOR SHARE;
  IF settings.user_id IS NULL OR NOT settings.enabled OR (owner_id<>c.user_id AND settings.sharing<>'superadmin')
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  v_now:=clock_timestamp();
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'key',m.key,'content',m.content,'version',m.version,
    'assistantId',m.assistant_id,'connectionId',m.connection_id,'source',jsonb_build_object('channel',m.source_channel,'label',m.source_label),
    'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at) ORDER BY m.updated_at DESC,m.id),'[]') INTO items
    FROM (SELECT * FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=owner_id
      AND expires_at>v_now AND (v_since IS NULL OR updated_at>=v_since) ORDER BY updated_at DESC,id LIMIT v_limit OFFSET v_offset) m;
  -- Audit stores identifiers and counts only; forgotten text is never copied.
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_MEMORY_READ','hermes_assistant',c.assistant_id,
    jsonb_build_object('actor',c.user_id,'ownerUserId',owner_id,'connectionId',c.id,'accessVersion',settings.access_version,'count',jsonb_array_length(items)));
  RETURN jsonb_build_object('organizationId',c.organization_id,'ownerUserId',owner_id,'settings',app_private.hermes_work_memory_settings_json_v1(settings),
    'classification','crm_work_memory','authority','reference_only','readAt',v_now,'items',items,
    'offset',v_offset,'nextOffset',CASE WHEN jsonb_array_length(items)=v_limit AND v_offset+v_limit<200 THEN v_offset+v_limit ELSE NULL END);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_work_memory_upsert_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; settings app_private.hermes_work_memory_settings; m app_private.hermes_work_memories;
  expected bigint; expected_id uuid; access bigint; v_key text; v_content text; v_source text; v_now timestamptz;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['key','content','sourceLabel','expectedId','expectedVersion','expectedAccessVersion']);
  expected:=(CASE WHEN p_input->'expectedVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'expectedVersion') END); access:=(CASE WHEN p_input->'expectedAccessVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'expectedAccessVersion') END);
  v_key:=p_input->>'key'; v_content:=p_input->>'content'; v_source:=p_input->>'sourceLabel';
  expected_id:=CASE WHEN p_input->'expectedId'='null'::jsonb THEN NULL ELSE app_private.hermes_uuid_v1(p_input->'expectedId') END;
  IF (expected=0)<>(expected_id IS NULL) THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  IF expected<0 OR access<1 OR jsonb_typeof(p_input->'key') IS DISTINCT FROM 'string' OR v_key !~ '^[a-z0-9_]{1,64}$'
    OR jsonb_typeof(p_input->'content') IS DISTINCT FROM 'string' OR char_length(btrim(v_content)) NOT BETWEEN 1 AND 1000
    OR jsonb_typeof(p_input->'sourceLabel') IS DISTINCT FROM 'string' OR char_length(btrim(v_source)) NOT BETWEEN 1 AND 200
    OR v_content ~ '[\x00-\x1F\x7F-\x9F]' OR v_source ~ '[\x00-\x1F\x7F-\x9F]'
    OR position(chr(8232) IN v_content)>0 OR position(chr(8233) IN v_content)>0 OR position(chr(8232) IN v_source)>0 OR position(chr(8233) IN v_source)>0
    OR (v_content||v_source) ~ '(hc_[A-Za-z0-9_-]{43}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_work_memory_context_v1(p,true);
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=c.user_id FOR UPDATE;
  IF settings.user_id IS NULL OR NOT settings.enabled THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  IF settings.access_version<>access THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  v_now:=clock_timestamp();
  DELETE FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=c.user_id AND expires_at<=v_now;
  SELECT * INTO m FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=c.user_id AND key=v_key;
  IF m.id IS DISTINCT FROM expected_id OR (m.id IS NOT NULL AND m.version<>expected)
    THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  IF m.id IS NULL AND (SELECT count(*) FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=c.user_id)>=200
    THEN RAISE EXCEPTION 'hermes_memory_limit' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,created_at,updated_at,expires_at)
    VALUES(c.organization_id,c.user_id,c.assistant_id,c.id,v_key,v_content,v_source,v_now,v_now,v_now+make_interval(days=>settings.retention_days))
    ON CONFLICT(organization_id,user_id,key) DO UPDATE SET content=EXCLUDED.content,source_label=EXCLUDED.source_label,
      assistant_id=EXCLUDED.assistant_id,connection_id=EXCLUDED.connection_id,version=hermes_work_memories.version+1,
      updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at RETURNING * INTO m;
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_MEMORY_SAVED','hermes_work_memory',m.id,
    jsonb_build_object('actor',c.user_id,'connectionId',c.id,'version',m.version,'accessVersion',settings.access_version));
  RETURN jsonb_build_object('organizationId',c.organization_id,'ownerUserId',c.user_id,'id',m.id,'key',m.key,'version',m.version,
    'accessVersion',settings.access_version,'expiresAt',m.expires_at);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_work_memory_forget_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; m app_private.hermes_work_memories; settings app_private.hermes_work_memory_settings; expected bigint; expected_id uuid;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['key','expectedId','expectedVersion','expectedAccessVersion']);
  expected_id:=app_private.hermes_uuid_v1(p_input->'expectedId');
  expected:=(CASE WHEN p_input->'expectedVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'expectedVersion') END);
  IF expected<1 OR jsonb_typeof(p_input->'key') IS DISTINCT FROM 'string' OR p_input->>'key' !~ '^[a-z0-9_]{1,64}$'
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_work_memory_context_v1(p,true);
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=c.user_id FOR UPDATE;
  IF settings.user_id IS NULL OR settings.access_version<>(CASE WHEN p_input->'expectedAccessVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'expectedAccessVersion') END)
    THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT * INTO m FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=c.user_id AND key=p_input->>'key';
  IF m.id IS NOT NULL AND (m.version<>expected OR m.id<>expected_id) THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  DELETE FROM app_private.hermes_work_memories WHERE id=m.id;
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_MEMORY_FORGOTTEN','hermes_assistant',c.assistant_id,
    jsonb_build_object('actor',c.user_id,'connectionId',c.id,'memoryId',m.id,'version',m.version));
  RETURN jsonb_build_object('organizationId',c.organization_id,'ownerUserId',c.user_id,'key',p_input->>'key','forgotten',true,
    'auditRetained',true,'remoteCopies','not_revocable');
END $fn$;

-- Dedicated retention executor can erase expired content only. No auth claims,
-- owner override, contents or identifiers are returned through this port.
CREATE OR REPLACE FUNCTION app_private.hermes_store_prune_work_memories_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_limit integer; v_count integer;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['limit']);
  v_limit:=app_private.hermes_integer_v1(p->'limit');
  IF v_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  WITH expired AS (SELECT id FROM app_private.hermes_work_memories WHERE expires_at<=clock_timestamp()
    ORDER BY expires_at,id LIMIT v_limit FOR UPDATE SKIP LOCKED), removed AS (
    DELETE FROM app_private.hermes_work_memories m USING expired e WHERE m.id=e.id RETURNING 1)
    SELECT count(*) INTO v_count FROM removed;
  RETURN jsonb_build_object('pruned',v_count);
END $fn$;
ALTER FUNCTION app_private.hermes_store_prune_work_memories_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_prune_work_memories_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_prune_work_memories_v1(jsonb) TO hermes_store_executor;

DO $acl$ DECLARE name text; sig regprocedure; BEGIN
  FOREACH name IN ARRAY ARRAY['hermes_work_memory_capabilities_v1(uuid)','hermes_work_memory_status_v1(jsonb)',
    'hermes_work_memory_configure_v1(jsonb,jsonb)','hermes_work_memory_list_v1(jsonb,jsonb)',
    'hermes_work_memory_upsert_v1(jsonb,jsonb)','hermes_work_memory_forget_v1(jsonb,jsonb)'] LOOP
    sig:=('public.'||name)::regprocedure;
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',sig);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['hermes_work_memory_context_v1(jsonb,boolean)',
    'hermes_work_memory_settings_json_v1(app_private.hermes_work_memory_settings)'] LOOP
    sig:=('app_private.'||name)::regprocedure;
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
  END LOOP;
END $acl$;
COMMIT;
NOTIFY pgrst,'reload schema';
