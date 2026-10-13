-- Private outbound through the existing Zalo worker. The worker supplies only
-- its pinned session, never a recipient, user, connection, or message body.
-- A first definite dispatch ACK admits one send; no unknown effect is replayed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app_private.hermes_zalo_private_commands
  ADD COLUMN IF NOT EXISTS authorization_version bigint CHECK(authorization_version>0),
  ADD COLUMN IF NOT EXISTS authorization_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_id uuid,
  ADD COLUMN IF NOT EXISTS reply_instance_id uuid,
  ADD COLUMN IF NOT EXISTS reply_generation uuid,
  ADD COLUMN IF NOT EXISTS reply_account_owner_id uuid,
  ADD COLUMN IF NOT EXISTS reply_own_uid text,
  ADD COLUMN IF NOT EXISTS reply_login_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_provider_message_id text,
  ADD COLUMN IF NOT EXISTS reply_outcome text,
  ADD COLUMN IF NOT EXISTS reply_ack_at timestamptz;
ALTER TABLE app_private.hermes_zalo_private_commands DROP CONSTRAINT IF EXISTS hermes_zalo_private_commands_state_check;
ALTER TABLE app_private.hermes_zalo_private_commands ADD CONSTRAINT hermes_zalo_private_commands_state_check
  CHECK(state IN ('QUEUED','CLAIMED','DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED','SENT','EXPIRED','FAILED','UNKNOWN_EFFECT'));
