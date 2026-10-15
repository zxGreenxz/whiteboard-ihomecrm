-- P7.01/P7.06 · Hermes tổng tra cứu work memory CRM được CHÍNH CHỦ chia sẻ, và
-- trang CRM cho chủ ghi nhớ xem/sửa/quên/retention. Không đọc personal memory,
-- lịch sử riêng hay filesystem; không mount kho của người khác.
-- Đọc memory người khác (assistant.memory.supervise) là quyền riêng, khác với
-- giao việc (tasks.create) và làm thay (không có). Mặc định TẮT ở registry.
-- Mức chia sẻ mới 'managers' = người có quyền CRM users.view trong công ty
-- (gồm superadmin); 'superadmin' giữ nguyên nghĩa cũ.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
  VALUES('assistant.memory.supervise','read',false) ON CONFLICT(capability) DO NOTHING;

ALTER TABLE app_private.hermes_work_memory_settings DROP CONSTRAINT IF EXISTS hermes_work_memory_settings_sharing_check;
ALTER TABLE app_private.hermes_work_memory_settings ADD CONSTRAINT hermes_work_memory_settings_sharing_check
  CHECK(sharing IN ('owner','superadmin','managers'));

CREATE OR REPLACE FUNCTION app_private.hermes_work_memory_int_v1(p jsonb,p_min integer,p_max integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'number' OR (p#>>'{}') !~ '^[0-9]{1,6}$' OR (p#>>'{}')::integer NOT BETWEEN p_min AND p_max
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::integer;
END $fn$;

-- Hermes read overlay for supervision ∩ current CRM users.view. Returns the
-- live member projection (isSuperadmin decides the legacy 'superadmin' sharing).
CREATE OR REPLACE FUNCTION app_private.hermes_memory_supervisor_v1(c app_private.hermes_connections)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies; member jsonb; v_auth record;
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF NOT COALESCE(policy.enabled,false) OR NOT('assistant.memory.supervise'=ANY(policy.read_capabilities))
    OR NOT('assistant.memory.supervise'=ANY(c.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.memory.supervise' AND mode='read' AND enabled)
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'users.view');
  IF v_auth.allowed IS DISTINCT FROM true OR v_auth.authorization_version::text IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  RETURN member;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_memory_shared_with_v1(p_sharing text,p_member jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT p_sharing='managers' OR (p_sharing='superadmin' AND p_member->'isSuperadmin'='true'::jsonb)
$fn$;

-- Forward replacement: also accepts sharing='managers'. Everything else unchanged.
CREATE OR REPLACE FUNCTION public.hermes_work_memory_configure_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; settings app_private.hermes_work_memory_settings; expected bigint; days integer;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['enabled','sharing','retentionDays','expectedAccessVersion']);
  IF jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' OR p_input->>'sharing' NOT IN ('owner','superadmin','managers')
    OR jsonb_typeof(p_input->'sharing') IS DISTINCT FROM 'string'
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  expected:=(CASE WHEN p_input->'expectedAccessVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_input->'expectedAccessVersion') END);
  days:=app_private.hermes_integer_v1(p_input->'retentionDays');
  IF expected<0 OR days NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_work_memory_context_v1(p,true);
  INSERT INTO app_private.hermes_work_memory_settings(organization_id,user_id) VALUES(c.organization_id,c.user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=c.user_id FOR UPDATE;
  IF (expected=0 AND settings.access_version<>1) OR (expected<>0 AND expected<>settings.access_version)
    THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.hermes_work_memory_settings SET enabled=(p_input->>'enabled')::boolean,
    sharing=p_input->>'sharing',retention_days=days,access_version=access_version+1,updated_at=clock_timestamp()
    WHERE organization_id=c.organization_id AND user_id=c.user_id RETURNING * INTO settings;
  UPDATE app_private.hermes_work_memories SET expires_at=LEAST(expires_at,updated_at+make_interval(days=>days))
    WHERE organization_id=c.organization_id AND user_id=c.user_id;
  DELETE FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=c.user_id AND expires_at<=clock_timestamp();
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_MEMORY_CONFIGURED','hermes_assistant',c.assistant_id,
    jsonb_build_object('actor',c.user_id,'connectionId',c.id,'accessVersion',settings.access_version,'enabled',settings.enabled,'sharing',settings.sharing,'retentionDays',days));
  RETURN public.hermes_work_memory_status_v1(p);
END $fn$;

-- Forward replacement: cross-owner list now needs the separate supervision
-- grant (registry ∩ company ∩ connection) plus live users.view, and honours
-- 'managers'. Self listing is unchanged.
CREATE OR REPLACE FUNCTION public.hermes_work_memory_list_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; settings app_private.hermes_work_memory_settings; owner_id uuid;
  items jsonb; v_limit integer; v_offset integer; v_since timestamptz; v_now timestamptz; member jsonb;
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
  member:=CASE WHEN owner_id<>c.user_id THEN app_private.hermes_memory_supervisor_v1(c) ELSE app_private.hermes_member_v1(c.user_id,c.organization_id) END;
  PERFORM app_private.hermes_member_v1(owner_id,c.organization_id);
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=c.organization_id AND user_id=owner_id FOR SHARE;
  IF settings.user_id IS NULL OR NOT settings.enabled
    OR (owner_id<>c.user_id AND NOT app_private.hermes_memory_shared_with_v1(settings.sharing,member))
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  v_now:=clock_timestamp();
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'key',m.key,'content',m.content,'version',m.version,
    'assistantId',m.assistant_id,'connectionId',m.connection_id,'source',jsonb_build_object('channel',m.source_channel,'label',m.source_label),
    'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at) ORDER BY m.updated_at DESC,m.id),'[]') INTO items
    FROM (SELECT * FROM app_private.hermes_work_memories WHERE organization_id=c.organization_id AND user_id=owner_id
      AND expires_at>v_now AND (v_since IS NULL OR updated_at>=v_since) ORDER BY updated_at DESC,id LIMIT v_limit OFFSET v_offset) m;
  PERFORM app_private.append_authz_audit_v1(c.organization_id,
    CASE WHEN owner_id<>c.user_id THEN 'HERMES_MEMORY_SUPERVISED_READ' ELSE 'HERMES_MEMORY_READ' END,'hermes_assistant',c.assistant_id,
    jsonb_build_object('actor',c.user_id,'ownerUserId',owner_id,'connectionId',c.id,'accessVersion',settings.access_version,'count',jsonb_array_length(items)));
  RETURN jsonb_build_object('organizationId',c.organization_id,'ownerUserId',owner_id,'settings',app_private.hermes_work_memory_settings_json_v1(settings),
    'classification','crm_work_memory','authority','reference_only','readAt',v_now,'items',items,
    'offset',v_offset,'nextOffset',CASE WHEN jsonb_array_length(items)=v_limit AND v_offset+v_limit<200 THEN v_offset+v_limit ELSE NULL END);
END $fn$;

-- Hermes tổng: tìm trong work memory được chia sẻ của người khác cùng công ty.
-- organizationId bắt buộc và phải trùng công ty của kết nối (superadmin chọn rõ).
CREATE OR REPLACE FUNCTION public.hermes_work_memory_search_v1(p jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; member jsonb; v_owner uuid; v_query text; v_limit integer; v_offset integer;
  v_now timestamptz; items jsonb; owners jsonb;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','ownerUserId','query','limit','offset']);
  PERFORM app_private.hermes_uuid_v1(p_input->'organizationId');
  IF p_input->'ownerUserId'<>'null'::jsonb THEN v_owner:=app_private.hermes_uuid_v1(p_input->'ownerUserId'); END IF;
  v_query:=p_input->>'query';
  IF jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(v_query)>100 OR v_query ~ '[\x01-\x1F\x7F-\x9F]'
    OR position(chr(8232) IN v_query)>0 OR position(chr(8233) IN v_query)>0
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  v_query:=lower(btrim(v_query));
  v_limit:=app_private.hermes_work_memory_int_v1(p_input->'limit',1,20);
  v_offset:=app_private.hermes_work_memory_int_v1(p_input->'offset',0,200);
  c:=app_private.hermes_work_memory_context_v1(p,false);
  IF p_input->>'organizationId' IS DISTINCT FROM c.organization_id::text OR v_owner=c.user_id
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_memory_supervisor_v1(c);
  v_now:=clock_timestamp();
  SELECT COALESCE(jsonb_agg(item ORDER BY updated_at DESC,id),'[]'),COALESCE(jsonb_agg(DISTINCT owner_id),'[]') INTO items,owners FROM (
    SELECT m.id,m.updated_at,m.user_id owner_id,jsonb_build_object('id',m.id,'ownerUserId',m.user_id,
      'ownerName',app_private.hermes_memory_owner_name_v1(m.user_id),'key',m.key,'content',m.content,'version',m.version,
      'assistantId',m.assistant_id,'connectionId',m.connection_id,'source',jsonb_build_object('channel',m.source_channel,'label',m.source_label),
      'sharing',s.sharing,'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at) item
    FROM app_private.hermes_work_memories m
    JOIN app_private.hermes_work_memory_settings s ON s.organization_id=m.organization_id AND s.user_id=m.user_id
    WHERE m.organization_id=c.organization_id AND m.user_id<>c.user_id AND s.enabled AND m.expires_at>v_now
      AND app_private.hermes_memory_shared_with_v1(s.sharing,member) AND (v_owner IS NULL OR m.user_id=v_owner)
      AND EXISTS(SELECT 1 FROM public.organization_memberships om WHERE om.user_id=m.user_id AND om.organization_id=m.organization_id
        AND om.status='ACTIVE' AND om.revoked_at IS NULL AND (om.valid_from IS NULL OR om.valid_from<=v_now) AND (om.valid_to IS NULL OR om.valid_to>v_now))
      AND (v_query='' OR position(v_query IN lower(m.key||' '||m.content||' '||m.source_label))>0)
    ORDER BY m.updated_at DESC,m.id LIMIT v_limit OFFSET v_offset) found;
  -- Identifiers and counts only; neither query text nor note content is copied.
  PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_MEMORY_SUPERVISED_READ','hermes_assistant',c.assistant_id,
    jsonb_build_object('actor',c.user_id,'connectionId',c.id,'ownerFilter',v_owner,'owners',owners,'count',jsonb_array_length(items),
      'queryLength',char_length(v_query)));
  RETURN jsonb_build_object('organizationId',c.organization_id,'actorUserId',c.user_id,'classification','crm_work_memory',
    'authority','reference_only','scope','shared_work_memory','personalMemory','not_accessible','readAt',v_now,'items',items,
    'offset',v_offset,'nextOffset',CASE WHEN jsonb_array_length(items)=v_limit AND v_offset+v_limit<200 THEN v_offset+v_limit ELSE NULL END);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_memory_owner_name_v1(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT NULLIF(left(btrim(regexp_replace(translate(COALESCE(p.full_name,''),chr(8232)||chr(8233),'  '),'[[:cntrl:]]',' ','g')),120),'')
    FROM public.profiles p WHERE p.id=p_user
$fn$;

-- ---------------------------------------------------------------------------
-- Trang CRM của chính chủ (JWT người dùng, không cần kết nối Hermes): xem, cấu
-- hình, sửa, quên. Không cần quyền Hermes để xem/quên dữ liệu của chính mình.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_my_memory_owner_v1(p_org uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_org IS NULL
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  PERFORM app_private.hermes_member_v1(auth.uid(),p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  RETURN auth.uid();
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_my_memory_status_v1(p_org uuid,p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT jsonb_build_object('organizationId',p_org,'ownerUserId',p_user,'settings',COALESCE(
      (SELECT app_private.hermes_work_memory_settings_json_v1(s) FROM app_private.hermes_work_memory_settings s
        WHERE s.organization_id=p_org AND s.user_id=p_user),
      jsonb_build_object('enabled',false,'sharing','owner','retentionDays',30,'accessVersion',0)),
    'personalMemory','outside_crm','remoteCopies','not_revocable')
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_my_work_memory_v1(p_org uuid,p_offset integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_user uuid; v_now timestamptz; items jsonb; v_total integer;
BEGIN
  IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 200 THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  v_user:=app_private.hermes_my_memory_owner_v1(p_org);
  v_now:=clock_timestamp();
  SELECT count(*) INTO v_total FROM app_private.hermes_work_memories WHERE organization_id=p_org AND user_id=v_user AND expires_at>v_now;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'key',m.key,'content',m.content,'version',m.version,
    'assistantId',m.assistant_id,'connectionId',m.connection_id,'source',jsonb_build_object('channel',m.source_channel,'label',m.source_label),
    'createdAt',m.created_at,'updatedAt',m.updated_at,'expiresAt',m.expires_at) ORDER BY m.updated_at DESC,m.id),'[]') INTO items
    FROM (SELECT * FROM app_private.hermes_work_memories WHERE organization_id=p_org AND user_id=v_user AND expires_at>v_now
      ORDER BY updated_at DESC,id LIMIT 50 OFFSET p_offset) m;
  RETURN app_private.hermes_my_memory_status_v1(p_org,v_user)||jsonb_build_object('items',items,'offset',p_offset,
    'nextOffset',CASE WHEN p_offset+jsonb_array_length(items)<v_total AND p_offset+50<=200 THEN p_offset+50 ELSE NULL END,'total',v_total);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_my_work_memory_configure_v1(p_org uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_user uuid; settings app_private.hermes_work_memory_settings; expected bigint; days integer;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['enabled','sharing','retentionDays','expectedAccessVersion']);
  IF jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'sharing') IS DISTINCT FROM 'string'
    OR p_input->>'sharing' NOT IN ('owner','superadmin','managers') THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  expected:=app_private.hermes_work_memory_int_v1(p_input->'expectedAccessVersion',0,999999);
  days:=app_private.hermes_work_memory_int_v1(p_input->'retentionDays',1,365);
  v_user:=app_private.hermes_my_memory_owner_v1(p_org);
  INSERT INTO app_private.hermes_work_memory_settings(organization_id,user_id) VALUES(p_org,v_user) ON CONFLICT DO NOTHING;
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=p_org AND user_id=v_user FOR UPDATE;
  IF (expected=0 AND settings.access_version<>1) OR (expected<>0 AND expected<>settings.access_version)
    THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.hermes_work_memory_settings SET enabled=(p_input->>'enabled')::boolean,sharing=p_input->>'sharing',
    retention_days=days,access_version=access_version+1,updated_at=clock_timestamp()
    WHERE organization_id=p_org AND user_id=v_user RETURNING * INTO settings;
  UPDATE app_private.hermes_work_memories SET expires_at=LEAST(expires_at,updated_at+make_interval(days=>days))
    WHERE organization_id=p_org AND user_id=v_user;
  DELETE FROM app_private.hermes_work_memories WHERE organization_id=p_org AND user_id=v_user AND expires_at<=clock_timestamp();
  PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_MEMORY_CONFIGURED','hermes_work_memory_settings',v_user,
    jsonb_build_object('actor',v_user,'channel','crm_web','accessVersion',settings.access_version,'enabled',settings.enabled,
      'sharing',settings.sharing,'retentionDays',days));
  RETURN app_private.hermes_my_memory_status_v1(p_org,v_user);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_my_work_memory_edit_v1(p_org uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_user uuid; settings app_private.hermes_work_memory_settings; m app_private.hermes_work_memories; v_content text; v_now timestamptz;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['id','expectedVersion','content']);
  PERFORM app_private.hermes_uuid_v1(p_input->'id'); PERFORM app_private.hermes_integer_v1(p_input->'expectedVersion');
  v_content:=p_input->>'content';
  IF jsonb_typeof(p_input->'content') IS DISTINCT FROM 'string' OR char_length(btrim(v_content)) NOT BETWEEN 1 AND 1000
    OR v_content ~ '[\x01-\x1F\x7F-\x9F]' OR position(chr(8232) IN v_content)>0 OR position(chr(8233) IN v_content)>0
    OR v_content ~ '(hc_[A-Za-z0-9_-]{43}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  v_user:=app_private.hermes_my_memory_owner_v1(p_org);
  SELECT * INTO settings FROM app_private.hermes_work_memory_settings WHERE organization_id=p_org AND user_id=v_user FOR UPDATE;
  IF settings.user_id IS NULL OR NOT settings.enabled THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  v_now:=clock_timestamp();
  SELECT * INTO m FROM app_private.hermes_work_memories WHERE id=(p_input->>'id')::uuid AND organization_id=p_org AND user_id=v_user FOR UPDATE;
  IF NOT FOUND OR m.expires_at<=v_now THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  IF m.version::text IS DISTINCT FROM p_input->>'expectedVersion' THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.hermes_work_memories SET content=v_content,version=version+1,updated_at=v_now,
    expires_at=v_now+make_interval(days=>settings.retention_days) WHERE id=m.id RETURNING * INTO m;
  PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_MEMORY_SAVED','hermes_work_memory',m.id,
    jsonb_build_object('actor',v_user,'channel','crm_web','version',m.version,'accessVersion',settings.access_version));
  RETURN jsonb_build_object('organizationId',p_org,'ownerUserId',v_user,'id',m.id,'key',m.key,'version',m.version,'expiresAt',m.expires_at);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_my_work_memory_forget_v1(p_org uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_user uuid; m app_private.hermes_work_memories;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['id','expectedVersion']);
  PERFORM app_private.hermes_uuid_v1(p_input->'id'); PERFORM app_private.hermes_integer_v1(p_input->'expectedVersion');
  v_user:=app_private.hermes_my_memory_owner_v1(p_org);
  SELECT * INTO m FROM app_private.hermes_work_memories WHERE id=(p_input->>'id')::uuid AND organization_id=p_org AND user_id=v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  IF m.version::text IS DISTINCT FROM p_input->>'expectedVersion' THEN RAISE EXCEPTION 'hermes_memory_context_changed' USING ERRCODE='PT409'; END IF;
  DELETE FROM app_private.hermes_work_memories WHERE id=m.id;
  PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_MEMORY_FORGOTTEN','hermes_work_memory',m.id,
    jsonb_build_object('actor',v_user,'channel','crm_web','memoryId',m.id,'version',m.version));
  RETURN jsonb_build_object('organizationId',p_org,'ownerUserId',v_user,'id',m.id,'forgotten',true,'auditRetained',true,'remoteCopies','not_revocable');
END $fn$;

DO $acl$ DECLARE sig text; BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.hermes_work_memory_int_v1(jsonb,integer,integer)',
    'app_private.hermes_memory_supervisor_v1(app_private.hermes_connections)','app_private.hermes_memory_shared_with_v1(text,jsonb)',
    'app_private.hermes_memory_owner_name_v1(uuid)','app_private.hermes_my_memory_owner_v1(uuid)',
    'app_private.hermes_my_memory_status_v1(uuid,uuid)','public.hermes_work_memory_configure_v1(jsonb,jsonb)',
    'public.hermes_work_memory_list_v1(jsonb,jsonb)','public.hermes_work_memory_search_v1(jsonb,jsonb)',
    'public.hermes_my_work_memory_v1(uuid,integer)','public.hermes_my_work_memory_configure_v1(uuid,jsonb)',
    'public.hermes_my_work_memory_edit_v1(uuid,jsonb)','public.hermes_my_work_memory_forget_v1(uuid,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.hermes_work_memory_configure_v1(jsonb,jsonb),public.hermes_work_memory_list_v1(jsonb,jsonb),
  public.hermes_work_memory_search_v1(jsonb,jsonb),public.hermes_my_work_memory_v1(uuid,integer),
  public.hermes_my_work_memory_configure_v1(uuid,jsonb),public.hermes_my_work_memory_edit_v1(uuid,jsonb),
  public.hermes_my_work_memory_forget_v1(uuid,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
