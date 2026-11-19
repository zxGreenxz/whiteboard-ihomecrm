-- Sol is the primary proposal; OCR remains an independent check. Human approval is unchanged.
BEGIN;

-- Keep the approved baseline visible before confirmation, within the same meter/contract/date.
CREATE OR REPLACE FUNCTION app_private.meter_capture_previous_value_v1(p_id uuid)
RETURNS numeric LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_previous numeric;v_start_date date;
BEGIN
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF c.status='CONFIRMED' THEN RETURN c.previous_value; END IF;
 SELECT start_date INTO v_start_date FROM public.contracts WHERE id=c.contract_id AND organization_id=c.organization_id AND deleted_at IS NULL;
 SELECT current_reading INTO v_previous FROM public.meter_readings WHERE meter_id=c.meter_id AND contract_id=c.contract_id AND organization_id=c.organization_id
  AND deleted_at IS NULL AND status='APPROVED' AND reading_date>=v_start_date AND reading_date<=c.reading_date
  ORDER BY reading_date DESC,created_at DESC,id DESC LIMIT 1;
 IF v_previous IS NULL THEN
  SELECT (x#>>'{start,value}')::numeric INTO v_previous FROM jsonb_array_elements(app_private.meter_capture_resolve_billing_v1(c.organization_id,
   jsonb_build_object('contractId',c.contract_id,'month',c.month,'readingDate',c.reading_date,'purpose',c.purpose))->'meters') x WHERE x->>'meterId'=c.meter_id::text;
 END IF;
 RETURN v_previous;
END $$;

-- Evidence is taken only from persisted receipts of the result pinned at approval time.
CREATE OR REPLACE FUNCTION app_private.meter_capture_evidence_frames_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('objectKey',e.object_key,'timestampSeconds',e.timestamp_seconds)
  ORDER BY e.timestamp_seconds,e.object_key),'[]'::jsonb)
 FROM (SELECT f.object_key,f.timestamp_seconds FROM app_private.meter_captures c
  JOIN LATERAL (SELECT res.job_id FROM app_private.meter_capture_results res WHERE res.capture_id=c.id
   AND res.created_at<=COALESCE(c.confirmed_at,'infinity'::timestamptz) ORDER BY res.created_at DESC LIMIT 1) r ON true
  JOIN app_private.meter_capture_frame_receipts f ON f.capture_id=c.id AND f.job_id=r.job_id
  WHERE c.id=p_id ORDER BY f.timestamp_seconds,f.object_key LIMIT 6) e