ALTER TABLE app_private.hermes_zalo_private_commands DROP CONSTRAINT IF EXISTS hermes_private_command_content_check;
ALTER TABLE app_private.hermes_zalo_private_commands ADD CONSTRAINT hermes_private_command_content_check CHECK(
  (state NOT IN ('QUEUED','CLAIMED','DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED') OR body IS NOT NULL)
  AND (state NOT IN ('CLAIMED','DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED','SENT') OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL))
  AND (state NOT IN ('DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED','SENT') OR dispatched_at IS NOT NULL)
  AND (reply_body IS NULL OR octet_length(reply_body) BETWEEN 1 AND 32768)
  AND (state NOT IN ('READY','REPLY_CLAIMED','REPLY_DISPATCHED') OR reply_body IS NOT NULL)
  AND (state NOT IN ('SENT','EXPIRED','FAILED','UNKNOWN_EFFECT') OR (body IS NULL AND reply_body IS NULL))
  AND (failure_code IS NULL OR failure_code IN ('runtime_failed','runtime_cancelled','runtime_unknown','expired'))
);
ALTER TABLE app_private.hermes_zalo_private_commands DROP CONSTRAINT IF EXISTS hermes_private_reply_content_check;
ALTER TABLE app_private.hermes_zalo_private_commands ADD CONSTRAINT hermes_private_reply_content_check CHECK(
  (state NOT IN ('REPLY_CLAIMED','REPLY_DISPATCHED','SENT') OR delivery_id IS NOT NULL)
  AND (delivery_id IS NULL OR (reply_instance_id IS NOT NULL AND reply_generation IS NOT NULL
    AND reply_account_owner_id IS NOT NULL AND reply_own_uid IS NOT NULL AND reply_own_uid ~ '^[1-9][0-9]{0,39}$' AND reply_claimed_at IS NOT NULL))
  AND (state NOT IN ('REPLY_DISPATCHED','SENT') OR reply_dispatched_at IS NOT NULL)
  AND ((reply_outcome IS NULL AND reply_ack_at IS NULL AND reply_provider_message_id IS NULL)
    OR (delivery_id IS NOT NULL AND reply_ack_at IS NOT NULL AND reply_outcome IS NOT NULL AND (
      (reply_outcome='sent' AND state='SENT' AND reply_dispatched_at IS NOT NULL
        AND reply_provider_message_id IS NOT NULL AND reply_provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$')
      OR (reply_outcome='unknown' AND state='UNKNOWN_EFFECT' AND reply_provider_message_id IS NULL)
      OR (reply_outcome='cancelled' AND state='FAILED' AND reply_dispatched_at IS NULL AND reply_provider_message_id IS NULL))))
  AND (state<>'SENT' OR reply_outcome IS NOT DISTINCT FROM 'sent')
);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_private_reply_delivery ON app_private.hermes_zalo_private_commands(delivery_id) WHERE delivery_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hermes_private_reply_one_running ON app_private.hermes_zalo_private_commands(account_id) WHERE state IN ('REPLY_CLAIMED','REPLY_DISPATCHED');
CREATE INDEX IF NOT EXISTS hermes_private_reply_ready ON app_private.hermes_zalo_private_commands(account_id,accepted_at,id) WHERE state='READY';
DROP INDEX IF EXISTS app_private.hermes_private_command_expiry;
CREATE INDEX hermes_private_command_expiry ON app_private.hermes_zalo_private_commands(expires_at)
  WHERE state IN ('QUEUED','CLAIMED','DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED');

-- Capture the CRM permission revision when admitting runtime, before generating
-- a reply. QUEUED/CLAIMED contain only the user's input and may use fresh rights.
-- Old rows without a capture stay undeliverable. CRM permission mutations bump
-- this revision under the same organization decision lock used by the callers.
-- The trigger itself takes no org lock after a row lock (prune/ack lock rows
-- only). A terminal receipt can still clear content after authority changed.
CREATE OR REPLACE FUNCTION app_private.hermes_private_command_authority_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_version bigint; v_now timestamptz;
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.authorization_version:=NULL;
    NEW.authorization_expires_at:=NULL;
  ELSIF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.authorization_version IS DISTINCT FROM OLD.authorization_version
    OR NEW.authorization_expires_at IS DISTINCT FROM OLD.authorization_expires_at THEN
    RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501';
  END IF;
  IF NEW.state IN ('DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED') THEN
    SELECT authorization_version INTO v_version FROM public.organizations WHERE id=NEW.organization_id AND status='ACTIVE';
    IF TG_OP='UPDATE' AND OLD.state='CLAIMED' AND NEW.state='DISPATCHED' AND OLD.authorization_version IS NULL THEN
      NEW.authorization_version:=v_version;
      v_now:=clock_timestamp();
      -- Time alone can change membership/role/override authority without a
      -- version bump. Conservatively expire at the next such boundary for this
      -- user, even if that boundary would only increase permissions.
      SELECT LEAST(NEW.expires_at,min(deadline)) INTO NEW.authorization_expires_at FROM (
        SELECT boundary.deadline FROM public.organization_memberships m
          CROSS JOIN LATERAL (VALUES(m.valid_from),(m.valid_to)) boundary(deadline)
          WHERE m.user_id=NEW.user_id AND m.status='ACTIVE' AND m.revoked_at IS NULL AND boundary.deadline>v_now
        UNION ALL
        SELECT boundary.deadline FROM public.role_bindings rb JOIN public.organization_memberships m ON m.id=rb.membership_id
          CROSS JOIN LATERAL (VALUES(rb.valid_from),(rb.valid_to)) boundary(deadline)
          WHERE m.user_id=NEW.user_id AND m.organization_id=NEW.organization_id AND rb.organization_id=NEW.organization_id AND boundary.deadline>v_now
        UNION ALL
        SELECT overrides.expires_at FROM public.member_permission_overrides overrides JOIN public.organization_memberships m ON m.id=overrides.membership_id
          WHERE m.user_id=NEW.user_id AND m.organization_id=NEW.organization_id AND overrides.organization_id=NEW.organization_id
            AND overrides.revoked_at IS NULL AND overrides.expires_at>v_now
      ) deadlines;
    END IF;
    IF v_version IS NULL OR NEW.authorization_version IS NULL OR NEW.authorization_version IS DISTINCT FROM v_version
      OR NEW.authorization_expires_at IS NULL OR NEW.authorization_expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hermes_private_command_authority ON app_private.hermes_zalo_private_commands;
CREATE TRIGGER hermes_private_command_authority BEFORE INSERT OR UPDATE ON app_private.hermes_zalo_private_commands
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_private_command_authority_guard_v1();

-- Internal only. Preserve the intake/dispatch lock order: org -> session ->
-- connection/token/policy -> worker -> account/bot/ingress -> binding -> row.
-- The current credential is derived inside the database, never from a worker.
CREATE OR REPLACE FUNCTION app_private.hermes_private_reply_lock_v1(p_id uuid,p_source jsonb)
RETURNS app_private.hermes_zalo_private_commands LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE q app_private.hermes_zalo_private_commands; c app_private.hermes_connections; v_digest text; v_now timestamptz;
BEGIN
  SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE id=p_id;
  IF q.id IS NULL OR q.account_id IS DISTINCT FROM (p_source->>'accountId')::uuid
    OR q.organization_id IS DISTINCT FROM (p_source->>'organizationId')::uuid
  THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  SELECT token_digest INTO v_digest FROM app_private.hermes_connection_tokens WHERE connection_id=q.connection_id AND revoked_at IS NULL;
  IF v_digest IS NULL THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  c:=app_private.hermes_private_command_connection_v1(v_digest);
  q:=app_private.hermes_private_command_lock_v1(c,p_id,v_digest);
  v_now:=clock_timestamp();
  IF q.authorization_version IS NULL OR q.authorization_expires_at IS NULL OR q.authorization_expires_at<=v_now
    OR NOT EXISTS(SELECT 1 FROM public.organizations
    WHERE id=q.organization_id AND authorization_version=q.authorization_version AND status='ACTIVE')
  THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts a
    JOIN app_private.hermes_zalo_ingress_sessions i ON i.account_id=a.id
    JOIN public.zalo_worker_lease l ON l.id='singleton' AND l.instance_id=i.instance_id
    WHERE a.id=q.account_id AND a.organization_id=q.organization_id AND a.kind='personal' AND a.status='connected'
      AND a.user_id=(p_source->>'accountOwnerId')::uuid AND a.zalo_uid=p_source->>'ownUid'
      AND a.login_requested_at IS NOT DISTINCT FROM (p_source->>'loginRequestedAt')::timestamptz
      AND i.organization_id=q.organization_id AND i.account_owner_id=a.user_id AND i.own_uid=a.zalo_uid
      AND i.login_requested_at IS NOT DISTINCT FROM a.login_requested_at
      AND i.instance_id=(p_source->>'instanceId')::uuid AND i.generation=(p_source->>'generation')::uuid
      AND l.heartbeat_at>v_now-interval '30 seconds')
  THEN RAISE EXCEPTION 'hermes_reply_denied' USING ERRCODE='42501'; END IF;
  RETURN q;
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
        JOIN app_private.hermes_org_policies policy ON policy.organization_id=c.organization_id
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

