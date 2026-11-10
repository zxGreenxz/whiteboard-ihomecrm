-- hermes_zalo_binding_v1: xác nhận liên kết Zalo chọn lại kết nối CRM khi trợ lý chưa có liên kết nào đang hoạt động (10/11/2026).
--
-- VẤN ĐỀ. Thân 20261019034850 (md5 prosrc e1d3f75a…) giữ MỘT dòng chọn kết nối cho mỗi trợ lý ở
-- app_private.hermes_zalo_active_credentials. Nhánh confirm chỉ INSERT … ON CONFLICT DO NOTHING rồi báo
-- 'hermes_zalo_context_changed' (PT409) khi dòng chọn khác kết nối của mã liên kết; selectCredential là CAS và trang Cài đặt
-- chỉ hiện nút "Dùng kết nối này cho trợ lý" cạnh một liên kết ACTIVE. Người đã gỡ liên kết Zalo (liên kết thành REVOKED,
-- dòng chọn ở lại), thu hồi kết nối cũ rồi tạo kết nối mới thì kẹt: confirm luôn PT409 và không còn nút nào đổi được dòng chọn.
--
-- LUẬT MỚI. Trong confirm, khi trợ lý KHÔNG có liên kết ACTIVE nào, dòng chọn được thay bằng kết nối của mã liên kết vừa
-- được xác nhận (selected_by = người xác nhận, revision + 1). Khi trợ lý CÒN liên kết ACTIVE mà dòng chọn khác kết nối của
-- mã liên kết: vẫn PT409 như cũ, dòng chọn không đổi — lúc đó đổi kết nối vẫn chỉ qua selectCredential.
--
-- VÌ SAO AN TOÀN. Dòng chọn chỉ được đọc trong 20261019034850: trigger chiếu hermes_zalo_project_credential_v1 (chỉ ghi lên
-- liên kết ACTIVE), selectCredential/confirm và hermes_zalo_provisioning_v1 (liên kết không ACTIVE luôn trả 'revoked').
-- Các đường khác (lệnh riêng, trả lời riêng, nhóm, lịch phòng, nhắc việc) đọc hermes_zalo_bindings.connection_id của liên
-- kết ACTIVE. Không còn liên kết ACTIVE thì không đường nào dựa vào dòng chọn cũ. UPDATE đứng sau cùng hai khoá công ty
-- (lock_org_for_decision_v1 rồi pg_advisory_xact_lock) như INSERT sẵn có, nên xếp hàng với confirm / selectCredential /
-- unlink / setBot khác của công ty; thứ tự khoá không đổi. Kết nối của mã liên kết đã qua hermes_zalo_context_v1 (đúng
-- người, đúng công ty, kết nối và phiên còn hiệu lực) nên trigger chiếu chấp nhận dòng chọn mới.
--
-- PHẠM VI. Chỉ thân public.hermes_zalo_binding_v1(jsonb): thêm biến v_prior; trong nhánh confirm thêm một SELECT và một
-- UPDATE có điều kiện ngay sau INSERT sẵn có; lý do audit có thêm đuôi ' (credential reselected from <kết nối cũ>)' khi
-- dòng chọn bị thay. Giữ nguyên: mọi operation khác, hình dạng kết quả (không thêm trường), chữ ký, DEFINER, VOLATILE,
-- search_path, chủ và ACL (chỉ authenticated). Chữ ký không đổi nên không cần NOTIFY pgrst.
-- Ghim md5 thân đang chạy; lượt hai (idempotent) chấp nhận md5 thân mới. Không DROP, không đổi dữ liệu, không đổi bảng.
-- Lùi: docs/plans/hermes-crm/revert/hermes_zalo_confirm_reselect_unbound_revert_v1.sql (dựng lại đúng thân 20261019034850).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_md5 FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('public.hermes_zalo_binding_v1(jsonb)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('e1d3f75afa5e5d1a16d15fe7a7d0ab3b','f915a08d71d4a827588648955edfa001')
    OR to_regclass('app_private.hermes_zalo_active_credentials') IS NULL OR to_regclass('app_private.hermes_zalo_bindings') IS NULL THEN
    RAISE EXCEPTION 'hermes_zalo_binding_v1_body_drift: %',COALESCE(v_md5,'missing');
  END IF;
END $requires$;

-- Thân 20261019034850 giữ nguyên từng dòng; khác đúng ba chỗ: biến v_prior, khối chọn lại trong confirm, đuôi lý do audit.
CREATE OR REPLACE FUNCTION public.hermes_zalo_binding_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE op text:=p->>'operation'; u uuid:=auth.uid(); o uuid;
  c app_private.hermes_connections; b app_private.hermes_zalo_bots;
  h app_private.hermes_zalo_link_challenges; x app_private.hermes_zalo_bindings;
  v_secret text; v_now timestamptz; v_account uuid; v_id uuid; v_epoch bigint; v_after uuid; v_result jsonb; v_can_enable boolean;
  v_prior uuid;
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
      -- Exception: while the assistant has no ACTIVE binding, nothing uses the
      -- earlier selection and the CRM offers selectCredential only beside an
      -- ACTIVE binding, so this confirmed pairing re-selects its own connection.
      -- With an ACTIVE binding only selectCredential changes the selection.
      SELECT connection_id INTO v_prior FROM app_private.hermes_zalo_active_credentials WHERE assistant_id=c.assistant_id;
      UPDATE app_private.hermes_zalo_active_credentials SET connection_id=c.id,selected_by=u,revision=revision+1
        WHERE assistant_id=c.assistant_id AND connection_id<>c.id
          AND NOT EXISTS(SELECT 1 FROM app_private.hermes_zalo_bindings z WHERE z.assistant_id=c.assistant_id AND z.state='ACTIVE');
      IF NOT FOUND THEN v_prior:=NULL; END IF;
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
    v_result-'challenge','Explicit CRM user action: '||op||COALESCE(' (credential reselected from '||v_prior::text||')','')); END IF;
  RETURN v_result||jsonb_build_object('userId',u,'organizationId',o);
END $$;
ALTER FUNCTION public.hermes_zalo_binding_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_binding_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_binding_v1(jsonb) TO authenticated;

DO $check$
DECLARE p record;
BEGIN
  SELECT x.prosecdef,x.provolatile,x.proconfig,pg_get_userbyid(x.proowner) AS owner,md5(replace(x.prosrc,chr(13),'')) AS md5,
      pg_get_function_result(x.oid) AS result
    INTO p FROM pg_catalog.pg_proc x WHERE x.oid='public.hermes_zalo_binding_v1(jsonb)'::regprocedure;
  IF NOT p.prosecdef OR p.provolatile<>'v' OR p.owner<>'postgres' OR p.result<>'jsonb'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']
    OR p.md5<>'f915a08d71d4a827588648955edfa001'
    OR NOT pg_catalog.has_function_privilege('authenticated','public.hermes_zalo_binding_v1(jsonb)'::regprocedure,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','service_role','hermes_store_executor')
      AND pg_catalog.has_function_privilege(r.oid,'public.hermes_zalo_binding_v1(jsonb)'::regprocedure,'EXECUTE')) THEN
    RAISE EXCEPTION 'hermes_zalo_binding_v1_check_failed';
  END IF;
END $check$;

COMMIT;
