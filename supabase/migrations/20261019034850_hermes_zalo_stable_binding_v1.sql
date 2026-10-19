-- Stable verified Zalo identity, separate from its explicitly selected CRM credential.
-- Connection/epoch fields remain current compatibility projections for legacy
-- dispatch/group/schedule admission. Their updates never revoke the Zalo identity.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_active_credentials (
  assistant_id uuid PRIMARY KEY REFERENCES app_private.hermes_assistants(id),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  selected_by uuid NOT NULL REFERENCES auth.users(id)
);
ALTER TABLE app_private.hermes_zalo_active_credentials OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_active_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_zalo_active_credentials FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Existing confirmed rows are explicit choices. Ambiguous history is retained,
-- with no automatic newest-token fallback.
INSERT INTO app_private.hermes_zalo_active_credentials(assistant_id,connection_id,selected_by)
  SELECT assistant_id,min(connection_id::text)::uuid,min(user_id::text)::uuid
  FROM app_private.hermes_zalo_bindings WHERE state='ACTIVE'
  GROUP BY assistant_id HAVING count(DISTINCT connection_id)=1 AND count(DISTINCT user_id)=1
  ON CONFLICT(assistant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.hermes_zalo_project_credential_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections;
BEGIN
  IF TG_TABLE_NAME='hermes_connections' THEN
    IF NOT EXISTS(SELECT 1 FROM app_private.hermes_zalo_active_credentials WHERE assistant_id=NEW.assistant_id AND connection_id=NEW.id) THEN RETURN NEW; END IF;
    c:=NEW;
  ELSE
    SELECT * INTO c FROM app_private.hermes_connections WHERE id=NEW.connection_id;
    IF c.id IS NULL OR c.assistant_id IS DISTINCT FROM NEW.assistant_id OR c.user_id IS DISTINCT FROM NEW.selected_by
      OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=c.assistant_id AND a.user_id=c.user_id AND a.organization_id=c.organization_id)
    THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  END IF;
  UPDATE app_private.hermes_zalo_bindings SET connection_id=c.id,connection_epoch=c.epoch
    WHERE assistant_id=c.assistant_id AND user_id=c.user_id AND organization_id=c.organization_id AND state='ACTIVE'
      AND (connection_id IS DISTINCT FROM c.id OR connection_epoch IS DISTINCT FROM c.epoch);
  RETURN NEW;
END $$;
ALTER FUNCTION app_private.hermes_zalo_project_credential_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_project_credential_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
DROP TRIGGER IF EXISTS hermes_zalo_project_selection ON app_private.hermes_zalo_active_credentials;
CREATE TRIGGER hermes_zalo_project_selection AFTER INSERT OR UPDATE ON app_private.hermes_zalo_active_credentials
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_zalo_project_credential_v1();
DROP TRIGGER IF EXISTS hermes_zalo_project_connection ON app_private.hermes_connections;
CREATE TRIGGER hermes_zalo_project_connection AFTER UPDATE OF epoch ON app_private.hermes_connections
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_zalo_project_credential_v1();
UPDATE app_private.hermes_zalo_bindings b SET connection_id=c.id,connection_epoch=c.epoch
  FROM app_private.hermes_zalo_active_credentials p JOIN app_private.hermes_connections c ON c.id=p.connection_id
  WHERE b.assistant_id=p.assistant_id AND b.user_id=c.user_id AND b.organization_id=c.organization_id AND b.state='ACTIVE'
    AND (b.connection_id IS DISTINCT FROM c.id OR b.connection_epoch IS DISTINCT FROM c.epoch);
-- Replace only the original lifetime constraint, preserving candidate integrity.
DO $$ DECLARE name text; BEGIN
  FOR name IN SELECT conname FROM pg_constraint
    WHERE conrelid='app_private.hermes_zalo_link_challenges'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%expires_at%created_at%'
  LOOP EXECUTE format('ALTER TABLE app_private.hermes_zalo_link_challenges DROP CONSTRAINT %I',name); END LOOP;
