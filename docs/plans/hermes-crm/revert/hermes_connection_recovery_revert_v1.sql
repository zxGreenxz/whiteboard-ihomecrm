-- REVERT of 20261113131751_hermes_connection_recovery_v1.sql — prepared 13/11/2026 next to the forward file; NOT a migration
-- (docs/plans/hermes-crm/revert/). Puts the store renewal function back to the exact 20261019034754 body and takes EXECUTE on the
-- recovery function away from the store principal (the function stays; nothing can call it). Effect: a lapsed lease is final
-- again, so a connector outage longer than the lease costs the owner a new connection, and renewal is capped at created_at + 30
-- days once more. Token rows the forward body already re-anchored keep their created_at: their thirty days simply count from
-- that anchor, no connection dies at the moment of the revert. The connector must be rolled back to a release without the
-- recovery lane first (a newer connector calling a revoked function only logs a refused recovery and retries).
-- Body pin (md5 of prosrc, CR stripped): b8c1d2e9bab82eafbafd8d64261f3c14 = forward body ⇒ restore; ea9223f8d5d74f32e0185630a9727e60 = already the
-- 20261019034754 body ⇒ re-run, no change; any other body ⇒ stop (another file changed it since). Signature, return type, owner and
-- ACL of the renewal function unchanged; no DROP, no data change.
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_connection_recovery_revert_v1`
-- gives; add its provenance entry and reviewed pins like the forward file; TEST lane, then production. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_md5 FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('app_private.hermes_store_renew_connection_v1(jsonb)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('b8c1d2e9bab82eafbafd8d64261f3c14','ea9223f8d5d74f32e0185630a9727e60') THEN
    RAISE EXCEPTION 'hermes_connection_recovery_revert_body_drift: %',COALESCE(v_md5,'missing');
  END IF;
END $requires$;

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

ALTER FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) TO hermes_store_executor;
DO $revoke$ BEGIN
  IF to_regprocedure('app_private.hermes_store_recover_connection_v1(jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.hermes_store_recover_connection_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
  END IF;
END $revoke$;

DO $check$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_md5 FROM pg_catalog.pg_proc p
    WHERE p.oid='app_private.hermes_store_renew_connection_v1(jsonb)'::regprocedure;
  IF v_md5<>'ea9223f8d5d74f32e0185630a9727e60'
    OR NOT pg_catalog.has_function_privilege('hermes_store_executor','app_private.hermes_store_renew_connection_v1(jsonb)'::regprocedure,'EXECUTE')
    OR (to_regprocedure('app_private.hermes_store_recover_connection_v1(jsonb)') IS NOT NULL AND pg_catalog.has_function_privilege(
      'hermes_store_executor',to_regprocedure('app_private.hermes_store_recover_connection_v1(jsonb)'),'EXECUTE')) THEN
    RAISE EXCEPTION 'hermes_connection_recovery_revert_check_failed';
  END IF;
END $check$;

COMMIT;