CREATE OR REPLACE FUNCTION app_private.hermes_store_prune_private_commands_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_limit bigint; v_count integer; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['limit']); v_limit:=app_private.hermes_integer_v1(p->'limit');
  IF v_limit>256 THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  WITH picked AS (SELECT id FROM app_private.hermes_zalo_private_commands WHERE expires_at<=v_now
    AND state IN ('QUEUED','CLAIMED','DISPATCHED','READY','REPLY_CLAIMED','REPLY_DISPATCHED') ORDER BY expires_at,id LIMIT v_limit FOR UPDATE SKIP LOCKED)
  UPDATE app_private.hermes_zalo_private_commands q SET
    state=CASE WHEN q.state IN ('DISPATCHED','REPLY_DISPATCHED') THEN 'UNKNOWN_EFFECT' ELSE 'EXPIRED' END,
    body=NULL,reply_body=NULL,completed_at=v_now,failure_code='expired'
    FROM picked WHERE q.id=picked.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('status','pruned','count',v_count);
END $$;

ALTER FUNCTION app_private.hermes_private_reply_lock_v1(uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_private_command_authority_guard_v1() OWNER TO postgres;
ALTER FUNCTION public.hermes_zalo_private_reply_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_prune_private_commands_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_private_reply_lock_v1(uuid,jsonb),app_private.hermes_private_command_authority_guard_v1(),public.hermes_zalo_private_reply_v1(jsonb),
  app_private.hermes_store_prune_private_commands_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_private_reply_v1(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_prune_private_commands_v1(jsonb) TO hermes_store_executor;
COMMIT;
