-- Candidate P4 only. No provider login, send, AI dispatch, or cross-company bot.
-- Binding: authenticated CRM intent -> live worker DM observation -> fresh CRM
-- confirmation of exact sender. Possession of a copied challenge cannot activate.
BEGIN;

CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_bots (
  account_id uuid PRIMARY KEY REFERENCES public.zalo_accounts(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by uuid NOT NULL REFERENCES auth.users(id)
);
CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_ingress_sessions (
  account_id uuid PRIMARY KEY REFERENCES public.zalo_accounts(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  account_owner_id uuid NOT NULL REFERENCES auth.users(id),
  instance_id uuid NOT NULL,
  generation uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  own_uid text NOT NULL CHECK(own_uid ~ '^[1-9][0-9]{0,39}$'),
  login_requested_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  assistant_id uuid NOT NULL REFERENCES app_private.hermes_assistants(id),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  connection_epoch bigint NOT NULL CHECK(connection_epoch>0),
  account_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bots(account_id),
  bot_version bigint NOT NULL CHECK(bot_version>0),
  challenge_digest text NOT NULL UNIQUE CHECK(challenge_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'WAITING' CHECK(state IN ('WAITING','OBSERVED','CONFIRMED','REVOKED')),
  candidate_version bigint NOT NULL DEFAULT 0 CHECK(candidate_version>=0),
  sender_uid text CHECK(sender_uid ~ '^[1-9][0-9]{0,39}$'),
  conversation_id uuid REFERENCES public.zalo_conversations(id),
  message_id uuid UNIQUE REFERENCES public.zalo_messages(id),
  ingress_generation uuid,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK(state NOT IN ('OBSERVED','CONFIRMED') OR
    (candidate_version=1 AND sender_uid IS NOT NULL AND conversation_id IS NOT NULL AND message_id IS NOT NULL AND ingress_generation IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  assistant_id uuid NOT NULL REFERENCES app_private.hermes_assistants(id),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  connection_epoch bigint NOT NULL CHECK(connection_epoch>0),
  account_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bots(account_id),
  bot_version bigint NOT NULL CHECK(bot_version>0),
  sender_uid text NOT NULL CHECK(sender_uid ~ '^[1-9][0-9]{0,39}$'),
  conversation_id uuid NOT NULL REFERENCES public.zalo_conversations(id),
  challenge_id uuid NOT NULL UNIQUE REFERENCES app_private.hermes_zalo_link_challenges(id),
  epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS hermes_zalo_self_list ON app_private.hermes_zalo_bindings(user_id,organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_zalo_one_sender ON app_private.hermes_zalo_bindings(account_id,sender_uid) WHERE state='ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS hermes_zalo_one_user_bot ON app_private.hermes_zalo_bindings(account_id,user_id) WHERE state='ACTIVE';

ALTER TABLE app_private.hermes_zalo_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_zalo_ingress_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_zalo_link_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_zalo_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_zalo_bots OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_ingress_sessions OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_link_challenges OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_bindings OWNER TO postgres;
REVOKE ALL ON app_private.hermes_zalo_bots,app_private.hermes_zalo_ingress_sessions,
  app_private.hermes_zalo_link_challenges,app_private.hermes_zalo_bindings FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- A bot account is a private DM channel even after disable/revoke. The account
-- row serializes this final write boundary with setBot; a worker-side read alone
-- cannot close the race between classification and a later inbox INSERT.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_shared_inbox_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE a public.zalo_accounts; c public.zalo_conversations; v_private boolean; v_account uuid; v_old_account uuid;
BEGIN
  IF TG_OP='UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id
    AND EXISTS(SELECT 1 FROM app_private.hermes_zalo_bots WHERE account_id=OLD.account_id)
  THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
  v_account:=NEW.account_id;
  IF TG_TABLE_NAME='zalo_messages' THEN
    -- The nullable message account_id is not authority: resolve its parent.
    -- KEY SHARE protects parent keys/deletion while allowing legacy preview
    -- UPDATEs; SHARE creates a lock cycle with concurrent dedup INSERTs.
    SELECT * INTO c FROM public.zalo_conversations WHERE id=NEW.conversation_id FOR KEY SHARE;
    v_account:=c.account_id;
    IF TG_OP='UPDATE' AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
      SELECT account_id INTO v_old_account FROM public.zalo_conversations WHERE id=OLD.conversation_id;
      IF EXISTS(SELECT 1 FROM app_private.hermes_zalo_bots WHERE account_id=v_old_account)
      THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=v_account FOR SHARE;
  v_private:=EXISTS(SELECT 1 FROM app_private.hermes_zalo_bots WHERE account_id IN (a.id,NEW.account_id));
  IF NOT v_private THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='zalo_messages' THEN
    -- The account lock may have waited for first enable. Refresh non-key
    -- classification now that the retained bot's identity cannot change.
    SELECT * INTO c FROM public.zalo_conversations WHERE id=NEW.conversation_id FOR KEY SHARE;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM a.organization_id THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='zalo_conversations' THEN
    IF TG_OP='UPDATE' AND
      (NEW.thread_type IS DISTINCT FROM OLD.thread_type OR NEW.thread_id IS DISTINCT FROM OLD.thread_id)
    THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
    IF NEW.thread_type='group' THEN RETURN NEW; END IF;
    NEW.last_message_text:='[Hermes private - hidden]';
    NEW.unread_count:=0;
    RETURN NEW;
  END IF;
  IF c.id IS NULL OR NEW.account_id IS DISTINCT FROM a.id OR c.account_id IS DISTINCT FROM a.id OR c.organization_id IS DISTINCT FROM a.organization_id
  THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
  THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
  IF c.thread_type='group' THEN RETURN NEW; END IF;
  -- Only the redacted identity row needed for linking belongs in this table.
  -- Rebuild raw identity instead of trusting captions/quotes/metadata from any
  -- legacy caller. Normal private messages must use the private runtime path.
  IF NEW.body IS DISTINCT FROM '[Hermes link - hidden]' OR NEW.msg_type IS DISTINCT FROM 'text'
    OR NEW.zalo_raw->>'uidFrom' IS NULL OR NEW.zalo_raw->>'uidFrom' !~ '^[1-9][0-9]{0,39}$'
    OR NEW.zalo_raw->>'idTo' IS NULL OR NEW.zalo_raw->>'idTo' !~ '^[1-9][0-9]{0,39}$'
  THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;
  NEW.zalo_raw:=jsonb_build_object('uidFrom',NEW.zalo_raw->>'uidFrom','idTo',NEW.zalo_raw->>'idTo',
    'msgType','webchat','content','[Hermes link - hidden]');
  NEW.media_url:=NULL; NEW.media_label:=NULL; NEW.media_meta:=NULL; NEW.media_tone:=NULL;
  NEW.reply_to:=NULL; NEW.reaction_emoji:=NULL; NEW.reactions:='{}'::jsonb;
  RETURN NEW;
END $$;
ALTER FUNCTION app_private.hermes_zalo_shared_inbox_guard_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_shared_inbox_guard_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
DROP TRIGGER IF EXISTS hermes_zalo_private_conversation_guard ON public.zalo_conversations;
CREATE TRIGGER hermes_zalo_private_conversation_guard BEFORE INSERT OR UPDATE ON public.zalo_conversations
FOR EACH ROW EXECUTE FUNCTION app_private.hermes_zalo_shared_inbox_guard_v1();
DROP TRIGGER IF EXISTS hermes_zalo_private_message_guard ON public.zalo_messages;
CREATE TRIGGER hermes_zalo_private_message_guard BEFORE INSERT OR UPDATE ON public.zalo_messages
FOR EACH ROW EXECUTE FUNCTION app_private.hermes_zalo_shared_inbox_guard_v1();

-- Same lock order as connection mutations: session -> connection -> policy.
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
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org AND enabled FOR SHARE;
  IF NOT FOUND OR c.state<>'ACTIVE' OR c.epoch IS DISTINCT FROM p_epoch OR s.state<>'ACTIVE' OR s.expires_at<=clock_timestamp()
    OR s.id IS NULL OR s.id IS DISTINCT FROM c.credential_ref
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=c.assistant_id AND a.state='ACTIVE' AND a.user_id=p_user AND a.organization_id=p_org)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  RETURN c;
END $$;

-- Fixed browser operations. The caller JWT owns the selected user/org; no userId
-- argument and no superadmin bypass of company membership or bot organization.
CREATE OR REPLACE FUNCTION public.hermes_zalo_binding_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE op text:=p->>'operation'; u uuid:=auth.uid(); o uuid;
  c app_private.hermes_connections; b app_private.hermes_zalo_bots;
  h app_private.hermes_zalo_link_challenges; x app_private.hermes_zalo_bindings;
  v_secret text; v_now timestamptz; v_account uuid; v_id uuid; v_epoch bigint; v_after uuid; v_result jsonb; v_can_enable boolean;
BEGIN
  IF op='setBot' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','accountId','expectedVersion','enabled']);
  ELSIF op='begin' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','connectionId','expectedConnectionEpoch','accountId']);
  ELSIF op='status' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','challengeId']);
  ELSIF op='confirm' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','challengeId','expectedCandidateVersion','expectedSenderUid']);
  ELSIF op='unlink' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','bindingId','expectedEpoch']);
  ELSIF op='list' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','afterBindingId']);
  ELSIF op='bots' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','afterAccountId']);
  ELSIF op='manageBots' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','organizationId','afterAccountId']);
  ELSE RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
  o:=app_private.hermes_uuid_v1(p->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(o);
  PERFORM app_private.hermes_member_v1(u,o);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
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
  ELSIF op='begin' THEN
    c:=app_private.hermes_zalo_context_v1(app_private.hermes_uuid_v1(p->'connectionId'),u,o,app_private.hermes_integer_v1(p->'expectedConnectionEpoch'));
    v_account:=app_private.hermes_uuid_v1(p->'accountId');
    SELECT * INTO b FROM app_private.hermes_zalo_bots WHERE account_id=v_account AND organization_id=o AND enabled FOR SHARE;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.zalo_accounts a WHERE a.id=v_account AND a.organization_id=o AND a.kind='personal' AND a.status='connected' AND a.zalo_uid ~ '^[1-9][0-9]{0,39}$') THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
    UPDATE app_private.hermes_zalo_link_challenges SET state='REVOKED' WHERE user_id=u AND organization_id=o AND state IN ('WAITING','OBSERVED');
    v_secret:='hz_'||encode(extensions.gen_random_bytes(32),'hex'); v_now:=clock_timestamp();
    INSERT INTO app_private.hermes_zalo_link_challenges(user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,challenge_digest,created_at,expires_at)
    VALUES(u,o,c.assistant_id,c.id,c.epoch,b.account_id,b.version,encode(extensions.digest(v_secret,'sha256'),'hex'),v_now,v_now+interval '5 minutes') RETURNING * INTO h;
    v_result:=jsonb_build_object('status','waiting','challengeId',h.id,'challenge',v_secret,'accountId',h.account_id,'connectionId',h.connection_id,'expiresAt',floor(extract(epoch FROM h.expires_at)*1000)::bigint);
  ELSIF op IN ('status','confirm') THEN
    v_id:=app_private.hermes_uuid_v1(p->'challengeId');
    SELECT * INTO h FROM app_private.hermes_zalo_link_challenges WHERE id=v_id AND user_id=u AND organization_id=o;
    IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
    c:=app_private.hermes_zalo_context_v1(h.connection_id,u,o,h.connection_epoch);
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
      INSERT INTO app_private.hermes_zalo_bindings(user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,sender_uid,conversation_id,challenge_id)
      VALUES(u,o,c.assistant_id,c.id,c.epoch,h.account_id,h.bot_version,h.sender_uid,h.conversation_id,h.id) RETURNING * INTO x;
      UPDATE app_private.hermes_zalo_link_challenges SET state='CONFIRMED' WHERE id=h.id;
      v_result:=jsonb_build_object('status','active','bindingId',x.id,'epoch',x.epoch,'accountId',x.account_id,'connectionId',x.connection_id,'senderUid',x.sender_uid);
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
      'accountId',z.account_id,'connectionId',z.connection_id,'senderUid',z.sender_uid) ORDER BY z.id),'[]'::jsonb),
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

-- Only the EXISTING trusted worker's service-role credential may call ingress.
-- Lease instance is not an authentication secret; role grants are the boundary.
CREATE OR REPLACE FUNCTION public.hermes_zalo_ingress_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE op text:=p->>'operation'; a public.zalo_accounts; i app_private.hermes_zalo_ingress_sessions;
  h app_private.hermes_zalo_link_challenges; m public.zalo_messages; c public.zalo_conversations;
  v_account uuid; v_org uuid; v_instance uuid; v_generation uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  IF op='register' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','accountId','organizationId','instanceId','accountOwnerId','ownUid','loginRequestedAt']);
  ELSIF op='privacy' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','accountId','organizationId','instanceId','accountOwnerId','ownUid','loginRequestedAt']);
  ELSIF op='observe' THEN PERFORM app_private.hermes_request_v1(p,ARRAY['operation','accountId','organizationId','instanceId','generation','senderUid','providerMessageId','challengeDigest']);
  ELSE RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
  v_account:=app_private.hermes_uuid_v1(p->'accountId');v_org:=app_private.hermes_uuid_v1(p->'organizationId');v_instance:=app_private.hermes_uuid_v1(p->'instanceId');
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=v_instance AND heartbeat_at>clock_timestamp()-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_lease_lost' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=v_account AND organization_id=v_org AND kind='personal' AND status='connected' FOR SHARE;
  IF NOT FOUND OR a.zalo_uid IS NULL OR a.zalo_uid !~ '^[1-9][0-9]{0,39}$' THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  IF op='privacy' THEN
    IF a.user_id IS DISTINCT FROM app_private.hermes_uuid_v1(p->'accountOwnerId') OR a.zalo_uid IS DISTINCT FROM p->>'ownUid'
      OR a.login_requested_at IS DISTINCT FROM (p->>'loginRequestedAt')::timestamptz THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('status',CASE WHEN EXISTS(SELECT 1 FROM app_private.hermes_zalo_bots WHERE account_id=a.id)
      THEN 'private' ELSE 'shared' END,'accountId',a.id,'organizationId',a.organization_id);
  END IF;
  PERFORM 1 FROM app_private.hermes_zalo_bots WHERE account_id=a.id AND organization_id=v_org AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  IF op='register' THEN
    IF a.user_id IS DISTINCT FROM app_private.hermes_uuid_v1(p->'accountOwnerId') OR a.zalo_uid IS DISTINCT FROM p->>'ownUid'
      OR a.login_requested_at IS DISTINCT FROM (p->>'loginRequestedAt')::timestamptz THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
    INSERT INTO app_private.hermes_zalo_ingress_sessions(account_id,organization_id,account_owner_id,instance_id,own_uid,login_requested_at)
    VALUES(a.id,v_org,a.user_id,v_instance,a.zalo_uid,a.login_requested_at)
    ON CONFLICT(account_id) DO UPDATE SET organization_id=v_org,account_owner_id=a.user_id,instance_id=v_instance,generation=gen_random_uuid(),own_uid=a.zalo_uid,login_requested_at=a.login_requested_at,registered_at=clock_timestamp() RETURNING * INTO i;
    RETURN jsonb_build_object('status','registered','accountId',i.account_id,'organizationId',i.organization_id,'generation',i.generation);
  END IF;
  v_generation:=app_private.hermes_uuid_v1(p->'generation');
  SELECT * INTO i FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id AND organization_id=v_org AND instance_id=v_instance AND generation=v_generation FOR SHARE;
  IF NOT FOUND OR i.account_owner_id<>a.user_id OR i.own_uid<>a.zalo_uid OR i.login_requested_at IS DISTINCT FROM a.login_requested_at THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  IF jsonb_typeof(p->'senderUid')<>'string' OR (p->>'senderUid') !~ '^[1-9][0-9]{0,39}$' OR p->>'senderUid'=i.own_uid
    OR jsonb_typeof(p->'challengeDigest')<>'string' OR (p->>'challengeDigest') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'providerMessageId')<>'string' OR (p->>'providerMessageId') !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'hermes_zalo_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM public.zalo_messages WHERE account_id=a.id AND organization_id=v_org AND zalo_msg_id=p->>'providerMessageId' AND direction='in' AND msg_type='text';
  SELECT * INTO c FROM public.zalo_conversations WHERE id=m.conversation_id AND account_id=a.id AND organization_id=v_org AND thread_type='user';
  IF m.id IS NULL OR c.id IS NULL OR c.thread_id IS DISTINCT FROM p->>'senderUid' OR c.peer_zalo_uid IS DISTINCT FROM p->>'senderUid'
    OR m.zalo_raw->>'uidFrom' IS DISTINCT FROM p->>'senderUid' OR m.zalo_raw->>'idTo' IS DISTINCT FROM i.own_uid OR m.zalo_raw->>'msgType' IS DISTINCT FROM 'webchat'
  THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO h FROM app_private.hermes_zalo_link_challenges WHERE challenge_digest=p->>'challengeDigest' AND account_id=a.id AND organization_id=v_org FOR UPDATE;
  IF NOT FOUND OR h.state<>'WAITING' OR h.expires_at<=clock_timestamp() OR m.created_at<h.created_at OR m.created_at<i.registered_at
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_zalo_bots b WHERE b.account_id=a.id AND b.enabled AND b.version=h.bot_version)
  THEN RAISE EXCEPTION 'hermes_zalo_context_changed' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.hermes_member_v1(h.user_id,v_org);
  UPDATE app_private.hermes_zalo_link_challenges SET state='OBSERVED',candidate_version=1,sender_uid=p->>'senderUid',conversation_id=c.id,message_id=m.id,ingress_generation=i.generation WHERE id=h.id;
  RETURN jsonb_build_object('status','observed');
END $$;

ALTER FUNCTION app_private.hermes_zalo_context_v1(uuid,uuid,uuid,bigint) OWNER TO postgres;
ALTER FUNCTION public.hermes_zalo_binding_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_zalo_ingress_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_context_v1(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_zalo_binding_v1(jsonb),public.hermes_zalo_ingress_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_binding_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_ingress_v1(jsonb) TO service_role;
COMMIT;
