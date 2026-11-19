BEGIN;
-- Fixtures: owner de6f33f3… gets network_center.view on building …1001; actor dddd2000… gets nothing.
INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,scope_mode)
VALUES('dddd6000-0000-4000-8000-0000000000c5','dddd0000-0000-4000-8000-000000000001','dddd5000-0000-4000-8000-000000000001','network_center.view','ALLOW','SCOPED');
INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id)
SELECT organization_id,'dddd6000-0000-4000-8000-0000000000c5',id FROM public.authorization_scopes WHERE building_id='dddd1000-0000-4000-8000-000000000001';
INSERT INTO public.network_device_connections(id,organization_id,building_id,device_id,transport,management_ip,management_port,credential_ref,host_key_fingerprint,is_enabled)
SELECT 'dddd9000-0000-4000-8000-0000000000c5',organization_id,building_id,id,'ROUTEROS_SSH','10.90.0.1',22,'router/camera-share-proof','SHA256:ccccccccccccccccccccccccccccccccccccccccccc',true
FROM public.network_devices WHERE building_id='dddd1000-0000-4000-8000-000000000001' AND device_kind='MIKROTIK';
SELECT public.network_center_admin_enroll_camera_v1('dddd8000-0000-4000-8000-0000000000c5','dddd0000-0000-4000-8000-000000000001','dddd1000-0000-4000-8000-000000000001','dddd9000-0000-4000-8000-0000000000c5','Share proof recorder','KBVISION',null,2,'http://10.90.0.1:18080','camera/share-proof',true);
INSERT INTO public.camera_recorder_current(recorder_id,organization_id,building_id,status,checked_at,channels,storage,event_coverage)
VALUES('dddd8000-0000-4000-8000-0000000000c5','dddd0000-0000-4000-8000-000000000001','dddd1000-0000-4000-8000-000000000001','ONLINE',now(),
  '[{"channel":1,"name":"SAN PHOI","state":"CONNECTED"},{"channel":2,"state":"EMPTY"}]'::jsonb,'[]'::jsonb,'STATE_POLLING_ONLY');
-- The Network Center harness has no profiles table; production does. Only the two columns the list reads.
CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY, full_name text, email text);
INSERT INTO public.profiles(id,full_name,email) VALUES('de6f33f3-349f-4bec-bd3d-106192f6715e','  Chủ Thử  ','owner@example.test') ON CONFLICT (id) DO NOTHING;
CREATE TEMP TABLE share_proof(k text PRIMARY KEY, v jsonb);
GRANT ALL ON share_proof TO authenticated, anon;

