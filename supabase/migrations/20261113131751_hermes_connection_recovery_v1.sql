-- Kết nối Hermes tự hồi sau mất mạng, sống tới khi bị thu hồi (13/11/2026).
--
-- VẤN ĐỀ. Token kết nối là một hợp đồng thuê 15 phút do connector gia hạn. Hàm gia hạn của store từ chối token đã hết hạn và
-- chặn tuổi token ở 30 ngày, nên mỗi lần VPS mất đường tới database quá vài phút là kết nối chết hẳn và chủ phải tạo kết nối
-- mới (21/10, 31/10, 02/11, 11/11). Đo trên production 13/11: mọi kết nối chết đều do hạn token trôi qua trong khi phiên vẫn
-- ACTIVE, không cái nào bị quarantine. Cổng phiên (đòi một token còn hạn) cũng chặn luôn việc làm mới phiên sau đó.
--
-- LUẬT MỚI (chủ dự án chốt 13/11).
-- 1. Không còn trần 30 ngày: kết nối sống tới khi bị thu hồi. Khoảng mười lăm hàm khác vẫn so created_at + 30 ngày, nên hàm
--    gia hạn dời mốc created_at của token (cũ hơn 1 ngày thì đặt về 1 giờ trước) thay vì sửa từng hàm đó. Từ đây created_at
--    của token là đầu cửa sổ tuổi hiện tại, không phải lúc phát hành; lúc phát hành xem ở hermes_connections.created_at.
-- 2. Thêm một hàm hồi chỉ vai store gọi được. Token hết hạn chưa quá 7 ngày, kết nối chưa thu hồi, phiên còn nguyên
--    (ACTIVE hoặc RESERVED, không quarantine), thành viên, chính sách công ty và giới hạn còn hiệu lực thì token được sống
--    lại 5 phút, đủ cho connector làm mới phiên rồi quay về vòng gia hạn 15 phút như cũ. Im quá 7 ngày thì hết hồi: đo trên
--    cả hạn token lẫn hạn phiên, vì hạn phiên chỉ tiến khi làm mới phiên thành công còn mỗi lần hồi lại dời hạn token.
--
-- VÌ SAO AN TOÀN. Không nới cổng phiên, không sửa hàm đọc hay ghi nào. Trong 5 phút hồi, token có thể sống khi phiên đã hết
-- hạn; mọi đường uỷ quyền đều đòi phiên ACTIVE còn hạn cạnh token còn hạn nên vẫn từ chối tới khi phiên được làm mới. Hàm
-- hồi không nhận thêm quyền nào so với hàm gia hạn: cùng thứ tự khoá (phiên, kết nối, token), cùng phép kiểm thành viên,
-- chính sách và giới hạn; nó không trả envelope. Thu hồi vẫn có hiệu lực ngay vì mọi đường đều kiểm revoked_at và state.
-- Một bản sao ổ đĩa connector bị bỏ quên không bật lại được sau 7 ngày.
--
-- PHẠM VI. Thay thân hàm gia hạn (hợp đồng vào/ra, chữ ký, DEFINER, VOLATILE, search_path, chủ và ACL giữ nguyên) và thêm
-- một hàm mới. Không đổi bảng, không đổi dữ liệu, không DROP. Ghim md5 thân đang chạy; lượt hai chấp nhận md5 thân mới.
-- Lùi: áp lại đúng thân gia hạn của 20261019034754 và REVOKE EXECUTE trên hàm hồi.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_md5 FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('app_private.hermes_store_renew_connection_v1(jsonb)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('ea9223f8d5d74f32e0185630a9727e60','b8c1d2e9bab82eafbafd8d64261f3c14')
    OR to_regclass('app_private.hermes_connection_tokens') IS NULL OR to_regclass('app_private.hermes_sessions') IS NULL
    OR to_regprocedure('app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])') IS NULL
    OR to_regprocedure('app_private.hermes_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_validate_limits_v1(uuid,text[],text[],uuid[])') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='hermes_store_executor') THEN
    RAISE EXCEPTION 'hermes_connection_recovery_requires: %',COALESCE(v_md5,'missing');
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
  -- past the session. expectedExpiresAt remains a CAS value only. There is no
  -- hard-age cap: a connection lives until it is revoked.
  v_target:=date_trunc('milliseconds',LEAST(v_now+v_ttl_ms*interval '1 millisecond',s.expires_at));
  IF t.created_at>v_now OR v_target<=v_now OR v_target<=t.expires_at THEN
    RAISE EXCEPTION 'hermes_renewal_expired_or_changed' USING ERRCODE='40001'; END IF;
  -- created_at is the start of the current age window, not the issue time. Other
  -- functions still test created_at+30 days, so once it is older than a day it
  -- moves to one hour ago: never the future, readers compare it with their own
  -- transaction time.
  UPDATE app_private.hermes_connection_tokens SET expires_at=v_target,
    created_at=CASE WHEN created_at<v_now-interval '1 day' THEN v_now-interval '1 hour' ELSE created_at END
    WHERE token_digest=t.token_digest;
  RETURN jsonb_build_object('ok',true,'status','renewed','expiresAt',floor(extract(epoch FROM v_target)*1000)::bigint);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_store_recover_connection_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE s app_private.hermes_sessions; c app_private.hermes_connections; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies;
  v_now timestamptz; v_ready boolean; v_status text; v_expires timestamptz;
  c_unavailable CONSTANT jsonb:=jsonb_build_object('status','unavailable');
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['tokenDigest']);
  IF jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' OR (p->>'tokenDigest') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'hermes_token_invalid' USING ERRCODE='22023'; END IF;
  -- Locate without locks, then take the renewal/refresh/revoke lock order
  -- (session, connection, token) and judge only the re-read rows.
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest';
  IF NOT FOUND THEN RETURN c_unavailable; END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id;
  IF NOT FOUND OR c.credential_ref IS NULL THEN RETURN c_unavailable; END IF;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE;
  IF NOT FOUND THEN RETURN c_unavailable; END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id FOR UPDATE;
  IF NOT FOUND THEN RETURN c_unavailable; END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest' AND connection_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RETURN c_unavailable; END IF;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id FOR SHARE;
  IF NOT FOUND THEN RETURN c_unavailable; END IF;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF NOT FOUND THEN RETURN c_unavailable; END IF;
  -- Membership and limits are judged live, exactly as a renewal judges them. A
  -- refusal means the connection has no authority left to recover.
  BEGIN
    PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
    PERFORM app_private.hermes_validate_limits_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN RETURN c_unavailable;
  END;
  v_now:=clock_timestamp();
  -- The credential must be intact: ACTIVE, or RESERVED (a refresh that was admitted
  -- but never dispatched). DISPATCHED/STAGED are ambiguous at the provider and stay
  -- with the refresh fence. The last line is the dead-man switch: nothing renewed
  -- or recovered this token for seven days, or no refresh has published a session
  -- for seven days. Recovery moves the token expiry and never the session's, so
  -- attempts that cannot bring the session back do not keep the connection alive.
  IF s.state NOT IN ('ACTIVE','RESERVED') OR s.quarantine_reason IS NOT NULL
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR c.credential_ref IS DISTINCT FROM s.id
    OR c.assistant_id<>s.assistant_id OR c.organization_id<>s.organization_id OR c.user_id<>s.user_id
    OR t.revoked_at IS NOT NULL OR t.created_at>v_now
    OR a.state<>'ACTIVE' OR NOT policy.enabled OR (c.permission_mode='legacy_allowlist' AND (NOT(c.read_capabilities<@policy.read_capabilities)
      OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids)))
    OR t.expires_at<=v_now-interval '7 days' OR s.expires_at<=v_now-interval '7 days' THEN
    RETURN c_unavailable; END IF;
  v_ready:=s.state='ACTIVE' AND s.expires_at>v_now;
  IF t.expires_at>v_now AND (v_ready OR t.expires_at>v_now+interval '5 minutes') THEN
    v_status:='live'; v_expires:=t.expires_at;
  ELSE
    -- Five minutes: room for one provider refresh, whose fence needs a live token
    -- at every step. While the session itself is expired every authorization path
    -- keeps refusing, because each requires a live session next to a live token.
    v_status:='recovered'; v_expires:=date_trunc('milliseconds',v_now+interval '5 minutes');
    UPDATE app_private.hermes_connection_tokens SET expires_at=v_expires,
      created_at=CASE WHEN created_at<v_now-interval '1 day' THEN v_now-interval '1 hour' ELSE created_at END
      WHERE token_digest=t.token_digest;
  END IF;
  RETURN jsonb_build_object('status',v_status,'connectionId',c.id,'credentialRef',s.id,
    'binding',jsonb_build_object('assistantId',s.assistant_id,'userId',s.user_id,'organizationId',s.organization_id,'sessionId',s.provider_session_id),
    'sessionReady',v_ready,'sessionExpiresAt',floor(extract(epoch FROM s.expires_at)*1000)::bigint,
    'expiresAt',floor(extract(epoch FROM v_expires)*1000)::bigint);