END $$;
ALTER TABLE app_private.hermes_zalo_link_challenges ADD CONSTRAINT hermes_zalo_challenge_lifetime
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes');
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
  IF EXISTS(SELECT 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org AND NOT enabled) OR c.state<>'ACTIVE' OR (p_epoch IS NOT NULL AND c.epoch IS DISTINCT FROM p_epoch) OR s.state<>'ACTIVE' OR s.expires_at<=clock_timestamp()
    OR s.id IS NULL OR s.id IS DISTINCT FROM c.credential_ref
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=c.assistant_id AND a.state='ACTIVE' AND a.user_id=p_user AND a.organization_id=p_org)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION public.hermes_zalo_binding_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE op text:=p->>'operation'; u uuid:=auth.uid(); o uuid;
  c app_private.hermes_connections; b app_private.hermes_zalo_bots;
  h app_private.hermes_zalo_link_challenges; x app_private.hermes_zalo_bindings;
  v_secret text; v_now timestamptz; v_account uuid; v_id uuid; v_epoch bigint; v_after uuid; v_result jsonb; v_can_enable boolean;
BEGIN
  IF op='setBot' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','accountId','expectedVersion','enabled']);
  ELSIF op='selectCredential' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','connectionId','expectedConnectionEpoch','expectedActiveConnectionId']);
  ELSIF op='begin' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','connectionId','expectedConnectionEpoch','accountId']);
  ELSIF op='status' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','challengeId']);
  ELSIF op='confirm' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','challengeId','expectedCandidateVersion','expectedSenderUid']);
  ELSIF op='unlink' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','bindingId','expectedEpoch']);
  ELSIF op='list' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','afterBindingId']);
  ELSIF op='bots' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','afterAccountId']);
  ELSIF op='manageBots' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','afterAccountId']);
  ELSE RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
  o:=app_private.hermes_uuid_v1(p->'organizationId');
  IF op IN ('begin','selectCredential','confirm','unlink','setBot','manageBots') THEN PERFORM app_private.lock_org_for_decision_v1(o); END IF;
  PERFORM app_private.hermes_member_v1(u,o);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  -- Match canonical writers and settings/restrict/revoke: organization row,
  -- audit chain advisory, then credential/connection/binding rows. Read-only
  -- status/list/bots never acquire either writer lock.
  IF op IN ('begin','selectCredential','confirm','unlink','setBot') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(o::text,0));
  END IF;
  IF op IN ('manageBots','setBot') THEN
    PERFORM app_private.require_perm_v1(o,'users.edit','quản lý liên kết trợ lý Hermes');
    PERFORM app_private.require_perm_v1(o,'chat_zalo.manage_automation','chọn tài khoản bot của công ty');
  END IF;
  IF op='setBot' THEN
    v_account:=app_private.hermes_uuid_v1(p->'accountId');
    IF jsonb_typeof(p->'enabled')<>'boolean' OR jsonb_typeof(p->'expectedVersion')<>'number' OR (p->>'expectedVersion') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
    v_epoch:=(p->>'expectedVersion')::bigint;
    IF v_epoch>=9007199254740990 THEN RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
    SELECT status='connected' AND zalo_uid ~ '^[1-9][0-9]{0,39}$' INTO v_can_enable
      FROM public.zalo_accounts WHERE id=v_account AND organization_id=o AND kind='personal' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
    IF (p->>'enabled')::boolean AND v_can_enable IS DISTINCT FROM true THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    SELECT * INTO b FROM app_private.hermes_zalo_bots WHERE account_id=v_account FOR UPDATE;
    IF b.account_id IS NOT NULL AND b.organization_id<>o THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
    IF (b.account_id IS NULL AND v_epoch<>0) OR (b.account_id IS NOT NULL AND b.version<>v_epoch) THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    INSERT INTO app_private.hermes_zalo_bots(account_id,organization_id,enabled,updated_by) VALUES(v_account,o,(p->>'enabled')::boolean,u)
    ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=hermes_zalo_bots.version+1,updated_by=u
      WHERE hermes_zalo_bots.organization_id=o AND hermes_zalo_bots.version=v_epoch RETURNING * INTO b;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    -- Invalidate old grants as part of the same configuration change. Retain
    -- history for reconciliation and for the private DM router's privacy fence.
    UPDATE app_private.hermes_zalo_link_challenges SET state='REVOKED'
      WHERE account_id=v_account AND organization_id=o AND state IN ('WAITING','OBSERVED');
    UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp()
      WHERE account_id=v_account AND organization_id=o AND state='ACTIVE';
    v_result:=jsonb_build_object('status','configured','accountId',b.account_id,'version',b.version,'enabled',b.enabled);
  ELSIF op='manageBots' THEN
    IF p->'afterAccountId'='null'::jsonb THEN v_after:=NULL;
    ELSE v_after:=app_private.hermes_uuid_v1(p->'afterAccountId'); END IF;
    WITH window_rows AS MATERIALIZED (
      SELECT a.id, left(COALESCE(a.name,'Zalo'),80) AS name,
        CASE WHEN a.zalo_uid ~ '^[1-9][0-9]{0,39}$' THEN a.zalo_uid ELSE NULL END AS zalo_uid,
        COALESCE(a.status='connected' AND a.zalo_uid ~ '^[1-9][0-9]{0,39}$',false) AS connected,
        COALESCE(z.enabled,false) AS enabled, COALESCE(z.version,0) AS version
      FROM public.zalo_accounts a LEFT JOIN app_private.hermes_zalo_bots z ON z.account_id=a.id
      WHERE a.organization_id=o AND a.kind='personal' AND (z.account_id IS NULL OR z.organization_id=o)
        AND (v_after IS NULL OR a.id>v_after) ORDER BY a.id LIMIT 101
    ), page_rows AS (SELECT * FROM window_rows ORDER BY id LIMIT 100)
    SELECT jsonb_build_object('status','listed','bots',COALESCE(jsonb_agg(jsonb_build_object('accountId',a.id,'name',a.name,'zaloUid',a.zalo_uid,
      'connected',a.connected,'enabled',a.enabled,'version',a.version) ORDER BY a.id),'[]'::jsonb),
      'nextCursor',CASE WHEN (SELECT count(*) FROM window_rows)>100 THEN (SELECT id FROM page_rows ORDER BY id DESC LIMIT 1) ELSE NULL END)
      INTO v_result FROM page_rows a;
  ELSIF op='bots' THEN
    IF p->'afterAccountId'='null'::jsonb THEN v_after:=NULL;
    ELSE v_after:=app_private.hermes_uuid_v1(p->'afterAccountId'); END IF;
    WITH window_rows AS MATERIALIZED (
      SELECT a.id, left(COALESCE(a.name,'Zalo'),80) AS name, a.zalo_uid
      FROM app_private.hermes_zalo_bots z JOIN public.zalo_accounts a ON a.id=z.account_id AND a.organization_id=z.organization_id
      WHERE z.organization_id=o AND z.enabled AND a.kind='personal' AND a.status='connected'
        AND a.zalo_uid ~ '^[1-9][0-9]{0,39}$' AND (v_after IS NULL OR a.id>v_after)
      ORDER BY a.id LIMIT 101
    ), page_rows AS (SELECT * FROM window_rows ORDER BY id LIMIT 100)
    SELECT jsonb_build_object('status','listed','bots',COALESCE(jsonb_agg(jsonb_build_object('accountId',a.id,'name',a.name,'zaloUid',a.zalo_uid) ORDER BY a.id),'[]'::jsonb),
      'nextCursor',CASE WHEN (SELECT count(*) FROM window_rows)>100 THEN (SELECT id FROM page_rows ORDER BY id DESC LIMIT 1) ELSE NULL END)
      INTO v_result FROM page_rows a;
  ELSIF op='selectCredential' THEN
    c:=app_private.hermes_zalo_context_v1(app_private.hermes_uuid_v1(p->'connectionId'),u,o,app_private.hermes_integer_v1(p->'expectedConnectionEpoch'));
    IF p->'expectedActiveConnectionId'='null'::jsonb THEN v_id:=NULL;
    ELSE v_id:=app_private.hermes_uuid_v1(p->'expectedActiveConnectionId'); END IF;
    -- CAS the explicit selection. Never pick the newest connection.
    INSERT INTO app_private.hermes_zalo_active_credentials(assistant_id,connection_id,selected_by)
      SELECT c.assistant_id,c.id,u WHERE v_id IS NULL
      ON CONFLICT(assistant_id) DO NOTHING;
    UPDATE app_private.hermes_zalo_active_credentials SET connection_id=c.id,selected_by=u,revision=revision+1
      WHERE assistant_id=c.assistant_id AND (connection_id=v_id OR connection_id=c.id AND v_id IS NULL);
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    v_result:=jsonb_build_object('status','selected','connectionId',c.id);
  ELSIF op='begin' THEN
    -- Only this user's challenge creation serializes. Metadata polling never
    -- takes the organization writer lock or this advisory lock.
    PERFORM pg_advisory_xact_lock(hashtextextended('hermes-zalo-challenge:'||u::text||':'||o::text,0));
    c:=app_private.hermes_zalo_context_v1(app_private.hermes_uuid_v1(p->'connectionId'),u,o,app_private.hermes_integer_v1(p->'expectedConnectionEpoch'));
    v_account:=app_private.hermes_uuid_v1(p->'accountId');
    SELECT * INTO b FROM app_private.hermes_zalo_bots WHERE account_id=v_account AND organization_id=o AND enabled FOR SHARE;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.zalo_accounts a WHERE a.id=v_account AND a.organization_id=o AND a.kind='personal' AND a.status='connected' AND a.zalo_uid ~ '^[1-9][0-9]{0,39}$') THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
    UPDATE app_private.hermes_zalo_link_challenges SET state='REVOKED' WHERE user_id=u AND organization_id=o AND state IN ('WAITING','OBSERVED');
    v_secret:='hz_'||encode(extensions.gen_random_bytes(32),'hex'); v_now:=clock_timestamp();
    INSERT INTO app_private.hermes_zalo_link_challenges(user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,challenge_digest,created_at,expires_at)
    VALUES(u,o,c.assistant_id,c.id,c.epoch,b.account_id,b.version,encode(extensions.digest(v_secret,'sha256'),'hex'),v_now,v_now+interval '15 minutes') RETURNING * INTO h;
    v_result:=jsonb_build_object('status','waiting','challengeId',h.id,'challenge',v_secret,'accountId',h.account_id,'connectionId',h.connection_id,'expiresAt',floor(extract(epoch FROM h.expires_at)*1000)::bigint);
  ELSIF op IN ('status','confirm') THEN
    v_id:=app_private.hermes_uuid_v1(p->'challengeId');
    SELECT * INTO h FROM app_private.hermes_zalo_link_challenges WHERE id=v_id AND user_id=u AND organization_id=o;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
    c:=app_private.hermes_zalo_context_v1(h.connection_id,u,o,NULL);
    -- Match ingress lock order before touching the challenge. Keep the worker
    -- generation/account/lease stable through the binding INSERT and audit.
    IF op='confirm' THEN
      PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
      PERFORM 1 FROM public.zalo_accounts WHERE id=h.account_id AND organization_id=o AND kind='personal' AND status='connected' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    END IF;
    SELECT * INTO b FROM app_private.hermes_zalo_bots WHERE account_id=h.account_id AND organization_id=o AND enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    IF op='confirm' THEN
      PERFORM 1 FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=h.account_id AND organization_id=o FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    END IF;
    SELECT * INTO h FROM app_private.hermes_zalo_link_challenges WHERE id=v_id AND user_id=u AND organization_id=o FOR UPDATE;
    IF NOT FOUND OR b.version<>h.bot_version OR h.expires_at<=clock_timestamp() OR h.state='REVOKED' THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    IF op='status' THEN
      v_result:=jsonb_build_object('status',lower(h.state),'challengeId',h.id,'accountId',h.account_id,'connectionId',h.connection_id,
        'candidateVersion',h.candidate_version,'senderUid',h.sender_uid,'expiresAt',floor(extract(epoch FROM h.expires_at)*1000)::bigint);
    ELSE
      IF h.state<>'OBSERVED' OR h.candidate_version IS DISTINCT FROM app_private.hermes_integer_v1(p->'expectedCandidateVersion')
        OR jsonb_typeof(p->'expectedSenderUid')<>'string' OR h.sender_uid IS DISTINCT FROM p->>'expectedSenderUid'
      THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
      PERFORM 1 FROM app_private.hermes_zalo_ingress_sessions i JOIN public.zalo_accounts a ON a.id=i.account_id
        JOIN public.zalo_worker_lease l ON l.id='singleton' AND l.instance_id=i.instance_id
        WHERE i.account_id=h.account_id AND i.organization_id=o AND i.generation=h.ingress_generation
          AND a.organization_id=o AND a.user_id=i.account_owner_id AND a.status='connected' AND a.zalo_uid=i.own_uid
          AND a.login_requested_at IS NOT DISTINCT FROM i.login_requested_at AND l.heartbeat_at>clock_timestamp()-interval '30 seconds';
      IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
      -- A confirmed human selection chooses the assistant credential once.
      -- Existing selection is never replaced implicitly by a later connection.
      INSERT INTO app_private.hermes_zalo_active_credentials(assistant_id,connection_id,selected_by)
        VALUES(c.assistant_id,c.id,u) ON CONFLICT(assistant_id) DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM app_private.hermes_zalo_active_credentials WHERE assistant_id=c.assistant_id AND connection_id=c.id)
      THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
      INSERT INTO app_private.hermes_zalo_bindings(user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,sender_uid,conversation_id,challenge_id)
      VALUES(u,o,c.assistant_id,c.id,c.epoch,h.account_id,h.bot_version,h.sender_uid,h.conversation_id,h.id) RETURNING * INTO x;
      UPDATE app_private.hermes_zalo_link_challenges SET state='CONFIRMED' WHERE id=h.id;
      v_result:=jsonb_build_object('status','active','bindingId',x.id,'epoch',x.epoch,'accountId',x.account_id,'connectionId',x.connection_id,'senderUid',x.sender_uid,'provisioningState','pending');
    END IF;
  ELSIF op='list' THEN
    -- Bounded keyset pages include revoked rows so an unknown unlink ACK can
    -- still be reconciled after arbitrarily many link/unlink cycles.
    IF p->'afterBindingId'='null'::jsonb THEN v_after:=NULL;
    ELSE v_after:=app_private.hermes_uuid_v1(p->'afterBindingId'); END IF;
    WITH window_rows AS MATERIALIZED (
      SELECT z.* FROM app_private.hermes_zalo_bindings z
      WHERE z.user_id=u AND z.organization_id=o AND (v_after IS NULL OR z.id>v_after)
      ORDER BY z.id LIMIT 101
    ), page_rows AS (SELECT * FROM window_rows ORDER BY id LIMIT 100)
    SELECT jsonb_build_object('status','listed','bindings',COALESCE(jsonb_agg(jsonb_build_object('bindingId',z.id,'epoch',z.epoch,'state',lower(z.state),
      'accountId',z.account_id,'connectionId',z.connection_id,'senderUid',z.sender_uid)
      ||CASE WHEN z.state='ACTIVE' THEN jsonb_build_object('provisioningState',COALESCE(
        (SELECT state FROM app_private.hermes_zalo_provisioning_queue q WHERE q.binding_id=z.id),'pending')) ELSE '{}'::jsonb END ORDER BY z.id),'[]'::jsonb),
      'nextCursor',CASE WHEN (SELECT count(*) FROM window_rows)>100
        THEN (SELECT id FROM page_rows ORDER BY id DESC LIMIT 1) ELSE NULL END) INTO v_result
      FROM page_rows z;
  ELSE
    v_id:=app_private.hermes_uuid_v1(p->'bindingId');v_epoch:=app_private.hermes_integer_v1(p->'expectedEpoch');
    SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=v_id AND user_id=u AND organization_id=o FOR UPDATE;
    IF NOT FOUND OR x.epoch<>v_epoch THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    IF x.state='ACTIVE' THEN UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x; END IF;
    v_result:=jsonb_build_object('status','revoked','bindingId',x.id,'epoch',x.epoch);
  END IF;
  IF op NOT IN ('status','list','bots','manageBots') THEN PERFORM app_private.append_authz_audit_v1(o,'HERMES_ZALO_BINDING_CHANGED','hermes_zalo_binding',COALESCE(x.id,h.id,b.account_id),NULL,
    v_result-'challenge','Explicit CRM user action: '||op); END IF;
  RETURN v_result||jsonb_build_object('userId',u,'organizationId',o);