$$;
REVOKE ALL ON FUNCTION app_private.meter_capture_previous_value_v1(uuid),app_private.meter_capture_evidence_frames_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.meter_capture_json_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('id',c.id,'clientId',c.client_id,'organizationId',c.organization_id,'meterId',c.meter_id,
  'buildingId',c.building_id,'roomId',c.room_id,'contractId',c.contract_id,'purpose',c.purpose,'readingDate',c.reading_date,
  'orgId',c.organization_id,'month',c.month,'capturedAt',c.captured_at,'receivedAt',c.received_at,'status',CASE WHEN c.status='AWAITING_UPLOAD' THEN 'UPLOADING' ELSE c.status END,'version',c.version,
  'mimeType',c.mime_type,'sizeBytes',c.size_bytes,'sha256',c.sha256,'durationSeconds',c.duration_seconds,
  'objectKey',c.object_key,'originalObjectKey',c.object_key,'mediaReceived',c.media_received,'mediaValidated',c.media_validated,'readingId',c.reading_id,
  'imageObjectKey',CASE WHEN c.mime_type LIKE 'image/%' THEN c.object_key ELSE app_private.meter_capture_selected_frame_v1(c.id)->>'objectKey' END,
  'videoObjectKey',CASE WHEN c.mime_type LIKE 'video/%' THEN c.object_key END,
  'previousValue',app_private.meter_capture_previous_value_v1(c.id)::text,'evidenceFrames',app_private.meter_capture_evidence_frames_v1(c.id),
  'value',c.confirmed_value::text,'reason',c.reason,'issues',c.issues||app_private.meter_capture_anomaly_v1(c.id,
   CASE WHEN COALESCE(c.confirmed_value::text,r.result#>>'{ai,value}',r.result#>>'{server,value}')~'^\d{1,8}(\.\d{1,2})?$'
   THEN COALESCE(c.confirmed_value::text,r.result#>>'{ai,value}',r.result#>>'{server,value}')::numeric END,c.previous_value),'result',r.result,
  'proposedValue',COALESCE(c.confirmed_value::text,r.result#>>'{ai,value}',r.result#>>'{server,value}'),
  'serverResult',r.result->'server','aiResult',r.result->'ai','evidenceUrl',NULL,'videoUrl',NULL,'confirmedReadingId',c.reading_id)
 FROM app_private.meter_captures c LEFT JOIN LATERAL (SELECT result FROM app_private.meter_capture_results res WHERE res.capture_id=c.id
  AND res.created_at<=COALESCE(c.confirmed_at,'infinity'::timestamptz) ORDER BY res.created_at DESC LIMIT 1) r ON true WHERE c.id=p_id
$$;

CREATE OR REPLACE FUNCTION public.meter_capture_v1(p_organization_id uuid,p_action text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE m public.meters%ROWTYPE; p app_private.meter_capture_profiles%ROWTYPE; c app_private.meter_captures%ROWTYPE;
 ct public.contracts%ROWTYPE; v_id uuid; v_before jsonb; v_value numeric; v_previous numeric; v_result jsonb;v_anomaly jsonb;
 v_reason text:=NULLIF(btrim(p_payload->>'reason'),''); v_hash text; v_qr text; v_month text; v_date date;
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong meter organization' USING ERRCODE='42501'; END IF;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Expected object payload' USING ERRCODE='22023'; END IF;
 IF p_action='documentReceipt' THEN
  IF p_payload->>'kind' IS NULL OR p_payload->>'kind' NOT IN ('invoice','exit') OR NULLIF(p_payload->>'idempotencyKey','') IS NULL THEN RAISE EXCEPTION 'Invalid document receipt key' USING ERRCODE='22023'; END IF;
  SELECT result INTO v_result FROM app_private.meter_capture_document_requests WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=(p_payload->>'kind')||':'||(p_payload->>'idempotencyKey');
  IF v_result IS NOT NULL THEN
   IF p_payload->>'kind'='invoice' THEN SELECT building_id INTO v_id FROM public.invoices WHERE id=(v_result->>'invoice_id')::uuid AND organization_id=p_organization_id;
   ELSE SELECT r.building_id INTO v_id FROM public.contract_exit_cases e JOIN public.contracts ctr ON ctr.id=e.contract_id AND ctr.organization_id=e.organization_id JOIN public.rooms r ON r.id=ctr.room_id AND r.organization_id=ctr.organization_id WHERE e.id=(v_result->>'id')::uuid AND e.organization_id=p_organization_id; END IF;
   PERFORM app_private.meter_capture_scope_v1(p_organization_id,v_id,CASE WHEN p_payload->>'kind'='invoice' THEN 'invoices.view' ELSE 'contracts.view' END);
  END IF;
  RETURN jsonb_build_object('receipt',v_result);
 END IF;
 IF p_action='documentEvidence' THEN
  IF p_payload->>'kind'='INVOICE' THEN SELECT building_id INTO v_id FROM public.invoices WHERE id=(p_payload->>'documentId')::uuid AND organization_id=p_organization_id;
  ELSIF p_payload->>'kind'='EXIT' THEN SELECT r.building_id INTO v_id FROM public.contract_exit_cases e JOIN public.contracts ctr ON ctr.id=e.contract_id AND ctr.organization_id=e.organization_id JOIN public.rooms r ON r.id=ctr.room_id AND r.organization_id=ctr.organization_id WHERE e.id=(p_payload->>'documentId')::uuid AND e.organization_id=p_organization_id;
  ELSE RAISE EXCEPTION 'Invalid evidence document kind' USING ERRCODE='22023'; END IF;
  PERFORM app_private.meter_capture_scope_v1(p_organization_id,v_id,CASE WHEN p_payload->>'kind'='INVOICE' THEN 'invoices.view' ELSE 'contracts.view' END);
  RETURN jsonb_build_object('sources',COALESCE((SELECT jsonb_agg(jsonb_build_object('meterId',l.meter_id,'meterName',COALESCE((SELECT COALESCE(name,code) FROM public.meters WHERE id=l.meter_id),'Đồng hồ điện'),
    'sortOrder',(l.source->>'sortOrder')::int,'startCaptureId',l.source->'startCaptureId',
    'endCaptureId',l.source->'endCaptureId','previousReading',l.source->>'previousReading','currentReading',l.source->>'currentReading') ORDER BY l.meter_id)
   FROM app_private.meter_capture_evidence_links l WHERE l.organization_id=p_organization_id AND l.document_kind=p_payload->>'kind' AND l.document_id=(p_payload->>'documentId')::uuid),'[]'));
 END IF;
 IF p_action='catalog' THEN RETURN app_private.meter_capture_catalog_v1(p_organization_id); END IF;
 IF p_action='resolveBilling' THEN RETURN app_private.meter_capture_resolve_billing_v1(p_organization_id,p_payload); END IF;
 IF p_action='listCaptures' THEN
  RETURN jsonb_build_object('captures',COALESCE((SELECT jsonb_agg(app_private.meter_capture_json_v1(x.id) ORDER BY x.created_at DESC) FROM (
   SELECT cap.id,cap.created_at FROM app_private.meter_captures cap WHERE cap.organization_id=p_organization_id
    AND (p_payload->>'month' IS NULL OR cap.month=p_payload->>'month')
    AND EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'meter_readings.view',cap.building_id,NULL) a WHERE a.allowed)
   ORDER BY cap.created_at DESC LIMIT 500) x),'[]'));
 END IF;
 IF p_action IN ('getCapture','finalizeCapture','confirmCapture','evidence') THEN
  SELECT * INTO c FROM app_private.meter_captures WHERE organization_id=p_organization_id AND
   ((p_payload->>'captureId' IS NOT NULL AND id=(p_payload->>'captureId')::uuid) OR
    (p_payload->>'captureId' IS NULL AND client_id=(p_payload->>'clientId')::uuid AND actor_id=auth.uid())) FOR UPDATE;
  IF NOT FOUND THEN
   IF p_action='getCapture' AND p_payload->>'captureId' IS NULL THEN RETURN jsonb_build_object('capture',NULL); END IF;
   RAISE EXCEPTION 'Meter capture not found' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.meter_capture_scope_v1(p_organization_id,c.building_id,CASE p_action WHEN 'confirmCapture' THEN 'meter_readings.approve' WHEN 'finalizeCapture' THEN 'meter_readings.create' ELSE 'meter_readings.view' END);
  IF p_action='evidence' THEN
   RETURN jsonb_build_object('evidence',jsonb_build_object('captureId',c.id,
    'imageObjectKey',CASE WHEN c.mime_type LIKE 'image/%' THEN c.object_key ELSE app_private.meter_capture_selected_frame_v1(c.id)->>'objectKey' END,
    'videoObjectKey',CASE WHEN c.mime_type LIKE 'video/%' THEN c.object_key END,
    'timestampSeconds',app_private.meter_capture_selected_frame_v1(c.id)->'timestampSeconds',
    'evidenceFrames',app_private.meter_capture_evidence_frames_v1(c.id)));
  ELSIF p_action='finalizeCapture' THEN
   IF NOT c.media_received THEN RAISE EXCEPTION 'Original media has not been verified by storage service' USING ERRCODE='55000'; END IF;
   IF p_payload->>'sha256' IS DISTINCT FROM c.sha256 OR (p_payload->>'sizeBytes')::bigint IS DISTINCT FROM c.size_bytes THEN RAISE EXCEPTION 'Original media receipt mismatch' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.meter_capture_jobs(capture_id) VALUES(c.id) ON CONFLICT DO NOTHING;
   UPDATE app_private.meter_captures SET status='QUEUED',version=version+1 WHERE id=c.id AND status='AWAITING_UPLOAD';
  ELSIF p_action='confirmCapture' THEN
   IF p_payload->>'value' IS NULL OR p_payload->>'value' !~ '^\d{1,8}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'Invalid meter value' USING ERRCODE='22023'; END IF;
   v_value:=(p_payload->>'value')::numeric;
   IF c.status='CONFIRMED' THEN
    IF c.confirmed_value IS DISTINCT FROM v_value OR c.reason IS DISTINCT FROM v_reason THEN RAISE EXCEPTION 'Capture already confirmed with different facts' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('capture',app_private.meter_capture_json_v1(c.id),'uploadPath',c.object_key);
   END IF;
   IF (p_payload->>'expectedVersion')::int IS DISTINCT FROM c.version THEN RAISE EXCEPTION 'Meter capture changed; reload' USING ERRCODE='PT409'; END IF;
   IF NOT c.media_received OR NOT c.media_validated THEN RAISE EXCEPTION 'Original media missing or clip not yet validated by server' USING ERRCODE='55000'; END IF;
   IF round(v_value,(c.profile_snapshot->>'decimalPlaces')::int)<>v_value THEN RAISE EXCEPTION 'Meter decimals mismatch' USING ERRCODE='22023'; END IF;
   SELECT result INTO v_result FROM app_private.meter_capture_results WHERE capture_id=c.id ORDER BY created_at DESC LIMIT 1;
   IF v_reason IS NULL AND (v_result IS NULL OR c.issues<>'[]'::jsonb OR c.qr_text IS NULL OR
    v_result#>>'{server,status}' IS DISTINCT FROM 'ok' OR v_result#>>'{ai,status}' IS DISTINCT FROM 'ok' OR
    v_result#>>'{server,value}' IS DISTINCT FROM v_result#>>'{ai,value}' OR
    (v_result#>>'{server,value}')::numeric IS DISTINCT FROM v_value) THEN
    RAISE EXCEPTION 'Manual confirmation needs a reason' USING ERRCODE='22023'; END IF;
   SELECT * INTO m FROM public.meters WHERE id=c.meter_id AND organization_id=p_organization_id AND deleted_at IS NULL AND status='ACTIVE' FOR UPDATE;
   SELECT * INTO ct FROM public.contracts WHERE id=c.contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR SHARE;
   IF m.room_id IS DISTINCT FROM c.room_id OR m.building_id IS DISTINCT FROM c.building_id OR ct.room_id IS DISTINCT FROM c.room_id
     OR c.reading_date<ct.start_date OR c.reading_date>COALESCE(ct.actual_end_date,ct.end_date) THEN RAISE EXCEPTION 'Meter or contract moved since capture' USING ERRCODE='PT409'; END IF;
   IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_profiles prof WHERE prof.meter_id=c.meter_id AND prof.organization_id=p_organization_id AND prof.revoked_at IS NULL
    AND 'ihome-meter:'||prof.qr_token=c.profile_snapshot->>'qrToken' AND prof.version=(c.profile_snapshot->>'version')::int) THEN RAISE EXCEPTION 'QR/profile changed; collect new evidence' USING ERRCODE='PT409'; END IF;
   IF EXISTS(SELECT 1 FROM app_private.meter_captures x WHERE x.meter_id=c.meter_id AND x.contract_id=c.contract_id AND x.reading_date=c.reading_date AND x.purpose=c.purpose AND x.status='CONFIRMED') THEN
    RAISE EXCEPTION 'A reading was already confirmed for this meter/date' USING ERRCODE='PT409'; END IF;
   v_previous:=app_private.meter_capture_previous_value_v1(c.id);
   IF v_previous IS NULL THEN RAISE EXCEPTION 'Missing verified starting reading for this contract/meter' USING ERRCODE='55000'; END IF;
   IF v_value<v_previous THEN RAISE EXCEPTION 'Meter value decreased; replace meter or correct prior reading first' USING ERRCODE='22023'; END IF;
   v_anomaly:=app_private.meter_capture_anomaly_v1(c.id,v_value,v_previous);
   IF v_anomaly<>'[]'::jsonb AND v_reason IS NULL THEN RAISE EXCEPTION 'Unusual increase or no historical baseline; confirmation needs a reason' USING ERRCODE='22023'; END IF;
   v_id:=gen_random_uuid();
   UPDATE app_private.meter_captures SET status='CONFIRMED',reading_id=v_id,confirmed_value=v_value,previous_value=v_previous,
    confirmed_by=auth.uid(),confirmed_at=clock_timestamp(),reason=v_reason,issues=issues||v_anomaly,version=version+1 WHERE id=c.id;
   INSERT INTO public.meter_readings(id,user_id,organization_id,meter_id,contract_id,building_id,room_id,service_id,meter_type,reading_code,
    reading_date,previous_reading,current_reading,status,approved_by,approved_at,recorded_by,notes)
   VALUES(v_id,auth.uid(),p_organization_id,c.meter_id,c.contract_id,c.building_id,c.room_id,m.service_id,m.meter_type,
    CASE WHEN c.purpose='MOVE_OUT' THEN 'TLY' ELSE 'CAP' END||replace(v_id::text,'-',''),c.reading_date,v_previous,v_value,'APPROVED',auth.uid(),clock_timestamp(),auth.uid(),v_reason);
  END IF;
  RETURN jsonb_build_object('capture',app_private.meter_capture_json_v1(c.id),'uploadPath',c.object_key);
 END IF;
 IF p_action='resolveQr' THEN
  SELECT * INTO p FROM app_private.meter_capture_profiles WHERE organization_id=p_organization_id AND 'ihome-meter:'||qr_token=p_payload->>'qrText' AND revoked_at IS NULL;
  SELECT * INTO m FROM public.meters WHERE id=p.meter_id AND organization_id=p_organization_id AND deleted_at IS NULL AND status='ACTIVE';
 ELSE SELECT * INTO m FROM public.meters WHERE id=(p_payload->>'meterId')::uuid AND organization_id=p_organization_id AND deleted_at IS NULL AND status='ACTIVE' FOR UPDATE; END IF;
 IF m.id IS NULL OR m.room_id IS NULL OR m.meter_type::text<>'ELECTRICITY' THEN RAISE EXCEPTION 'Meter not found in organization' USING ERRCODE='42501'; END IF;
 PERFORM app_private.meter_capture_scope_v1(p_organization_id,m.building_id,CASE WHEN p_action IN ('profile','revokeQr','rotateQr') THEN 'meters.edit' WHEN p_action='resolveQr' THEN 'meter_readings.view' ELSE 'meter_readings.create' END);
 SELECT * INTO p FROM app_private.meter_capture_profiles WHERE meter_id=m.id AND organization_id=p_organization_id FOR UPDATE;
 IF p_action='resolveQr' THEN RETURN jsonb_build_object('meter',(SELECT x FROM jsonb_array_elements(app_private.meter_capture_catalog_v1(p_organization_id)->'meters') x WHERE x->>'id'=m.id::text)); END IF;
 IF p_action IN ('profile','revokeQr','rotateQr') THEN
  IF COALESCE((p_payload->>'expectedVersion')::int,0)<>COALESCE(p.version,0) THEN RAISE EXCEPTION 'Meter profile changed; reload' USING ERRCODE='PT409'; END IF;
  v_before:=to_jsonb(p);
  IF p_action='profile' THEN
   IF p_payload->>'verified' IS DISTINCT FROM 'true' OR NULLIF(btrim(p_payload->>'serial'),'') IS NULL OR
    NULLIF(btrim(p_payload->>'registerCode'),'') IS NULL OR length(p_payload->>'registerCode')>40 OR (p_payload->>'decimalPlaces') IS NULL THEN RAISE EXCEPTION 'Verify serial and kWh register before printing QR' USING ERRCODE='22023'; END IF;
   IF NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='meter-capture-media' AND o.name=p_payload->>'referencePath'
     AND split_part(o.name,'/',1)=p_organization_id::text AND split_part(o.name,'/',2)='profiles' AND split_part(o.name,'/',3)=m.id::text
     AND split_part(o.name,'/',4)=auth.uid()::text AND o.metadata->>'mimetype' LIKE 'image/%') THEN RAISE EXCEPTION 'Registration photo must be persisted in this meter scope' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.meter_capture_profiles(meter_id,organization_id,serial_number,display_kind,decimal_places,register_code,reference_path,verified_by)
    VALUES(m.id,p_organization_id,btrim(p_payload->>'serial'),p_payload->>'displayKind',(p_payload->>'decimalPlaces')::int,btrim(p_payload->>'registerCode'),p_payload->>'referencePath',auth.uid())
   ON CONFLICT(meter_id) DO UPDATE SET serial_number=EXCLUDED.serial_number,display_kind=EXCLUDED.display_kind,decimal_places=EXCLUDED.decimal_places,
    register_code=EXCLUDED.register_code,reference_path=EXCLUDED.reference_path,verified_by=auth.uid(),verified_at=clock_timestamp(),
    qr_token=CASE WHEN meter_capture_profiles.revoked_at IS NOT NULL THEN gen_random_uuid() ELSE meter_capture_profiles.qr_token END,revoked_at=NULL,
    version=meter_capture_profiles.version+1,updated_at=clock_timestamp();
  ELSE
   IF p.meter_id IS NULL OR v_reason IS NULL THEN RAISE EXCEPTION 'QR change needs profile and reason' USING ERRCODE='22023'; END IF;
   UPDATE app_private.meter_capture_profiles SET qr_token=CASE WHEN p_action='rotateQr' THEN gen_random_uuid() ELSE qr_token END,
    revoked_at=CASE WHEN p_action='revokeQr' THEN clock_timestamp() ELSE NULL END,version=version+1,updated_at=clock_timestamp() WHERE meter_id=m.id;
  END IF;
  INSERT INTO app_private.meter_capture_profile_history(meter_id,organization_id,actor_id,action,reason,before_state,after_state)
   SELECT m.id,p_organization_id,auth.uid(),p_action,v_reason,v_before,to_jsonb(x) FROM app_private.meter_capture_profiles x WHERE x.meter_id=m.id;
  RETURN jsonb_build_object('meter',(SELECT x FROM jsonb_array_elements(app_private.meter_capture_catalog_v1(p_organization_id)->'meters') x WHERE x->>'id'=m.id::text),
   'qrText',(SELECT CASE WHEN revoked_at IS NULL THEN 'ihome-meter:'||qr_token END FROM app_private.meter_capture_profiles WHERE meter_id=m.id));
 END IF;
 IF p_action<>'startCapture' THEN RAISE EXCEPTION 'Unsupported meter action' USING ERRCODE='22023'; END IF;
 IF p.meter_id IS NULL OR p.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Register a valid QR profile first' USING ERRCODE='55000'; END IF;
 v_qr:=NULLIF(p_payload->>'qrText','');
 IF v_qr IS NOT NULL AND v_qr IS DISTINCT FROM 'ihome-meter:'||p.qr_token THEN RAISE EXCEPTION 'Wrong or revoked meter QR' USING ERRCODE='22023'; END IF;
 v_date:=(p_payload->>'readingDate')::date;v_month:=p_payload->>'month';
 IF v_date IS NULL OR v_month IS DISTINCT FROM to_char(v_date,'YYYY-MM') OR p_payload->>'purpose' NOT IN ('MONTHLY','MOVE_OUT')
   OR p_payload->>'mimeType' NOT IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime') THEN RAISE EXCEPTION 'Invalid capture period/media' USING ERRCODE='22023'; END IF;
 IF p_payload->>'contractId' IS NOT NULL THEN
  SELECT * INTO ct FROM public.contracts WHERE id=(p_payload->>'contractId')::uuid AND organization_id=p_organization_id AND room_id=m.room_id AND deleted_at IS NULL AND start_date<=v_date AND COALESCE(actual_end_date,end_date)>=v_date;
 ELSE
  IF (SELECT count(*) FROM public.contracts WHERE organization_id=p_organization_id AND room_id=m.room_id AND deleted_at IS NULL AND status::text IN ('ACTIVE','EXTENDED','TERMINATED') AND start_date<=v_date AND COALESCE(actual_end_date,end_date)>=v_date)<>1 THEN RAISE EXCEPTION 'Choose the contract for this reading date' USING ERRCODE='22023'; END IF;
  SELECT * INTO ct FROM public.contracts WHERE organization_id=p_organization_id AND room_id=m.room_id AND deleted_at IS NULL AND status::text IN ('ACTIVE','EXTENDED','TERMINATED') AND start_date<=v_date AND COALESCE(actual_end_date,end_date)>=v_date;
 END IF;
 IF ct.id IS NULL THEN RAISE EXCEPTION 'Capture contract scope/date mismatch' USING ERRCODE='42501'; END IF;
 v_hash:=md5(p_payload::text);
 SELECT * INTO c FROM app_private.meter_captures WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND client_id=(p_payload->>'clientId')::uuid;
 IF FOUND THEN
  IF c.request_hash<>v_hash THEN RAISE EXCEPTION 'Capture request reused with different facts' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('capture',app_private.meter_capture_json_v1(c.id),'uploadPath',c.object_key);
 END IF;
 v_id:=gen_random_uuid();
 INSERT INTO app_private.meter_captures(id,organization_id,building_id,room_id,meter_id,contract_id,actor_id,client_id,request_hash,purpose,reading_date,month,captured_at,
  profile_snapshot,qr_text,mime_type,size_bytes,sha256,duration_seconds,object_key)
 VALUES(v_id,p_organization_id,m.building_id,m.room_id,m.id,ct.id,auth.uid(),(p_payload->>'clientId')::uuid,v_hash,p_payload->>'purpose',v_date,v_month,(p_payload->>'capturedAt')::timestamptz,
  jsonb_build_object('qrToken','ihome-meter:'||p.qr_token,'version',p.version,'serialNumber',p.serial_number,'displayKind',p.display_kind,'decimalPlaces',p.decimal_places,'registerCode',p.register_code),v_qr,
  p_payload->>'mimeType',(p_payload->>'sizeBytes')::bigint,p_payload->>'sha256',(p_payload->>'durationSeconds')::numeric,
  p_organization_id::text||'/meter-captures/'||v_id::text||'/original');
 IF EXISTS(SELECT 1 FROM app_private.meter_captures other WHERE other.organization_id=p_organization_id AND other.sha256=p_payload->>'sha256' AND other.id<>v_id) THEN
  UPDATE app_private.meter_captures SET issues='["DUPLICATE_MEDIA"]'::jsonb WHERE id=v_id;
 END IF;
 RETURN jsonb_build_object('capture',app_private.meter_capture_json_v1(v_id),'uploadPath',p_organization_id::text||'/meter-captures/'||v_id::text||'/original');
END $$;

COMMIT;
