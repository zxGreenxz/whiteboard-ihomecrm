BEGIN;
CREATE TEMP TABLE camera_proof_payload(payload jsonb);
INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,scope_mode)
VALUES('dddd6000-0000-4000-8000-0000000000c0','dddd0000-0000-4000-8000-000000000001','dddd5000-0000-4000-8000-000000000001','network_center.view','ALLOW','SCOPED');
INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id)
SELECT organization_id,'dddd6000-0000-4000-8000-0000000000c0',id FROM public.authorization_scopes WHERE building_id='dddd1000-0000-4000-8000-000000000001';
INSERT INTO public.network_workers(id,worker_key,display_name,status,capabilities)
VALUES('dddd7000-0000-4000-8000-0000000000c0','camera-proof','Camera proof','ACTIVE',ARRAY['POLL','TELEMETRY']);
INSERT INTO public.network_worker_credentials(worker_id,secret_digest,fingerprint,not_before,expires_at)
VALUES('dddd7000-0000-4000-8000-0000000000c0',repeat('c',64),'sha256:cccccccccccccccccccccccc',now()-interval '1 minute',now()+interval '1 day');
INSERT INTO public.network_worker_assignments(worker_id,organization_id,building_id,device_id,can_poll,active_from)
SELECT 'dddd7000-0000-4000-8000-0000000000c0',organization_id,building_id,id,true,now()-interval '1 minute' FROM public.network_devices WHERE building_id='dddd1000-0000-4000-8000-000000000001' AND device_kind='MIKROTIK';
INSERT INTO public.network_device_connections(id,organization_id,building_id,device_id,transport,management_ip,management_port,credential_ref,host_key_fingerprint,is_enabled)
SELECT 'dddd9000-0000-4000-8000-0000000000c0',organization_id,building_id,id,'ROUTEROS_SSH','10.90.0.1',22,'router/camera-proof','SHA256:ccccccccccccccccccccccccccccccccccccccccccc',true
FROM public.network_devices WHERE building_id='dddd1000-0000-4000-8000-000000000001' AND device_kind='MIKROTIK';
SELECT public.network_center_admin_enroll_camera_v1('dddd8000-0000-4000-8000-0000000000c0','dddd0000-0000-4000-8000-000000000001','dddd1000-0000-4000-8000-000000000001','dddd9000-0000-4000-8000-0000000000c0','Demo recorder','KBVISION',null,2,'http://10.90.0.1:18080','camera/proof',true);
INSERT INTO camera_proof_payload SELECT jsonb_build_object('recorderId','dddd8000-0000-4000-8000-0000000000c0','connectionId','dddd9000-0000-4000-8000-0000000000c0','observedAt',now()-interval '1 minute','status','ONLINE','channels','[{"channel":1,"state":"CONNECTED"},{"channel":2,"state":"EMPTY"}]'::jsonb,'storage','[{"slot":1,"state":"NORMAL","totalBytes":100,"usedBytes":100}]'::jsonb,'eventCoverage','EVENT_STREAM','issues','[]'::jsonb,'events','[]'::jsonb);
DO $proof$
DECLARE p jsonb; result jsonb; initial_events bigint; later_events bigint;
BEGIN
  SELECT payload INTO p FROM camera_proof_payload;
  result:=public.network_center_worker_camera_connections_v1(repeat('c',64),100);
  IF jsonb_array_length(result->'items')<>1 OR result#>>'{items,0,recorderId}'<>p->>'recorderId' THEN RAISE EXCEPTION 'connection scope missing'; END IF;
  PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p);
  SELECT count(*) INTO initial_events FROM public.camera_events;
  IF initial_events<>2 THEN RAISE EXCEPTION 'initial recorder and disk baseline missing'; END IF;
  IF (SELECT storage#>>'{0,state}' FROM public.camera_recorder_current)<>'NORMAL' THEN RAISE EXCEPTION 'full overwrite disk called failed'; END IF;
  result:=public.network_center_worker_camera_ingest_v1(repeat('c',64),p);
  IF result->>'snapshotApplied'<>'false' OR (SELECT count(*) FROM public.camera_events)<>initial_events THEN RAISE EXCEPTION 'replay created duplicate'; END IF;
  p:=p||jsonb_build_object('observedAt',now()-interval '30 seconds','status','OFFLINE','channels','[]'::jsonb,'storage','[]'::jsonb,'eventCoverage','STATE_POLLING_ONLY');
  PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p);
  IF (SELECT channels#>>'{0,state}' FROM public.camera_recorder_current)<>'UNKNOWN' OR (SELECT channels#>>'{1,state}' FROM public.camera_recorder_current)<>'UNKNOWN' THEN RAISE EXCEPTION 'recorder loss fabricated channel failures'; END IF;
  IF (SELECT storage#>>'{0,state}' FROM public.camera_recorder_current)<>'UNKNOWN' THEN RAISE EXCEPTION 'missing disk observation lost'; END IF;
  IF NOT EXISTS(SELECT FROM public.camera_events WHERE code='COVERAGE_GAP') THEN RAISE EXCEPTION 'coverage gap omitted'; END IF;
  SELECT count(*) INTO later_events FROM public.camera_events;
  PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),(SELECT payload FROM camera_proof_payload));
  IF (SELECT status FROM public.camera_recorder_current)<>'OFFLINE' OR (SELECT count(*) FROM public.camera_events)<>later_events THEN RAISE EXCEPTION 'stale snapshot changed current/history'; END IF;
  p:=p||jsonb_build_object('events',jsonb_build_array(jsonb_build_object('eventKey','native:1','code','VideoLoss','action','Start','channel',1,'observedAt',now()-interval '40 seconds')));
  PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p);
  PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p);
  IF (SELECT count(*) FROM public.camera_events WHERE event_key='device:native:1')<>1 THEN RAISE EXCEPTION 'raw events not independently deduped'; END IF;
  BEGIN
    PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p||'{"connectionId":"dddd9000-0000-4000-8000-0000000000c1"}'::jsonb);
    RAISE EXCEPTION 'wrong connection accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.network_center_admin_enroll_camera_v1('dddd8000-0000-4000-8000-0000000000c0','dddd0000-0000-4000-8000-000000000001','dddd1000-0000-4000-8000-000000000002','dddd9000-0000-4000-8000-0000000000c0','Wrong building','KBVISION',null,2,'http://10.90.0.1:18080','camera/proof',true);
    RAISE EXCEPTION 'enrollment cross-building connection accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p||'{"channels":[{"channel":1,"state":"CONNECTED"},{"channel":1,"state":"EMPTY"}]}'::jsonb);
    RAISE EXCEPTION 'duplicate channels accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p||jsonb_build_object('observedAt',now()+interval '1 hour'));
    RAISE EXCEPTION 'future time accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  UPDATE public.network_worker_assignments SET active_until=now()-interval '1 second' WHERE worker_id='dddd7000-0000-4000-8000-0000000000c0';
  BEGIN
    PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),p);
    RAISE EXCEPTION 'revoked assignment accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF jsonb_array_length(public.network_center_worker_camera_connections_v1(repeat('c',64),100)->'items')<>0 THEN RAISE EXCEPTION 'revoked list leak'; END IF;
