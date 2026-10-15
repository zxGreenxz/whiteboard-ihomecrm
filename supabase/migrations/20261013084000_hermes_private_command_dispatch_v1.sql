-- Trusted backend consumer for the private ledger. No public RPC, provider send
-- or implicit replay. Only a definite first dispatch ACK permits a runtime call.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app_private.hermes_zalo_private_commands
  ADD COLUMN IF NOT EXISTS claim_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_body text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ALTER COLUMN body DROP NOT NULL;
ALTER TABLE app_private.hermes_zalo_private_commands DROP CONSTRAINT IF EXISTS hermes_zalo_private_commands_state_check;
ALTER TABLE app_private.hermes_zalo_private_commands ADD CONSTRAINT hermes_zalo_private_commands_state_check
  CHECK(state IN ('QUEUED','CLAIMED','DISPATCHED','READY','EXPIRED','FAILED','UNKNOWN_EFFECT'));
ALTER TABLE app_private.hermes_zalo_private_commands DROP CONSTRAINT IF EXISTS hermes_private_command_content_check;
ALTER TABLE app_private.hermes_zalo_private_commands ADD CONSTRAINT hermes_private_command_content_check CHECK(
  (state NOT IN ('QUEUED','CLAIMED','DISPATCHED','READY') OR body IS NOT NULL)
  AND (state NOT IN ('CLAIMED','DISPATCHED','READY') OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL))
  AND (state NOT IN ('DISPATCHED','READY') OR dispatched_at IS NOT NULL)
  AND (reply_body IS NULL OR octet_length(reply_body) BETWEEN 1 AND 32768)
  AND (state<>'READY' OR reply_body IS NOT NULL)
  AND (state NOT IN ('EXPIRED','FAILED','UNKNOWN_EFFECT') OR (body IS NULL AND reply_body IS NULL))
  AND (failure_code IS NULL OR failure_code IN ('runtime_failed','runtime_cancelled','runtime_unknown','expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_private_command_claim ON app_private.hermes_zalo_private_commands(claim_id) WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hermes_private_command_one_running ON app_private.hermes_zalo_private_commands(connection_id) WHERE state IN ('CLAIMED','DISPATCHED');
CREATE INDEX IF NOT EXISTS hermes_private_command_expiry ON app_private.hermes_zalo_private_commands(expires_at) WHERE state IN ('QUEUED','CLAIMED','DISPATCHED','READY');

-- No grants on helpers. Every exported operation derives its connection from
-- the actual opaque-token digest, locks current authority, and returns no token.
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
  SELECT * INTO policy FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
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

-- Follow intake's lock order: context, worker lease, account, bot, ingress,
-- binding, then the command row. Pruning locks only command rows.
CREATE OR REPLACE FUNCTION app_private.hermes_private_command_lock_v1(c app_private.hermes_connections,p_id uuid,p_digest text)
RETURNS app_private.hermes_zalo_private_commands LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE q app_private.hermes_zalo_private_commands; x app_private.hermes_zalo_bindings;
  a public.zalo_accounts; i app_private.hermes_zalo_ingress_sessions; v_instance uuid; v_now timestamptz;
BEGIN
  SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE id=p_id AND connection_id=c.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  SELECT instance_id INTO v_instance FROM public.zalo_worker_lease WHERE id='singleton'
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=q.account_id AND organization_id=c.organization_id
    AND kind='personal' AND status='connected' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=q.binding_id;
  PERFORM 1 FROM app_private.hermes_zalo_bots WHERE account_id=a.id AND organization_id=c.organization_id AND enabled AND version=x.bot_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO i FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id AND organization_id=c.organization_id AND instance_id=v_instance FOR SHARE;
  IF NOT FOUND OR i.account_owner_id IS DISTINCT FROM a.user_id OR i.own_uid IS DISTINCT FROM a.zalo_uid
    OR i.login_requested_at IS DISTINCT FROM a.login_requested_at
  THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=q.binding_id FOR SHARE;
  SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE id=p_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF q.id IS NULL OR x.id IS NULL OR q.connection_id<>c.id OR q.connection_epoch<>c.epoch
    OR q.user_id<>c.user_id OR q.assistant_id<>c.assistant_id OR q.organization_id<>c.organization_id
    OR x.state<>'ACTIVE' OR x.epoch<>q.binding_epoch OR x.connection_epoch<>c.epoch OR x.connection_id<>c.id
    OR x.user_id<>c.user_id OR x.assistant_id<>c.assistant_id OR x.organization_id<>c.organization_id
    OR x.account_id<>a.id OR x.sender_uid<>q.sender_uid OR x.sender_uid=i.own_uid
    OR q.expires_at<=v_now
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens WHERE token_digest=p_digest AND connection_id=c.id AND revoked_at IS NULL AND expires_at>v_now AND created_at+interval '30 days'>v_now)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref AND state='ACTIVE' AND expires_at>v_now)
  THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  RETURN q;