END $$;

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
    OR a.state<>'ACTIVE' OR NOT policy.enabled OR (c.permission_mode<>'inherit_crm' AND (NOT(c.read_capabilities<@policy.read_capabilities)
    OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids)))
  THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  RETURN c;
END $$;
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
          AND assistant.state='ACTIVE' AND policy.enabled AND (c.permission_mode='inherit_crm' OR (c.read_capabilities<@policy.read_capabilities
          AND c.action_capabilities<@policy.action_capabilities AND c.scope_ids<@policy.scope_ids))
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
ALTER FUNCTION app_private.hermes_zalo_context_v1(uuid,uuid,uuid,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_context_v1(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_private_command_connection_v1(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_private_command_connection_v1(text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_zalo_private_reply_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_private_reply_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_private_reply_v1(jsonb) TO service_role;
ALTER FUNCTION public.hermes_zalo_binding_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_binding_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_binding_v1(jsonb) TO authenticated;

-- A transactionally queued latest event identifies this assistant/bot mapping.
-- It never chooses a connection: the explicit credential pointer above does.
CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_provisioning_queue(
  assistant_id uuid NOT NULL REFERENCES app_private.hermes_assistants(id),
  account_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bots(account_id),
  binding_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bindings(id),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','pending_credential','restart_pending','synchronized','unavailable')),
  PRIMARY KEY(assistant_id,account_id)
);
ALTER TABLE app_private.hermes_zalo_provisioning_queue OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_provisioning_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_zalo_provisioning_queue FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_enqueue_provisioning_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
BEGIN
  INSERT INTO app_private.hermes_zalo_provisioning_queue(assistant_id,account_id,binding_id)
    VALUES(NEW.assistant_id,NEW.account_id,NEW.id)
    ON CONFLICT(assistant_id,account_id) DO UPDATE SET binding_id=EXCLUDED.binding_id,
      revision=hermes_zalo_provisioning_queue.revision+1,
      state=CASE WHEN hermes_zalo_provisioning_queue.state='restart_pending' THEN 'restart_pending' ELSE 'pending' END;
  RETURN NEW;
END $$;
ALTER FUNCTION app_private.hermes_zalo_enqueue_provisioning_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_enqueue_provisioning_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
DROP TRIGGER IF EXISTS hermes_zalo_queue_provisioning ON app_private.hermes_zalo_bindings;
CREATE TRIGGER hermes_zalo_queue_provisioning AFTER INSERT OR UPDATE OF state,connection_id,connection_epoch ON app_private.hermes_zalo_bindings
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_zalo_enqueue_provisioning_v1();
INSERT INTO app_private.hermes_zalo_provisioning_queue(assistant_id,account_id,binding_id)
  SELECT assistant_id,account_id,id FROM app_private.hermes_zalo_bindings WHERE state='ACTIVE'
  ON CONFLICT(assistant_id,account_id) DO NOTHING;

-- Trusted host-only provisioning snapshot. No token, session envelope or DM text.
-- The host maps assistant_id to its existing profile; the model cannot choose it.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_provisioning_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE x app_private.hermes_zalo_bindings; a public.zalo_accounts;
  c app_private.hermes_connections; v_state text:='active';
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['bindingId']);
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=app_private.hermes_uuid_v1(p->'bindingId');
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  IF x.state<>'ACTIVE' OR x.revoked_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_zalo_bots WHERE account_id=x.account_id AND organization_id=x.organization_id AND enabled AND version=x.bot_version)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants WHERE id=x.assistant_id AND user_id=x.user_id AND organization_id=x.organization_id AND state='ACTIVE')
  THEN v_state:='revoked'; END IF;
  -- Membership uses the same canonical validator. This host-only function
  -- cannot manufacture an actor JWT or return a credential.
  BEGIN PERFORM app_private.hermes_member_v1(x.user_id,x.organization_id);
  EXCEPTION WHEN insufficient_privilege THEN v_state:='revoked'; END;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=x.account_id AND organization_id=x.organization_id AND kind='personal';
  SELECT connection.* INTO c FROM app_private.hermes_zalo_active_credentials selection
    JOIN app_private.hermes_connections connection ON connection.id=selection.connection_id
    WHERE selection.assistant_id=x.assistant_id AND connection.assistant_id=x.assistant_id
      AND connection.user_id=x.user_id AND connection.organization_id=x.organization_id;
  IF v_state='active' AND (a.zalo_uid IS NULL OR a.zalo_uid !~ '^[1-9][0-9]{0,39}$' OR a.status<>'connected'
    OR c.id IS NULL OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL)
  THEN v_state:='unavailable'; END IF;
  RETURN jsonb_build_object('bindingId',x.id,'bindingEpoch',x.epoch,'assistantId',x.assistant_id,
    'userId',x.user_id,'organizationId',x.organization_id,'accountId',x.account_id,
    'ownUid',a.zalo_uid,'senderUid',x.sender_uid,'connectionId',c.id,'status',v_state);
END $$;
ALTER FUNCTION app_private.hermes_zalo_provisioning_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_provisioning_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_zalo_provisioning_v1(jsonb) TO hermes_store_executor;

CREATE OR REPLACE FUNCTION app_private.hermes_zalo_provisioning_work_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE q app_private.hermes_zalo_provisioning_queue;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['assistantId','accountId']);
  SELECT * INTO q FROM app_private.hermes_zalo_provisioning_queue
    WHERE assistant_id=app_private.hermes_uuid_v1(p->'assistantId') AND account_id=app_private.hermes_uuid_v1(p->'accountId');
  IF NOT FOUND THEN RETURN jsonb_build_object('status','empty'); END IF;
  RETURN jsonb_build_object('status','queued','revision',q.revision,'provisioningState',q.state,
    'binding',app_private.hermes_zalo_provisioning_v1(jsonb_build_object('bindingId',q.binding_id)));
END $$;
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_provisioning_ack_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE n bigint;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['assistantId','accountId','bindingId','expectedRevision','state']);
  IF jsonb_typeof(p->'state')<>'string' OR p->>'state' NOT IN ('pending_credential','restart_pending','synchronized','unavailable')
  THEN RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
  UPDATE app_private.hermes_zalo_provisioning_queue SET state=p->>'state'
    WHERE assistant_id=app_private.hermes_uuid_v1(p->'assistantId') AND account_id=app_private.hermes_uuid_v1(p->'accountId')
      AND binding_id=app_private.hermes_uuid_v1(p->'bindingId') AND revision=app_private.hermes_integer_v1(p->'expectedRevision');
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('status','recorded');
END $$;
ALTER FUNCTION app_private.hermes_zalo_provisioning_work_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_provisioning_ack_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_provisioning_work_v1(jsonb),app_private.hermes_zalo_provisioning_ack_v1(jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_zalo_provisioning_work_v1(jsonb),app_private.hermes_zalo_provisioning_ack_v1(jsonb) TO hermes_store_executor;
COMMIT;
