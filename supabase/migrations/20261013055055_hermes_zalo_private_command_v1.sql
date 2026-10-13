-- P4 private command intake only. QUEUED is not execution or a provider reply.
-- No runtime/LLM credential, fabricated caller JWT, or shared inbox writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app_private.hermes_zalo_bindings ADD COLUMN IF NOT EXISTS activated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_private_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bindings(id),
  binding_epoch bigint NOT NULL CHECK(binding_epoch>0),
  account_id uuid NOT NULL REFERENCES public.zalo_accounts(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  assistant_id uuid NOT NULL REFERENCES app_private.hermes_assistants(id),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  connection_epoch bigint NOT NULL CHECK(connection_epoch>0),
  ingress_generation uuid NOT NULL,
  sender_uid text NOT NULL CHECK(sender_uid ~ '^[1-9][0-9]{0,39}$'),
  provider_message_id text NOT NULL CHECK(provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  sent_at_ms bigint NOT NULL CHECK(sent_at_ms>0 AND sent_at_ms<9007199254740991),
  body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 8192),
  accepted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','EXPIRED')),
  UNIQUE(account_id,provider_message_id),
  CHECK(expires_at>accepted_at AND expires_at<=accepted_at+interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS hermes_zalo_private_pending
  ON app_private.hermes_zalo_private_commands(account_id,expires_at) WHERE state='QUEUED';
ALTER TABLE app_private.hermes_zalo_private_commands OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_private_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_zalo_private_commands FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

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
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=v_org AND enabled FOR SHARE;
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
ALTER FUNCTION public.hermes_zalo_private_command_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_private_command_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_private_command_v1(jsonb) TO service_role;
COMMIT;