END $$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_claim_private_command_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; q app_private.hermes_zalo_private_commands; v_claim uuid; v_id uuid; v_exp timestamptz;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest','claimId']);
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  v_claim:=app_private.hermes_uuid_v1(p->'claimId'); c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE claim_id=v_claim;
  IF FOUND THEN
    IF q.connection_id<>c.id THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
    v_id:=q.id;
  ELSE
    IF EXISTS(SELECT 1 FROM app_private.hermes_zalo_private_commands WHERE connection_id=c.id AND state IN ('CLAIMED','DISPATCHED'))
      THEN RETURN jsonb_build_object('status','empty'); END IF;
    -- Skip an obsolete channel/binding instead of letting an old queued row
    -- block a newly linked channel. This unlocked filter grants no authority:
    -- lock_v1 still locks and rechecks the selected row before exposing text.
    SELECT pending.id INTO v_id FROM app_private.hermes_zalo_private_commands pending
      JOIN app_private.hermes_zalo_bindings binding ON binding.id=pending.binding_id
      JOIN app_private.hermes_zalo_bots bot ON bot.account_id=binding.account_id
      JOIN public.zalo_accounts account ON account.id=bot.account_id
      JOIN app_private.hermes_zalo_ingress_sessions ingress ON ingress.account_id=account.id
      JOIN public.zalo_worker_lease lease ON lease.id='singleton' AND lease.instance_id=ingress.instance_id
      WHERE pending.connection_id=c.id AND pending.connection_epoch=c.epoch AND pending.state='QUEUED' AND pending.expires_at>clock_timestamp()
        AND pending.user_id=c.user_id AND pending.assistant_id=c.assistant_id AND pending.organization_id=c.organization_id
        AND binding.state='ACTIVE' AND binding.epoch=pending.binding_epoch AND binding.connection_epoch=c.epoch AND binding.connection_id=c.id
        AND binding.user_id=c.user_id AND binding.assistant_id=c.assistant_id AND binding.organization_id=c.organization_id
        AND binding.account_id=pending.account_id AND binding.sender_uid=pending.sender_uid AND binding.sender_uid<>ingress.own_uid
        AND bot.enabled AND bot.version=binding.bot_version AND bot.organization_id=c.organization_id
        AND account.kind='personal' AND account.status='connected' AND account.organization_id=c.organization_id
        AND ingress.organization_id=c.organization_id AND ingress.account_owner_id=account.user_id AND ingress.own_uid=account.zalo_uid
        AND ingress.login_requested_at IS NOT DISTINCT FROM account.login_requested_at AND lease.heartbeat_at>clock_timestamp()-interval '30 seconds'
      ORDER BY pending.accepted_at,pending.id LIMIT 1;
    IF v_id IS NULL THEN RETURN jsonb_build_object('status','empty'); END IF;
  END IF;
  q:=app_private.hermes_private_command_lock_v1(c,v_id,p->>'tokenDigest');
  IF q.state='QUEUED' AND q.claim_id IS NULL THEN
    UPDATE app_private.hermes_zalo_private_commands SET state='CLAIMED',claim_id=v_claim,claimed_at=clock_timestamp() WHERE id=q.id RETURNING * INTO q;
  ELSIF q.state<>'CLAIMED' OR q.claim_id IS DISTINCT FROM v_claim THEN
    RAISE EXCEPTION 'hermes_command_conflict' USING ERRCODE='40001';
  END IF;
  SELECT LEAST(q.expires_at,t.expires_at,s.expires_at,t.created_at+interval '30 days') INTO v_exp
    FROM app_private.hermes_connection_tokens t JOIN app_private.hermes_sessions s ON s.id=c.credential_ref WHERE t.token_digest=p->>'tokenDigest';
  RETURN jsonb_build_object('status','claimed','claimId',q.claim_id,'command',jsonb_build_object(
    'commandId',q.id,'connectionId',c.id,'assistantId',c.assistant_id,'userId',c.user_id,'organizationId',c.organization_id,
    'bindingId',q.binding_id,'bindingEpoch',q.binding_epoch,'text',q.body,'expiresAt',floor(extract(epoch FROM v_exp)*1000)::bigint));
END $$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_dispatch_private_command_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; q app_private.hermes_zalo_private_commands; v_claim uuid; v_id uuid; v_status text;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest','claimId']);
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  v_claim:=app_private.hermes_uuid_v1(p->'claimId'); c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT id INTO v_id FROM app_private.hermes_zalo_private_commands WHERE claim_id=v_claim AND connection_id=c.id;
  q:=app_private.hermes_private_command_lock_v1(c,v_id,p->>'tokenDigest');
  IF q.state='DISPATCHED' THEN v_status:='already_dispatched';
  ELSIF q.state='CLAIMED' THEN
    UPDATE app_private.hermes_zalo_private_commands SET state='DISPATCHED',dispatched_at=clock_timestamp() WHERE id=q.id;
    v_status:='dispatched';
  ELSE RAISE EXCEPTION 'hermes_command_conflict' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('status',v_status,'commandId',q.id,'claimId',q.claim_id);