-- 1. Người quản lý có quyền xem Trung tâm mạng của toà: tạo, xem danh sách.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','de6f33f3-349f-4bec-bd3d-106192f6715e',true);
DO $owner$
DECLARE a jsonb; b jsonb; c jsonb; l jsonb; t0 timestamptz := date_trunc('second', now()) - interval '25 hours';
BEGIN
  a := public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '1 hour',24,'  Khách phòng 301  ');
  IF a->>'code' !~ '^[A-HJ-NP-Z2-9]{8}$' OR a->>'password' !~ '^[a-z0-9]{8}$' THEN RAISE EXCEPTION 'credential format wrong'; END IF;
  IF a->>'channel_name' <> 'SAN PHOI' OR a->>'note' <> 'Khách phòng 301' THEN RAISE EXCEPTION 'channel name or note not captured'; END IF;
  IF (a->>'expires_at')::timestamptz NOT BETWEEN now()+interval '23 hours 59 minutes' AND now()+interval '24 hours 1 minute' THEN RAISE EXCEPTION 'default expiry wrong'; END IF;
  INSERT INTO share_proof VALUES('a',a);
  b := public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',2,t0,t0+interval '24 hours',1,NULL);
  INSERT INTO share_proof VALUES('b',b);
  IF a->>'code' = b->>'code' THEN RAISE EXCEPTION 'duplicate code'; END IF;
  l := public.camera_shares_v1('dddd1000-0000-4000-8000-000000000001');
  IF jsonb_array_length(l->'shares') <> 2 OR l::text LIKE '%password%' THEN RAISE EXCEPTION 'list wrong or leaks password'; END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(l->'shares') x WHERE x->>'status' <> 'ACTIVE' OR x->>'created_by_name' <> 'Chủ Thử') THEN RAISE EXCEPTION 'fresh share not active or creator name wrong'; END IF;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '24 hours 1 second',24,NULL); RAISE EXCEPTION 'window over 24h accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',3,t0,t0+interval '1 hour',24,NULL); RAISE EXCEPTION 'unknown channel accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '1 hour',169,NULL); RAISE EXCEPTION 'expiry over 7 days accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,now()+interval '1 hour',now()+interval '2 hours',24,NULL); RAISE EXCEPTION 'future window accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- chỉ xem lại: giờ kết thúc ở tương lai (quá lề lệch đồng hồ 5 phút) bị từ chối, trong lề thì kéo về "bây giờ"
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,now()-interval '1 hour',now()+interval '1 hour',24,NULL); RAISE EXCEPTION 'future end accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  c := public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,now()-interval '1 hour',now()+interval '2 minutes',1,NULL);
  IF (c->>'window_end')::timestamptz > clock_timestamp() OR (c->>'window_end')::timestamptz < now() - interval '1 second' THEN RAISE EXCEPTION 'near-future end not clamped to now'; END IF;
  IF public.camera_share_revoke_v1((c->>'id')::uuid)->>'status' <> 'REVOKED' THEN RAISE EXCEPTION 'clamp fixture not revoked'; END IF;
  BEGIN PERFORM public.camera_shares_v1('aaaa1000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'cross-org list accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000ff',1,t0,t0+interval '1 hour',24,NULL); RAISE EXCEPTION 'unknown recorder accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_shares_v1('dddd1000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'cross-building list accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM app_private.camera_shares; RAISE EXCEPTION 'browser reads share table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $owner$;

-- 2. Người không có quyền xem Trung tâm mạng của toà: không tạo, không xem, không thu hồi.
SELECT set_config('request.jwt.claim.sub','dddd2000-0000-4000-8000-000000000001',true);
DO $denied$
DECLARE t0 timestamptz := date_trunc('second', now()) - interval '3 hours';
BEGIN
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '1 hour',24,NULL); RAISE EXCEPTION 'ungranted actor created share'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_shares_v1('dddd1000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'ungranted actor listed shares'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_share_revoke_v1(((SELECT v FROM share_proof WHERE k='a')->>'id')::uuid); RAISE EXCEPTION 'ungranted actor revoked share'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $denied$;

-- 3. Khách (anon): đăng nhập, kiểm phiên, khoá dò, thoát.
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub','',true);
DO $guest$
DECLARE a jsonb := (SELECT v FROM share_proof WHERE k='a'); b jsonb := (SELECT v FROM share_proof WHERE k='b'); r jsonb; s text; i integer;
BEGIN
  BEGIN PERFORM public.camera_shares_v1('dddd1000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'anon listed shares'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_share_revoke_v1((a->>'id')::uuid); RAISE EXCEPTION 'anon revoked share'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,now()-interval '2 hours',now()-interval '1 hour',24,NULL); RAISE EXCEPTION 'anon created share'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  r := public.camera_share_login_v1('ZZZZ2222','aaaa2222');
  IF r->>'status' <> 'INVALID' OR (r->>'attempts_left')::int <> 4 THEN RAISE EXCEPTION 'unknown code not generic'; END IF;
  r := public.camera_share_login_v1(a->>'code','wrongpw2');
  IF r->>'status' <> 'INVALID' OR (r->>'attempts_left')::int <> 4 THEN RAISE EXCEPTION 'first wrong password miscounted'; END IF;
  -- nhập kiểu người dùng: chữ thường, có dấu cách và gạch trong ID; mật khẩu viết hoa
  r := public.camera_share_login_v1(' ' || lower(left(a->>'code',4)) || '-' || lower(right(a->>'code',4)) || ' ', upper(a->>'password'));
  IF r->>'status' <> 'OK' OR r->>'session' !~ '^cs_[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'valid login rejected'; END IF;
  IF r#>>'{share,recorder_id}' <> 'dddd8000-0000-4000-8000-0000000000c5' OR (r#>>'{share,channel}')::int <> 1 OR r->'share' ? 'code' OR r::text LIKE '%password%' THEN RAISE EXCEPTION 'login payload wrong'; END IF;
  s := r->>'session';
  INSERT INTO share_proof VALUES('a_session', to_jsonb(s));
  r := public.camera_share_authorize_v1(s);
  IF r IS NULL OR r->>'share_id' <> a->>'id' OR r->>'building_id' <> 'dddd1000-0000-4000-8000-000000000001' OR r->>'organization_id' <> 'dddd0000-0000-4000-8000-000000000001'
     OR (r->>'window_start')::timestamptz <> (a->>'window_start')::timestamptz OR (r->>'window_end')::timestamptz <> (a->>'window_end')::timestamptz THEN RAISE EXCEPTION 'authorize payload wrong'; END IF;
  IF public.camera_share_authorize_v1('cs_' || repeat('A',43)) IS NOT NULL OR public.camera_share_authorize_v1(substr(s,4)) IS NOT NULL OR public.camera_share_authorize_v1(NULL) IS NOT NULL THEN RAISE EXCEPTION 'forged session authorized'; END IF;
  -- lượt B: 5 lần sai thì khoá, kể cả khi sau đó nhập đúng
  FOR i IN 1..5 LOOP
    r := public.camera_share_login_v1(b->>'code','wrongpw2');
    IF r->>'status' <> 'INVALID' OR (r->>'attempts_left')::int <> 5 - i THEN RAISE EXCEPTION 'failure % miscounted', i; END IF;
  END LOOP;
  r := public.camera_share_login_v1(b->>'code', b->>'password');
  IF r->>'status' <> 'LOCKED' OR (r->>'retry_after_seconds')::int NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'lockout missing'; END IF;
  -- lượt A không bị khoá theo lượt B; thoát thì phiên chết
  r := public.camera_share_login_v1(a->>'code', a->>'password');
  IF r->>'status' <> 'OK' THEN RAISE EXCEPTION 'lockout leaked across shares'; END IF;
  PERFORM public.camera_share_logout_v1(r->>'session');
  IF public.camera_share_authorize_v1(r->>'session') IS NOT NULL THEN RAISE EXCEPTION 'logged-out session authorized'; END IF;
  IF public.camera_share_authorize_v1(s) IS NULL THEN RAISE EXCEPTION 'logout killed another session'; END IF;
  -- giữ 5 phiên mới nhất của một lượt: thêm 5 lần đăng nhập thì phiên đầu bị loại, phiên mới nhất còn dùng được
  FOR i IN 1..5 LOOP
    r := public.camera_share_login_v1(a->>'code', a->>'password');
    IF r->>'status' <> 'OK' THEN RAISE EXCEPTION 'repeat login % rejected', i; END IF;
  END LOOP;
  IF public.camera_share_authorize_v1(s) IS NOT NULL THEN RAISE EXCEPTION 'session cap not enforced'; END IF;
  IF public.camera_share_authorize_v1(r->>'session') IS NULL THEN RAISE EXCEPTION 'newest session evicted'; END IF;
  UPDATE share_proof SET v = to_jsonb(r->>'session') WHERE k = 'a_session';
  BEGIN PERFORM 1 FROM app_private.camera_share_sessions; RAISE EXCEPTION 'anon reads session table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $guest$;

-- 4. Thu hồi bằng tay cắt phiên ngay.
RESET ROLE;
DO $internal$ BEGIN
  IF (SELECT count(*) FROM app_private.camera_share_login_failures WHERE code='ZZZZ2222') <> 0 THEN RAISE EXCEPTION 'unknown code recorded failures'; END IF;
  IF EXISTS(SELECT FROM app_private.camera_shares WHERE revoked_at IS NULL AND (password_hash IS NULL OR password_hash NOT LIKE '$2%')) THEN RAISE EXCEPTION 'password not bcrypt'; END IF;
  IF EXISTS(SELECT FROM app_private.camera_shares WHERE revoked_at IS NOT NULL AND password_hash IS NOT NULL) THEN RAISE EXCEPTION 'revoked share kept its password hash'; END IF;
  IF EXISTS(SELECT FROM app_private.camera_share_sessions x WHERE x.token_hash = (SELECT v#>>'{}' FROM share_proof WHERE k='a_session')) THEN RAISE EXCEPTION 'raw session stored'; END IF;
END $internal$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','de6f33f3-349f-4bec-bd3d-106192f6715e',true);
DO $revoke$
DECLARE a jsonb := (SELECT v FROM share_proof WHERE k='a'); s text := (SELECT v#>>'{}' FROM share_proof WHERE k='a_session'); r jsonb;
BEGIN
  r := public.camera_share_revoke_v1((a->>'id')::uuid);
  IF r->>'status' <> 'REVOKED' THEN RAISE EXCEPTION 'revoke failed'; END IF;
  IF public.camera_share_authorize_v1(s) IS NOT NULL THEN RAISE EXCEPTION 'revoked share still authorized'; END IF;
  IF public.camera_share_login_v1(a->>'code', a->>'password')->>'status' <> 'ENDED' THEN RAISE EXCEPTION 'revoked share still logs in'; END IF;
  IF public.camera_share_revoke_v1((a->>'id')::uuid)->>'status' <> 'ALREADY_ENDED' THEN RAISE EXCEPTION 'second revoke not idempotent'; END IF;
  IF NOT EXISTS(SELECT FROM jsonb_array_elements(public.camera_shares_v1('dddd1000-0000-4000-8000-000000000001')->'shares') x WHERE x->>'id' = a->>'id' AND x->>'status' = 'REVOKED' AND (x->>'login_count')::int = 7) THEN RAISE EXCEPTION 'revoked status or login count wrong'; END IF;
END $revoke$;

-- 5. Hết hạn tự mất quyền (không cần job), job dọn xoá mật khẩu băm và xoá dòng sau 30 ngày; đầu ghi tắt là mất quyền.
RESET ROLE;
DO $expiry$
DECLARE a jsonb := (SELECT v FROM share_proof WHERE k='a'); c jsonb; r jsonb; s text; t0 timestamptz := date_trunc('second', now()) - interval '3 hours';
BEGIN
  IF (SELECT password_hash FROM app_private.camera_shares WHERE id = (a->>'id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'revoke kept password hash'; END IF;
  DELETE FROM app_private.camera_share_login_failures;
  PERFORM set_config('role','authenticated',true);
  c := public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '1 hour',1,NULL);
  PERFORM set_config('role','anon',true);
  r := public.camera_share_login_v1(c->>'code', c->>'password'); s := r->>'session';
  IF r->>'status' <> 'OK' OR public.camera_share_authorize_v1(s) IS NULL THEN RAISE EXCEPTION 'fresh share unusable'; END IF;
  RESET ROLE;
  UPDATE public.camera_recorders SET enabled=false WHERE id='dddd8000-0000-4000-8000-0000000000c5';
  IF public.camera_share_authorize_v1(s) IS NOT NULL THEN RAISE EXCEPTION 'disabled recorder still authorized'; END IF;
  UPDATE public.camera_recorders SET enabled=true WHERE id='dddd8000-0000-4000-8000-0000000000c5';
  IF public.camera_share_authorize_v1(s) IS NULL THEN RAISE EXCEPTION 're-enabled recorder not authorized'; END IF;
  UPDATE app_private.camera_shares SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = (c->>'id')::uuid;
  IF public.camera_share_authorize_v1(s) IS NOT NULL THEN RAISE EXCEPTION 'expired share still authorized'; END IF;
  IF public.camera_share_login_v1(c->>'code', c->>'password')->>'status' <> 'ENDED' THEN RAISE EXCEPTION 'expired share still logs in'; END IF;
  PERFORM app_private.camera_share_cleanup_v1();
  IF EXISTS(SELECT FROM app_private.camera_shares WHERE id = (c->>'id')::uuid AND password_hash IS NOT NULL)
     OR EXISTS(SELECT FROM app_private.camera_share_sessions WHERE share_id = (c->>'id')::uuid) THEN RAISE EXCEPTION 'cleanup kept ended credentials'; END IF;
  IF NOT EXISTS(SELECT FROM app_private.camera_shares WHERE id = (c->>'id')::uuid) THEN RAISE EXCEPTION 'cleanup deleted recent history'; END IF;
  UPDATE app_private.camera_shares SET created_at = now() - interval '37 days', expires_at = now() - interval '31 days' WHERE id = (c->>'id')::uuid;
  PERFORM app_private.camera_share_cleanup_v1();
  IF EXISTS(SELECT FROM app_private.camera_shares WHERE id = (c->>'id')::uuid) THEN RAISE EXCEPTION 'cleanup kept 30-day-old share'; END IF;
  IF (SELECT count(*) FROM app_private.camera_shares WHERE revoked_at IS NULL AND expires_at > now()) <> 1 THEN RAISE EXCEPTION 'cleanup touched active share'; END IF;
END $expiry$;

-- 6. Trần 20 lượt còn hiệu lực mỗi toà.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','de6f33f3-349f-4bec-bd3d-106192f6715e',true);
DO $cap$
DECLARE i integer; t0 timestamptz := date_trunc('second', now()) - interval '3 hours';
BEGIN
  FOR i IN 1..19 LOOP PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '1 hour',1,NULL); END LOOP;
  BEGIN PERFORM public.camera_share_create_v1('dddd8000-0000-4000-8000-0000000000c5',1,t0,t0+interval '1 hour',1,NULL); RAISE EXCEPTION 'share cap not enforced'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Toà này đang có 20%' THEN RAISE; END IF; END;
END $cap$;
RESET ROLE;
ROLLBACK;
SELECT 'CAMERA_SHARE_PROOF_OK';
