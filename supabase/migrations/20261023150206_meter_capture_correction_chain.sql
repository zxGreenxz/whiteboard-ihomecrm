-- Revision chains preserve approved facts and document evidence; confirmation compares the baseline the manager saw.
BEGIN;
ALTER TABLE app_private.meter_captures ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES app_private.meter_captures(id);
ALTER TABLE app_private.meter_captures ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES app_private.meter_captures(id);
ALTER TABLE app_private.meter_captures ADD COLUMN IF NOT EXISTS supersedes_version integer;
CREATE UNIQUE INDEX IF NOT EXISTS meter_capture_single_revision_child ON app_private.meter_captures(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meter_capture_active_head ON app_private.meter_captures(organization_id,meter_id,contract_id,reading_date,purpose) WHERE status='CONFIRMED' AND superseded_by IS NULL;

-- A retired reading keeps all approved facts. Only the RPC-created, reciprocal
-- confirmed chain may perform the one-time metadata retirement.
CREATE OR REPLACE FUNCTION app_private.meter_capture_is_retirement_v1(p_old public.meter_readings,p_new public.meter_readings)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT p_old.deleted_at IS NULL AND p_new.deleted_at IS NOT NULL
  -- PostgreSQL computes this stored generated column after BEFORE triggers, so
  -- NEW.consumption is not yet populated. Its two source facts remain exact.
  AND (to_jsonb(p_old)-ARRAY['deleted_at','updated_at','consumption'])=(to_jsonb(p_new)-ARRAY['deleted_at','updated_at','consumption'])
  AND EXISTS(SELECT 1 FROM app_private.meter_captures old
   JOIN app_private.meter_captures replacement ON replacement.id=old.superseded_by AND replacement.supersedes_id=old.id
    AND replacement.organization_id=old.organization_id AND replacement.meter_id=old.meter_id AND replacement.contract_id=old.contract_id
    AND replacement.reading_date=old.reading_date AND replacement.purpose=old.purpose AND replacement.status='CONFIRMED'
   JOIN public.meter_readings approved ON approved.id=replacement.reading_id AND approved.status::text='APPROVED' AND approved.deleted_at IS NULL
   WHERE old.reading_id=p_old.id AND old.status='CONFIRMED')
$$;
REVOKE ALL ON FUNCTION app_private.meter_capture_is_retirement_v1(public.meter_readings,public.meter_readings) FROM PUBLIC,anon,authenticated,service_role;

-- Legacy imports/approvals do not all participate in the decision lock. Once a meter
-- uses capture, approved points must enter through the serialized capture RPC.
CREATE OR REPLACE FUNCTION app_private.meter_capture_approved_writer_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_meter uuid;v_org uuid;
BEGIN
 IF TG_OP='UPDATE' AND app_private.meter_capture_is_retirement_v1(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN v_meter:=OLD.meter_id;v_org:=OLD.organization_id; ELSE v_meter:=NEW.meter_id;v_org:=NEW.organization_id; END IF;
 IF (TG_OP='INSERT' AND NEW.status::text='APPROVED') OR (TG_OP='DELETE' AND OLD.status::text='APPROVED') OR
  (TG_OP='UPDATE' AND (OLD.status::text='APPROVED' OR NEW.status::text='APPROVED')) THEN
  IF EXISTS(SELECT 1 FROM app_private.meter_capture_profiles p WHERE ((p.meter_id=v_meter AND p.organization_id=v_org) OR (TG_OP='UPDATE' AND p.meter_id=OLD.meter_id AND p.organization_id=OLD.organization_id)) AND p.revoked_at IS NULL) AND
   NOT (TG_OP='INSERT' AND EXISTS(SELECT 1 FROM app_private.meter_captures c WHERE c.reading_id=NEW.id AND c.organization_id=NEW.organization_id AND c.meter_id=NEW.meter_id AND c.status='CONFIRMED')) THEN
   RAISE EXCEPTION 'Meter uses QR capture; approve or correct a reading through capture review' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.meter_capture_approved_writer_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zz_meter_capture_approved_writer ON public.meter_readings;
CREATE TRIGGER zz_meter_capture_approved_writer BEFORE INSERT OR UPDATE OR DELETE ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_approved_writer_v1();

CREATE OR REPLACE FUNCTION app_private.meter_capture_reading_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND app_private.meter_capture_is_retirement_v1(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO c FROM app_private.meter_captures WHERE reading_id=NEW.id AND status='CONFIRMED';
  IF FOUND THEN
   NEW.previous_reading:=c.previous_value;NEW.current_reading:=c.confirmed_value;NEW.contract_id:=c.contract_id;
   NEW.organization_id:=c.organization_id;NEW.room_id:=c.room_id;NEW.building_id:=c.building_id;
  END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM app_private.meter_captures WHERE reading_id=OLD.id) OR EXISTS(
   SELECT 1 FROM app_private.meter_capture_evidence_links WHERE start_reading_id=OLD.id OR end_reading_id=OLD.id) THEN
  RAISE EXCEPTION 'Evidence-backed reading is immutable; use a new evidence revision and invoice adjustment' USING ERRCODE='55000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_replacement_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('id',old.id,'version',old.version,'value',old.confirmed_value::text)
 FROM app_private.meter_captures pending JOIN app_private.meter_captures old
 ON old.organization_id=pending.organization_id AND old.meter_id=pending.meter_id AND old.contract_id=pending.contract_id
 AND old.reading_date=pending.reading_date AND old.purpose=pending.purpose AND old.status='CONFIRMED' AND old.superseded_by IS NULL
 WHERE pending.id=p_id AND pending.status<>'CONFIRMED'
$$;
REVOKE ALL ON FUNCTION app_private.meter_capture_replacement_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION app_private.meter_capture_previous_value_v1(p_id uuid)
RETURNS numeric LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_previous numeric;v_start_date date;
BEGIN
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF c.status='CONFIRMED' THEN RETURN c.previous_value; END IF;
 SELECT previous_value INTO v_previous FROM app_private.meter_captures old
  WHERE old.organization_id=c.organization_id AND old.meter_id=c.meter_id AND old.contract_id=c.contract_id
   AND old.reading_date=c.reading_date AND old.purpose=c.purpose AND old.status='CONFIRMED' AND old.superseded_by IS NULL;
 IF FOUND THEN RETURN v_previous; END IF;
 SELECT start_date INTO v_start_date FROM public.contracts WHERE id=c.contract_id AND organization_id=c.organization_id AND deleted_at IS NULL;
 SELECT r.current_reading INTO v_previous FROM public.meter_readings r
  LEFT JOIN app_private.meter_captures cap ON cap.reading_id=r.id
  WHERE r.meter_id=c.meter_id AND r.contract_id=c.contract_id AND r.organization_id=c.organization_id
   AND r.deleted_at IS NULL AND r.status='APPROVED' AND r.reading_date>=v_start_date AND r.reading_date<=c.reading_date
   AND cap.superseded_by IS NULL AND (r.reading_date<c.reading_date OR cap.id IS NULL OR (c.purpose='MOVE_OUT' AND cap.purpose='MONTHLY'))
  ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
 IF v_previous IS NULL THEN
  SELECT (x#>>'{start,value}')::numeric INTO v_previous FROM jsonb_array_elements(app_private.meter_capture_resolve_billing_v1(c.organization_id,
   jsonb_build_object('contractId',c.contract_id,'month',c.month,'readingDate',c.reading_date,'purpose',c.purpose))->'meters') x WHERE x->>'meterId'=c.meter_id::text;
 END IF;
 RETURN v_previous;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_anomaly_v1(p_capture_id uuid,p_value numeric,p_previous numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_median numeric;v_previous numeric:=p_previous;
BEGIN
 IF p_value IS NULL THEN RETURN '[]'::jsonb; END IF;
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_capture_id;
 SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY delta)::numeric INTO v_median FROM (
  SELECT current_reading-previous_reading delta FROM public.meter_readings r WHERE r.organization_id=c.organization_id
   AND r.meter_id=c.meter_id AND r.contract_id=c.contract_id AND r.deleted_at IS NULL AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL)
   AND r.reading_date<=c.reading_date AND r.created_at<c.created_at AND r.current_reading>r.previous_reading
   ORDER BY r.reading_date DESC,r.created_at DESC LIMIT 3) h;
 IF v_median IS NULL THEN RETURN '["BASELINE_UNAVAILABLE"]'::jsonb; END IF;
 IF v_previous IS NULL THEN
  SELECT current_reading INTO v_previous FROM public.meter_readings r WHERE r.organization_id=c.organization_id AND r.meter_id=c.meter_id AND r.contract_id=c.contract_id
   AND r.deleted_at IS NULL AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL) AND r.reading_date<=c.reading_date AND r.created_at<c.created_at ORDER BY r.reading_date DESC,r.created_at DESC LIMIT 1;
 END IF;
 IF v_previous IS NULL THEN RETURN '["BASELINE_UNAVAILABLE"]'::jsonb; END IF;
 IF p_value-v_previous>GREATEST(100,3*v_median) THEN RETURN '["ABNORMAL_INCREASE"]'::jsonb; END IF;
 RETURN '[]'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_resolve_billing_v1(p_org uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c public.contracts%ROWTYPE; m record; v_building uuid; v_from date; v_to date; v_start jsonb; v_end jsonb;
 v_id uuid; v_rows jsonb:='[]'; v_purpose text:=COALESCE(p_payload->>'purpose','MONTHLY');
BEGIN
 SELECT * INTO c FROM public.contracts WHERE id=(p_payload->>'contractId')::uuid AND organization_id=p_org AND deleted_at IS NULL;
 SELECT building_id INTO v_building FROM public.rooms WHERE id=c.room_id AND organization_id=p_org;
 PERFORM app_private.meter_capture_scope_v1(p_org,v_building,'meter_readings.view');
 IF p_payload->>'month' !~ '^\d{4}-(0[1-9]|1[0-2])$' OR v_purpose NOT IN ('MONTHLY','MOVE_OUT') THEN
  RAISE EXCEPTION 'Invalid meter billing period' USING ERRCODE='22023'; END IF;
 v_from:=GREATEST((p_payload->>'month'||'-01')::date,c.start_date);
 v_to:=LEAST(COALESCE((p_payload->>'readingDate')::date,((v_from+interval '1 month')::date-1)),COALESCE(c.actual_end_date,c.end_date));
 IF v_to<v_from THEN RAISE EXCEPTION 'Meter billing period outside contract' USING ERRCODE='22023'; END IF;
 FOR m IN SELECT meters.*,p.decimal_places,p.register_code FROM public.meters meters LEFT JOIN app_private.meter_capture_profiles p ON p.meter_id=meters.id
  WHERE meters.organization_id=p_org AND meters.room_id=c.room_id AND meters.building_id=v_building AND meters.deleted_at IS NULL AND meters.status='ACTIVE' AND meters.meter_type::text='ELECTRICITY' ORDER BY meters.id
 LOOP
  v_start:=NULL;v_end:=NULL;
  SELECT r.id INTO v_id FROM public.meter_readings r WHERE r.organization_id=p_org AND r.contract_id=c.id AND r.meter_id=m.id
   AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL) AND r.deleted_at IS NULL AND r.reading_date>=c.start_date AND r.reading_date<v_from
   AND v_purpose='MONTHLY'
   ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_id IS NOT NULL THEN v_start:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  IF v_purpose='MOVE_OUT' THEN
   SELECT l.end_reading_id INTO v_id FROM app_private.meter_capture_evidence_links l JOIN public.invoices i ON i.id=l.document_id
    WHERE l.document_kind='INVOICE' AND l.organization_id=p_org AND l.contract_id=c.id AND l.meter_id=m.id
    AND i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
    AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=l.end_reading_id AND retired.superseded_by IS NOT NULL)
    AND (l.source->>'purpose'='MOVE_OUT' OR i.billing_month<=p_payload->>'month') AND (l.source->>'readingDate')::date<=v_to
    ORDER BY (l.source->>'readingDate')::date DESC,i.created_at DESC LIMIT 1;
   IF v_id IS NOT NULL THEN v_start:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  END IF;
  IF v_start IS NULL AND (SELECT count(*) FROM public.meters x WHERE x.organization_id=p_org AND x.room_id=c.room_id AND x.status='ACTIVE' AND x.deleted_at IS NULL AND x.meter_type::text='ELECTRICITY')=1 THEN
   SELECT jsonb_build_object('readingId',NULL,'value',ii.current_reading::text,'version','invoice:'||i.id::text||':'||ii.id::text||':'||i.updated_at::text,
    'captureId',NULL,'kind','invoice','readingDate',COALESCE(ii.to_date,i.issue_date)) INTO v_start
   FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id=i.id WHERE i.organization_id=p_org AND i.contract_id=c.id
    AND NOT EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links billed JOIN app_private.meter_captures retired ON retired.reading_id IN (billed.start_reading_id,billed.end_reading_id) WHERE billed.document_kind='INVOICE' AND billed.document_id=i.id AND retired.superseded_by IS NOT NULL)
    AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND (i.billing_month<p_payload->>'month' OR (v_purpose='MOVE_OUT' AND i.billing_month=p_payload->>'month' AND COALESCE(ii.to_date,i.issue_date)<=v_to)) AND i.issue_date>=c.start_date
    AND (ii.service_id IS NOT DISTINCT FROM m.service_id OR (m.service_id IS NULL AND EXISTS(SELECT 1 FROM public.contract_services cs WHERE cs.organization_id=p_org AND cs.contract_id=c.id AND cs.service_id=ii.service_id))) AND ii.current_reading IS NOT NULL
    AND (SELECT count(*) FROM public.invoice_items same_line WHERE same_line.invoice_id=i.id AND same_line.current_reading IS NOT NULL AND
     (same_line.service_id IS NOT DISTINCT FROM m.service_id OR (m.service_id IS NULL AND EXISTS(SELECT 1 FROM public.contract_services cs WHERE cs.organization_id=p_org AND cs.contract_id=c.id AND cs.service_id=same_line.service_id))))=1
    ORDER BY i.billing_month DESC,i.issue_date DESC,i.created_at DESC,ii.sort_order DESC LIMIT 1;
  END IF;
  IF v_start IS NULL THEN
   SELECT jsonb_build_object('readingId',NULL,'value',b.reading::text,'version','boundary:'||s.id::text||':'||s.revision::text,
    'captureId',NULL,'kind','boundary','readingDate',s.effective_on) INTO v_start
   FROM public.contract_meter_boundary_sets s JOIN public.contract_meter_boundaries b ON b.set_id=s.id AND b.revision=s.revision
   WHERE s.organization_id=p_org AND s.contract_id=c.id AND s.kind='MOVE_IN' AND s.state='VERIFIED' AND b.meter_id=m.id AND b.state='VERIFIED'
    AND NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND (i.billing_month<p_payload->>'month' OR (v_purpose='MOVE_OUT' AND i.billing_month=p_payload->>'month')));
  END IF;
  IF v_start IS NULL AND c.initial_electricity_reading IS NOT NULL AND
   NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND (i.billing_month<p_payload->>'month' OR (v_purpose='MOVE_OUT' AND i.billing_month=p_payload->>'month'))) AND
   (SELECT count(*) FROM public.meters x WHERE x.organization_id=p_org AND x.room_id=c.room_id AND x.status='ACTIVE' AND x.deleted_at IS NULL AND x.meter_type::text='ELECTRICITY')=1 THEN
   v_start:=jsonb_build_object('readingId',NULL,'value',c.initial_electricity_reading::text,'version',c.updated_at::text,'captureId',NULL,'kind','contractInitial','readingDate',c.start_date);
  END IF;
  SELECT r.id INTO v_id FROM public.meter_readings r JOIN app_private.meter_captures cap ON cap.reading_id=r.id
   WHERE r.organization_id=p_org AND r.contract_id=c.id AND r.meter_id=m.id AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL) AND r.deleted_at IS NULL
    AND r.reading_date>=v_from AND r.reading_date<=v_to AND cap.purpose=v_purpose AND cap.status='CONFIRMED'
    AND (v_purpose<>'MOVE_OUT' OR r.reading_date=v_to)
   ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_id IS NOT NULL THEN v_end:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('meterId',m.id,'meterName',COALESCE(m.name,m.code),'meterType',m.meter_type,'serviceId',m.service_id,
   'decimalPlaces',COALESCE(m.decimal_places,2),'registerCode',COALESCE(m.register_code,''),'start',v_start,'end',v_end,
   'issues',(CASE WHEN v_start IS NULL THEN '["MISSING_START"]' ELSE '[]' END)::jsonb||(CASE WHEN v_end IS NULL THEN '["MISSING_END"]' ELSE '[]' END)::jsonb||
    (CASE WHEN EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links l
      JOIN app_private.meter_captures retired ON retired.reading_id IN (l.start_reading_id,l.end_reading_id)
      WHERE l.organization_id=p_org AND l.contract_id=c.id AND l.meter_id=m.id AND retired.superseded_by IS NOT NULL
       AND (l.source->>'readingDate')::date<=v_to AND (
        (l.document_kind='INVOICE' AND EXISTS(SELECT 1 FROM public.invoices billed WHERE billed.id=l.document_id AND billed.organization_id=p_org AND billed.deleted_at IS NULL AND billed.status::text<>'CANCELLED')) OR
        (l.document_kind='EXIT' AND EXISTS(SELECT 1 FROM public.contract_exit_cases exited WHERE exited.id=l.document_id AND exited.organization_id=p_org AND exited.state::text='FINALIZED'))))
     THEN '["BILLED_READING_REPLACED"]' ELSE '[]' END)::jsonb));
 END LOOP;
 RETURN jsonb_build_object('meters',v_rows);
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_json_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('id',c.id,'clientId',c.client_id,'organizationId',c.organization_id,'meterId',c.meter_id,
  'buildingId',c.building_id,'roomId',c.room_id,'contractId',c.contract_id,'purpose',c.purpose,'readingDate',c.reading_date,
  'orgId',c.organization_id,'month',c.month,'capturedAt',c.captured_at,'receivedAt',c.received_at,'status',CASE WHEN c.status='AWAITING_UPLOAD' THEN 'UPLOADING' ELSE c.status END,'version',c.version,
  'mimeType',c.mime_type,'sizeBytes',c.size_bytes,'sha256',c.sha256,'durationSeconds',c.duration_seconds,
  'objectKey',c.object_key,'originalObjectKey',c.object_key,'mediaReceived',c.media_received,'mediaValidated',c.media_validated,'readingId',c.reading_id,
  'imageObjectKey',CASE WHEN c.mime_type LIKE 'image/%' THEN c.object_key ELSE app_private.meter_capture_selected_frame_v1(c.id)->>'objectKey' END,
  'videoObjectKey',CASE WHEN c.mime_type LIKE 'video/%' THEN c.object_key END,
  'replacement',app_private.meter_capture_replacement_v1(c.id),'supersedesCaptureId',c.supersedes_id,'supersededBy',c.superseded_by,
  'previousValue',app_private.meter_capture_previous_value_v1(c.id)::text,'evidenceFrames',app_private.meter_capture_evidence_frames_v1(c.id),
  'value',c.confirmed_value::text,'reason',c.reason,'issues',c.issues||app_private.meter_capture_anomaly_v1(c.id,
   CASE WHEN COALESCE(c.confirmed_value::text,r.result#>>'{ai,value}',r.result#>>'{server,value}')~'^\d{1,8}(\.\d{1,2})?$'
   THEN COALESCE(c.confirmed_value::text,r.result#>>'{ai,value}',r.result#>>'{server,value}')::numeric END,app_private.meter_capture_previous_value_v1(c.id)),'result',r.result,
  'proposedValue',COALESCE(c.confirmed_value::text,r.result#>>'{ai,value}',r.result#>>'{server,value}'),
  'serverResult',r.result->'server','aiResult',r.result->'ai','evidenceUrl',NULL,'videoUrl',NULL,'confirmedReadingId',c.reading_id)
 FROM app_private.meter_captures c LEFT JOIN LATERAL (SELECT result FROM app_private.meter_capture_results res WHERE res.capture_id=c.id
  AND res.created_at<=COALESCE(c.confirmed_at,'infinity'::timestamptz) ORDER BY res.created_at DESC LIMIT 1) r ON true WHERE c.id=p_id
$$;

CREATE OR REPLACE FUNCTION public.meter_capture_v1(p_organization_id uuid,p_action text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE m public.meters%ROWTYPE; p app_private.meter_capture_profiles%ROWTYPE; c app_private.meter_captures%ROWTYPE;
 old app_private.meter_captures%ROWTYPE; v_target uuid; v_target_version integer; v_ceiling numeric;
 ct public.contracts%ROWTYPE; v_id uuid; v_before jsonb; v_value numeric; v_previous numeric; v_result jsonb;v_anomaly jsonb;
 v_reason text:=NULLIF(btrim(p_payload->>'reason'),''); v_hash text; v_qr text; v_month text; v_date date;
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong meter organization' USING ERRCODE='42501'; END IF;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Expected object payload' USING ERRCODE='22023'; END IF;
 -- Every action takes the organization decision lock before capture/meter locks.
 -- This prevents old/new revision requests from acquiring these locks in reverse order.
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
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
   IF NOT (p_payload ? 'expectedPreviousValue') OR (p_payload->>'expectedPreviousValue' IS NOT NULL AND p_payload->>'expectedPreviousValue' !~ '^\d{1,8}(\.\d{1,2})?$') THEN
    RAISE EXCEPTION 'Confirmation must include the displayed previous value, including null' USING ERRCODE='22023'; END IF;
   v_target:=NULLIF(p_payload->>'supersedesCaptureId','')::uuid;
   v_target_version:=NULLIF(p_payload->>'expectedSupersededVersion','')::integer;
   IF c.status='CONFIRMED' THEN
    IF c.confirmed_value IS DISTINCT FROM v_value OR c.reason IS DISTINCT FROM v_reason OR c.previous_value IS DISTINCT FROM (p_payload->>'expectedPreviousValue')::numeric OR c.supersedes_id IS DISTINCT FROM v_target OR c.supersedes_version IS DISTINCT FROM v_target_version THEN RAISE EXCEPTION 'Capture already confirmed with different facts' USING ERRCODE='PT409'; END IF;
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
   -- Lock mutable baseline sources before recalculating. Immutable capture readings remain available for audit.
   PERFORM 1 FROM public.meter_readings r WHERE r.organization_id=p_organization_id AND r.meter_id=c.meter_id AND r.contract_id=c.contract_id AND r.deleted_at IS NULL AND r.status='APPROVED' ORDER BY r.id FOR SHARE;
   PERFORM 1 FROM public.invoices i WHERE i.organization_id=p_organization_id AND i.contract_id=c.contract_id ORDER BY i.id FOR SHARE;
   PERFORM 1 FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id WHERE i.organization_id=p_organization_id AND i.contract_id=c.contract_id ORDER BY ii.id FOR SHARE OF ii;
   PERFORM 1 FROM public.contract_meter_boundary_sets s WHERE s.organization_id=p_organization_id AND s.contract_id=c.contract_id ORDER BY s.id FOR SHARE;
   PERFORM 1 FROM public.contract_meter_boundaries b JOIN public.contract_meter_boundary_sets s ON s.id=b.set_id WHERE s.organization_id=p_organization_id AND s.contract_id=c.contract_id ORDER BY b.id FOR SHARE OF b;
   SELECT * INTO old FROM app_private.meter_captures x WHERE x.organization_id=p_organization_id AND x.meter_id=c.meter_id AND x.contract_id=c.contract_id AND x.reading_date=c.reading_date AND x.purpose=c.purpose AND x.status='CONFIRMED' AND x.superseded_by IS NULL FOR UPDATE;
   IF old.id IS DISTINCT FROM v_target OR (old.id IS NOT NULL AND old.version IS DISTINCT FROM v_target_version) OR (old.id IS NULL AND v_target_version IS NOT NULL) THEN
    RAISE EXCEPTION 'Replacement head changed; reload and explicitly choose the current approved reading' USING ERRCODE='PT409'; END IF;
   IF old.id IS NOT NULL AND old.purpose='MOVE_OUT' AND EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links link
     JOIN public.contract_exit_cases exited ON exited.id=link.document_id AND exited.organization_id=link.organization_id
     WHERE link.document_kind='EXIT' AND link.organization_id=p_organization_id AND link.contract_id=c.contract_id
      AND old.reading_id IN (link.start_reading_id,link.end_reading_id) AND exited.state::text='FINALIZED') THEN
    RAISE EXCEPTION 'Finalized settlement reading requires accounting and contract adjustment before correction' USING ERRCODE='PT422'; END IF;
   IF old.id IS NOT NULL AND (v_reason IS NULL OR length(v_reason)<5) THEN RAISE EXCEPTION 'Correcting an approved reading needs an explicit reason' USING ERRCODE='22023'; END IF;
   v_previous:=app_private.meter_capture_previous_value_v1(c.id);
   IF v_previous IS DISTINCT FROM (p_payload->>'expectedPreviousValue')::numeric THEN RAISE EXCEPTION 'Previous reading changed; reload before confirming' USING ERRCODE='PT409'; END IF;
   -- Do not cross an already approved later point, including legacy readings without a capture.
   SELECT min(r.current_reading) INTO v_ceiling FROM public.meter_readings r LEFT JOIN app_private.meter_captures cap ON cap.reading_id=r.id
    WHERE r.organization_id=p_organization_id AND r.meter_id=c.meter_id AND r.contract_id=c.contract_id AND r.status='APPROVED' AND r.deleted_at IS NULL
     AND cap.superseded_by IS NULL AND r.id IS DISTINCT FROM old.reading_id
     AND (r.reading_date>c.reading_date OR (r.reading_date=c.reading_date AND (cap.id IS NULL OR (c.purpose='MONTHLY' AND cap.purpose='MOVE_OUT'))));
   IF v_ceiling IS NOT NULL AND v_value>v_ceiling THEN RAISE EXCEPTION 'Reading exceeds an approved later reading; correct later points first' USING ERRCODE='22023'; END IF;
   IF v_previous IS NULL THEN RAISE EXCEPTION 'Missing verified starting reading for this contract/meter' USING ERRCODE='55000'; END IF;
   IF v_value<v_previous THEN RAISE EXCEPTION 'Meter value decreased; replace meter or correct prior reading first' USING ERRCODE='22023'; END IF;
   v_anomaly:=app_private.meter_capture_anomaly_v1(c.id,v_value,v_previous);
   IF v_anomaly<>'[]'::jsonb AND v_reason IS NULL THEN RAISE EXCEPTION 'Unusual increase or no historical baseline; confirmation needs a reason' USING ERRCODE='22023'; END IF;
   v_id:=gen_random_uuid();
   IF old.id IS NOT NULL THEN UPDATE app_private.meter_captures SET superseded_by=c.id,version=version+1 WHERE id=old.id; END IF;
   UPDATE app_private.meter_captures SET supersedes_id=old.id,supersedes_version=old.version,status='CONFIRMED',reading_id=v_id,confirmed_value=v_value,previous_value=v_previous,
    confirmed_by=auth.uid(),confirmed_at=clock_timestamp(),reason=v_reason,issues=issues||v_anomaly,version=version+1 WHERE id=c.id;
   INSERT INTO public.meter_readings(id,user_id,organization_id,meter_id,contract_id,building_id,room_id,service_id,meter_type,reading_code,
    reading_date,previous_reading,current_reading,status,approved_by,approved_at,recorded_by,notes)
   VALUES(v_id,auth.uid(),p_organization_id,c.meter_id,c.contract_id,c.building_id,c.room_id,m.service_id,m.meter_type,
    CASE WHEN c.purpose='MOVE_OUT' THEN 'TLY' ELSE 'CAP' END||replace(v_id::text,'-',''),c.reading_date,v_previous,v_value,'APPROVED',auth.uid(),clock_timestamp(),auth.uid(),v_reason);
   IF old.id IS NOT NULL THEN UPDATE public.meter_readings SET deleted_at=clock_timestamp() WHERE id=old.reading_id; END IF;
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