END;
$proof$;

-- Real PostgreSQL role switching and request claims against scoped harness RBAC.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','de6f33f3-349f-4bec-bd3d-106192f6715e',true);
DO $allowed$ BEGIN
  IF jsonb_array_length(public.camera_building_snapshot_v1('dddd1000-0000-4000-8000-000000000001')->'recorders')<>1 THEN RAISE EXCEPTION 'owner cannot read'; END IF;
  IF jsonb_array_length(public.camera_building_events_v1('dddd1000-0000-4000-8000-000000000001',1)->'items')<>1 OR public.camera_building_events_v1('dddd1000-0000-4000-8000-000000000001',1)->>'hasMore'<>'true' THEN RAISE EXCEPTION 'event page failed'; END IF;
  BEGIN PERFORM public.network_center_worker_camera_ingest_v1(repeat('c',64),'{}'); RAISE EXCEPTION 'browser ingest ACL open'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.camera_events; RAISE EXCEPTION 'history delete ACL open'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.camera_events SET state='FORGED'; RAISE EXCEPTION 'history update ACL open'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_building_snapshot_v1('dddd1000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'cross-building read accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.camera_building_snapshot_v1('aaaa1000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'cross-org read accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $allowed$;
SELECT set_config('request.jwt.claim.sub','dddd2000-0000-4000-8000-000000000001',true);
DO $denied$ BEGIN
  IF EXISTS(SELECT FROM public.camera_recorders) OR EXISTS(SELECT FROM public.camera_events) THEN RAISE EXCEPTION 'ungranted actor RLS leak'; END IF;
  BEGIN PERFORM public.camera_building_snapshot_v1('dddd1000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'ungranted RPC accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $denied$;
RESET ROLE;
ROLLBACK;
SELECT 'CAMERA_PROOF_OK';