END
$fn$;

ALTER FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) TO hermes_store_executor;
ALTER FUNCTION app_private.hermes_store_recover_connection_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_store_recover_connection_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_recover_connection_v1(jsonb) TO hermes_store_executor;
COMMENT ON COLUMN app_private.hermes_connection_tokens.created_at IS
  'Start of the current age window, re-anchored by renewal and recovery; not the issue time (see hermes_connections.created_at).';

DO $check$
DECLARE p record; v_expected jsonb:=jsonb_build_object(
  'hermes_store_renew_connection_v1','b8c1d2e9bab82eafbafd8d64261f3c14','hermes_store_recover_connection_v1','4d2ed5672e88158e8587e6c8d47e8f60');
BEGIN
  FOR p IN SELECT x.oid,x.proname,x.prosecdef,x.provolatile,x.proconfig,pg_get_userbyid(x.proowner) AS owner,
      md5(replace(x.prosrc,chr(13),'')) AS md5,pg_get_function_result(x.oid) AS result
    FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
    WHERE n.nspname='app_private' AND x.proname IN ('hermes_store_renew_connection_v1','hermes_store_recover_connection_v1') LOOP
    IF NOT p.prosecdef OR p.provolatile<>'v' OR p.owner<>'postgres' OR p.result<>'jsonb'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']
      OR p.md5 IS DISTINCT FROM v_expected->>p.proname
      OR NOT pg_catalog.has_function_privilege('hermes_store_executor',p.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
        AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'hermes_connection_recovery_check_failed: %',p.proname;
    END IF;
    v_expected:=v_expected-p.proname;
  END LOOP;
  IF v_expected<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_connection_recovery_check_failed: missing %',v_expected; END IF;
END $check$;

NOTIFY pgrst,'reload schema';
COMMIT;