END $$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_finish_private_command_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; q app_private.hermes_zalo_private_commands; v_claim uuid; v_id uuid; v_status text;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest','claimId','text']);
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'text') IS DISTINCT FROM 'string'
    OR octet_length(p->>'text') NOT BETWEEN 1 AND 32768 THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  v_claim:=app_private.hermes_uuid_v1(p->'claimId'); c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT id INTO v_id FROM app_private.hermes_zalo_private_commands WHERE claim_id=v_claim AND connection_id=c.id;
  q:=app_private.hermes_private_command_lock_v1(c,v_id,p->>'tokenDigest');
  IF q.state='READY' AND q.reply_body IS NOT DISTINCT FROM p->>'text' THEN v_status:='already_ready';
  ELSIF q.state='DISPATCHED' THEN
    UPDATE app_private.hermes_zalo_private_commands SET state='READY',reply_body=p->>'text',completed_at=clock_timestamp() WHERE id=q.id;
    v_status:='ready';
  ELSE RAISE EXCEPTION 'hermes_command_conflict' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('status',v_status,'commandId',q.id,'claimId',q.claim_id);
END $$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_fail_private_command_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; q app_private.hermes_zalo_private_commands; v_claim uuid; v_id uuid; v_state text;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest','claimId','reason']);
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string'
    OR p->>'reason' NOT IN ('runtime_failed','runtime_cancelled','runtime_unknown') THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  v_claim:=app_private.hermes_uuid_v1(p->'claimId'); c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT id INTO v_id FROM app_private.hermes_zalo_private_commands WHERE claim_id=v_claim AND connection_id=c.id;
  q:=app_private.hermes_private_command_lock_v1(c,v_id,p->>'tokenDigest');
  IF q.state IN ('FAILED','UNKNOWN_EFFECT') AND q.failure_code=p->>'reason' THEN v_state:=q.state;
  ELSIF q.state IN ('CLAIMED','DISPATCHED') THEN
    v_state:=CASE WHEN q.state='DISPATCHED' OR p->>'reason'='runtime_unknown' THEN 'UNKNOWN_EFFECT' ELSE 'FAILED' END;
    UPDATE app_private.hermes_zalo_private_commands SET state=v_state,body=NULL,reply_body=NULL,failure_code=p->>'reason',completed_at=clock_timestamp() WHERE id=q.id;
  ELSE RAISE EXCEPTION 'hermes_command_conflict' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('status',CASE WHEN v_state='FAILED' THEN 'failed' ELSE 'unknown' END,'commandId',q.id,'claimId',q.claim_id);
END $$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_prune_private_commands_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_limit bigint; v_count integer; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['limit']); v_limit:=app_private.hermes_integer_v1(p->'limit');
  IF v_limit>256 THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  WITH picked AS (SELECT id FROM app_private.hermes_zalo_private_commands WHERE expires_at<=v_now
    AND state IN ('QUEUED','CLAIMED','DISPATCHED','READY') ORDER BY expires_at,id LIMIT v_limit FOR UPDATE SKIP LOCKED)
  UPDATE app_private.hermes_zalo_private_commands q SET
    state=CASE WHEN q.state='DISPATCHED' THEN 'UNKNOWN_EFFECT' ELSE 'EXPIRED' END,
    body=NULL,reply_body=NULL,completed_at=v_now,failure_code='expired'
    FROM picked WHERE q.id=picked.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('status','pruned','count',v_count);
END $$;

ALTER FUNCTION app_private.hermes_private_command_connection_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_private_command_lock_v1(app_private.hermes_connections,uuid,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_claim_private_command_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_dispatch_private_command_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_finish_private_command_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_fail_private_command_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_prune_private_commands_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_private_command_connection_v1(text),app_private.hermes_private_command_lock_v1(app_private.hermes_connections,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_store_claim_private_command_v1(jsonb),app_private.hermes_store_dispatch_private_command_v1(jsonb),
  app_private.hermes_store_finish_private_command_v1(jsonb),app_private.hermes_store_fail_private_command_v1(jsonb),app_private.hermes_store_prune_private_commands_v1(jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_claim_private_command_v1(jsonb),app_private.hermes_store_dispatch_private_command_v1(jsonb),
  app_private.hermes_store_finish_private_command_v1(jsonb),app_private.hermes_store_fail_private_command_v1(jsonb),app_private.hermes_store_prune_private_commands_v1(jsonb)
  TO hermes_store_executor;
COMMIT;
