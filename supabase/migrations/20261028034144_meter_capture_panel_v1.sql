-- Panel capture ("cả bảng"): one photo/clip of several electricity meters in ONE building.
-- The worker surveys every meter (room label, QR token, register, value, per-meter crop). The server
-- matches each detection to a meter (QR token first, then the room label within the panel building)
-- and turns each match into an ordinary child capture whose media is that meter's crop. Review,
-- confirmation, billing and document evidence therefore keep using the reviewed per-capture path.
-- A child has one reader (the AI survey), so its confirmation always needs a human reason.
BEGIN;
-- The storage policy helper is replaced below. Refuse to overwrite a body other than the reviewed
-- 20261022144130 definition (live on TEST and production 28/10/2026) or this migration's own body.
DO $requires$
BEGIN
 IF (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='meter_capture_storage_allowed_v1')
    NOT IN ('710353bdc64430fb3505dfee10d9517e','b632ec24475dd81a8c77aa71ebc704ca') THEN
  RAISE EXCEPTION 'meter_capture_storage_allowed_v1 drifted from the reviewed body; rebase this migration' USING ERRCODE='55000';
 END IF;
END $requires$;

CREATE TABLE IF NOT EXISTS app_private.meter_capture_panels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL REFERENCES public.buildings(id),
  actor_id uuid NOT NULL, client_id uuid NOT NULL, request_hash text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('MONTHLY','MOVE_OUT')), reading_date date NOT NULL, month text NOT NULL, captured_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'AWAITING_UPLOAD' CHECK(status IN ('AWAITING_UPLOAD','QUEUED','PROCESSING','REVIEW')),
  version integer NOT NULL DEFAULT 1, mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=104857600),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), duration_seconds numeric,
  object_key text NOT NULL UNIQUE, media_received boolean NOT NULL DEFAULT false, media_validated boolean NOT NULL DEFAULT false,
  received_at timestamptz, issues jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,actor_id,client_id),
  CHECK((mime_type LIKE 'video/%' AND duration_seconds>0 AND duration_seconds<=60) OR (mime_type LIKE 'image/%' AND duration_seconds IS NULL))
);
CREATE INDEX IF NOT EXISTS meter_capture_panels_scope_idx ON app_private.meter_capture_panels(organization_id,building_id,month,created_at DESC);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_panel_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), panel_id uuid NOT NULL REFERENCES app_private.meter_capture_panels(id), generation integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','DONE','FAILED')),
  attempts integer NOT NULL DEFAULT 0, worker_id text, lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(panel_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS meter_capture_panel_jobs_one_active_idx ON app_private.meter_capture_panel_jobs(panel_id) WHERE state IN ('QUEUED','RUNNING');
CREATE TABLE IF NOT EXISTS app_private.meter_capture_panel_results (
  job_id uuid PRIMARY KEY REFERENCES app_private.meter_capture_panel_jobs(id), panel_id uuid NOT NULL REFERENCES app_private.meter_capture_panels(id),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_panel_frame_receipts (
  object_key text NOT NULL, panel_id uuid NOT NULL REFERENCES app_private.meter_capture_panels(id),
  job_id uuid NOT NULL REFERENCES app_private.meter_capture_panel_jobs(id), sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  timestamp_seconds numeric NOT NULL CHECK(timestamp_seconds>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,object_key,timestamp_seconds)
);
CREATE INDEX IF NOT EXISTS meter_capture_panel_frame_receipts_object_idx ON app_private.meter_capture_panel_frame_receipts(panel_id,object_key);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_panel_detections (
  panel_id uuid NOT NULL REFERENCES app_private.meter_capture_panels(id), job_id uuid NOT NULL REFERENCES app_private.meter_capture_panel_jobs(id),
  detection_index integer NOT NULL CHECK(detection_index BETWEEN 0 AND 39),
  label text CHECK(label IS NULL OR length(label) BETWEEN 1 AND 20), register_code text CHECK(register_code IS NULL OR length(register_code) BETWEEN 1 AND 40),
  display text CHECK(display IS NULL OR display IN ('mechanical','digital')), value text CHECK(value IS NULL OR value ~ '^\d{1,8}(\.\d{1,2})?$'),
  clear boolean NOT NULL, qr_tokens jsonb NOT NULL DEFAULT '[]',
  crop_object_key text NOT NULL, crop_sha256 text NOT NULL CHECK(crop_sha256~'^[a-f0-9]{64}$'),
  crop_size_bytes bigint NOT NULL CHECK(crop_size_bytes>0 AND crop_size_bytes<=3145728),
  timestamp_seconds numeric NOT NULL CHECK(timestamp_seconds>=0), frames jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('MATCHED','UNMATCHED','AMBIGUOUS','DUPLICATE','NO_PROFILE','NO_CONTRACT','OTHER_BUILDING')),
  match_kind text CHECK(match_kind IS NULL OR match_kind IN ('QR','LABEL','MANUAL')),
  meter_id uuid REFERENCES public.meters(id), capture_id uuid UNIQUE REFERENCES app_private.meter_captures(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(panel_id,detection_index),
  CHECK(capture_id IS NULL OR (state='MATCHED' AND meter_id IS NOT NULL AND match_kind IS NOT NULL))
);
ALTER TABLE app_private.meter_captures ADD COLUMN IF NOT EXISTS panel_id uuid REFERENCES app_private.meter_capture_panels(id);
ALTER TABLE app_private.meter_captures ADD COLUMN IF NOT EXISTS panel_detection_index integer;
CREATE UNIQUE INDEX IF NOT EXISTS meter_captures_panel_detection_idx ON app_private.meter_captures(panel_id,panel_detection_index) WHERE panel_id IS NOT NULL;
ALTER TABLE app_private.meter_capture_panels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_panel_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_panel_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_panel_frame_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_panel_detections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.meter_capture_panels,app_private.meter_capture_panel_jobs,app_private.meter_capture_panel_results,
 app_private.meter_capture_panel_frame_receipts,app_private.meter_capture_panel_detections FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS meter_capture_panel_results_immutable ON app_private.meter_capture_panel_results;
CREATE TRIGGER meter_capture_panel_results_immutable BEFORE UPDATE OR DELETE ON app_private.meter_capture_panel_results FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_immutable_v1();
DROP TRIGGER IF EXISTS meter_capture_panel_receipts_immutable ON app_private.meter_capture_panel_frame_receipts;
CREATE TRIGGER meter_capture_panel_receipts_immutable BEFORE UPDATE OR DELETE ON app_private.meter_capture_panel_frame_receipts FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_immutable_v1();
-- A detection only gains its match/assignment once; the survey facts never change.
CREATE OR REPLACE FUNCTION app_private.meter_capture_panel_detection_guard_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.capture_id IS NOT NULL OR (to_jsonb(NEW)-ARRAY['state','match_kind','meter_id','capture_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','match_kind','meter_id','capture_id']) THEN
  RAISE EXCEPTION 'Panel detection evidence is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meter_capture_panel_detection_guard ON app_private.meter_capture_panel_detections;
CREATE TRIGGER meter_capture_panel_detection_guard BEFORE UPDATE OR DELETE ON app_private.meter_capture_panel_detections FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_panel_detection_guard_v1();

-- "1.05", "P 105" and "105" compare on letters and digits only; "P105" and "105" stay different.
CREATE OR REPLACE FUNCTION app_private.meter_capture_panel_norm_v1(p_label text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT NULLIF(upper(regexp_replace(COALESCE(p_label,''),'[^0-9A-Za-z]','','g')),'')
$$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_panel_json_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('id',p.id,'clientId',p.client_id,'orgId',p.organization_id,'organizationId',p.organization_id,
  'buildingId',p.building_id,'buildingName',(SELECT b.name FROM public.buildings b WHERE b.id=p.building_id),
  'purpose',p.purpose,'readingDate',p.reading_date,'month',p.month,'capturedAt',p.captured_at,
  'status',CASE WHEN p.status='AWAITING_UPLOAD' THEN 'UPLOADING' ELSE p.status END,'version',p.version,
  'mimeType',p.mime_type,'sizeBytes',p.size_bytes,'sha256',p.sha256,'durationSeconds',p.duration_seconds,'objectKey',p.object_key,
  'mediaReceived',p.media_received,'mediaValidated',p.media_validated,'issues',p.issues,'createdAt',p.created_at,
  'aiStatus',(SELECT r.result#>>'{ai,status}' FROM app_private.meter_capture_panel_results r WHERE r.panel_id=p.id ORDER BY r.created_at DESC LIMIT 1),
  'detections',COALESCE((SELECT jsonb_agg(jsonb_build_object('index',d.detection_index,'label',d.label,'registerCode',d.register_code,
    'display',d.display,'value',d.value,'clear',d.clear,'state',d.state,'matchKind',d.match_kind,'meterId',d.meter_id,
    'roomId',m.room_id,'roomName',rm.name,'meterCode',m.code,'captureId',d.capture_id,'cropObjectKey',d.crop_object_key,
    'timestampSeconds',d.timestamp_seconds) ORDER BY d.detection_index)
   FROM app_private.meter_capture_panel_detections d LEFT JOIN public.meters m ON m.id=d.meter_id LEFT JOIN public.rooms rm ON rm.id=m.room_id
   WHERE d.panel_id=p.id AND d.job_id=(SELECT r.job_id FROM app_private.meter_capture_panel_results r WHERE r.panel_id=p.id ORDER BY r.created_at DESC LIMIT 1)),'[]'::jsonb))
 FROM app_private.meter_capture_panels p WHERE p.id=p_id
$$;

-- Creates the ordinary capture for one matched detection: media = that meter's crop, one AI reader,
-- evidence = the survey frames. Callers own matching/permission; this re-checks scope facts.
CREATE OR REPLACE FUNCTION app_private.meter_capture_panel_child_v1(p_panel_id uuid,p_index integer,p_meter_id uuid,p_contract_id uuid,p_match_kind text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE pn app_private.meter_capture_panels%ROWTYPE; d app_private.meter_capture_panel_detections%ROWTYPE; m public.meters%ROWTYPE;
 prof app_private.meter_capture_profiles%ROWTYPE; ct public.contracts%ROWTYPE; v_id uuid:=gen_random_uuid(); v_job uuid:=gen_random_uuid();
 v_issues jsonb:='["PANEL_SINGLE_READER"]'; v_version text; v_frames integer;
BEGIN
 IF p_match_kind IS NULL OR p_match_kind NOT IN ('QR','LABEL','MANUAL') THEN RAISE EXCEPTION 'Invalid panel match' USING ERRCODE='22023'; END IF;
 SELECT * INTO pn FROM app_private.meter_capture_panels WHERE id=p_panel_id FOR UPDATE;
 SELECT * INTO d FROM app_private.meter_capture_panel_detections WHERE panel_id=p_panel_id AND detection_index=p_index
  AND job_id=(SELECT r.job_id FROM app_private.meter_capture_panel_results r WHERE r.panel_id=p_panel_id ORDER BY r.created_at DESC LIMIT 1) FOR UPDATE;
 IF pn.id IS NULL OR d.panel_id IS NULL THEN RAISE EXCEPTION 'Panel detection not found' USING ERRCODE='42501'; END IF;
 IF d.capture_id IS NOT NULL THEN RAISE EXCEPTION 'Panel detection already has a capture' USING ERRCODE='23505'; END IF;
 SELECT * INTO m FROM public.meters WHERE id=p_meter_id AND organization_id=pn.organization_id AND deleted_at IS NULL AND status='ACTIVE' FOR UPDATE;
 IF m.id IS NULL OR m.room_id IS NULL OR m.meter_type::text<>'ELECTRICITY' OR m.building_id IS DISTINCT FROM pn.building_id THEN
  RAISE EXCEPTION 'Meter is not an active electricity meter of this panel building' USING ERRCODE='42501'; END IF;
 SELECT * INTO prof FROM app_private.meter_capture_profiles WHERE meter_id=m.id AND organization_id=pn.organization_id AND revoked_at IS NULL;
 IF prof.meter_id IS NULL THEN RAISE EXCEPTION 'Register a valid QR profile first' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.meter_capture_panel_detections x WHERE x.panel_id=pn.id AND x.meter_id=m.id AND x.capture_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Meter already has a capture from this panel' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.meter_captures x WHERE x.object_key=d.crop_object_key) THEN
  RAISE EXCEPTION 'Panel crop already cited by another capture' USING ERRCODE='23505'; END IF;
 IF p_contract_id IS NOT NULL THEN
  SELECT * INTO ct FROM public.contracts WHERE id=p_contract_id AND organization_id=pn.organization_id AND room_id=m.room_id AND deleted_at IS NULL
   AND start_date<=pn.reading_date AND COALESCE(actual_end_date,end_date)>=pn.reading_date;
 ELSE
  IF (SELECT count(*) FROM public.contracts WHERE organization_id=pn.organization_id AND room_id=m.room_id AND deleted_at IS NULL AND status::text IN ('ACTIVE','EXTENDED','TERMINATED')
    AND start_date<=pn.reading_date AND COALESCE(actual_end_date,end_date)>=pn.reading_date)<>1 THEN RAISE EXCEPTION 'Choose the contract for this reading date' USING ERRCODE='22023'; END IF;
  SELECT * INTO ct FROM public.contracts WHERE organization_id=pn.organization_id AND room_id=m.room_id AND deleted_at IS NULL AND status::text IN ('ACTIVE','EXTENDED','TERMINATED')
   AND start_date<=pn.reading_date AND COALESCE(actual_end_date,end_date)>=pn.reading_date;
 END IF;
 IF ct.id IS NULL THEN RAISE EXCEPTION 'Capture contract scope/date mismatch' USING ERRCODE='42501'; END IF;
 SELECT r.result#>>'{ai,version}' INTO v_version FROM app_private.meter_capture_panel_results r WHERE r.job_id=d.job_id;
 SELECT count(DISTINCT x->>'timestampSeconds') INTO v_frames FROM jsonb_array_elements(d.frames) x;
 IF p_match_kind<>'QR' THEN v_issues:=v_issues||'["IDENTITY_UNVERIFIED"]'::jsonb; END IF;
 IF pn.issues ? 'DUPLICATE_MEDIA' THEN v_issues:=v_issues||'["DUPLICATE_MEDIA"]'::jsonb; END IF;
 IF d.value IS NULL THEN v_issues:=v_issues||'["ENGINE_INCOMPLETE"]'::jsonb;
 ELSE
  IF d.register_code IS DISTINCT FROM prof.register_code THEN v_issues:=v_issues||'["WRONG_REGISTER_OR_VALUE"]'::jsonb; END IF;
  IF round(d.value::numeric,prof.decimal_places)<>d.value::numeric THEN v_issues:=v_issues||'["DECIMAL_MISMATCH"]'::jsonb; END IF;
 END IF;
 IF pn.mime_type LIKE 'video/%' AND v_frames<2 THEN v_issues:=v_issues||'["INSUFFICIENT_CLEAR_FRAMES"]'::jsonb; END IF;
 INSERT INTO app_private.meter_captures(id,organization_id,building_id,room_id,meter_id,contract_id,actor_id,client_id,request_hash,purpose,reading_date,month,
  captured_at,received_at,profile_snapshot,qr_text,status,mime_type,size_bytes,sha256,duration_seconds,object_key,media_received,media_validated,issues,
  panel_id,panel_detection_index)
 VALUES(v_id,pn.organization_id,m.building_id,m.room_id,m.id,ct.id,pn.actor_id,gen_random_uuid(),
  md5(pn.id::text||':'||p_index::text||':'||m.id::text||':'||ct.id::text),pn.purpose,pn.reading_date,pn.month,pn.captured_at,clock_timestamp(),
  jsonb_build_object('qrToken','ihome-meter:'||prof.qr_token,'version',prof.version,'serialNumber',prof.serial_number,'displayKind',prof.display_kind,
   'decimalPlaces',prof.decimal_places,'registerCode',prof.register_code),
  CASE WHEN p_match_kind='QR' THEN 'ihome-meter:'||prof.qr_token END,'REVIEW','image/jpeg',d.crop_size_bytes,d.crop_sha256,NULL,d.crop_object_key,true,true,v_issues,
  pn.id,p_index);
 INSERT INTO app_private.meter_capture_jobs(id,capture_id,generation,state,attempts,worker_id) VALUES(v_job,v_id,1,'DONE',1,'panel:'||d.job_id::text);
 INSERT INTO app_private.meter_capture_frame_receipts(object_key,capture_id,job_id,sha256,timestamp_seconds)
  SELECT f.object_key,v_id,v_job,f.sha256,f.timestamp_seconds FROM app_private.meter_capture_panel_frame_receipts f
  WHERE f.panel_id=pn.id AND f.job_id=d.job_id AND ((f.object_key=d.crop_object_key AND f.timestamp_seconds=d.timestamp_seconds) OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(d.frames) x WHERE x->>'objectKey'=f.object_key AND (x->>'timestampSeconds')::numeric=f.timestamp_seconds))
  ON CONFLICT DO NOTHING;
 INSERT INTO app_private.meter_capture_results(job_id,capture_id,result) VALUES(v_job,v_id,jsonb_build_object(
  'server',jsonb_build_object('status','unreadable','value',NULL,'registerCode',prof.register_code,'unit','kWh','version','panel/1;server-reader-not-run','frames','[]'::jsonb),
  'ai',jsonb_build_object('status',CASE WHEN d.value IS NULL THEN 'unreadable' ELSE 'ok' END,'value',d.value,'registerCode',d.register_code,'unit','kWh',
   'version',COALESCE(v_version,'panel/1'),'frames',d.frames),
  'identity',jsonb_build_object('qrTokens',d.qr_tokens,'ambiguous',p_match_kind<>'QR'),'issues',v_issues,'mediaValidated',true,'durationSeconds',NULL,
  'evidence',d.frames,'panel',jsonb_build_object('panelId',pn.id,'detectionIndex',p_index,'label',d.label,'matchKind',p_match_kind,
   'assignedBy',CASE WHEN p_match_kind='MANUAL' THEN auth.uid() END)));
 UPDATE app_private.meter_capture_panel_detections SET state='MATCHED',match_kind=p_match_kind,meter_id=m.id,capture_id=v_id
  WHERE panel_id=pn.id AND detection_index=p_index AND job_id=d.job_id;
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.meter_capture_panel_v1(p_organization_id uuid,p_action text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE pn app_private.meter_capture_panels%ROWTYPE; v_id uuid; v_building uuid; v_date date; v_month text; v_hash text; v_issues jsonb:='[]';
 v_index integer;
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong meter organization' USING ERRCODE='42501'; END IF;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Expected object payload' USING ERRCODE='22023'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 IF p_action='listPanels' THEN
  RETURN jsonb_build_object('panels',COALESCE((SELECT jsonb_agg(app_private.meter_capture_panel_json_v1(x.id) ORDER BY x.created_at DESC) FROM (
   SELECT pnl.id,pnl.created_at FROM app_private.meter_capture_panels pnl WHERE pnl.organization_id=p_organization_id
    AND (p_payload->>'month' IS NULL OR pnl.month=p_payload->>'month')
    AND EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'meter_readings.view',pnl.building_id,NULL) a WHERE a.allowed)
   ORDER BY pnl.created_at DESC LIMIT 200) x),'[]'::jsonb));
 END IF;
 IF p_action='startPanel' THEN
  IF p_payload->>'buildingId' IS NULL OR p_payload->>'buildingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_payload->>'clientId' IS NULL OR p_payload->>'clientId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   RAISE EXCEPTION 'Invalid panel building/client' USING ERRCODE='22023'; END IF;
  v_building:=(p_payload->>'buildingId')::uuid;
  PERFORM app_private.meter_capture_scope_v1(p_organization_id,v_building,'meter_readings.create');
  IF p_payload->>'readingDate' IS NULL OR p_payload->>'readingDate' !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
    OR p_payload->>'capturedAt' IS NULL OR p_payload->>'capturedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$'
    -- Browsers report clip duration as an unrounded ratio (e.g. Safari 21.446666666666665).
    OR (p_payload->>'durationSeconds' IS NOT NULL AND p_payload->>'durationSeconds' !~ '^\d{1,2}(\.\d+)?$') THEN
   RAISE EXCEPTION 'Invalid panel period/media' USING ERRCODE='22023'; END IF;
  BEGIN
   v_date:=(p_payload->>'readingDate')::date;
   PERFORM (p_payload->>'capturedAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'Invalid panel period/media' USING ERRCODE='22023';
  END;
  v_month:=p_payload->>'month';
  -- A whole-building survey is a monthly reading; move-out stays a per-meter decision.
  IF v_date IS NULL OR v_month IS DISTINCT FROM to_char(v_date,'YYYY-MM') OR p_payload->>'purpose' IS DISTINCT FROM 'MONTHLY'
    OR p_payload->>'mimeType' IS NULL OR p_payload->>'mimeType' NOT IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime')
    OR p_payload->>'sha256' IS NULL OR p_payload->>'sha256' !~ '^[a-f0-9]{64}$'
    OR p_payload->>'sizeBytes' IS NULL OR p_payload->>'sizeBytes' !~ '^\d{1,9}$' OR (p_payload->>'sizeBytes')::bigint NOT BETWEEN 1 AND 104857600
    OR (p_payload->>'capturedAt')::timestamptz IS NULL
    OR (p_payload->>'mimeType' LIKE 'video/%' AND ((p_payload->>'durationSeconds')::numeric IS NULL OR (p_payload->>'durationSeconds')::numeric<=0 OR (p_payload->>'durationSeconds')::numeric>60))
    OR (p_payload->>'mimeType' LIKE 'image/%' AND p_payload->>'durationSeconds' IS NOT NULL) THEN
   RAISE EXCEPTION 'Invalid panel period/media' USING ERRCODE='22023'; END IF;
  v_hash:=md5(p_payload::text);
  SELECT * INTO pn FROM app_private.meter_capture_panels WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND client_id=(p_payload->>'clientId')::uuid;
  IF FOUND THEN
   IF pn.request_hash<>v_hash THEN RAISE EXCEPTION 'Panel request reused with different facts' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('panel',app_private.meter_capture_panel_json_v1(pn.id),'uploadPath',pn.object_key,'bucket','meter-capture-media');
  END IF;
  v_id:=gen_random_uuid();
  IF EXISTS(SELECT 1 FROM app_private.meter_capture_panels x WHERE x.organization_id=p_organization_id AND x.sha256=p_payload->>'sha256')
    OR EXISTS(SELECT 1 FROM app_private.meter_captures x WHERE x.organization_id=p_organization_id AND x.sha256=p_payload->>'sha256') THEN
   v_issues:='["DUPLICATE_MEDIA"]'; END IF;
  INSERT INTO app_private.meter_capture_panels(id,organization_id,building_id,actor_id,client_id,request_hash,purpose,reading_date,month,captured_at,
   mime_type,size_bytes,sha256,duration_seconds,object_key,issues)
  VALUES(v_id,p_organization_id,v_building,auth.uid(),(p_payload->>'clientId')::uuid,v_hash,p_payload->>'purpose',v_date,v_month,(p_payload->>'capturedAt')::timestamptz,
   p_payload->>'mimeType',(p_payload->>'sizeBytes')::bigint,p_payload->>'sha256',(p_payload->>'durationSeconds')::numeric,
   p_organization_id::text||'/meter-panels/'||v_id::text||'/original',v_issues);
  RETURN jsonb_build_object('panel',app_private.meter_capture_panel_json_v1(v_id),'uploadPath',p_organization_id::text||'/meter-panels/'||v_id::text||'/original','bucket','meter-capture-media');
 END IF;
 IF p_action NOT IN ('getPanel','finalizePanel','assignDetection','panelEvidence') THEN RAISE EXCEPTION 'Unsupported panel action' USING ERRCODE='22023'; END IF;
 IF (p_payload->>'panelId' IS NOT NULL AND p_payload->>'panelId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   OR (p_payload->>'panelId' IS NULL AND COALESCE(p_payload->>'clientId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
  RAISE EXCEPTION 'Invalid panel reference' USING ERRCODE='22023'; END IF;
 SELECT * INTO pn FROM app_private.meter_capture_panels WHERE organization_id=p_organization_id AND
  ((p_payload->>'panelId' IS NOT NULL AND id=(p_payload->>'panelId')::uuid) OR
   (p_payload->>'panelId' IS NULL AND client_id=(p_payload->>'clientId')::uuid AND actor_id=auth.uid())) FOR UPDATE;
 IF NOT FOUND THEN
  IF p_action='getPanel' AND p_payload->>'panelId' IS NULL THEN RETURN jsonb_build_object('panel',NULL); END IF;
  RAISE EXCEPTION 'Meter panel not found' USING ERRCODE='42501';
 END IF;
 PERFORM app_private.meter_capture_scope_v1(p_organization_id,pn.building_id,CASE WHEN p_action IN ('finalizePanel','assignDetection') THEN 'meter_readings.create' ELSE 'meter_readings.view' END);
 IF p_action='panelEvidence' THEN
  RETURN jsonb_build_object('evidence',jsonb_build_object('panelId',pn.id,
   'imageObjectKey',CASE WHEN pn.mime_type LIKE 'image/%' AND pn.media_received THEN pn.object_key END,
   'videoObjectKey',CASE WHEN pn.mime_type LIKE 'video/%' AND pn.media_received THEN pn.object_key END,
   'evidenceFrames',COALESCE((SELECT jsonb_agg(jsonb_build_object('objectKey',y.object_key,'timestampSeconds',y.ts) ORDER BY y.ts,y.object_key) FROM (
     SELECT DISTINCT x->>'objectKey' AS object_key,(x->>'timestampSeconds')::numeric AS ts
     FROM app_private.meter_capture_panel_detections d CROSS JOIN LATERAL jsonb_array_elements(d.frames) x
     WHERE d.panel_id=pn.id AND d.job_id=(SELECT r.job_id FROM app_private.meter_capture_panel_results r WHERE r.panel_id=pn.id ORDER BY r.created_at DESC LIMIT 1)
     ORDER BY 2,1 LIMIT 6) y),'[]'::jsonb)));
 ELSIF p_action='finalizePanel' THEN
  IF NOT pn.media_received THEN RAISE EXCEPTION 'Original media has not been verified by storage service' USING ERRCODE='55000'; END IF;
  IF p_payload->>'sha256' IS DISTINCT FROM pn.sha256 OR (p_payload->>'sizeBytes')::bigint IS DISTINCT FROM pn.size_bytes THEN RAISE EXCEPTION 'Original media receipt mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.meter_capture_panel_jobs(panel_id) SELECT pn.id WHERE NOT EXISTS(SELECT 1 FROM app_private.meter_capture_panel_jobs WHERE panel_id=pn.id);
  UPDATE app_private.meter_capture_panels SET status='QUEUED',version=version+1 WHERE id=pn.id AND status='AWAITING_UPLOAD';
 ELSIF p_action='assignDetection' THEN
  IF pn.status<>'REVIEW' OR NOT pn.media_validated THEN RAISE EXCEPTION 'Panel is not ready for assignment' USING ERRCODE='55000'; END IF;
  IF p_payload->>'detectionIndex' IS NULL OR p_payload->>'detectionIndex' !~ '^\d{1,2}$'
    OR p_payload->>'meterId' IS NULL OR p_payload->>'meterId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (p_payload->>'contractId' IS NOT NULL AND p_payload->>'contractId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
   RAISE EXCEPTION 'Invalid panel assignment' USING ERRCODE='22023'; END IF;
  v_index:=(p_payload->>'detectionIndex')::int;
  PERFORM app_private.meter_capture_panel_child_v1(pn.id,v_index,(p_payload->>'meterId')::uuid,NULLIF(p_payload->>'contractId','')::uuid,'MANUAL');
  UPDATE app_private.meter_capture_panels SET version=version+1 WHERE id=pn.id;
 END IF;
 RETURN jsonb_build_object('panel',app_private.meter_capture_panel_json_v1(pn.id));
END $$;

CREATE OR REPLACE FUNCTION public.meter_capture_panel_media_receipt_v1(p_panel_id uuid,p_object_key text,p_sha256 text,p_size_bytes bigint,p_mime_type text,p_duration_seconds numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE pn app_private.meter_capture_panels%ROWTYPE;
BEGIN
 SELECT * INTO pn FROM app_private.meter_capture_panels WHERE id=p_panel_id FOR UPDATE;
 IF NOT FOUND OR pn.object_key IS DISTINCT FROM p_object_key OR pn.sha256 IS DISTINCT FROM p_sha256 OR pn.size_bytes IS DISTINCT FROM p_size_bytes OR pn.mime_type IS DISTINCT FROM p_mime_type THEN RAISE EXCEPTION 'Original media receipt mismatch' USING ERRCODE='22023'; END IF;
 IF p_mime_type LIKE 'video/%' AND p_duration_seconds IS NOT NULL AND (p_duration_seconds<=0 OR p_duration_seconds>60 OR abs(p_duration_seconds-pn.duration_seconds)>1) THEN RAISE EXCEPTION 'Clip duration invalid' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='meter-capture-media' AND name=p_object_key) THEN RAISE EXCEPTION 'Original object not persisted' USING ERRCODE='55000'; END IF;
 UPDATE app_private.meter_capture_panels SET media_received=true,received_at=COALESCE(received_at,clock_timestamp()) WHERE id=pn.id;
 RETURN jsonb_build_object('panelId',pn.id,'mediaReceived',true);
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_panel_job_json_v1(p_job uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('kind','panel','jobId',j.id,'panelId',p.id,'organizationId',p.organization_id,'leaseToken',j.lease_token,
  'media',jsonb_build_array(jsonb_build_object('id',p.id,'objectKey',p.object_key,'mimeType',p.mime_type,'sizeBytes',p.size_bytes,'sha256',p.sha256,
   'kind',CASE WHEN p.mime_type LIKE 'video/%' THEN 'video' ELSE 'image' END,'durationSeconds',p.duration_seconds)))
 FROM app_private.meter_capture_panel_jobs j JOIN app_private.meter_capture_panels p ON p.id=j.panel_id WHERE j.id=p_job
$$;
CREATE OR REPLACE FUNCTION public.meter_capture_panel_claim_v1(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE j app_private.meter_capture_panel_jobs%ROWTYPE;
BEGIN
 IF NULLIF(btrim(p_worker_id),'') IS NULL OR length(p_worker_id)>100 THEN RAISE EXCEPTION 'Invalid worker identifier' USING ERRCODE='22023'; END IF;
 WITH exhausted AS (
  UPDATE app_private.meter_capture_panel_jobs SET state='FAILED',lease_until=NULL
   WHERE state='RUNNING' AND lease_until<clock_timestamp() AND attempts>=3 RETURNING panel_id
 )
 UPDATE app_private.meter_capture_panels pnl SET status='REVIEW',issues=pnl.issues||'["WORKER_LEASE_EXHAUSTED"]'::jsonb,version=pnl.version+1
 FROM exhausted WHERE pnl.id=exhausted.panel_id;
 SELECT jobs.* INTO j FROM app_private.meter_capture_panel_jobs jobs JOIN app_private.meter_capture_panels pnl ON pnl.id=jobs.panel_id
  WHERE pnl.media_received AND jobs.created_at<=clock_timestamp() AND (jobs.state='QUEUED' OR (jobs.state='RUNNING' AND jobs.lease_until<clock_timestamp())) AND jobs.attempts<3
  ORDER BY jobs.created_at FOR UPDATE OF jobs SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE app_private.meter_capture_panel_jobs SET state='RUNNING',worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '10 minutes',attempts=attempts+1 WHERE id=j.id;
 UPDATE app_private.meter_capture_panels SET status='PROCESSING',version=version+1 WHERE id=j.panel_id;
 RETURN app_private.meter_capture_panel_job_json_v1(j.id);
END $$;
CREATE OR REPLACE FUNCTION public.meter_capture_panel_worker_context_v1(p_job_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_panel_jobs WHERE id=p_job_id AND lease_token=p_lease_token AND state='RUNNING' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'Worker lease expired' USING ERRCODE='PT409'; END IF;
 RETURN app_private.meter_capture_panel_job_json_v1(p_job_id);
END $$;
CREATE OR REPLACE FUNCTION public.meter_capture_panel_evidence_receipt_v1(p_job_id uuid,p_lease_token uuid,p_object_key text,p_sha256 text,p_timestamp_seconds numeric)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE pn app_private.meter_capture_panels%ROWTYPE;
BEGIN
 PERFORM public.meter_capture_panel_worker_context_v1(p_job_id,p_lease_token);
 SELECT p.* INTO pn FROM app_private.meter_capture_panels p JOIN app_private.meter_capture_panel_jobs j ON j.panel_id=p.id WHERE j.id=p_job_id;
 IF p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$' OR p_object_key IS DISTINCT FROM pn.organization_id::text||'/meter-panels/'||pn.id::text||'/evidence/'||p_sha256||'.jpg'
  -- The declared clip duration is browser-measured; allow the same 1 s tolerance as the media receipt.
  OR p_timestamp_seconds IS NULL OR p_timestamp_seconds<0 OR p_timestamp_seconds>COALESCE(pn.duration_seconds+1,0)
  OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='meter-capture-media' AND name=p_object_key) THEN RAISE EXCEPTION 'Evidence frame scope/persistence mismatch' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.meter_capture_panel_frame_receipts(object_key,panel_id,job_id,sha256,timestamp_seconds)
 VALUES(p_object_key,pn.id,p_job_id,p_sha256,p_timestamp_seconds) ON CONFLICT(job_id,object_key,timestamp_seconds) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_panel_frame_receipts WHERE object_key=p_object_key AND panel_id=pn.id AND job_id=p_job_id AND sha256=p_sha256 AND timestamp_seconds=p_timestamp_seconds) THEN RAISE EXCEPTION 'Evidence frame receipt reused differently' USING ERRCODE='23505'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.meter_capture_panel_complete_v1(p_job_id uuid,p_lease_token uuid,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE j app_private.meter_capture_panel_jobs%ROWTYPE; pn app_private.meter_capture_panels%ROWTYPE; d app_private.meter_capture_panel_detections%ROWTYPE;
 v_org uuid; v_issues jsonb; det jsonb; frame jsonb; v_seen integer[]:='{}'; v_index integer; v_ok boolean; v_matched integer:=0;
 v_meter uuid; v_kind text; v_state text; v_n integer; v_total integer; v_profiled integer; v_room uuid; v_text text; v_tokens text[];
BEGIN
 -- Same lock order as the user actions: organization decision lock, then panel rows.
 SELECT pnl.organization_id INTO v_org FROM app_private.meter_capture_panel_jobs jj JOIN app_private.meter_capture_panels pnl ON pnl.id=jj.panel_id WHERE jj.id=p_job_id;
 IF v_org IS NULL THEN RAISE EXCEPTION 'Worker lease expired' USING ERRCODE='PT409'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(v_org);
 SELECT * INTO j FROM app_private.meter_capture_panel_jobs WHERE id=p_job_id FOR UPDATE;
 IF j.state='DONE' AND j.lease_token=p_lease_token THEN
  IF (SELECT result FROM app_private.meter_capture_panel_results WHERE job_id=j.id) IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'Immutable worker result differs' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('ok',true);
 END IF;
 PERFORM public.meter_capture_panel_worker_context_v1(p_job_id,p_lease_token);
 SELECT * INTO pn FROM app_private.meter_capture_panels WHERE id=j.panel_id FOR UPDATE;
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR jsonb_typeof(p_result->'issues') IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_result->'detections') IS DISTINCT FROM 'array' OR jsonb_array_length(p_result->'detections')>40
   OR jsonb_typeof(p_result->'ai') IS DISTINCT FROM 'object' OR p_result#>>'{ai,status}' IS NULL OR p_result#>>'{ai,status}' NOT IN ('ok','unreadable','error')
   OR NULLIF(p_result#>>'{ai,version}','') IS NULL OR length(p_result#>>'{ai,version}')>200
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'issues') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>64) THEN
  RAISE EXCEPTION 'Invalid panel worker output' USING ERRCODE='22023'; END IF;
 -- Server-set flags (DUPLICATE_MEDIA at start, WORKER_LEASE_EXHAUSTED) survive every worker result;
 -- codes from an earlier worker attempt do not outlive a successful retry.
 v_issues:=(SELECT COALESCE(jsonb_agg(DISTINCT x),'[]'::jsonb) FROM jsonb_array_elements(
  (SELECT COALESCE(jsonb_agg(f),'[]'::jsonb) FROM jsonb_array_elements(pn.issues) f WHERE f#>>'{}' IN ('DUPLICATE_MEDIA','WORKER_LEASE_EXHAUSTED'))
  ||(p_result->'issues')) x);
 IF p_result->>'mediaValidated' IS DISTINCT FROM 'true' THEN v_issues:=v_issues||'"MEDIA_VALIDATION_FAILED"'::jsonb; END IF;
 IF pn.mime_type LIKE 'video/%' AND (p_result->>'mediaValidated' IS DISTINCT FROM 'true' OR jsonb_typeof(p_result->'durationSeconds') IS DISTINCT FROM 'number'
   OR (p_result->>'durationSeconds')::numeric<=0 OR (p_result->>'durationSeconds')::numeric>60) THEN
  v_issues:=v_issues||'"MEDIA_VALIDATION_FAILED"'::jsonb; END IF;
 v_ok:=p_result#>>'{ai,status}'='ok' AND NOT v_issues ? 'MEDIA_VALIDATION_FAILED';
 INSERT INTO app_private.meter_capture_panel_results(job_id,panel_id,result) VALUES(j.id,pn.id,p_result);
 IF v_ok THEN
  FOR det IN SELECT value FROM jsonb_array_elements(p_result->'detections') LOOP
   IF jsonb_typeof(det) IS DISTINCT FROM 'object' OR jsonb_typeof(det->'index') IS DISTINCT FROM 'number' OR det->>'index' !~ '^\d{1,2}$'
     OR COALESCE(jsonb_typeof(det->'label'),'missing') NOT IN ('string','null') OR COALESCE(jsonb_typeof(det->'registerCode'),'missing') NOT IN ('string','null')
     OR COALESCE(jsonb_typeof(det->'display'),'missing') NOT IN ('string','null') OR COALESCE(jsonb_typeof(det->'value'),'missing') NOT IN ('string','null')
     OR jsonb_typeof(det->'clear') IS DISTINCT FROM 'boolean' OR jsonb_typeof(det->'qrTokens') IS DISTINCT FROM 'array' OR jsonb_array_length(det->'qrTokens')>4
     OR jsonb_typeof(det->'crop') IS DISTINCT FROM 'object' OR jsonb_typeof(det->'frames') IS DISTINCT FROM 'array'
     OR jsonb_array_length(det->'frames') NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'Invalid panel detection' USING ERRCODE='22023'; END IF;
   v_index:=(det->>'index')::int;
   IF v_index>39 OR v_index=ANY(v_seen) OR (det->>'label' IS NOT NULL AND length(det->>'label') NOT BETWEEN 1 AND 20)
     OR (det->>'registerCode' IS NOT NULL AND length(det->>'registerCode') NOT BETWEEN 1 AND 40)
     OR (det->>'display' IS NOT NULL AND det->>'display' NOT IN ('mechanical','digital'))
     OR (det->>'value' IS NOT NULL AND det->>'value' !~ '^\d{1,8}(\.\d{1,2})?$') OR (det->>'clear'='false' AND det->>'value' IS NOT NULL)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(det->'qrTokens') q WHERE jsonb_typeof(q)<>'string' OR q#>>'{}' !~* '^ihome-meter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR det#>>'{crop,sha256}' IS NULL OR det#>>'{crop,sha256}' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(det#>'{crop,sizeBytes}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(det#>'{crop,timestampSeconds}') IS DISTINCT FROM 'number' OR jsonb_typeof(det#>'{crop,objectKey}') IS DISTINCT FROM 'string'
     OR NOT EXISTS(SELECT 1 FROM app_private.meter_capture_panel_frame_receipts f WHERE f.job_id=j.id AND f.object_key=det#>>'{crop,objectKey}'
      AND f.timestamp_seconds=(det#>>'{crop,timestampSeconds}')::numeric AND f.sha256=det#>>'{crop,sha256}') THEN
    RAISE EXCEPTION 'Invalid panel detection' USING ERRCODE='22023'; END IF;
   v_seen:=v_seen||v_index;
   FOR frame IN SELECT value FROM jsonb_array_elements(det->'frames') LOOP
    IF jsonb_typeof(frame) IS DISTINCT FROM 'object' OR jsonb_typeof(frame->'timestampSeconds') IS DISTINCT FROM 'number' OR jsonb_typeof(frame->'objectKey') IS DISTINCT FROM 'string'
      OR NOT EXISTS(SELECT 1 FROM app_private.meter_capture_panel_frame_receipts f WHERE f.job_id=j.id AND f.object_key=frame->>'objectKey'
       AND f.timestamp_seconds=(frame->>'timestampSeconds')::numeric) THEN RAISE EXCEPTION 'Unverified frame cannot be cited' USING ERRCODE='22023'; END IF;
   END LOOP;
   INSERT INTO app_private.meter_capture_panel_detections(panel_id,job_id,detection_index,label,register_code,display,value,clear,qr_tokens,
    crop_object_key,crop_sha256,crop_size_bytes,timestamp_seconds,frames,state)
   VALUES(pn.id,j.id,v_index,det->>'label',det->>'registerCode',det->>'display',det->>'value',(det->>'clear')::boolean,det->'qrTokens',
    det#>>'{crop,objectKey}',det#>>'{crop,sha256}',(det#>>'{crop,sizeBytes}')::bigint,(det#>>'{crop,timestampSeconds}')::numeric,
    (SELECT jsonb_agg(jsonb_build_object('objectKey',x->>'objectKey','timestampSeconds',(x->>'timestampSeconds')::numeric)) FROM jsonb_array_elements(det->'frames') x),
    'UNMATCHED');
  END LOOP;
  FOR d IN SELECT * FROM app_private.meter_capture_panel_detections WHERE panel_id=pn.id AND job_id=j.id ORDER BY detection_index LOOP
   v_meter:=NULL;v_kind:=NULL;v_state:='UNMATCHED';
   SELECT array_agg(x) INTO v_tokens FROM jsonb_array_elements_text(d.qr_tokens) x;
   -- The room the label names in this building (exactly one), if any.
   v_room:=NULL;
   IF app_private.meter_capture_panel_norm_v1(d.label) IS NOT NULL THEN
    SELECT count(*),min(r.id::text) INTO v_n,v_text FROM public.rooms r WHERE r.organization_id=pn.organization_id AND r.building_id=pn.building_id
     AND r.deleted_at IS NULL AND app_private.meter_capture_panel_norm_v1(r.name)=app_private.meter_capture_panel_norm_v1(d.label);
    IF v_n=1 THEN v_room:=v_text::uuid; ELSIF v_n>1 THEN v_state:='AMBIGUOUS'; END IF;
   END IF;
   IF COALESCE(array_length(v_tokens,1),0)>0 THEN
    SELECT count(DISTINCT pr.meter_id),min(pr.meter_id::text) INTO v_n,v_text FROM app_private.meter_capture_profiles pr
     WHERE pr.organization_id=pn.organization_id AND pr.revoked_at IS NULL AND 'ihome-meter:'||pr.qr_token::text=ANY(v_tokens);
    IF v_n=1 THEN
     IF EXISTS(SELECT 1 FROM public.meters m WHERE m.id=v_text::uuid AND m.organization_id=pn.organization_id AND m.building_id=pn.building_id
       AND m.deleted_at IS NULL AND m.status='ACTIVE' AND m.meter_type::text='ELECTRICITY' AND m.room_id IS NOT NULL) THEN
      -- A QR sticker never silently overrides a room label that names a different room.
      IF v_room IS NOT NULL AND v_room IS DISTINCT FROM (SELECT m.room_id FROM public.meters m WHERE m.id=v_text::uuid) THEN v_state:='AMBIGUOUS';
      ELSE v_meter:=v_text::uuid;v_kind:='QR';v_state:='MATCHED'; END IF;
     ELSIF EXISTS(SELECT 1 FROM public.meters m WHERE m.id=v_text::uuid AND m.organization_id=pn.organization_id AND m.building_id IS DISTINCT FROM pn.building_id) THEN
      v_state:='OTHER_BUILDING';
     END IF;
    ELSIF v_n>1 THEN v_state:='AMBIGUOUS'; END IF;
   END IF;
   IF v_state='UNMATCHED' AND v_kind IS NULL AND v_room IS NOT NULL THEN
    -- Only a room with exactly one active electricity meter is unambiguous; a sub-meter must not
    -- be billed as the room's registered meter.
    SELECT count(*),count(pr.meter_id),min(CASE WHEN pr.meter_id IS NOT NULL THEN m.id::text END) INTO v_total,v_profiled,v_text
     FROM public.meters m LEFT JOIN app_private.meter_capture_profiles pr ON pr.meter_id=m.id AND pr.organization_id=m.organization_id AND pr.revoked_at IS NULL
     WHERE m.organization_id=pn.organization_id AND m.building_id=pn.building_id AND m.room_id=v_room AND m.deleted_at IS NULL
      AND m.status='ACTIVE' AND m.meter_type::text='ELECTRICITY';
    IF v_total=1 AND v_profiled=1 THEN v_meter:=v_text::uuid;v_kind:='LABEL';v_state:='MATCHED';
    ELSIF v_total>1 THEN v_state:='AMBIGUOUS';
    ELSIF v_total=1 THEN v_state:='NO_PROFILE'; END IF;
   END IF;
   UPDATE app_private.meter_capture_panel_detections SET state=v_state,match_kind=v_kind,meter_id=v_meter
    WHERE panel_id=pn.id AND job_id=j.id AND detection_index=d.detection_index;
  END LOOP;
  -- One survey cannot read the same meter twice; a reviewer decides which detection is right.
  UPDATE app_private.meter_capture_panel_detections x SET state='DUPLICATE',match_kind=NULL
   WHERE x.panel_id=pn.id AND x.job_id=j.id AND x.state='MATCHED' AND x.meter_id IN (
    SELECT y.meter_id FROM app_private.meter_capture_panel_detections y WHERE y.panel_id=pn.id AND y.job_id=j.id AND y.state='MATCHED'
    GROUP BY y.meter_id HAVING count(*)>1);
  FOR d IN SELECT * FROM app_private.meter_capture_panel_detections WHERE panel_id=pn.id AND job_id=j.id AND state='MATCHED' ORDER BY detection_index LOOP
   IF EXISTS(SELECT 1 FROM app_private.meter_captures c WHERE c.object_key=d.crop_object_key) THEN
    UPDATE app_private.meter_capture_panel_detections SET state='DUPLICATE',match_kind=NULL WHERE panel_id=pn.id AND job_id=j.id AND detection_index=d.detection_index;
    CONTINUE;
   END IF;
   SELECT count(*) INTO v_n FROM public.contracts ct JOIN public.meters m ON m.room_id=ct.room_id
    WHERE m.id=d.meter_id AND ct.organization_id=pn.organization_id AND ct.deleted_at IS NULL AND ct.status::text IN ('ACTIVE','EXTENDED','TERMINATED')
     AND ct.start_date<=pn.reading_date AND COALESCE(ct.actual_end_date,ct.end_date)>=pn.reading_date;
   IF v_n<>1 THEN
    UPDATE app_private.meter_capture_panel_detections SET state='NO_CONTRACT',match_kind=NULL WHERE panel_id=pn.id AND job_id=j.id AND detection_index=d.detection_index;
    CONTINUE;
   END IF;
   PERFORM app_private.meter_capture_panel_child_v1(pn.id,d.detection_index,d.meter_id,NULL,d.match_kind);
   v_matched:=v_matched+1;
  END LOOP;
 END IF;
 IF p_result#>>'{ai,status}' IN ('ok','unreadable') AND jsonb_array_length(p_result->'detections')=0 AND NOT v_issues ? 'NO_METERS_DETECTED'
   AND NOT v_issues ? 'worker_result_rejected' THEN
  v_issues:=v_issues||'"NO_METERS_DETECTED"'::jsonb; END IF;
 UPDATE app_private.meter_capture_panel_jobs SET state='DONE',lease_until=NULL WHERE id=j.id;
 UPDATE app_private.meter_capture_panels SET issues=v_issues,media_validated=NOT v_issues ? 'MEDIA_VALIDATION_FAILED',version=version+1,status='REVIEW' WHERE id=pn.id;
 IF p_result#>>'{ai,status}'='error' AND j.generation<3 AND NOT v_issues ? 'MEDIA_VALIDATION_FAILED' THEN
  INSERT INTO app_private.meter_capture_panel_jobs(panel_id,generation,created_at) VALUES(pn.id,j.generation+1,clock_timestamp()+interval '1 minute') ON CONFLICT DO NOTHING;
 END IF;
 RETURN jsonb_build_object('ok',true,'issues',v_issues,'detections',jsonb_array_length(p_result->'detections'),'matched',v_matched);
END $$;

-- Storage: body of 20261022144130 plus the panel branch (original upload by its actor; reads of the
-- original and of receipted panel evidence, which also backs child captures' crops and frames).
CREATE OR REPLACE FUNCTION public.meter_capture_storage_allowed_v1(p_name text,p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;pnl app_private.meter_capture_panels%ROWTYPE;v_org uuid;v_building uuid;v_allowed boolean;
BEGIN
 IF auth.uid() IS NULL THEN RETURN false; END IF;
 IF split_part(p_name,'/',2)='profiles' THEN
  SELECT m.organization_id,m.building_id INTO v_org,v_building FROM public.meters m
   WHERE m.id::text=split_part(p_name,'/',3) AND m.organization_id::text=split_part(p_name,'/',1) AND m.deleted_at IS NULL;
  IF v_org IS NULL OR NOT COALESCE(v_org=ANY(public.my_org_ids()),false) THEN RETURN false; END IF;
  IF p_write AND (split_part(p_name,'/',4)<>auth.uid()::text OR split_part(p_name,'/',5)='' OR split_part(p_name,'/',6)<>'') THEN RETURN false; END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),v_org,CASE WHEN p_write THEN 'meters.edit' ELSE 'meter_readings.view' END,v_building,NULL);
  RETURN COALESCE(v_allowed,false);
 END IF;
 IF split_part(p_name,'/',2)='meter-panels' THEN
  SELECT pn.* INTO pnl FROM app_private.meter_capture_panels pn WHERE pn.organization_id::text=split_part(p_name,'/',1) AND pn.id::text=split_part(p_name,'/',3);
  IF pnl.id IS NULL OR NOT COALESCE(pnl.organization_id=ANY(public.my_org_ids()),false) THEN RETURN false; END IF;
  IF p_write AND (pnl.object_key<>p_name OR pnl.actor_id<>auth.uid() OR pnl.media_received) THEN RETURN false; END IF;
  IF NOT p_write AND p_name<>pnl.object_key AND NOT EXISTS(SELECT 1 FROM app_private.meter_capture_panel_frame_receipts WHERE panel_id=pnl.id AND object_key=p_name) THEN RETURN false; END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),pnl.organization_id,CASE WHEN p_write THEN 'meter_readings.create' ELSE 'meter_readings.view' END,pnl.building_id,NULL);
  RETURN COALESCE(v_allowed,false);
 END IF;
 SELECT cap.* INTO c FROM app_private.meter_captures cap WHERE cap.organization_id::text=split_part(p_name,'/',1)
  AND cap.id::text=split_part(p_name,'/',3) AND split_part(p_name,'/',2)='meter-captures';
 IF c.id IS NULL OR NOT COALESCE(c.organization_id=ANY(public.my_org_ids()),false) THEN RETURN false; END IF;
 IF p_write AND (c.object_key<>p_name OR c.actor_id<>auth.uid() OR c.media_received) THEN RETURN false; END IF;
 IF NOT p_write AND p_name<>c.object_key AND NOT EXISTS(SELECT 1 FROM app_private.meter_capture_frame_receipts WHERE capture_id=c.id AND object_key=p_name) THEN RETURN false; END IF;
 SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,CASE WHEN p_write THEN 'meter_readings.create' ELSE 'meter_readings.view' END,c.building_id,NULL);
 RETURN COALESCE(v_allowed,false);
END $$;

DO $acl$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','app_private') AND p.proname LIKE 'meter_capture_panel%' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.meter_capture_panel_v1(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.meter_capture_panel_claim_v1(text),public.meter_capture_panel_worker_context_v1(uuid,uuid),
 public.meter_capture_panel_media_receipt_v1(uuid,text,text,bigint,text,numeric),public.meter_capture_panel_evidence_receipt_v1(uuid,uuid,text,text,numeric),
 public.meter_capture_panel_complete_v1(uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
